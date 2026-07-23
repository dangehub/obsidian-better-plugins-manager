/**
 * plugin-notes/types.ts
 *
 * BPM 插件笔记导出模块的数据模型和 frontmatter 编解码器。
 *
 * 设计要点：
 * - 纯函数设计，所有编解码操作不依赖 Obsidian API，可单测。
 * - 旧 schema 兼容：读取旧字段并映射到新 schema。
 * - 用户自定义 frontmatter 保留：非 bpm_ 前缀属性始终保留。
 */

import { stringifyYaml, parseYaml } from "obsidian";

// ---- Schema 版本 ----
export const CURRENT_SCHEMA_VERSION = 1;

// ---- 字段前缀 ----
export const BPM_PREFIX = "bpm_";
export const BPM_RO_PREFIX = "bpm_ro_";
export const BPM_RW_PREFIX = "bpm_rw_";
export const BPM_RWC_PREFIX = "bpm_rwc_";

/**
 * 插件笔记的 frontmatter schema。
 *
 * 所有字段以 bpm_ 开头，RO/RW/RWC 表示读写模式。
 * 用户自定义属性（非 bpm_ 前缀）独立于本结构，在编解码中保留。
 */
export interface PluginNoteFrontmatter {
	// ---- 只读（由 BPM 导出维护） ----
	/** 插件唯一标识（obsidian plugin id） */
	bpm_ro_id: string;
	/** 插件名称 */
	bpm_ro_name: string;
	/** 分组 ID */
	bpm_ro_group: string;
	/** 标签 ID 列表 */
	bpm_ro_tags: string[];
	/** 延迟配置 ID */
	bpm_ro_delay: string;
	/** 是否通过 BPM 安装 */
	bpm_ro_installed_via_bpm: boolean;

	// ---- 可读写（双向同步可写回） ----
	/** 插件描述 */
	bpm_rw_desc: string;
	/** 用户备注 */
	bpm_rw_note: string;
	/** 启用状态（严格 boolean） */
	bpm_rw_enabled: boolean;

	// ---- 条件可写 ----
	/** 仓库地址（仅官方未匹配且非 BPM 安装时写回） */
	bpm_rwc_repo: string;

	// ---- 新增补充字段 ----
	/** Schema 版本号 */
	bpm_schema_version: number;
	/** 插件当前安装版本 */
	bpm_version: string;
	/** 插件作者 */
	bpm_author: string;
	/** 与 bpm_ro_id 一致，便于 Bases 展示 */
	bpm_id: string;
}

/** 编解码器处理后的完整结果，包含 frontmatter 和 body。 */
export interface DecodedNote {
	/** 标准化的 frontmatter（含所有 bpm_ 字段和用户自定义属性） */
	frontmatter: PluginNoteFrontmatter & Record<string, unknown>;
	/** Markdown 正文（不含 frontmatter） */
	body: string;
	/** 用户自定义属性（非 bpm_ 前缀） */
	customProps: Record<string, unknown>;
	/** 是否旧 schema（无 bpm_schema_version 或版本 < CURRENT） */
	isLegacy: boolean;
}

// ---- 编解码器 ----

/** 原始解析结果。 */
interface RawParsed {
	frontmatter: Record<string, unknown> | null;
	body: string;
}

/**
 * 解析 Markdown 顶部 YAML frontmatter。
 *
 * 只处理文件开头的标准 --- 块。没有 frontmatter 或解析失败时返回 null，body 保留原内容。
 */
export function parseFrontmatter(content: string): RawParsed {
	if (!content.startsWith("---")) return { frontmatter: null, body: content };

	const end = content.indexOf("\n---", 3);
	if (end === -1) return { frontmatter: null, body: content };

	const raw = content.slice(3, end).trim();
	let frontmatter: Record<string, unknown> | null = null;
	try {
		const parsed = parseYaml(raw);
		if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
			frontmatter = parsed as Record<string, unknown>;
		}
	} catch {
		frontmatter = null;
	}

	return {
		frontmatter,
		body: content.slice(end + 4),
	};
}

