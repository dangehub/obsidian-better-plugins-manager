/**
 * plugin-notes/sync.ts
 *
 * 双向同步模块：
 * - per-path debounce（不丢文件）
 * - 串行队列 + generation guard（stop 后无副作用）
 * - path+content token 自写抑制（无竞态）
 * - 严格类型校验：只有原始 YAML 值为 boolean 才允许 enabled 写回
 * - BPM 自身始终跳过 enabled 写回
 * - 原子 enabled 写回：API 失败后回滚 mp.enabled
 */

import { normalizePath, TFile, EventRef } from "obsidian";
import type Manager from "main";
import { decodeNote, hasStrictBooleanEnabled, getStrictEnabledValue } from "./types";
import { buildDirIndex, exportPluginNote } from "./exporter";

/** per-path debounce */
function createDebouncedMap(): {
	get: (path: string) => void;
	set: (path: string, fn: () => void, delay: number) => void;
	delete: (path: string) => void;
	clear: () => void;
} {
	const timers = new Map<string, ReturnType<typeof setTimeout>>();
	return {
		get: (_path: string) => { /* existence check not needed externally */ },
		set: (path: string, fn: () => void, delay: number) => {
			const existing = timers.get(path);
			if (existing) clearTimeout(existing);
			const timer = setTimeout(() => {
				timers.delete(path);
				fn();
			}, delay);
			timers.set(path, timer);
		},
		delete: (path: string) => {
			const t = timers.get(path);
			if (t) clearTimeout(t);
			timers.delete(path);
		},
		clear: () => {
			timers.forEach((t) => clearTimeout(t));
			timers.clear();
		},
	};
}

/** 串行任务队列 */
class SerialQueue {
	private pending: Array<() => Promise<void>> = [];
	private running = false;
	private generation = 0;

	push(fn: () => Promise<void>): number {
		const gen = this.generation;
		this.pending.push(async () => {
			if (gen !== this.generation) return; // stop 后跳过
			await fn();
		});
		if (!this.running) {
			void this.runNext();
		}
		return gen;
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
		setTimeout(() => void this.runNext(), 0);
	}

	/** 停止所有任务，不再执行任何 pending 或 future 任务 */
	stop(): void {
		this.generation++;
		this.pending = [];
		this.running = false;
	}

	async drain(): Promise<void> {
		this.pending = [];
		while (this.running) {
			await new Promise((resolve) => setTimeout(resolve, 10));
		}
	}
}

/**
 * 自写抑制：基于 path+content token。
 * adapter.write 前登记 path → content，modify 时如果内容完全匹配则消费跳过。
 */
class WriteSuppression {
	private tokens = new Map<string, string[]>();

	/** 登记即将写入的 path 和内容 */
	register(path: string, content: string): void {
		const existing = this.tokens.get(path) || [];
		existing.push(content);
		this.tokens.set(path, existing);
	}

	/** 消费 token：检查 path 的内容是否匹配某个登记值，匹配则移除并返回 true */
	consume(path: string, content: string): boolean {
		const existing = this.tokens.get(path);
		if (!existing) return false;
		const idx = existing.indexOf(content);
		if (idx !== -1) {
			existing.splice(idx, 1);
			if (existing.length === 0) this.tokens.delete(path);
			return true;
		}
		// 清理所有过时的 token
		this.tokens.delete(path);
		return false;
	}

	/** 清除某个 path 的全部 token（写入失败时调用） */
	clear(path: string): void {
		this.tokens.delete(path);
	}

	clearAll(): void {
		this.tokens.clear();
	}
}

export class SyncService {
	private manager: Manager;
	private watcherRef: EventRef | null = null;
	private suppress = new WriteSuppression();
	private queue = new SerialQueue();
	private debouncer = createDebouncedMap();
	private isRunning = false;
	private currentDir = "";

	constructor(manager: Manager) {
		this.manager = manager;
	}

	start(dirPath: string): void {
		if (this.isRunning) return;
		if (!dirPath) return;

		this.currentDir = normalizePath(dirPath);
		this.isRunning = true;

		this.watcherRef = this.manager.app.vault.on(
			"modify",
			(file) => {
				if (!this.isRunning) return;
				if (!(file instanceof TFile)) return;
				if (!file.path.endsWith(".md")) return;

				const normalized = normalizePath(file.path);
				if (!normalized.startsWith(this.currentDir + "/") && normalized !== this.currentDir) return;

				// per-path debounce
				this.debouncer.set(normalized, () => {
					if (!this.isRunning) return;
					this.queue.push(() => this.handleFileChange(normalized));
				}, 500);
			}
		);

		if (this.watcherRef) {
			this.manager.registerEvent(this.watcherRef);
		}
	}

	stop(): void {
		this.isRunning = false;
		this.debouncer.clear();
		this.queue.stop(); // 停止所有待执行任务
		this.suppress.clearAll();

		if (this.watcherRef) {
			this.manager.app.vault.offref(this.watcherRef);
			this.watcherRef = null;
		}

		this.currentDir = "";
	}

