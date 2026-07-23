/**
 * plugin-notes/service.ts
 *
 * 插件笔记导出服务的主入口。
 *
 * main.ts 持有单一实例，通过 start/stop/restart 管理生命周期：
 * - start(dirPath, syncMode): 启动导出服务，可选开启双向同步。
 * - stop(): 清理 watcher/定时器/队列。
 * - restart(): 在设置目录或同步模式变化时安全重启。
 * - exportSingle(pluginId): 导出单个插件，供 savePluginAndExport 委托。
 * - exportAll(): 全量导出所有插件。
 */

import type Manager from "main";
import { buildDirIndex, ExportDirIndex, exportPluginNote, exportAllPluginNotes } from "./exporter";
import { SyncService } from "./sync";
import { normalizePath } from "obsidian";

export type SyncMode = "export-only" | "two-way";

/**
 * 插件笔记导出服务。
 */
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

	/**
	 * 启动服务。
	 *
	 * @param dirPath - 导出目录（相对 vault 路径），空字符串表示不启动。
	 * @param mode - 同步模式。
	 */
	start(dirPath: string, mode: SyncMode): void {
		if (this.started) return;
		const dir = (dirPath || "").trim();
		if (!dir) return;

		this.currentDir = normalizePath(dir);
		this.currentMode = mode;
		this.started = true;

		// 启动时全量导出一次
		void this.exportAll();

		// 如果启用双向同步，启动 watcher
		if (mode === "two-way") {
			this.syncService.start(this.currentDir);
		}
	}

	/**
	 * 停止服务。
	 */
	stop(): void {
		if (!this.started) return;
		this.started = false;
		this.syncService.stop();
		this.index = null;
	}

	/**
	 * 重启服务（设置变更时调用）。
	 */
	restart(dirPath: string, mode: SyncMode): void {
		this.stop();
		this.start(dirPath, mode);
	}

	/**
	 * 是否正在运行。
	 */
	get isRunning(): boolean {
		return this.started;
	}

	/**
	 * 导出单个插件。
	 *
	 * 供 main.ts 中 savePluginAndExport() 委托调用。
	 * 导出失败不会抛出异常，仅记录日志并返回 false。
	 */
	async exportSingle(pluginId: string): Promise<boolean> {
		if (!this.started || !this.currentDir) return false;

		try {
			// 确保索引有效
			if (!this.index || this.index.dirPath !== this.currentDir) {
				this.index = await buildDirIndex(this.manager, this.currentDir);
			}

			const mp = this.manager.settings.Plugins.find((p) => p.id === pluginId);
			if (!mp) return false;

			this.syncService.setWriting(true);
			try {
				return await exportPluginNote(this.manager, this.index, mp);
			} finally {
				this.syncService.setWriting(false);
			}
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

		this.syncService.setWriting(true);
		try {
			// 重新构建索引
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
		} finally {
			this.syncService.setWriting(false);
		}
	}

	/**
	 * 获取当前导出目录。
	 */
	get dirPath(): string {
		return this.currentDir;
	}

	/**
	 * 获取当前同步模式。
	 */
	get syncMode(): SyncMode {
		return this.currentMode;
	}
}
