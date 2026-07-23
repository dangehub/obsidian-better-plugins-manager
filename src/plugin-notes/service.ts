/**
 * plugin-notes/service.ts
 *
 * 插件笔记导出服务主入口。
 * main.ts 持有单一实例，通过 start/stop/restart 管理生命周期。
 * 仅 service 是导出入口（无第二套导出流程）。
 */

import type Manager from "main";
import { buildDirIndex, ExportDirIndex, exportPluginNote, exportAllPluginNotes } from "./exporter";
import { SyncService } from "./sync";
import { isValidExportPath, safeFileName } from "./types";
import { normalizePath } from "obsidian";

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

	start(dirPath: string, mode: SyncMode): boolean {
		if (this.started) return true;
		const dir = (dirPath || "").trim();

		// 空目录 = 关闭，安静返回
		if (!dir) return true;

		// 路径验证
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

		// 启动时全量导出
		void this.exportAll();

		// 双向同步开启 watcher
		if (mode === "two-way") {
			this.syncService.start(this.currentDir);
		}

		return true;
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

	get isRunning(): boolean {
		return this.started;
	}

	/**
	 * 导出单个插件（委托给 exporter，使用自写抑制）。
	 */
	async exportSingle(pluginId: string): Promise<boolean> {
		if (!this.started || !this.currentDir) return false;

		try {
			if (!this.index || this.index.dirPath !== this.currentDir) {
				this.index = await buildDirIndex(this.manager, this.currentDir);
			}

			const mp = this.manager.settings.Plugins.find((p) => p.id === pluginId);
			if (!mp) return false;

			const result = await exportPluginNote(this.manager, this.index, mp);
			return result.written;
		} catch (e) {
			if (this.manager.settings.DEBUG) {
				console.error(`[BPM] exportSingle failed for "${pluginId}"`, e);
			}
			return false;
		}
	}

	/**
	 * 全量导出所有插件笔记。
	 */
	async exportAll(): Promise<void> {
		if (!this.started || !this.currentDir) return;

		this.index = await buildDirIndex(this.manager, this.currentDir);

		const plugins = this.manager.settings.Plugins || [];
		for (const mp of plugins) {
			try {
				await exportPluginNote(this.manager, this.index, mp);
			} catch (e) {
				if (this.manager.settings.DEBUG) {
					console.error(`[BPM] exportAll failed for "${mp.id}"`, e);
				}
			}
		}
	}

	get dirPath(): string {
		return this.currentDir;
	}

	get syncMode(): SyncMode {
		return this.currentMode;
	}
}
