/**
 * plugin-notes/exporter.ts
 *
 * 导出核心：目录索引、增量写入、冲突跳过、TOCTOU 重新验证。
 *
 * 接受可选的 beforeWrite hook，供 SyncService 注册自写抑制 token。
 * 写前注册 path+content；写失败则清除 token；写成功 caller 消费 token。
 */

import { normalizePath } from "obsidian";
import type Manager from "main";
import type { ManagerPlugin } from "src/data/types";
import type { PluginNoteFrontmatter } from "./types";
import { decodeNote, buildExportFrontmatter, buildMarkdown, safeFileName, DEFAULT_BODY, CURRENT_SCHEMA_VERSION, isValidExportPath } from "./types";

export interface FileIndexEntry { path: string; confirmed: boolean; }

export interface ExportDirIndex {
	dirPath: string;
	idToFile: Map<string, FileIndexEntry>;
	conflictedIds: Set<string>;
	allFiles: string[];
}

/** Write lifecycle hooks — beforeWrite returns token id for cleanup */
export interface WriteHooks {
	beforeWrite?: (path: string, content: string) => string | undefined;
	writeSuccess?: (path: string, tokenId?: string) => void;
	writeFailure?: (path: string, tokenId?: string) => void;
}

function isDirectChild(filePath: string, dirPath: string): boolean {
	const normalized = normalizePath(filePath);
	const dir = normalizePath(dirPath);
	if (normalized === dir) return false;
	const parent = normalized.substring(0, normalized.lastIndexOf("/"));
	return parent === dir;
}

export async function buildDirIndex(manager: Manager, dirPath: string): Promise<ExportDirIndex> {
	const adapter = manager.app.vault.adapter;
	const normalizedDir = normalizePath(dirPath);
	const idToFile = new Map<string, FileIndexEntry>();
	const conflictedIds = new Set<string>();
	const allFiles: string[] = [];

	let listed;
	try {
		listed = await adapter.list(normalizedDir);
	} catch {
		return { dirPath: normalizedDir, idToFile, conflictedIds, allFiles };
	}

	for (const fp of listed.files) {
		if (fp.toLowerCase().endsWith(".md") && isDirectChild(fp, normalizedDir)) {
			allFiles.push(normalizePath(fp));
		}
	}

	for (const fp of allFiles) {
		try {
			const content = await adapter.read(fp);
			const decoded = decodeNote(content);
			if (decoded.isMalformed || !decoded.isBpmNote || decoded.isPlainMd) continue;

			const id = decoded.frontmatter.bpm_ro_id;
			if (!id) continue;

			if (idToFile.has(id)) {
				conflictedIds.add(id);
				idToFile.delete(id);
				if (manager.settings.DEBUG) {
					console.warn(`[BPM] Conflicting bpm_ro_id "${id}" in multiple files. Skipping all.`);
				}
				continue;
			}
			idToFile.set(id, { path: normalizePath(fp), confirmed: true });
		} catch {
			// unreadable files skipped
		}
	}
	conflictedIds.forEach((id) => idToFile.delete(id));
	return { dirPath: normalizedDir, idToFile, conflictedIds, allFiles };
}

export async function resolveExportPath(manager: Manager, index: ExportDirIndex, pluginId: string, displayName?: string): Promise<{ path: string | null; skipped: boolean; reason?: string }> {
	const adapter = manager.app.vault.adapter;
	const desiredPath = normalizePath(`${index.dirPath}/${safeFileName(displayName || pluginId, "plugin")}.md`);

	if (index.conflictedIds.has(pluginId)) {
		return { path: null, skipped: true, reason: "conflict" };
	}

	const existing = index.idToFile.get(pluginId);
	if (existing) {
		if (existing.path === desiredPath) return { path: existing.path, skipped: false };
		const desiredExists = await adapter.exists(desiredPath);
		if (!desiredExists) {
			try {
				await adapter.rename(existing.path, desiredPath);
				index.idToFile.set(pluginId, { path: desiredPath, confirmed: true });
				return { path: desiredPath, skipped: false };
			} catch (e) {
				if (manager.settings.DEBUG) console.warn(`[BPM] Rename failed: "${existing.path}" -> "${desiredPath}"`, e);
				return { path: existing.path, skipped: false };
			}
		}
		return { path: existing.path, skipped: false };
	}

	const desiredExists = await adapter.exists(desiredPath);
	if (desiredExists) {
		try {
			const content = await adapter.read(desiredPath);
			const decoded = decodeNote(content);
			if (decoded.isBpmNote && decoded.frontmatter.bpm_ro_id === pluginId) {
				index.idToFile.set(pluginId, { path: desiredPath, confirmed: true });
				return { path: desiredPath, skipped: false };
			}
			if (decoded.isBpmNote) return { path: null, skipped: true, reason: "target-owned" };
			return { path: null, skipped: true, reason: "target-unowned" };
		} catch {
			return { path: null, skipped: true, reason: "target-unreadable" };
		}
	}
	return { path: desiredPath, skipped: false };
}

