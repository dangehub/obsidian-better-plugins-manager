/**
 * plugin-notes/types.ts
 *
 * BPM 插件笔记导出模块的数据模型和 frontmatter 编解码器。
 *
 * 设计要点：
 * - 纯函数设计，所有编解码操作不依赖 Obsidian API，可单测。
 * - 旧 schema 兼容：读取旧字段并映射到新 schema。
 * - 用户自定义 frontmatter 保留：非 bpm_ 前缀属性始终保留。
 * - 严格布尔：字符串"false"不会被当作 false，只有 typeof boolean 被接受。
 */

import { stringifyYaml, parseYaml } from "obsidian";

// ---- Schema 版本 ----
export const CURRENT_SCHEMA_VERSION = 1;

// ---- 字段前缀 ----
export const BPM_PREFIX = "bpm_";
export const BPM_RO_PREFIX = "bpm_ro_";
export const BPM_RW_PREFIX = "bpm_rw_";
export const BPM_RWC_PREFIX = "bpm_rwc_";

const BPM_RO_FIELDS = new Set([
	"bpm_ro_id", "bpm_ro_name", "bpm_ro_group", "bpm_ro_tags",
	"bpm_ro_delay", "bpm_ro_installed_via_bpm",
	"bpm_schema_version", "bpm_version", "bpm_author", "bpm_id",
]);

/** 判断一个 key 是否属于 BPM 只读字段 */
export function isBpmReadonlyField(key: string): boolean {
	return BPM_RO_FIELDS.has(key);
}

/**
 * 插件笔记的 frontmatter schema。
 */
export interface PluginNoteFrontmatter {
	// ---- 只读（由 BPM 导出维护） ----
	bpm_ro_id: string;
	bpm_ro_name: string;
	bpm_ro_group: string;
	bpm_ro_tags: string[];
	bpm_ro_delay: string;
	bpm_ro_installed_via_bpm: boolean;

	// ---- 可读写（双向同步可写回） ----
	bpm_rw_desc: string;
	bpm_rw_note: string;
	/** 启用状态——sync 回写时必须检查原始 YAML 值是否为 typeof boolean */
	bpm_rw_enabled: boolean;
	/** 分组名（可写，新增字段，供双向同步写回） */
	bpm_rw_group: string;
	/** 标签列表（可写，新增字段，供双向同步写回） */
	bpm_rw_tags: string[];

	// ---- 条件可写 ----
	bpm_rwc_repo: string;

	// ---- 新增补充字段 ----
	bpm_schema_version: number;
	bpm_version: string;
	bpm_author: string;
	bpm_id: string;
}

/** 编解码器处理后的完整结果 */
export interface DecodedNote {
	/** 标准化的 frontmatter（含所有 bpm_ 字段和用户自定义属性） */
	frontmatter: PluginNoteFrontmatter & Record<string, unknown>;
	/** Markdown 正文（不含 frontmatter） */
	body: string;
	/** 用户自定义属性（非 bpm_ 前缀） */
	customProps: Record<string, unknown>;
	/** 是否旧 schema（无 bpm_schema_version 或版本 < CURRENT） */
	isLegacy: boolean;
	/** 原始 frontmatter 键值对（未标准化），供 sync 做严格类型校验 */
	rawValues: Record<string, unknown>;
	/** 文件是否有合法的 bpm frontmatter */
	isBpmNote: boolean;
	/** 文件存在但 frontmatter 解析失败 */
	isMalformed: boolean;
	/** 文件无 frontmatter（纯文本或非 YAML） */
	isPlainMd: boolean;
}

// ---- 编解码器 ----

/**
 * 解析 Markdown 顶部 YAML frontmatter。
 */
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

	return {
		frontmatter,
		body: content.slice(end + 4),
		hasFrontmatterBlock: true,
		parseError,
	};
}

export function safeString(value: unknown, fallback = ""): string {
	if (typeof value === "string") return value;
	if (typeof value === "number" || typeof value === "boolean") return String(value);
	return fallback;
}

/** 严格布尔：只有 typeof === "boolean" 返回该值，否则返回 fallback */
export function safeBoolean(value: unknown, fallback: boolean): boolean {
	return typeof value === "boolean" ? value : fallback;
}

function safeStringArray(value: unknown, fallback: string[] = []): string[] {
	if (!Array.isArray(value)) return fallback;
	return value.map((v) => safeString(v)).filter(Boolean);
}

function safeNumber(value: unknown, fallback: number): number {
	if (typeof value === "number" && Number.isFinite(value)) return value;
	const str = String(value ?? "");
	const parsed = Number(str);
	return Number.isFinite(parsed) ? parsed : fallback;
}

/**
 * 从原始 frontmatter 中提取所有非 bpm_ 前缀属性。
 */
export function extractCustomProps(
	frontmatter: Record<string, unknown>
): Record<string, unknown> {
	const props: Record<string, unknown> = {};
	Object.entries(frontmatter).forEach(([key, value]) => {
		if (!key.startsWith(BPM_PREFIX)) {
			props[key] = value;
		}
	});
	return props;
}

/**
 * 标准化 frontmatter，兼容旧 schema。
 */
