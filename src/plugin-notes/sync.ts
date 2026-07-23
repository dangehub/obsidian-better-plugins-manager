/**
 * plugin-notes/sync.ts
 *
 * 双向同步模块：
 * - 文件修改监听（debounce）
 * - 串行处理队列
 * - 自写事件抑制
 * - frontmatter 解析回写 BPM 设置
 *
 * 设计要点：
 * - 只监听配置目录（PLUGIN_NOTES_EXPORT_DIR）内 .md 文件。
 * - 使用 serial queue 确保一次只处理一个文件，不会并发冲突。
 * - 通过 exportWriting 标志抑制自身写入导致的事件循环。
 * - 只写回受控元数据（desc/note/group/tags），enabled 写回需要额外开关。
 * - 严格类型校验：布尔字段只接受 `typeof === "boolean"`。
 */

import { normalizePath, TFile, EventRef } from "obsidian";
import type Manager from "main";
import { decodeNote, safeBoolean, safeString } from "./types";
import { buildDirIndex, exportPluginNote, buildPluginFrontmatter } from "./exporter";

/** 串行任务队列 */
class SerialQueue {
	private pending: Array<() => Promise<void>> = [];
	private running = false;

	/** 入队一个异步任务，保证按 FIFO 顺序串行执行。 */
	push(fn: () => Promise<void>): void {
		this.pending.push(fn);
		if (!this.running) {
			void this.runNext();
		}
	}

	private async runNext(): Promise<void> {
		if (this.pending.length === 0) {
			this.running = false;
			return;
		}
		this.running = true;
		const fn = this.pending.shift()!;
		try {
			await fn();
		} catch (e) {
			console.error("[BPM] Sync queue task failed", e);
		}
		// 使用微任务或 setTimeout 避免递归栈溢出
		setTimeout(() => void this.runNext(), 0);
	}

	/** 清空并等待当前任务完成。 */
	async drain(): Promise<void> {
		this.pending = [];
		while (this.running) {
			await new Promise((resolve) => setTimeout(resolve, 10));
		}
	}
}

/** 简易 debounce */
function debounce<T extends (...args: unknown[]) => void>(
	fn: T,
	delay: number
): { (...args: Parameters<T>): void; cancel: () => void } {
	let timer: ReturnType<typeof setTimeout> | null = null;
	const debounced = (...args: Parameters<T>) => {
		if (timer) clearTimeout(timer);
		timer = setTimeout(() => {
			fn(...args);
			timer = null;
		}, delay);
	};
	debounced.cancel = () => {
		if (timer) {
			clearTimeout(timer);
			timer = null;
		}
	};
	return debounced;
}

/**
 * 双向同步服务。
 *
 * 生命周期由 PluginNotesService 调用 start/stop。
 */
export class SyncService {
	private manager: Manager;
	private watcherRef: EventRef | null = null;
	private writing = false;
	private queue = new SerialQueue();
	private debouncedHandler: ReturnType<typeof debounce> | null = null;
	private isRunning = false;

	constructor(manager: Manager) {
		this.manager = manager;
	}

	/**
	 * 开始监听导出目录。
	 */
	start(dirPath: string): void {
		if (this.isRunning) return;
		if (!dirPath) return;

		this.isRunning = true;

		// debounce handler — 快速连续修改只触发一次处理
		this.debouncedHandler = debounce((file: TFile) => {
			if (!this.isRunning) return;
			this.queue.push(() => this.handleFileChange(file));
		}, 500);

		this.watcherRef = this.manager.app.vault.on(
			"modify",
			(file) => {
				if (!this.isRunning) return;
				if (this.writing) return; // 自写抑制
				if (!(file instanceof TFile)) return;
				if (!file.path.endsWith(".md")) return;

				const normalized = normalizePath(file.path);
				const dir = normalizePath(dirPath);
				if (!normalized.startsWith(dir + "/") && normalized !== dir) return;

				this.debouncedHandler?.(file);
			}
		);

		if (this.watcherRef) {
			this.manager.registerEvent(this.watcherRef);
		}
	}

	/**
	 * 停止监听、取消 pending 任务。
	 */
	stop(): void {
		this.isRunning = false;

		if (this.debouncedHandler) {
			this.debouncedHandler.cancel();
			this.debouncedHandler = null;
		}

		if (this.watcherRef) {
			this.manager.app.vault.offref(this.watcherRef);
			this.watcherRef = null;
		}

		// 清空队列
		void this.queue.drain();
	}

