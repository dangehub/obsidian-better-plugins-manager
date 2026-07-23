/**
 * tests/plugin-notes/types.test.cjs
 *
 * Comprehensive pure-function tests for plugin-notes/types.ts.
 * Mocks the obsidian module to provide parseYaml/stringifyYaml.
 *
 * Run: npm test
 */

const Module = require("module");
const path = require("path");
const origRequire = Module.prototype.require;

const mockYamlThrow = Symbol('yaml-error');

// Realistic YAML mock that throws on malformed input (no key:value pairs)
const mockObsidian = {
	parseYaml: (str) => {
		if (!str || !str.trim()) return {};
		const lines = str.split("\n").filter(l => l.trim());
		if (lines.length === 0) return {};

		const hasKV = lines.some(l => l.indexOf(": ") > 0);
		if (!hasKV) throw mockYamlThrow;

		const obj = {};
		lines.forEach((line) => {
			const idx = line.indexOf(": ");
			if (idx > 0) {
				const key = line.slice(0, idx).trim();
				let raw = line.slice(idx + 2).trim();

				// Quoted strings
				if ((raw.startsWith('"') && raw.endsWith('"')) || (raw.startsWith("'") && raw.endsWith("'"))) {
					obj[key] = raw.slice(1, -1);
					return;
				}
				// Arrays: [val1, val2]
				if (raw.startsWith("[") && raw.endsWith("]")) {
					const items = raw.slice(1, -1).split(",").map(s => s.trim()).filter(Boolean);
					obj[key] = items.map(s => {
						if (s === "true") return true;
						if (s === "false") return false;
						if (/^\d+$/.test(s)) return Number(s);
						return s;
					});
					return;
				}
				// Booleans
				if (raw === "true") { obj[key] = true; return; }
				if (raw === "false") { obj[key] = false; return; }
				// Numbers
				if (/^\d+(\.\d+)?$/.test(raw)) { obj[key] = Number(raw); return; }
				obj[key] = raw;
			}
		});
		return obj;
	},
	stringifyYaml: (obj) => {
		return Object.entries(obj)
			.map(([k, v]) => {
				if (Array.isArray(v)) return k + ": [" + v.join(", ") + "]";
				if (typeof v === "boolean") return k + ": " + v;
				if (v === null || v === undefined) return k + ": ";
				return k + ": " + String(v);
			})
			.join("\n");
	},
};

Module.prototype.require = function (id) {
	if (id === "obsidian") return mockObsidian;
	return origRequire.apply(this, arguments);
};

const typesPath = path.resolve(__dirname, "../../src/plugin-notes/types.ts");
const mod = require(typesPath);
Module.prototype.require = origRequire;

const {
	decodeNote,
	buildExportFrontmatter,
	buildMarkdown,
	safeFileName,
	parseFrontmatter,
	normalizeFrontmatter,
	extractCustomProps,
	CURRENT_SCHEMA_VERSION,
	isValidExportPath,
	hasStrictBooleanEnabled,
	getStrictEnabledValue,
	isBpmReadonlyField,
} = mod;

let passed = 0;
let failed = 0;
const failures = [];

function assert(condition, msg) {
	if (condition) { passed++; }
	else { failed++; failures.push(msg); console.error("FAIL: " + msg); }
}

function assertEqual(actual, expected, msg) {
	if (actual === expected) { passed++; }
	else { failed++; failures.push(msg); console.error("FAIL: " + msg + " — expected " + JSON.stringify(expected) + ", got " + JSON.stringify(actual)); }
}

function assertDeepEqual(actual, expected, msg) {
	const a = JSON.stringify(actual);
	const e = JSON.stringify(expected);
	if (a === e) { passed++; }
	else { failed++; failures.push(msg); console.error("FAIL: " + msg + " — expected " + e + ", got " + a); }
}

// ==============================
// Group 1: parseFrontmatter
// ==============================
assert(parseFrontmatter("Hello").frontmatter === null, "1a: no frontmatter returns null");
assertEqual(parseFrontmatter("---\nkey: val\n---\nBody").body, "\nBody", "1b: body includes leading newline");
assert(parseFrontmatter("---\nno-close").frontmatter === null, "1c: no closing --- returns null");
assertDeepEqual(parseFrontmatter("---\n---\nBody").frontmatter, {}, "1d: empty frontmatter = {}");

// Malformed YAML (no key:value pairs)
const malformed = parseFrontmatter("---\n{invalid\n---\nbody");
assert(malformed.frontmatter === null, "1e: malformed frontmatter returns null");
assert(malformed.parseError, "1f: parseError=true for malformed");

