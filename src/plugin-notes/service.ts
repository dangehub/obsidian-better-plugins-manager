/**
 * plugin-notes/service.ts
 *
 * 服务主入口。main.ts 持有单一实例。
 * 在 two-way 模式下将 write hooks 传给 exporter 以实现自写抑制。
 * 仅此 service 为导出入口。
 */

import type Manager from "main";
import { buildDirIndex, ExportDirIndex, exportPluginNote, WriteHooks } from "./exporter";
import { SyncService } from "./sync";
import { isValidExportPath } from "./types";
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

	/** Expose write hooks for sync service */
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