	/**
	 * 设置写标志，用于在导出时抑制自身事件。
	 */
	setWriting(w: boolean): void {
		this.writing = w;
	}

	/**
	 * 处理单个文件的变更。
	 *
	 * 流程：
	 * 1. 读取文件内容，解析 frontmatter
	 * 2. 通过 bpm_ro_id 找到对应 ManagerPlugin
	 * 3. 按配置写回受控字段
	 */
	private async handleFileChange(file: TFile): Promise<void> {
		if (this.writing) return;
		if (this.manager.settings.PLUGIN_NOTES_SYNC_MODE !== "two-way") return;

		try {
			const content = await this.manager.app.vault.read(file);
			const decoded = decodeNote(content);
			const fm = decoded.frontmatter;
			const id = fm.bpm_ro_id;

			if (!id) return;

			const mp = this.manager.settings.Plugins.find((p) => p.id === id);
			if (!mp) return;

			let changed = false;

			// 受控写回：desc / note
			const newDesc = safeString(fm.bpm_rw_desc);
			if (newDesc !== mp.desc) {
				mp.desc = newDesc;
				changed = true;
			}

			const newNote = safeString(fm.bpm_rw_note);
			if (newNote !== mp.note) {
				mp.note = newNote;
				changed = true;
			}

			// 受控写回：group / tags（来自 bpm_ro_ 只读字段——用户编辑笔记后这些也会变）
			const newGroup = safeString(fm.bpm_ro_group);
			if (newGroup !== mp.group) {
				mp.group = newGroup;
				changed = true;
			}

			if (Array.isArray(fm.bpm_ro_tags)) {
				const newTags = fm.bpm_ro_tags.map(String).filter(Boolean);
				const oldTags = mp.tags || [];
				if (
					newTags.length !== oldTags.length ||
					!newTags.every((t, i) => t === oldTags[i])
				) {
					mp.tags = newTags;
					changed = true;
				}
			}

			// 条件可写 repo
			const repo = safeString(fm.bpm_rwc_repo);
			const allowRepo =
				!this.manager.settings.BPM_INSTALLED?.includes(id) &&
				!this.manager.settings.REPO_MAP?.[id];
			if (repo && allowRepo) {
				this.manager.settings.REPO_MAP[id] = repo;
				changed = true;
			}

			// enabled 写回（需额外开关，默认关闭）
			if (this.manager.settings.PLUGIN_NOTES_ALLOW_ENABLED_WRITE) {
				if (typeof fm.bpm_rw_enabled === "boolean") {
					const targetEnabled = fm.bpm_rw_enabled as boolean;
					if (id !== this.manager.manifest.id && targetEnabled !== mp.enabled) {
						mp.enabled = targetEnabled;
						changed = true;

						try {
							const isCurrentlyEnabled =
								this.manager.appPlugins.enabledPlugins.has(id);
							if (targetEnabled !== isCurrentlyEnabled) {
								if (targetEnabled) {
									await this.manager.appPlugins.enablePluginAndSave(id);
								} else {
									await this.manager.appPlugins.disablePluginAndSave(id);
								}
							}
						} catch (e) {
							console.error(
								`[BPM] Failed to toggle plugin "${id}" from note`,
								e
							);
						}
					}
				}
			}

			if (changed) {
				await this.manager.saveSettings();
			}
		} catch (e) {
			if (this.manager.settings.DEBUG) {
				console.error("[BPM] Failed to handle exported file change", e);
			}
		}
	}

	/**
	 * 重新同步导出（由自写抑制机制包装，不触发自身监听）。
	 */
	async reExportPlugin(manager: Manager, index: import("./exporter").ExportDirIndex, mp: import("src/data/types").ManagerPlugin): Promise<boolean> {
		this.writing = true;
		try {
			return await exportPluginNote(manager, index, mp);
		} finally {
			this.writing = false;
		}
	}

	/**
	 * 全量重新导出（由自写抑制机制包装）。
	 */
	async reExportAll(manager: Manager, dirPath: string): Promise<void> {
		this.writing = true;
		try {
			const { buildDirIndex, exportPluginNote } = await import("./exporter.js");
			const index = await buildDirIndex(manager, dirPath);
			const plugins = manager.settings.Plugins || [];
			for (const mp of plugins) {
				try {
					await exportPluginNote(manager, index, mp);
				} catch (e) {
					if (manager.settings.DEBUG) {
						console.error(`[BPM] reExportAll failed for "${mp.id}"`, e);
					}
				}
			}
		} finally {
			this.writing = false;
		}
	}
}
