/**
 * plugin-notes/exporter.ts
 *
 * 插件信息 Markdown 导出核心逻辑：
 * - 导出目录索引（一次性扫描构建 id→file 映射）
 * - 单插件写入（增量，内容未变化不写）
 * - 全量快照导出
 * - 旧文件安全迁移/复用
 *
 * 只使用 Obsidian Vault Adapter 公共 API。
 */

import { normalizePath } from "obsidian";
import type Manager from "main";
import { ManagerPlugin } from "src/data/types";
import type { PluginNoteFrontmatter } from "./types";
import {
	decodeNote,
	buildExportFrontmatter,
	buildMarkdown,
	safeFileName,
	DEFAULT_BODY,
	CURRENT_SCHEMA_VERSION,
} from "./types";

/** 目录索引：插件 id → 文件信息 */
export interface FileIndexEntry {
	/** 文件相对 vault 路径（normalized） */
	path: string;
	/** 是否通过 frontmatter 匹配确认身份 */
	confirmed: boolean;
}

/** 导出目录索引 */
export interface ExportDirIndex {
	/** 相对 vault 的目录路径（已 normalize） */
	dirPath: string;
	/** id → 文件映射 */
	idToFile: Map<string, FileIndexEntry>;
	/** 所有 Markdown 文件路径 */
	allFiles: string[];
}

/**
 * 判断文件路径是否在指定目录下。
 */
function isPathInDir(filePath: string, dirPath: string): boolean {
	const normalized = normalizePath(filePath);
	const dir = normalizePath(dirPath);
	if (normalized === dir) return true;
	return normalized.startsWith(dir + "/");
}

/**
 * 扫描导出目录，构建 id→file 索引。
 *
 * 只调用一次 `adapter.list()`，避免每插件全目录扫描。
 */
export async function buildDirIndex(
	manager: Manager,
	dirPath: string
): Promise<ExportDirIndex> {
	const adapter = manager.app.vault.adapter;
	const normalizedDir = normalizePath(dirPath);
	const idToFile = new Map<string, FileIndexEntry>();
	const allFiles: string[] = [];

	let listed;
	try {
		listed = await adapter.list(normalizedDir);
	} catch {
		return { dirPath: normalizedDir, idToFile, allFiles };
	}

	// 收集所有 .md 文件（递归）
	const collectMdFiles = async (paths: string[]): Promise<void> => {
		for (const fp of paths) {
			if (fp.toLowerCase().endsWith(".md")) {
				allFiles.push(normalizePath(fp));
			}
		}
	};

	if (listed.files.length > 0) {
		await collectMdFiles(listed.files);
	}

	// 递归子目录
	const processFolders = async (folders: string[]): Promise<void> => {
		for (const folder of folders) {
			try {
				const sub = await adapter.list(normalizePath(folder));
				if (sub.files.length > 0) await collectMdFiles(sub.files);
				if (sub.folders.length > 0) await processFolders(sub.folders);
			} catch {
				// 跳过无法读取的子目录
			}
		}
	};

	if (listed.folders.length > 0) {
		await processFolders(listed.folders);
	}

	// 解析每个文件的 frontmatter，构建索引
	for (const fp of allFiles) {
		try {
			const content = await adapter.read(fp);
			const decoded = decodeNote(content);
			const id = decoded.frontmatter.bpm_ro_id;
			if (id) {
				const existing = idToFile.get(id);
				if (existing) {
					// 重复 id：保留第一个，跳过后续
					if (manager.settings.DEBUG) {
						console.warn(
							`[BPM] Duplicate bpm_ro_id "${id}" found: "${existing.path}" and "${fp}". Skipping "${fp}".`
						);
					}
					continue;
				}
				idToFile.set(id, {
					path: normalizePath(fp),
					confirmed: true,
				});
			}
		} catch {
			// 解析失败的文件，不加入索引
		}
	}

	return { dirPath: normalizedDir, idToFile, allFiles };
}

/**
 * 为插件确定导出路径。
 *
 * 策略：
 * 1. 按 bpm_ro_id 在索引中查找匹配文件。
 * 2. 如果找到且路径与期望一致，复用。
 * 3. 如果找到但路径不同，且期望路径不存在，安全重命名。
 * 4. 如果期望路径已被另一插件占用，附加后缀。
 */
