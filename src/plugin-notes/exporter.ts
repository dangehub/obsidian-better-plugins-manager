/**
 * plugin-notes/exporter.ts
 *
 * 导出核心逻辑：
 * - 单次扫描构建 id→file 索引，同时记录 conflictedIds
 * - 按 plugin id 路径名写入，不按 name
 * - 不确定文件（无 frontmatter、解析错误、无 bpm_ro_id）不覆盖
 * - 重复 id 跳过全部操作
 * - 不调用网络 API（repoResolver）
 * - Vault/Adapter 公共 API，移动端兼容
 */

import { normalizePath } from "obsidian";
import type Manager from "main";
import type { ManagerPlugin } from "src/data/types";
import type { PluginNoteFrontmatter } from "./types";
import {
	decodeNote,
	buildExportFrontmatter,
	buildMarkdown,
	safeFileName,
	DEFAULT_BODY,
	CURRENT_SCHEMA_VERSION,
	isValidExportPath,
} from "./types";

/** 文件索引条目 */
export interface FileIndexEntry {
	path: string;
	confirmed: boolean;
}

/** 导出目录索引 */
export interface ExportDirIndex {
	dirPath: string;
	idToFile: Map<string, FileIndexEntry>;
	conflictedIds: Set<string>;
	allFiles: string[];
}

/**
 * 判断文件是否在导出目录内（直接子级）。
 * 本功能只管理配置目录的直接子级 .md 文件。
 */
function isDirectChild(filePath: string, dirPath: string): boolean {
	const normalized = normalizePath(filePath);
	const dir = normalizePath(dirPath);
	if (normalized === dir) return false;
	const parent = normalized.substring(0, normalized.lastIndexOf("/"));
	return parent === dir;
}

/**
 * 单次扫描导出目录，构建索引。
 * 只列出直接子级（不递归），除非目录中包含子目录（仅当需要兼容时）。
 */
export async function buildDirIndex(
	manager: Manager,
	dirPath: string
): Promise<ExportDirIndex> {
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

	// 只处理直接子级的 .md 文件
	for (const fp of listed.files) {
		if (fp.toLowerCase().endsWith(".md") && isDirectChild(fp, normalizedDir)) {
			allFiles.push(normalizePath(fp));
		}
	}

	// 解析每个文件
	for (const fp of allFiles) {
		try {
			const content = await adapter.read(fp);
			const decoded = decodeNote(content);

			// 跳过非 BPM 笔记、解析错误、无 bpm_ro_id 的文件
			if (decoded.isMalformed || !decoded.isBpmNote || decoded.isPlainMd) continue;

			const id = decoded.frontmatter.bpm_ro_id;
			if (!id) continue;

			// 检查冲突
			if (idToFile.has(id)) {
				conflictedIds.add(id);
				idToFile.delete(id); // 从有效索引移除
				if (manager.settings.DEBUG) {
					console.warn(`[BPM] Conflicting bpm_ro_id "${id}" in multiple files. Skipping all.`);
				}
				continue;
			}

			idToFile.set(id, { path: normalizePath(fp), confirmed: true });
		} catch {
			// 读取失败的文件跳过
		}
	}

	// 从索引中移除任何后来变冲突的 id
	conflictedIds.forEach((id) => idToFile.delete(id));

	return { dirPath: normalizedDir, idToFile, conflictedIds, allFiles };
}

/**
 * 确定导出路径。
 *
 * 策略：
 * 1. 按 plugin id 在索引中查找既有文件。
 * 2. 如果找到且路径匹配 `<dir>/<id>.md`，复用。
 * 3. 如果找到旧 name-based 文件且目标 `<dir>/<id>.md` 未被占用，安全迁移。
 * 4. 如果目标被占用（非自身），则返回冲突状态，跳过。
 */
export async function resolveExportPath(
	manager: Manager,
	index: ExportDirIndex,
	pluginId: string
): Promise<{ path: string | null; skipped: boolean; reason?: string }> {
	const adapter = manager.app.vault.adapter;
	const desiredPath = normalizePath(`${index.dirPath}/${safeFileName(pluginId, "plugin")}.md`);

	// 检查冲突
	if (index.conflictedIds.has(pluginId)) {
		return { path: null, skipped: true, reason: "conflict" };
	}

	// 1) 按 id 查找既有文件
	const existing = index.idToFile.get(pluginId);
	if (existing) {
		if (existing.path === desiredPath) {
			return { path: existing.path, skipped: false };
		}
		// 旧 name-based 文件存在，目标未被占用则迁移
		const desiredExists = await adapter.exists(desiredPath);
		if (!desiredExists) {
			try {
				await adapter.rename(existing.path, desiredPath);
				index.idToFile.set(pluginId, { path: desiredPath, confirmed: true });
				return { path: desiredPath, skipped: false };
			} catch (e) {
				if (manager.settings.DEBUG) {
					console.warn(`[BPM] Failed to rename "${existing.path}" to "${desiredPath}"`, e);
				}
				return { path: existing.path, skipped: false };
			}
		}
		// 目标被占用但不是我们：不覆盖，保留旧路径
		return { path: existing.path, skipped: false };
	}

	// 2) 检查目标路径是否存在
	const desiredExists = await adapter.exists(desiredPath);
	if (desiredExists) {
		// 检查路径内容
		try {
			const content = await adapter.read(desiredPath);
			const decoded = decodeNote(content);

			// 如果已有文件是我们的（但不在索引中），复用
			if (decoded.isBpmNote && decoded.frontmatter.bpm_ro_id === pluginId) {
				index.idToFile.set(pluginId, { path: desiredPath, confirmed: true });
				return { path: desiredPath, skipped: false };
			}

			// 如果目标被其他 BPM 笔记占用，跳过
			if (decoded.isBpmNote) {
				return { path: null, skipped: true, reason: "target-owned-by-other-plugin" };
			}

			// 如果是无标识文件（无 frontmatter/无 bpm_ro_id），不覆盖
			return { path: null, skipped: true, reason: "target-is-unowned-file" };
		} catch {
			// 读取失败，不覆盖
			return { path: null, skipped: true, reason: "target-unreadable" };
		}
	}

	return { path: desiredPath, skipped: false };
}

