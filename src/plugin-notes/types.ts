/**
 * plugin-notes/types.ts
 *
 * BPM 插件笔记导出模块的数据模型和 frontmatter 编解码器。
 * 纯函数设计，不依赖 Obsidian API（除 stringifyYaml/parseYaml）。
 */

import { stringifyYaml, parseYaml } from "obsidian";

export const CURRENT_SCHEMA_VERSION = 1;

export const BPM_PREFIX = "bpm_";

const BPM_RO_FIELDS = new Set([
	"bpm_ro_id", "bpm_ro_name", "bpm_ro_group", "bpm_ro_tags",
	"bpm_ro_delay", "bpm_ro_installed_via_bpm",
	"bpm_schema_version", "bpm_version", "bpm_author", "bpm_id",
]);

export function isBpmReadonlyField(key: string): boolean {
	return BPM_RO_FIELDS.has(key);
}

export interface PluginNoteFrontmatter {
	bpm_ro_id: string;
	bpm_ro_name: string;
	bpm_ro_group: string;
	bpm_ro_tags: string[];
	bpm_ro_delay: string;
	bpm_ro_installed_via_bpm: boolean;
	bpm_rw_desc: string;
	bpm_rw_note: string;
	bpm_rw_enabled: boolean;
	bpm_rw_group: string;
	bpm_rw_tags: string[];
	bpm_rwc_repo: string;
	bpm_schema_version: number;
	bpm_version: string;
	bpm_author: string;
	bpm_id: string;
}

export interface DecodedNote {
	frontmatter: PluginNoteFrontmatter & Record<string, unknown>;
	body: string;
	customProps: Record<string, unknown>;
	isLegacy: boolean;
	rawValues: Record<string, unknown>;
	isBpmNote: boolean;
	isMalformed: boolean;
	isPlainMd: boolean;
}

export function parseFrontmatter(content: string): {
	frontmatter: Record<string, unknown> | null;
	body: string;
	hasFrontmatterBlock: boolean;
	parseError: boolean;
} {
	if (!content.startsWith("---")) {
		return { frontmatter: null, body: content, hasFrontmatterBlock: false, parseError: false };
	}
	const end = content.indexOf("\n---", 3);
	if (end === -1) {
		return { frontmatter: null, body: content, hasFrontmatterBlock: true, parseError: true };
	}
	const raw = content.slice(3, end).trim();
	let frontmatter: Record<string, unknown> | null = null;
	let parseError = false;
	try {
		const parsed = parseYaml(raw);
		if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
			frontmatter = parsed as Record<string, unknown>;
		} else {
			parseError = true;
		}
	} catch {
		parseError = true;
	}
	return { frontmatter, body: content.slice(end + 4), hasFrontmatterBlock: true, parseError };
}

export function safeString(value: unknown, fallback = ""): string {
	if (typeof value === "string") return value;
	if (typeof value === "number" || typeof value === "boolean") return String(value);
	return fallback;
}

export function safeBoolean(value: unknown, fallback: boolean): boolean {
	return typeof value === "boolean" ? value : fallback;
}

function safeStringArray(value: unknown, fallback: string[] = []): string[] {
	if (!Array.isArray(value)) return fallback;
	return value.map((v) => safeString(v)).filter(Boolean);
}

/** 仅当数组且每个元素都是 string 时返回，否则返回 fallback */
export function strictStringArray(value: unknown, fallback: string[] = []): { valid: boolean; items: string[] } {
	if (!Array.isArray(value)) return { valid: false, items: fallback };
	for (const v of value) {
		if (typeof v !== "string") return { valid: false, items: fallback };
	}
	return { valid: true, items: value as string[] };
}

function safeNumber(value: unknown, fallback: number): number {
	if (typeof value === "number" && Number.isFinite(value)) return value;
	const str = String(value ?? "");
	const parsed = Number(str);
	return Number.isFinite(parsed) ? parsed : fallback;
}

export function extractCustomProps(frontmatter: Record<string, unknown>): Record<string, unknown> {
	const props: Record<string, unknown> = {};
	Object.entries(frontmatter).forEach(([key, value]) => {
		if (!key.startsWith(BPM_PREFIX)) props[key] = value;
	});
	return props;
}

