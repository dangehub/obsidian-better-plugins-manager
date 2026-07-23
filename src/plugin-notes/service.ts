/**
 * plugin-notes/service.ts
 *
 * 服务主入口。main.ts 持有单一实例。
 * exportAll 和 exportSingle 在写入前批量解析 repo 映射。
 * repo resolver 是产品代码，出口这里只协调。
 */

import type Manager from "main";
import { buildDirIndex, ExportDirIndex, exportPluginNote, WriteHooks } from "./exporter";
import { SyncService } from "./sync";
import { isValidExportPath } from "./types";
import { normalizePath } from "obsidian";
import type { RepoResolver } from "src/repo-resolver";

export type SyncMode = "export-only" | "two-way";

export class PluginNotesService {
	private manager: Manager;
	private syncService: SyncService;
	private currentDir = "";
	private currentMode: SyncMode = "export-only";
	private started = false;
	private index: ExportDirIndex | null = null;

	constructor(manager: Manager) {
		this.manager = manager;
		this.syncService = new SyncService(manager);
	}

	/** 获取 repoResolver（main.ts 持有） */
	private get resolver(): RepoResolver | undefined {
		return this.manager.repoResolver;
	}

	start(dirPath: string, mode: SyncMode): boolean {
		if (this.started) return true;
		const dir = (dirPath || "").trim();
		if (!dir) return true;

		const validation = isValidExportPath(dir);
		if (!validation.valid) {
			if (this.manager.settings.DEBUG) {
				console.warn(`[BPM] Plugin notes export path invalid: "${dir}" — ${validation.reason}`);
			}
			return false;
		}

		this.currentDir = normalizePath(dir);
		this.currentMode = mode;
		this.started = true;

		void this.exportAll();

		if (mode === "two-way") {
			this.syncService.start(this.currentDir);
		}

		return true;
	}

	private getWriteHooks(): WriteHooks | undefined {
		if (this.currentMode === "two-way") {
			return this.syncService.writeHooks;
		}
		return undefined;
	}

	stop(): void {
		if (!this.started) return;
		this.started = false;
		this.syncService.stop();
		this.index = null;
		this.currentDir = "";
	}

	restart(dirPath: string, mode: SyncMode): boolean {
		this.stop();
		return this.start(dirPath, mode);
	}

	get isRunning(): boolean { return this.started; }

	async exportSingle(pluginId: string): Promise<boolean> {
		if (!this.started || !this.currentDir) return false;
		try {
			if (!this.index || this.index.dirPath !== this.currentDir) {
				this.index = await buildDirIndex(this.manager, this.currentDir);
			}
			const mp = this.manager.settings.Plugins.find((p) => p.id === pluginId);
			if (!mp) return false;

			// 解析当前插件的 repo（最多一次网络请求，失败不阻断导出）
			if (this.resolver) {
				try {
					await this.resolver.resolveRepos([pluginId]);
				} catch {
					// resolver 失败不阻断
				}
			}

			const result = await exportPluginNote(this.manager, this.index, mp, {
				hooks: this.getWriteHooks(),
			});
			return result.written;
		} catch (e) {
			if (this.manager.settings.DEBUG) console.error(`[BPM] exportSingle failed for "${pluginId}"`, e);
			return false;
		}
	}

	async exportAll(): Promise<void> {
		if (!this.started || !this.currentDir) return;
		this.index = await buildDirIndex(this.manager, this.currentDir);
		const plugins = this.manager.settings.Plugins || [];

		// 批量解析所有插件的 repo（最多一次网络请求、一次 settings 保存）
		if (this.resolver && plugins.length > 0) {
			try {
				await this.resolver.resolveRepos(plugins.map((p) => p.id));
			} catch {
				// 失败不阻断导出
			}
		}

		for (const mp of plugins) {
			try {
				await exportPluginNote(this.manager, this.index, mp, {
					hooks: this.getWriteHooks(),
				});
			} catch (e) {
				if (this.manager.settings.DEBUG) console.error(`[BPM] exportAll failed for "${mp.id}"`, e);
			}
		}
	}

	get dirPath(): string { return this.currentDir; }
	get syncMode(): SyncMode { return this.currentMode; }
}