// ==============================
// Group 2: normalizeFrontmatter
// ==============================
{
	const r = normalizeFrontmatter({ bpm_ro_id: "test", bpm_rw_name: "OldName" });
	assertEqual(r.frontmatter.bpm_ro_id, "test", "2a: id preserved");
	assertEqual(r.frontmatter.bpm_ro_name, "OldName", "2b: legacy name from bpm_rw_name");
	assert(r.isLegacy, "2c: legacy without schema_version");
}
{
	const r = normalizeFrontmatter({ bpm_ro_id: "t2", bpm_schema_version: CURRENT_SCHEMA_VERSION });
	assert(!r.isLegacy, "2d: not legacy with current version");
}
assertEqual(normalizeFrontmatter(null).frontmatter.bpm_ro_id, "", "2e: null input empty id");

// ==============================
// Group 3: extractCustomProps
// ==============================
assertDeepEqual(extractCustomProps({ bpm_ro_id: "x", custom: "y" }), { custom: "y" }, "3a: custom extracted");

// ==============================
// Group 4: decodeNote
// ==============================
{
	const c = [
		"---",
		"bpm_ro_id: test-p",
		"bpm_ro_name: Test P",
		"bpm_rw_enabled: true",
		"bpm_schema_version: " + CURRENT_SCHEMA_VERSION,
		"custom_field: hello",
		"---",
		"",
		"Body content",
	].join("\n");
	const d = decodeNote(c);
	assertEqual(d.frontmatter.bpm_ro_id, "test-p", "4a: id decoded");
	assertEqual(d.frontmatter.bpm_rw_enabled, true, "4b: enabled true");
	assertEqual(d.frontmatter.custom_field, "hello", "4c: custom pr eserved");
	assert(d.body.includes("Body content"), "4d: body preserved");
	assert(d.isBpmNote, "4e: isBpmNote=true");
	assert(!d.isMalformed, "4f: not malformed");
}
{
	// Plain MD
	const d = decodeNote("Just text\nNo frontmatter");
	assert(d.isPlainMd, "4g: plain md detected");
	assert(!d.isBpmNote, "4h: not BPM note");
}
{
	// Has frontmatter but no bpm_ro_id
	const d = decodeNote("---\nkey: value\n---\nbody");
	assert(!d.isBpmNote, "4i: no bpm_ro_id = not BPM note");
	assert(!d.isMalformed, "4j: not malformed");
}
{
	// Malformed YAML frontmatter
	const d = decodeNote("---\n{invalid\n---\nbody");
	assert(d.isMalformed, "4k: malformed detected");
	assert(!d.isBpmNote, "4l: not BPM note");
}

// ==============================
// Group 5: Strict boolean
// ==============================
{
	// String "false" must NOT be treated as boolean
	const c = [
		"---",
		"bpm_ro_id: test",
		'bpm_rw_enabled: "false"',
		"bpm_schema_version: " + CURRENT_SCHEMA_VERSION,
		"---",
	].join("\n");
	const d = decodeNote(c);
	assertEqual(d.frontmatter.bpm_rw_enabled, true, "5a: string false falls back to true in frontmatter");
	assert(!hasStrictBooleanEnabled(d.rawValues), "5b: hasStrictBooleanEnabled false for string false");

	// Real boolean false
	const d2 = decodeNote("---\nbpm_ro_id: t\nbpm_rw_enabled: false\n---\n");
	assertEqual(d2.frontmatter.bpm_rw_enabled, false, "5c: real boolean false decoded");
	assert(hasStrictBooleanEnabled(d2.rawValues), "5d: hasStrictBooleanEnabled true for real false");
	assertEqual(getStrictEnabledValue(d2.rawValues), false, "5e: getStrictEnabledValue returns false");

	// Real boolean true
	const d3 = decodeNote("---\nbpm_ro_id: t\nbpm_rw_enabled: true\n---\n");
	assert(hasStrictBooleanEnabled(d3.rawValues), "5f: strict true detected");
	assertEqual(getStrictEnabledValue(d3.rawValues), true, "5g: getStrictEnabledValue true");

	// Non-boolean values
	assert(!hasStrictBooleanEnabled({ bpm_rw_enabled: 0 }), "5h: number 0 not strict");
	assert(!hasStrictBooleanEnabled({ bpm_rw_enabled: "false" }), "5i: string not strict");
	assert(!hasStrictBooleanEnabled({ bpm_rw_enabled: null }), "5j: null not strict");
	assert(!hasStrictBooleanEnabled({}), "5k: missing key not strict");

	// Number should not be mistaken for enabled
	const d4 = decodeNote("---\nbpm_ro_id: t\nbpm_rw_enabled: 0\n---\n");
	assert(!hasStrictBooleanEnabled(d4.rawValues), "5l: number 0 not strict boolean");
}