	setSuppress(path: string, content: string): void {
		this.suppress.register(path, content);
	}

	clearSuppress(): void {
		this.suppress.clearAll();
	}

	private async handleFileChange(filePath: string): Promise<void> {
		if (!this.isRunning) return;

		try {
			const content = await this.manager.app.vault.adapter.read(filePath);

			// 自写抑制
			if (this.suppress.consume(filePath, content)) return;

			const decoded = decodeNote(content);

			// 跳过非 BPM 笔记
			if (!decoded.isBpmNote || decoded.isMalformed) return;

			const id = decoded.frontmatter.bpm_ro_id;
			if (!id) return;

			const mp = this.manager.settings.Plugins.find((p) => p.id === id);
			if (!mp) return;

			let changed = false;

			// --- 受控写回（使用原始 rawValues 做严格类型校验） ---
			const raw = decoded.rawValues;

			// desc：只接受 string
			if (typeof raw["bpm_rw_desc"] === "string" && raw["bpm_rw_desc"] !== mp.desc) {
				mp.desc = raw["bpm_rw_desc"] as string;
				changed = true;
			}

			// note：只接受 string
			if (typeof raw["bpm_rw_note"] === "string" && raw["bpm_rw_note"] !== mp.note) {
				mp.note = raw["bpm_rw_note"] as string;
				changed = true;
			}

			// group：优先 bpm_rw_group（string），兼容 bpm_ro_group
			const rwGroup = raw["bpm_rw_group"];
			if (typeof rwGroup === "string" && rwGroup !== mp.group) {
				mp.group = rwGroup;
				changed = true;
			} else if (typeof rwGroup !== "string" && decoded.isLegacy) {
				// 旧笔记：写回 ro_group
				const roGroup = raw["bpm_ro_group"];
				if (typeof roGroup === "string" && roGroup !== mp.group) {
					mp.group = roGroup;
					changed = true;
				}
			}

			// tags：优先 bpm_rw_tags（string[]），兼容 bpm_ro_tags
			const rwTags = raw["bpm_rw_tags"];
			const roTags = raw["bpm_ro_tags"];
			const tagsSource = Array.isArray(rwTags) ? rwTags : (decoded.isLegacy && Array.isArray(roTags) ? roTags : null);
			if (Array.isArray(tagsSource)) {
				const newTags = tagsSource.map(String).filter(Boolean);
				const oldTags = mp.tags || [];
				if (newTags.length !== oldTags.length || !newTags.every((t, i) => t === oldTags[i])) {
					mp.tags = newTags;
					changed = true;
				}
			}

			// 条件可写 repo
			const repo = raw["bpm_rwc_repo"];
			const allowRepo =
				typeof repo === "string" &&
				repo.length > 0 &&
				!this.manager.settings.BPM_INSTALLED?.includes(id) &&
				!this.manager.settings.REPO_MAP?.[id];
			if (allowRepo) {
				this.manager.settings.REPO_MAP[id] = repo;
				changed = true;
			}

			// enabled 写回（需额外开关 + 严格 boolean）
			if (this.manager.settings.PLUGIN_NOTES_ALLOW_ENABLED_WRITE) {
				if (id === this.manager.manifest.id) {
					// BPM 自身不可禁用
					if (hasStrictBooleanEnabled(raw) && getStrictEnabledValue(raw) === false) {
						if (this.manager.settings.DEBUG) {
							console.warn("[BPM] Cannot disable BPM itself from notes.");
						}
					}
				} else if (hasStrictBooleanEnabled(raw)) {
					const targetEnabled = getStrictEnabledValue(raw)!;
					if (targetEnabled !== mp.enabled) {
						// 先尝试 API，成功后更新 mp.enabled
						const isCurrentlyEnabled = this.manager.appPlugins.enabledPlugins.has(id);
						if (targetEnabled !== isCurrentlyEnabled) {
							try {
								if (targetEnabled) {
									await this.manager.appPlugins.enablePluginAndSave(id);
								} else {
									await this.manager.appPlugins.disablePluginAndSave(id);
								}
								// API 成功后才更新记录
								mp.enabled = targetEnabled;
								changed = true;
							} catch (e) {
								// API 失败，不更新 mp.enabled
								console.error(`[BPM] Failed to toggle plugin "${id}" from note`, e);
							}
						} else {
							// 虽然 API 状态一致但记录不同步
							mp.enabled = targetEnabled;
							changed = true;
						}
					}
				}
			}

			if (changed) {
				await this.manager.saveSettings();
			}
		} catch (e) {
			if (this.manager.settings.DEBUG) {
				console.error("[BPM] Sync handleFileChange failed", e);
			}
		}
	}

	/**
	 * 使用自写抑制包装的导出。
	 */
	async exportWithSuppress(
		manager: Manager,
		index: import("./exporter").ExportDirIndex,
		mp: import("src/data/types").ManagerPlugin
	): Promise<boolean> {
		const result = await exportPluginNote(manager, index, mp);
		return result.written;
	}
}