/**
 * 安全地取字符串值。
 */
export function safeString(value: unknown, fallback = ""): string {
	if (typeof value === "string") return value;
	if (typeof value === "number" || typeof value === "boolean") return String(value);
	return fallback;
}

/**
 * 安全地取布尔值——严格检查 `typeof === "boolean"`。
 */
export function safeBoolean(value: unknown, fallback: boolean): boolean {
	return typeof value === "boolean" ? value : fallback;
}

/**
 * 安全地取字符串数组。
 */
function safeStringArray(value: unknown, fallback: string[] = []): string[] {
	if (!Array.isArray(value)) return fallback;
	return value.map((v) => safeString(v)).filter(Boolean);
}

/**
 * 安全地取数字。
 */
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
 * 读取旧 schema frontmatter 并与新 schema 合并。
 *
 * 旧字段映射：
 * - bpm_ro_id → bpm_ro_id (相同)
 * - bpm_ro_name → bpm_ro_name (旧版可能使用 bpm_rw_name)
 * - bpm_rw_desc → bpm_rw_desc (相同)
 * - bpm_rw_note → bpm_rw_note (相同)
 * - bpm_rw_enabled → bpm_rw_enabled (相同)
 * - bpm_rwc_repo → bpm_rwc_repo (相同)
 * - bpm_ro_group → bpm_ro_group (相同)
 * - bpm_ro_tags → bpm_ro_tags (相同)
 * - bpm_ro_delay → bpm_ro_delay (相同)
 * - bpm_ro_installed_via_bpm → bpm_ro_installed_via_bpm (相同)
 */
export function normalizeFrontmatter(
	raw: Record<string, unknown> | null
): {
	frontmatter: PluginNoteFrontmatter;
	custom: Record<string, unknown>;
	isLegacy: boolean;
} {
	const fm = raw ?? {};

	// 判断是否旧 schema：无 bpm_schema_version 或版本号 < CURRENT
	const schemaVersion = safeNumber(fm["bpm_schema_version"], 0);
	const isLegacy = schemaVersion < CURRENT_SCHEMA_VERSION;

	// 旧 schema 可能用 bpm_rw_name 作为名称
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
 * 解码完整的 Markdown 内容。
 */
export function decodeNote(content: string): DecodedNote {
	const { frontmatter: raw, body } = parseFrontmatter(content);
	const { frontmatter, custom, isLegacy } = normalizeFrontmatter(raw);

	// 合并：标准 bpm 字段 + 自定义属性
	const merged = { ...frontmatter, ...custom } as PluginNoteFrontmatter & Record<string, unknown>;

	return {
		frontmatter: merged,
		body,
		customProps: custom,
		isLegacy,
	};
}

/**
 * 构建导出的 frontmatter 数据。
 *
 * @param bpmFields - BPM 维护的必填字段
 * @param existingCustom - 已有的用户自定义属性（来自旧文件）
 */
export function buildExportFrontmatter(
	bpmFields: PluginNoteFrontmatter,
	existingCustom: Record<string, unknown> = {}
): Record<string, unknown> {
	// 从 bpmFields 中提取标准的 bpm_* 字段
	const bpm = bpmFields as unknown as Record<string, unknown>;

	// 合并：BPM 字段优先，用户自定义属性覆盖
	return { ...existingCustom, ...bpm };
}

/**
 * 将 frontmatter + body 重新组装为完整的 Markdown 字符串。
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
 * 安全文件名：将插件名或 id 转换为安全的文件名（不含扩展名）。
 */
export function safeFileName(name: string): string {
	return name
		.trim()
		.replace(/[/\\?%*:|"<>]/g, "-")
		.replace(/\s+/g, " ")
		.replace(/^\.+/, "")
		.slice(0, 200) || "plugin";
}

/** 默认 body 文本 */
export const DEFAULT_BODY = "\n\n";