// ==============================
// Group 6: safeFileName (id-based)
// ==============================
assertEqual(safeFileName("test-plugin"), "test-plugin", "6a: normal id preserved");
assertEqual(safeFileName("", "fallback"), "fallback", "6b: empty with fallback");
assertEqual(safeFileName("  ", "p"), "p", "6c: whitespace -> fallback");
assertEqual(safeFileName("plugin/id"), "plugin-id", "6d: slash replaced with dash");
assertEqual(safeFileName("a<b>c:d|e"), "a-b-c-d-e", "6e: special chars replaced");
assertEqual(safeFileName("obsidian-plugin"), "obsidian-plugin", "6f: plain id unchanged");
assertEqual(safeFileName(".hidden"), "hidden", "6g: leading dot removed");
assertEqual(safeFileName("obsidian42-br"), "obsidian42-br", "6h: id with dash ok");

// ==============================
// Group 7: buildMarkdown
// ==============================
{
	const md = buildMarkdown({ bpm_ro_id: "t" }, "\nBody");
	assert(md.startsWith("---\n"), "7a: starts with ---");
	assert(md.includes("bpm_ro_id: t"), "7b: contains field");
	assert(md.includes("\n---\n"), "7c: has closing ---");
	assert(md.endsWith("\nBody"), "7d: body at end");
}
{
	const md = buildMarkdown({ bpm_ro_id: "t" }, "Body");
	assert(md.includes("---\nBody"), "7e: adds newline separator");
}

// ==============================
// Group 8: buildExportFrontmatter preserves custom
// ==============================
{
	const bpm = {
		bpm_ro_id: "t", bpm_ro_name: "T", bpm_ro_group: "", bpm_ro_tags: [],
		bpm_ro_delay: "", bpm_ro_installed_via_bpm: false,
		bpm_rw_desc: "", bpm_rw_note: "", bpm_rw_enabled: true,
		bpm_rw_group: "", bpm_rw_tags: [],
		bpm_rwc_repo: "", bpm_schema_version: CURRENT_SCHEMA_VERSION,
		bpm_version: "", bpm_author: "", bpm_id: "t",
	};
	const fm = buildExportFrontmatter(bpm, { my_custom: "keep" });
	assertEqual(fm.bpm_ro_id, "t", "8a: bpm field preserved");
	assertEqual(fm.my_custom, "keep", "8b: custom field preserved");
}

// ==============================
// Group 9: isValidExportPath
// ==============================
assert(!isValidExportPath("").valid, "9a: empty invalid");
assert(!isValidExportPath("  ").valid, "9b: whitespace invalid");
assert(!isValidExportPath("/absolute/path").valid, "9c: absolute path invalid");
assert(!isValidExportPath("..").valid, "9d: parent traversal invalid");
assert(!isValidExportPath("../outside").valid, "9e: upward traversal invalid");
assert(!isValidExportPath("dir/../outside").valid, "9f: embedded traversal invalid");
assert(!isValidExportPath(".obsidian").valid, "9g: .obsidian root invalid");
assert(!isValidExportPath(".obsidian/plugins").valid, "9h: .obsidian subdir invalid");
assert(!isValidExportPath("C:/Users/test").valid, "9i: Windows absolute invalid");
assert(isValidExportPath("BPM-Export").valid, "9j: simple relative valid");
assert(isValidExportPath("my-vault/BPM").valid, "9k: nested valid");
assert(isValidExportPath("dir/subdir").valid, "9l: multi-level valid");

// ==============================
// Group 10: isBpmReadonlyField
// ==============================
assert(isBpmReadonlyField("bpm_ro_id"), "10a: ro_id is RO");
assert(isBpmReadonlyField("bpm_ro_name"), "10b: ro_name is RO");
assert(!isBpmReadonlyField("bpm_rw_desc"), "10c: rw_desc not RO");
assert(!isBpmReadonlyField("custom_field"), "10d: custom not RO");

// ==============================
// Summary
// ==============================
console.log("\n=== Test results: " + passed + " passed, " + failed + " failed ===");
if (failures.length > 0) {
	console.error("\nFailures:");
	failures.forEach(f => console.error("  - " + f));
}
if (failed > 0) process.exit(1);