export function normalizeFrontmatter(
	raw: Record<string, unknown> | null
): {
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
		bpm_rw_tags: safeStringArray(fm["bpm_rw_tags"]).length > 0
			? safeStringArray(fm["bpm_rw_tags"])
			: safeStringArray(fm["bpm_ro_tags"]),
		bpm_rwc_repo: safeString(fm["bpm_rwc_repo"]),
		bpm_schema_version: CURRENT_SCHEMA_VERSION,
		bpm_version: safeString(fm["bpm_version"]),
		bpm_author: safeString(fm["bpm_author"]),
		bpm_id: safeString(fm["bpm_id"]) || safeString(fm["bpm_ro_id"]),
	};

	const custom = extractCustomProps(fm);

	return { frontmatter: result, custom, isLegacy };
}

/**
 * 检查原始 frontmatter 中 bpm_rw_enabled 是否为严格的 boolean 值。
 * 用于 sync 回写判断。
 */
export function hasStrictBooleanEnabled(rawFm: Record<string, unknown>): boolean {
	return typeof rawFm["bpm_rw_enabled"] === "boolean";
}

/**
 * 获取原始 frontmatter 中的 bpm_rw_enabled 值（严格 boolean）。
 * 如果不是 boolean 类型，返回 undefined。
 */
export function getStrictEnabledValue(rawFm: Record<string, unknown>): boolean | undefined {
	const v = rawFm["bpm_rw_enabled"];
	return typeof v === "boolean" ? v : undefined;
}

/**
 * 解码完整的 Markdown 内容。
 */
export function decodeNote(content: string): DecodedNote {
	const parsed = parseFrontmatter(content);
	const { frontmatter: rawFm, body, hasFrontmatterBlock, parseError } = parsed;

	// 解析错误或没有 frontmatter 的情况
	if (parseError) {
		return {
			frontmatter: {} as PluginNoteFrontmatter & Record<string, unknown>,
			body,
			customProps: {},
			isLegacy: false,
			rawValues: {},
			isBpmNote: false,
			isMalformed: true,
			isPlainMd: !hasFrontmatterBlock,
		};
	}

	if (!rawFm) {
		return {
			frontmatter: {} as PluginNoteFrontmatter & Record<string, unknown>,
			body,
			customProps: {},
			isLegacy: false,
			rawValues: {},
			isBpmNote: false,
			isMalformed: false,
			isPlainMd: !hasFrontmatterBlock,
		};
	}

	// Check if this is a BPM note (has bpm_ro_id)
	const hasBpmId = Boolean(rawFm["bpm_ro_id"] && safeString(rawFm["bpm_ro_id"]));

	const { frontmatter, custom, isLegacy } = normalizeFrontmatter(rawFm);

	const merged = { ...frontmatter, ...custom } as PluginNoteFrontmatter & Record<string, unknown>;

	return {
		frontmatter: merged,
		body,
		customProps: custom,
		isLegacy,
		rawValues: rawFm,
		isBpmNote: hasBpmId,
		isMalformed: false,
		isPlainMd: false,
	};
}

/**
 * 构建导出的 frontmatter。
 */
export function buildExportFrontmatter(
	bpmFields: PluginNoteFrontmatter,
	existingCustom: Record<string, unknown> = {}
): Record<string, unknown> {
	const bpm = bpmFields as unknown as Record<string, unknown>;
	return { ...existingCustom, ...bpm };
}

/**
 * 将 frontmatter + body 组装为 Markdown。
 */
export function buildMarkdown(
	frontmatter: Record<string, unknown>,
	body: string
): string {
	const yaml = stringifyYaml(frontmatter).trimEnd();
	const separator = body.startsWith("\n") ? "" : "\n";
	return `---\n${yaml}\n---${separator}${body}`;
}

/**
 * 基于 plugin id 生成安全的文件名（不含扩展名）。
 * 不在文件名中使用 name，避免重命名抖动。
 */
export function safeFileName(name: string, fallback = "plugin"): string {
	const base = (name || fallback).trim();
	const safe = base
		.replace(/[/\\?%*:|"<>.]/g, "-")
		.replace(/\s+/g, " ")
		.replace(/^-+|-+$/g, "")
		.slice(0, 200);
	return safe || fallback;
}

/** 默认 body 文本 */
export const DEFAULT_BODY = "\n\n";

/** 判断一个路径是否在无效的子目录中 */
export function isValidExportPath(dir: string): { valid: boolean; reason?: string } {
	if (!dir || !dir.trim()) {
		return { valid: false, reason: "empty" };
	}
	const trimmed = dir.trim();
	// 拒绝绝对路径
	if (trimmed.startsWith("/") || trimmed.match(/^[A-Za-z]:[\\/]/)) {
		return { valid: false, reason: "absolute" };
	}
	// 拒绝根路径或相对遍历
	if (trimmed === "." || trimmed === ".." || trimmed.startsWith("../") || trimmed.includes("/../")) {
		return { valid: false, reason: "path-traversal" };
	}
	// 拒绝 .obsidian 及其子目录
	const parts = trimmed.split("/").filter(Boolean);
	if (parts[0] === ".obsidian" || parts.includes(".obsidian")) {
		return { valid: false, reason: "obsidian-config" };
	}
	return { valid: true };
}