export function normalizeFrontmatter(raw: Record<string, unknown> | null): {
	frontmatter: PluginNoteFrontmatter;
	custom: Record<string, unknown>;
	isLegacy: boolean;
} {
	const fm = raw ?? {};
	const schemaVersion = safeNumber(fm["bpm_schema_version"], 0);
	const isLegacy = schemaVersion < CURRENT_SCHEMA_VERSION;
	const legacyName = safeString(fm["bpm_rw_name"]);
	const result: PluginNoteFrontmatter = {
		bpm_ro_id: safeString(fm["bpm_ro_id"]),
		bpm_ro_name: safeString(fm["bpm_ro_name"]) || legacyName,
		bpm_ro_group: safeString(fm["bpm_ro_group"]),
		bpm_ro_tags: safeStringArray(fm["bpm_ro_tags"]),
		bpm_ro_delay: safeString(fm["bpm_ro_delay"]),
		bpm_ro_installed_via_bpm: safeBoolean(fm["bpm_ro_installed_via_bpm"], false),
		bpm_rw_desc: safeString(fm["bpm_rw_desc"]),
		bpm_rw_note: safeString(fm["bpm_rw_note"]),
		bpm_rw_enabled: safeBoolean(fm["bpm_rw_enabled"], true),
		bpm_rw_group: safeString(fm["bpm_rw_group"]) || safeString(fm["bpm_ro_group"]),
		bpm_rw_tags: safeStringArray(fm["bpm_rw_tags"]).length > 0 ? safeStringArray(fm["bpm_rw_tags"]) : safeStringArray(fm["bpm_ro_tags"]),
		bpm_rwc_repo: safeString(fm["bpm_rwc_repo"]),
		bpm_schema_version: CURRENT_SCHEMA_VERSION,
		bpm_version: safeString(fm["bpm_version"]),
		bpm_author: safeString(fm["bpm_author"]),
		bpm_id: safeString(fm["bpm_id"]) || safeString(fm["bpm_ro_id"]),
	};
	const custom = extractCustomProps(fm);
	return { frontmatter: result, custom, isLegacy };
}

export function hasStrictBooleanEnabled(rawFm: Record<string, unknown>): boolean {
	return typeof rawFm["bpm_rw_enabled"] === "boolean";
}

export function getStrictEnabledValue(rawFm: Record<string, unknown>): boolean | undefined {
	const v = rawFm["bpm_rw_enabled"];
	return typeof v === "boolean" ? v : undefined;
}

export function decodeNote(content: string): DecodedNote {
	const parsed = parseFrontmatter(content);
	const { frontmatter: rawFm, body, hasFrontmatterBlock, parseError } = parsed;

	if (parseError) {
		return {
			frontmatter: {} as PluginNoteFrontmatter & Record<string, unknown>,
			body, customProps: {}, isLegacy: false,
			rawValues: {}, isBpmNote: false, isMalformed: true, isPlainMd: !hasFrontmatterBlock,
		};
	}
	if (!rawFm) {
		return {
			frontmatter: {} as PluginNoteFrontmatter & Record<string, unknown>,
			body, customProps: {}, isLegacy: false,
			rawValues: {}, isBpmNote: false, isMalformed: false, isPlainMd: !hasFrontmatterBlock,
		};
	}

	// bpm_ro_id must be non-empty string
	const rawId = rawFm["bpm_ro_id"];
	const hasBpmId = typeof rawId === "string" && rawId.trim().length > 0;

	const { frontmatter, custom, isLegacy } = normalizeFrontmatter(rawFm);
	const merged = { ...frontmatter, ...custom } as PluginNoteFrontmatter & Record<string, unknown>;

	return {
		frontmatter: merged, body, customProps: custom, isLegacy,
		rawValues: rawFm, isBpmNote: hasBpmId, isMalformed: false, isPlainMd: false,
	};
}

export function buildExportFrontmatter(bpmFields: PluginNoteFrontmatter, existingCustom: Record<string, unknown> = {}): Record<string, unknown> {
	const bpm = bpmFields as unknown as Record<string, unknown>;
	return { ...existingCustom, ...bpm };
}

export function buildMarkdown(frontmatter: Record<string, unknown>, body: string): string {
	const yaml = stringifyYaml(frontmatter).trimEnd();
	const separator = body.startsWith("\n") ? "" : "\n";
	return `---\n${yaml}\n---${separator}${body}`;
}

export function safeFileName(name: string, fallback = "plugin"): string {
	const base = (name || fallback).trim();
	const safe = base
		.replace(/[/\\?%*:|"<>.]/g, "-")
		.replace(/\s+/g, " ")
		.replace(/^-+|-+$/g, "")
		.slice(0, 200);
	return safe || fallback;
}

export const DEFAULT_BODY = "\n\n";

export function isValidExportPath(dir: string): { valid: boolean; reason?: string } {
	if (!dir || !dir.trim()) {
		return { valid: false, reason: "empty" };
	}
	const trimmed = dir.trim();
	// Absolute paths
	if (trimmed.startsWith("/") || trimmed.match(/^[A-Za-z]:[\\/]/)) {
		return { valid: false, reason: "absolute" };
	}
	// Traversal (including backslash variants)
	if (trimmed === "." || trimmed === ".." || trimmed.startsWith("../") || trimmed.includes("/../") ||
		trimmed.startsWith("..\\") || trimmed.includes("\\..\\") || trimmed.endsWith("\\..")) {
		return { valid: false, reason: "path-traversal" };
	}
	// Control characters
	if (/[\x00-\x1f]/.test(trimmed)) {
		return { valid: false, reason: "control-chars" };
	}
	// .obsidian and subdirs
	const parts = trimmed.replace(/\\/g, "/").split("/").filter(Boolean);
	if (parts[0] === ".obsidian" || parts.includes(".obsidian")) {
		return { valid: false, reason: "obsidian-config" };
	}
	return { valid: true };
}
