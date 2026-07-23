/**
 * plugin-notes/sync.ts
 *
 * 双向同步：
 * - per-path debounce
 * - serial queue + correct pump (no generation=0 guard bug)
 * - SyncService-level generation guard (stop blocks all side effects)
 * - compute-diff-first, then apply atomically with guards
 * - path+content token with TTL timer
 * - strict type checks
 */

import { normalizePath, TFile, EventRef } from "obsidian";
import type Manager from "main";
import { decodeNote, hasStrictBooleanEnabled, getStrictEnabledValue, strictStringArray } from "./types";
import type { WriteHooks } from "./exporter";

/** Per-path debounce map */
class DebounceMap {
	private timers = new Map<string, ReturnType<typeof setTimeout>>();
	set(path: string, fn: () => void, delay: number): void {
		this.delete(path);
		const timer = setTimeout(() => { this.timers.delete(path); fn(); }, delay);
		this.timers.set(path, timer);
	}
	delete(path: string): void { const t = this.timers.get(path); if (t) clearTimeout(t); this.timers.delete(path); }
	clear(): void { this.timers.forEach((t) => clearTimeout(t)); this.timers.clear(); }
}

/** Serial queue: correct pump, no generation-0 false stop */
class SerialQueue {
	private pending: Array<() => Promise<void>> = [];
	private running = false;
	private stopped = false;
	private activePromise: Promise<void> | null = null;

	get isActive(): boolean { return this.running; }

	push(fn: () => Promise<void>): void {
		if (this.stopped) return;
		const guard = () => this.stopped;
		this.pending.push(async () => { if (guard()) return; await fn(); });
		if (!this.running) void this.pump();
	}

	private async pump(): Promise<void> {
		this.running = true;
		while (this.pending.length > 0 && !this.stopped) {
			const fn = this.pending.shift()!;
			const p = fn().finally(() => {});
			this.activePromise = p;
			await p;
		}
		this.running = false;
		this.activePromise = null;
	}

	stop(): void {
		this.stopped = true;
		this.pending = [];
		this.activePromise = null;
	}

	/** After stop+restart, reset flag */
	reset(): void { this.stopped = false; }

	async drain(): Promise<void> {
		this.pending = [];
		while (this.running && this.activePromise) {
			await Promise.race([this.activePromise, new Promise((r) => setTimeout(r, 100))]);
		}
	}
}

/** Token with TTL timer */
interface SuppressToken {
	id: string;
	path: string;
	content: string;
	timer: ReturnType<typeof setTimeout>;
}

class WriteSuppression {
	private tokens: SuppressToken[] = [];
	private nextId = 0;
	private ttlMs = 30000; // 30s TTL

	register(path: string, content: string): string {
		const id = `tok-${++this.nextId}`;
		const timer = setTimeout(() => {
			this.removeExact(id);
		}, this.ttlMs);
		this.tokens.push({ id, path, content, timer });
		return id;
	}

	consume(path: string, content: string): boolean {
		const idx = this.tokens.findIndex((t) => t.path === path && t.content === content);
		if (idx === -1) return false;
		const [tok] = this.tokens.splice(idx, 1);
		clearTimeout(tok.timer);
		return true;
	}

	/** Remove exact token by id (writeFailure uses this) */
	removeExact(id: string): void {
		const idx = this.tokens.findIndex((t) => t.id === id);
		if (idx !== -1) {
			const [tok] = this.tokens.splice(idx, 1);
			clearTimeout(tok.timer);
		}
	}

	/** Remove all tokens for path (writeFailure cleanup) */
	removePath(path: string): void {
		const remaining: SuppressToken[] = [];
		for (const t of this.tokens) {
			if (t.path === path) clearTimeout(t.timer);
			else remaining.push(t);
		}
		this.tokens = remaining;
	}

	clearAll(): void {
		this.tokens.forEach((t) => clearTimeout(t.timer));
		this.tokens = [];
	}
}

/** Computed patch for safe application */
interface SyncPatch {
	changed: boolean;
	mp?: { desc?: string; note?: string; enabled?: boolean; group?: string; tags?: string[] };
	repoMap?: { id: string; repo: string };
	needsPluginToggle?: { id: string; enable: boolean };
}

export class SyncService {
	private manager: Manager;
	private watcherRef: EventRef | null = null;
	private suppress = new WriteSuppression();
	private queue = new SerialQueue();
	private debouncer = new DebounceMap();
	private isRunning = false;
	private currentDir = "";
	private generation = 0;

	constructor(manager: Manager) { this.manager = manager; }

	/** Write hooks with token id tracking */
	get writeHooks(): WriteHooks {
		const svc = this;
		return {
			beforeWrite: (path: string, content: string) => {
				return svc.suppress.register(path, content);
			},
			writeSuccess: (_path: string, _tokenId?: string) => {
				// Token consumed by modify event; TTL cleans up if not consumed
			},
			writeFailure: (_path: string, tokenId?: string) => {
				if (tokenId) svc.suppress.removeExact(tokenId);
				else svc.suppress.removePath(_path);
			},
		};
	}

	start(dirPath: string): void {
		if (this.isRunning) return;
		if (!dirPath) return;
		this.currentDir = normalizePath(dirPath);
		this.isRunning = true;
		this.generation++;
		this.queue.reset();

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
		this.generation++;
		this.debouncer.clear();
		this.queue.stop();
		this.suppress.clearAll();
		if (this.watcherRef) { this.manager.app.vault.offref(this.watcherRef); this.watcherRef = null; }
		this.currentDir = "";
	}