/**
 * 构建 BPM 插件的导出 frontmatter。
 * 不调用网络 API（repoResolver），仅使用已有数据。
 */
export function buildPluginFrontmatter(
	manager: Manager,
	mp: ManagerPlugin
): PluginNoteFrontmatter {
	const manifest = manager.appPlugins.manifests[mp.id];
	const repo = manager.settings.REPO_MAP[mp.id] || "";

	return {
		bpm_ro_id: mp.id,
		bpm_ro_name: mp.name || mp.id,
		bpm_ro_group: mp.group || "",
		bpm_ro_tags: [...(mp.tags || [])],
		bpm_ro_delay: mp.delay || "",
		bpm_ro_installed_via_bpm: manager.settings.BPM_INSTALLED?.includes(mp.id) || false,
		bpm_rw_desc: mp.desc || "",
		bpm_rw_note: mp.note || "",
		bpm_rw_enabled: mp.enabled,
		bpm_rw_group: mp.group || "",
		bpm_rw_tags: [...(mp.tags || [])],
		bpm_rwc_repo: repo,
		bpm_schema_version: CURRENT_SCHEMA_VERSION,
		bpm_version: manifest?.version || "",
		bpm_author: (manifest as unknown as Record<string, unknown>)?.author
			? String((manifest as unknown as Record<string, unknown>).author)
			: "",
		bpm_id: mp.id,
	};
}

/**
 * 安全创建目录（逐层，Vault/Adapter 兼容）。
 */
async function ensureDirExists(adapter: import("obsidian").Vault["adapter"], dirPath: string): Promise<boolean> {
	const parts = dirPath.split("/").filter(Boolean);
	let current = "";
	for (const part of parts) {
		current = current ? `${current}/${part}` : part;
		try {
			if (!(await adapter.exists(current))) {
				await adapter.mkdir(current);
			}
		} catch {
			return false;
		}
	}
	return true;
}

/**
 * 导出单个插件笔记。
 */
export async function exportPluginNote(
	manager: Manager,
	index: ExportDirIndex,
	mp: ManagerPlugin,
	options?: { body?: string; customProps?: Record<string, unknown> }
): Promise<{ written: boolean; skipped: boolean; reason?: string }> {
	const adapter = manager.app.vault.adapter;

	// 检查冲突
	if (index.conflictedIds.has(mp.id)) {
		return { written: false, skipped: true, reason: "conflict" };
	}

	// 确保目录存在
	if (!(await ensureDirExists(adapter, index.dirPath))) {
		if (manager.settings.DEBUG) {
			console.error(`[BPM] Cannot create export directory "${index.dirPath}"`);
		}
		return { written: false, skipped: true, reason: "mkdir-failed" };
	}

	// 确定路径
	const resolved = await resolveExportPath(manager, index, mp.id);
	if (resolved.skipped || !resolved.path) {
		return { written: false, skipped: true, reason: resolved.reason || "path-unresolved" };
	}
	const targetPath = resolved.path;

	// 读取旧内容
	let existingBody = options?.body ?? DEFAULT_BODY;
	let existingCustom: Record<string, unknown> = {};
	let existingContent: string | null = null;

	try {
		if (await adapter.exists(targetPath)) {
			existingContent = await adapter.read(targetPath);
			const decoded = decodeNote(existingContent);
			// 只保留有效 BPM 笔记的正文和自定义属性
			if (decoded.isBpmNote) {
				existingBody = decoded.body || existingBody;
				existingCustom = options?.customProps ?? decoded.customProps;
			}
		}
	} catch {
		// 读取失败使用默认值
	}

	// 构建 frontmatter
	const bpmFields = buildPluginFrontmatter(manager, mp);
	const frontmatter = buildExportFrontmatter(bpmFields, existingCustom);
	const newContent = buildMarkdown(frontmatter, existingBody);

	// 内容未变化：跳过写入
	if (existingContent !== null && existingContent === newContent) {
		return { written: false, skipped: true, reason: "unchanged" };
	}

	try {
		await adapter.write(targetPath, newContent);
		index.idToFile.set(mp.id, { path: normalizePath(targetPath), confirmed: true });
		return { written: true, skipped: false };
	} catch (e) {
		if (manager.settings.DEBUG) {
			console.error(`[BPM] Failed to write plugin note for "${mp.id}"`, e);
		}
		return { written: false, skipped: true, reason: "write-failed" };
	}
}

/**
 * 全量导出所有插件笔记。
 * 只扫描一次导出目录。
 */
export async function exportAllPluginNotes(
	manager: Manager,
	dirPath: string
): Promise<{ total: number; written: number; skipped: number; errors: number }> {
	const stat = { total: 0, written: 0, skipped: 0, errors: 0 };

	const validation = isValidExportPath(dirPath);
	if (!validation.valid) return stat;

	const index = await buildDirIndex(manager, dirPath);

	const plugins = manager.settings.Plugins || [];
	stat.total = plugins.length;

	for (const mp of plugins) {
		try {
			const result = await exportPluginNote(manager, index, mp);
			if (result.written) {
				stat.written++;
			} else {
				stat.skipped++;
			}
		} catch (e) {
			stat.errors++;
			if (manager.settings.DEBUG) {
				console.error(`[BPM] Export failed for plugin "${mp.id}"`, e);
			}
		}
	}

	return stat;
}