export function buildPluginFrontmatter(manager: Manager, mp: ManagerPlugin): PluginNoteFrontmatter {
	const manifest = manager.appPlugins.manifests[mp.id];
	const repo = manager.settings.REPO_MAP[mp.id] || "";
	return {
		bpm_ro_id: mp.id, bpm_ro_name: mp.name || mp.id,
		bpm_ro_group: mp.group || "", bpm_ro_tags: [...(mp.tags || [])],
		bpm_ro_delay: mp.delay || "", bpm_ro_installed_via_bpm: manager.settings.BPM_INSTALLED?.includes(mp.id) || false,
		bpm_rw_desc: mp.desc || "", bpm_rw_note: mp.note || "",
		bpm_rw_enabled: mp.enabled, bpm_rw_group: mp.group || "", bpm_rw_tags: [...(mp.tags || [])],
		bpm_rwc_repo: repo, bpm_schema_version: CURRENT_SCHEMA_VERSION,
		bpm_version: manifest?.version || "",
		bpm_author: (manifest as unknown as Record<string, unknown>)?.author ? String((manifest as unknown as Record<string, unknown>).author) : "",
		bpm_id: mp.id,
	};
}

async function ensureDirExists(adapter: import("obsidian").Vault["adapter"], dirPath: string): Promise<boolean> {
	const parts = dirPath.split("/").filter(Boolean);
	let current = "";
	for (const part of parts) {
		current = current ? `${current}/${part}` : part;
		try {
			if (!(await adapter.exists(current))) await adapter.mkdir(current);
		} catch { return false; }
	}
	return true;
}

export async function exportPluginNote(
	manager: Manager, index: ExportDirIndex, mp: ManagerPlugin,
	options?: { body?: string; customProps?: Record<string, unknown>; hooks?: WriteHooks }
): Promise<{ written: boolean; skipped: boolean; reason?: string }> {
	const adapter = manager.app.vault.adapter;

	if (index.conflictedIds.has(mp.id)) return { written: false, skipped: true, reason: "conflict" };
	if (!(await ensureDirExists(adapter, index.dirPath))) return { written: false, skipped: true, reason: "mkdir-failed" };

	const resolved = await resolveExportPath(manager, index, mp.id, mp.name);
	if (resolved.skipped || !resolved.path) return { written: false, skipped: true, reason: resolved.reason || "path-unresolved" };
	const targetPath = resolved.path;

	// Read existing content
	let existingBody = options?.body ?? DEFAULT_BODY;
	let existingCustom: Record<string, unknown> = {};
	let existingContent: string | null = null;

	try {
		if (await adapter.exists(targetPath)) {
			existingContent = await adapter.read(targetPath);
			const decoded = decodeNote(existingContent);
			if (decoded.isBpmNote) {
				existingBody = decoded.body || existingBody;
				existingCustom = options?.customProps ?? decoded.customProps;
			} else {
				// TOCTOU: file changed since index, don't overwrite unowned content
				return { written: false, skipped: true, reason: "ownership-changed" };
			}
		}
	} catch {
		// File disappeared or unreadable - skip
		return { written: false, skipped: true, reason: "existing-unreadable" };
	}

	const bpmFields = buildPluginFrontmatter(manager, mp);
	const frontmatter = buildExportFrontmatter(bpmFields, existingCustom);
	const newContent = buildMarkdown(frontmatter, existingBody);

	if (existingContent !== null && existingContent === newContent) return { written: false, skipped: true, reason: "unchanged" };

	// Register write suppression BEFORE write (if hook provided)
	let tokenId: string | undefined;
	if (options?.hooks?.beforeWrite) {
		tokenId = options.hooks.beforeWrite(targetPath, newContent);
	}

	try {
		await adapter.write(targetPath, newContent);
		index.idToFile.set(mp.id, { path: normalizePath(targetPath), confirmed: true });
		if (options?.hooks?.writeSuccess) {
			options.hooks.writeSuccess(targetPath, tokenId);
		}
		return { written: true, skipped: false };
	} catch (e) {
		// Clean up suppression token on failure
		if (options?.hooks?.writeFailure) {
			options.hooks.writeFailure(targetPath, tokenId);
		}
		if (manager.settings.DEBUG) console.error(`[BPM] Write failed for "${mp.id}"`, e);
		return { written: false, skipped: true, reason: "write-failed" };
	}
}