	private async handleFileChange(filePath: string): Promise<void> {
		const gen = this.generation;

		// Guard: stopped before execution
		if (gen !== this.generation || !this.isRunning) return;

		try {
			const content = await this.manager.app.vault.adapter.read(filePath);
			if (this.suppress.consume(filePath, content)) return;

			const decoded = decodeNote(content);
			if (!decoded.isBpmNote || decoded.isMalformed) return;
			const id = decoded.frontmatter.bpm_ro_id;
			if (!id) return;

			const mp = this.manager.settings.Plugins.find((p) => p.id === id);
			if (!mp) return;

			// Guard: stopped during IO (read)
			if (gen !== this.generation || !this.isRunning) return;

			// ---- Compute diff only (no state mutation) ----
			const patch: SyncPatch = { changed: false, mp: {} };
			const raw = decoded.rawValues;

			if (typeof raw["bpm_rw_desc"] === "string" && raw["bpm_rw_desc"] !== mp.desc) {
				patch.mp!.desc = raw["bpm_rw_desc"] as string; patch.changed = true;
			}
			if (typeof raw["bpm_rw_note"] === "string" && raw["bpm_rw_note"] !== mp.note) {
				patch.mp!.note = raw["bpm_rw_note"] as string; patch.changed = true;
			}
			if (typeof raw["bpm_rw_group"] === "string") {
				if (raw["bpm_rw_group"] !== mp.group) { patch.mp!.group = raw["bpm_rw_group"] as string; patch.changed = true; }
			} else if (decoded.isLegacy && typeof raw["bpm_ro_group"] === "string") {
				if (raw["bpm_ro_group"] !== mp.group) { patch.mp!.group = raw["bpm_ro_group"] as string; patch.changed = true; }
			}
			const rwTags = strictStringArray(raw["bpm_rw_tags"]);
			if (rwTags.valid && !arraysEqual(rwTags.items, mp.tags || [])) {
				patch.mp!.tags = rwTags.items; patch.changed = true;
			} else if (decoded.isLegacy) {
				const roTags = strictStringArray(raw["bpm_ro_tags"]);
				if (roTags.valid && !arraysEqual(roTags.items, mp.tags || [])) {
					patch.mp!.tags = roTags.items; patch.changed = true;
				}
			}
			if (typeof raw["bpm_rwc_repo"] === "string" && raw["bpm_rwc_repo"].length > 0 &&
				!this.manager.settings.BPM_INSTALLED?.includes(id) &&
				!this.manager.settings.REPO_MAP?.[id]) {
				patch.repoMap = { id, repo: raw["bpm_rwc_repo"] as string }; patch.changed = true;
			}

			// enabled: compute what API should be called
			if (this.manager.settings.PLUGIN_NOTES_ALLOW_ENABLED_WRITE && id !== this.manager.manifest.id) {
				if (hasStrictBooleanEnabled(raw)) {
					const targetEnabled = getStrictEnabledValue(raw)!;
					if (targetEnabled !== mp.enabled) {
						const isCurrentlyEnabled = this.manager.appPlugins.enabledPlugins.has(id);
						if (targetEnabled !== isCurrentlyEnabled) {
							patch.needsPluginToggle = { id, enable: targetEnabled };
						}
						patch.mp!.enabled = targetEnabled;
						patch.changed = true;
					}
				}
			}

			if (!patch.changed) return;

			// Guard before applying any side effect
			if (gen !== this.generation || !this.isRunning) return;

			// ---- Apply patch atomically ----
			// Plugin toggle (API call) — cannot be cancelled once started
			if (patch.needsPluginToggle) {
				try {
					const { id: toggleId, enable } = patch.needsPluginToggle;
					if (enable) {
						await this.manager.appPlugins.enablePluginAndSave(toggleId);
					} else {
						await this.manager.appPlugins.disablePluginAndSave(toggleId);
					}
				} catch (e) {
					console.error(`[BPM] Plugin toggle failed for "${patch.needsPluginToggle.id}"`, e);
					// API failed — don't apply mp.enabled change
					delete patch.mp!.enabled;
				}
			}

			// Guard after API call (might have been stopped during async)
			if (gen !== this.generation || !this.isRunning) return;

			// Apply remaining mp changes
			const targetMp = this.manager.settings.Plugins.find((p) => p.id === id);
			if (!targetMp) return;
			const p = patch.mp!;
			if (p.desc !== undefined) targetMp.desc = p.desc;
			if (p.note !== undefined) targetMp.note = p.note;
			if (p.group !== undefined) targetMp.group = p.group;
			if (p.tags !== undefined) targetMp.tags = p.tags;
			if (p.enabled !== undefined) targetMp.enabled = p.enabled;

			if (patch.repoMap) {
				this.manager.settings.REPO_MAP[patch.repoMap.id] = patch.repoMap.repo;
			}

			await this.manager.saveSettings();
		} catch (e) {
			if (this.manager.settings.DEBUG) console.error("[BPM] Sync handleFileChange failed", e);
		}
	}
}

function arraysEqual(a: string[], b: string[]): boolean {
	if (a.length !== b.length) return false;
	for (let i = 0; i < a.length; i++) { if (a[i] !== b[i]) return false; }
	return true;
}
