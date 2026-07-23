/**
 * plugin-notes/sync.ts
 *
 * 双向同步：
 * - per-path debounce
 * - serial queue + generation guard (stop 后不执行 pending)
 * - path+content token 自写抑制（exporter hook 接线）
 * - 严格类型：raw boolean 才 enabled 写回；string[] 全部 string 才 tags 写回
 * - BPM 自身跳过；API 失败不污染 mp.enabled
 */

import { normalizePath, TFile, EventRef } from "obsidian";
import type Manager from "main";
import { decodeNote, hasStrictBooleanEnabled, getStrictEnabledValue, strictStringArray } from "./types";
import { buildDirIndex, WriteHooks, ExportDirIndex, exportPluginNote } from "./exporter";

/** Per-path debounce map */
class DebounceMap {
	private timers = new Map<string, ReturnType<typeof setTimeout>>();

	set(path: string, fn: () => void, delay: number): void {
		this.delete(path);
		const timer = setTimeout(() => {
			this.timers.delete(path);
			fn();
		}, delay);
		this.timers.set(path, timer);
	}

	delete(path: string): void {
		const t = this.timers.get(path);
		if (t) clearTimeout(t);
		this.timers.delete(path);
	}

	clear(): void {
		this.timers.forEach((t) => clearTimeout(t));
		this.timers.clear();
	}
}

/** Serial queue with generation guard */
class SerialQueue {
	private pending: Array<() => Promise<void>> = [];
	private active = false;
	private generation = 0;
	private activePromise: Promise<void> | null = null;

	get isActive(): boolean { return this.active; }

	push(fn: () => Promise<void>): void {
		const gen = this.generation;
		this.pending.push(async () => {
			if (gen !== this.generation) return;
			await fn();
		});
		if (!this.active) void this.runNext();
	}

	private async runNext(): Promise<void> {
		if (this.pending.length === 0) {
			this.active = false;
			this.activePromise = null;
			return;
		}
		this.active = true;
		const fn = this.pending.shift()!;
		const p = fn().finally(() => {
			if (this.generation === 0) return; // stopped
			setTimeout(() => { if (this.active) void this.runNext(); }, 0);
		});
		this.activePromise = p;
		await p;
	}

	stop(): void {
		this.generation++;
		this.pending = [];
		this.active = false;
		this.activePromise = null;
	}

	async drain(): Promise<void> {
		this.pending = [];
		while (this.active && this.activePromise) {
			await Promise.race([this.activePromise, new Promise((r) => setTimeout(r, 100))]);
		}
	}
}

/** Path+content token registration */
class WriteSuppression {
	private tokens = new Map<string, string[]>();

	register(path: string, content: string): void {
		const existing = this.tokens.get(path) || [];
		existing.push(content);
		this.tokens.set(path, existing);
	}

	consume(path: string, content: string): boolean {
		const existing = this.tokens.get(path);
		if (!existing) return false;
		const idx = existing.indexOf(content);
		if (idx !== -1) {
			existing.splice(idx, 1);
			if (existing.length === 0) this.tokens.delete(path);
			return true;
		}
		return false;
	}