export async function resolveExportPath(
	manager: Manager,
	index: ExportDirIndex,
	pluginId: string,
	pluginName: string
): Promise<string> {
	const adapter = manager.app.vault.adapter;
	const desiredName = safeFileName(pluginName || pluginId);
	const desiredPath = normalizePath(`${index.dirPath}/${desiredName}.md`);

	// 1) 按 id 查找既有文件
	const existing = index.idToFile.get(pluginId);
	if (existing) {
		const currentPath = existing.path;
		if (currentPath === desiredPath) return currentPath;

		// 期望路径不存在时，重命名旧文件到期望路径
		const desiredExists = await adapter.exists(desiredPath);
		if (!desiredExists) {
			try {
				await adapter.rename(currentPath, desiredPath);
				index.idToFile.set(pluginId, { path: desiredPath, confirmed: true });
				return desiredPath;
			} catch (e) {
				if (manager.settings.DEBUG) {
					console.warn(`[BPM] Failed to rename "${currentPath}" to "${desiredPath}"`, e);
				}
				return currentPath;
			}
		}
		// 期望路径已存在：返回当前路径
		return currentPath;
	}

	// 2) 期望路径是否已被占用
	const desiredExists = await adapter.exists(desiredPath);
	if (desiredExists) {
		// 检查是否已被其他 id 占用
		const content = await adapter.read(desiredPath);
		const decoded = decodeNote(content);
		if (decoded.frontmatter.bpm_ro_id && decoded.frontmatter.bpm_ro_id !== pluginId) {
			// 被占用：追加 id 后缀
			const altPath = normalizePath(`${index.dirPath}/${desiredName}-${pluginId}.md`);
			if (manager.settings.DEBUG) {
				console.warn(
					`[BPM] Path "${desiredPath}" already used by "${decoded.frontmatter.bpm_ro_id}". Using "${altPath}".`
				);
			}
			return altPath;
		}
	}

	return desiredPath;
}

/**
 * 构建 BPM 插件的导出 frontmatter 数据。
 *
 * 从 ManagerPlugin + PluginManifest 填充：
 * - 必填：id、name、group、tags、delay、enabled、note、desc
 * - 新增：version、author（来自 Obsidian PluginManifest）
 * - 仓库：优先 REPO_MAP，必要时调用 repoResolver
 */
export async function buildPluginFrontmatter(
	manager: Manager,
	mp: ManagerPlugin
): Promise<PluginNoteFrontmatter> {
	const manifest = manager.appPlugins.manifests[mp.id];

	// 解析仓库
	let repo = manager.settings.REPO_MAP[mp.id] || "";
	if (!repo) {
		try {
			const resolved = await manager.repoResolver.resolveRepo(mp.id);
			if (resolved) repo = resolved;
		} catch {
			// 解析失败保持原值
		}
	}

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
		bpm_rwc_repo: repo,
		bpm_schema_version: CURRENT_SCHEMA_VERSION,
		bpm_version: manifest?.version || "",
		bpm_author: (manifest as unknown as Record<string, unknown>)?.author ? String((manifest as unknown as Record<string, unknown>).author) : "",
		bpm_id: mp.id,
	};
}

/**
 * 导出单个插件笔记。
 *
 * @returns true 表示写入成功，false 表示跳过或失败。
 */
export async function exportPluginNote(
	manager: Manager,
	index: ExportDirIndex,
	mp: ManagerPlugin,
	options?: { body?: string; customProps?: Record<string, unknown> }
): Promise<boolean> {
	const adapter = manager.app.vault.adapter;

	// 确保目录存在
	try {
		if (!(await adapter.exists(index.dirPath))) {
			await adapter.mkdir(index.dirPath);
		}
	} catch (e) {
		if (manager.settings.DEBUG) {
			console.error(`[BPM] Failed to create export directory "${index.dirPath}"`, e);
		}
		return false;
	}

	// 确定输出路径
	const targetPath = await resolveExportPath(manager, index, mp.id, mp.name || mp.id);

	// 读取旧内容（如果存在）
	let existingBody = options?.body ?? DEFAULT_BODY;
	let existingCustom: Record<string, unknown> = {};
	let existingContent: string | null = null;

	try {
		if (await adapter.exists(targetPath)) {
			existingContent = await adapter.read(targetPath);
			const decoded = decodeNote(existingContent);
			existingBody = decoded.body || existingBody;
			existingCustom = options?.customProps ?? decoded.customProps;
		}
	} catch {
		// 读取失败时使用默认值
	}

	// 构建 frontmatter
	const bpmFields = await buildPluginFrontmatter(manager, mp);
	const frontmatter = buildExportFrontmatter(bpmFields, existingCustom);

	// 构建完整内容
	const newContent = buildMarkdown(frontmatter, existingBody);

	// 内容未变化：跳过写入
	if (existingContent !== null && existingContent === newContent) {
		return false;
	}

	try {
		await adapter.write(targetPath, newContent);

		// 更新索引
		index.idToFile.set(mp.id, { path: normalizePath(targetPath), confirmed: true });

		return true;
	} catch (e) {
		if (manager.settings.DEBUG) {
			console.error(`[BPM] Failed to write plugin note for "${mp.id}"`, e);
		}
		return false;
	}
}

/**
 * 全量导出所有插件笔记。
 *
 * 只扫描一次导出目录，然后遍历所有插件逐个导出。
 */
export async function exportAllPluginNotes(
	manager: Manager,
	dirPath: string
): Promise<{ total: number; written: number; skipped: number; errors: number }> {
	const stat = { total: 0, written: 0, skipped: 0, errors: 0 };

	if (!dirPath) return stat;

	const index = await buildDirIndex(manager, dirPath);

	const plugins = manager.settings.Plugins || [];
	stat.total = plugins.length;

	for (const mp of plugins) {
		try {
			const ok = await exportPluginNote(manager, index, mp);
			if (ok) {
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