	/** Remove only the FIRST matching (or any) token for path */
	removeOne(path: string): void {
		const existing = this.tokens.get(path);
		if (!existing) return;
		existing.shift();
		if (existing.length === 0) this.tokens.delete(path);
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
	private debouncer = new DebounceMap();
	private isRunning = false;
	private currentDir = "";

	constructor(manager: Manager) {
		this.manager = manager;
	}

	/** Expose write hooks for exporter */
	get writeHooks(): WriteHooks {
		return {
			beforeWrite: (path: string, content: string) => {
				this.suppress.register(path, content);
			},
			writeSuccess: (_path: string) => {
				// Token consumed by modify event; if event never fires,
				// TTL cleanup handles it
			},
			writeFailure: (path: string) => {
				this.suppress.removeOne(path);
			},
		};
	}

	start(dirPath: string): void {
		if (this.isRunning) return;
		if (!dirPath) return;

		this.currentDir = normalizePath(dirPath);
		this.isRunning = true;

		this.watcherRef = this.manager.app.vault.on("modify", (file) => {
			if (!this.isRunning) return;
			if (!(file instanceof TFile)) return;
			if (!file.path.endsWith(".md")) return;

			const normalized = normalizePath(file.path);
			if (!normalized.startsWith(this.currentDir + "/") && normalized !== this.currentDir) return;

			this.debouncer.set(normalized, () => {
				if (!this.isRunning) return;
				this.queue.push(() => this.handleFileChange(normalized));
			}, 500);
		});

		if (this.watcherRef) this.manager.registerEvent(this.watcherRef);
	}

	stop(): void {
		this.isRunning = false;
		this.debouncer.clear();
		this.queue.stop();
		this.suppress.clearAll();
		if (this.watcherRef) {
			this.manager.app.vault.offref(this.watcherRef);
			this.watcherRef = null;
		}
		this.currentDir = "";
	}

	private async handleFileChange(filePath: string): Promise<void> {
		// Guard: stop was called before we execute
		if (!this.isRunning) return;

		try {
			const content = await this.manager.app.vault.adapter.read(filePath);

			// Self-write suppression
			if (this.suppress.consume(filePath, content)) return;

			const decoded = decodeNote(content);
			if (!decoded.isBpmNote || decoded.isMalformed) return;

			const id = decoded.frontmatter.bpm_ro_id;
			if (!id) return;

			const mp = this.manager.settings.Plugins.find((p) => p.id === id);
			if (!mp) return;

			// Guard: stop during IO
			if (!this.isRunning) return;

			let changed = false;
			const raw = decoded.rawValues;

			// desc (strict string)
			if (typeof raw["bpm_rw_desc"] === "string" && raw["bpm_rw_desc"] !== mp.desc) {
				mp.desc = raw["bpm_rw_desc"]; changed = true;
			}

			// note (strict string)
			if (typeof raw["bpm_rw_note"] === "string" && raw["bpm_rw_note"] !== mp.note) {
				mp.note = raw["bpm_rw_note"]; changed = true;
			}

			// group: rw_group > ro_group (legacy)
			if (typeof raw["bpm_rw_group"] === "string" && raw["bpm_rw_group"] !== mp.group) {
				mp.group = raw["bpm_rw_group"]; changed = true;
			} else if (decoded.isLegacy && typeof raw["bpm_ro_group"] === "string") {
				const roG = raw["bpm_ro_group"] as string;
				if (roG !== mp.group) { mp.group = roG; changed = true; }
			}

			// tags: strict string[] only — every element must be string
			const rwTags = strictStringArray(raw["bpm_rw_tags"]);
			if (rwTags.valid) {
				if (!arraysEqual(rwTags.items, mp.tags || [])) {
					mp.tags = rwTags.items; changed = true;
				}
			} else if (decoded.isLegacy) {
				const roTags = strictStringArray(raw["bpm_ro_tags"]);
				if (roTags.valid && !arraysEqual(roTags.items, mp.tags || [])) {
					mp.tags = roTags.items; changed = true;
				}
			}

			// repo (conditional)
			if (typeof raw["bpm_rwc_repo"] === "string" && raw["bpm_rwc_repo"].length > 0 &&
				!this.manager.settings.BPM_INSTALLED?.includes(id) &&
				!this.manager.settings.REPO_MAP?.[id]) {
				this.manager.settings.REPO_MAP[id] = raw["bpm_rwc_repo"] as string;
				changed = true;
			}

			// enabled (strict boolean + switch)
			if (this.manager.settings.PLUGIN_NOTES_ALLOW_ENABLED_WRITE && id !== this.manager.manifest.id) {
				if (hasStrictBooleanEnabled(raw)) {
					const targetEnabled = getStrictEnabledValue(raw)!;
					if (targetEnabled !== mp.enabled) {
						const isCurrentlyEnabled = this.manager.appPlugins.enabledPlugins.has(id);
						if (targetEnabled !== isCurrentlyEnabled) {
							try {
								if (targetEnabled) {
									await this.manager.appPlugins.enablePluginAndSave(id);
								} else {
									await this.manager.appPlugins.disablePluginAndSave(id);
								}
								mp.enabled = targetEnabled;
								changed = true;
							} catch (e) {
								console.error(`[BPM] Plugin toggle failed for "${id}"`, e);
								// API failed — don't update mp.enabled
							}
						} else {
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
}

function arraysEqual(a: string[], b: string[]): boolean {
	if (a.length !== b.length) return false;
	for (let i = 0; i < a.length; i++) {
		if (a[i] !== b[i]) return false;
	}
	return true;
}
