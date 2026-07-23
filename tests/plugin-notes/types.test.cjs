/**
 * tests/plugin-notes/types.test.cjs
 *
 * 纯函数测试：frontmatter 编解码器。
 *
 * 使用 CommonJS require 加载 TypeScript（通过 tsx 注册器），
 * 并在加载前 mock obsidian 依赖。
 *
 * 运行：npx tsx tests/plugin-notes/types.test.cjs
 * 或：node --require tsx/esm tests/plugin-notes/types.test.cjs
 */

// Step 1: Mock obsidian before loading any module
const Module = require("module");
const path = require("path");
const origRequire = Module.prototype.require;

const mockObsidian = {
	parseYaml: (str) => {
		const obj = {};
		str.split("\n").forEach((line) => {
			const idx = line.indexOf(": ");
			if (idx > 0) {
				const key = line.slice(0, idx).trim();
				let value = line.slice(idx + 2).trim();
				if (value === "true") value = true;
				else if (value === "false") value = false;
				else if (/^\d+$/.test(String(value))) value = Number(value);
				obj[key] = value;
			}
		});
		return obj;
	},
	stringifyYaml: (obj) => {
		return Object.entries(obj)
			.map(([k, v]) => `${k}: ${String(v)}`)
			.join("\n");
	},
};

Module.prototype.require = function (id) {
	if (id === "obsidian") return mockObsidian;
	return origRequire.apply(this, arguments);
};

// Step 2: Load the module under test
const typesPath = path.resolve(__dirname, "../../src/plugin-notes/types.ts");
const mod = require(typesPath);

// Restore
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
} = mod;

let passed = 0;
let failed = 0;

function assert(condition, msg) {
	if (condition) {
		passed++;
	} else {
		failed++;
		console.error(`FAIL: ${msg}`);
	}
}

function assertEqual(actual, expected, msg) {
	if (actual === expected) {
		passed++;
	} else {
		failed++;
		console.error(`FAIL: ${msg} — expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
	}
}

function assertDeepEqual(actual, expected, msg) {
	const a = JSON.stringify(actual);
	const e = JSON.stringify(expected);
	if (a === e) {
		passed++;
	} else {
		failed++;
		console.error(`FAIL: ${msg} — expected ${e}, got ${a}`);
	}
}

// ==============================
// Test 1: parseFrontmatter
// ==============================
assert(parseFrontmatter("Hello world").frontmatter === null, "1a: no frontmatter returns null");
assertEqual(parseFrontmatter("Hello world").body, "Hello world", "1b: body preserved");

{
	const r2 = parseFrontmatter("---\nkey: value\n---\nBody text");
	assert(r2.frontmatter !== null, "1c: valid frontmatter not null");
	assertEqual(r2.frontmatter["key"], "value", "1d: key parsed");
	assertEqual(r2.body, "\nBody text", "1e: body after frontmatter (includes trailing newline)");
}

assert(parseFrontmatter("---\nbroken").frontmatter === null, "1f: no closing --- returns null");

{
	const r4 = parseFrontmatter("---\n---\nBody");
	assert(r4.frontmatter !== null, "1g: empty frontmatter");
	assertDeepEqual(r4.frontmatter, {}, "1h: empty frontmatter is empty object");
	assertEqual(r4.body, "\nBody", "1i: body after empty frontmatter (includes trailing newline)");
}

// ==============================
// Test 2: normalizeFrontmatter (old schema)
// ==============================
{
	const old = normalizeFrontmatter({
		bpm_ro_id: "test-plugin",
		bpm_rw_name: "Old Name",
		bpm_rw_desc: "Old desc",
		bpm_rw_note: "Old note",
		bpm_rw_enabled: true,
		bpm_ro_group: "old-group",
		bpm_ro_tags: ["tag1", "tag2"],
		bpm_ro_delay: "delay-1",
		bpm_ro_installed_via_bpm: true,
		bpm_rwc_repo: "owner/repo",
	});
	assert(old.isLegacy, "2a: old schema isLegacy=true");
	assertEqual(old.frontmatter.bpm_ro_id, "test-plugin", "2b: id preserved");
	assertEqual(old.frontmatter.bpm_ro_name, "Old Name", "2c: legacy name from bpm_rw_name");
	assertEqual(old.frontmatter.bpm_schema_version, CURRENT_SCHEMA_VERSION, "2d: schema version set to current");
}

{
	const fresh = normalizeFrontmatter({
		bpm_ro_id: "new-plugin",
		bpm_ro_name: "New Plugin",
		bpm_schema_version: CURRENT_SCHEMA_VERSION,
	});
	assert(!fresh.isLegacy, "2e: new schema isLegacy=false");
}

{
	const nullInput = normalizeFrontmatter(null);
	assertEqual(nullInput.frontmatter.bpm_ro_id, "", "2f: null input empty id");
	assert(nullInput.isLegacy, "2g: null input is legacy (schema version 0 < 1)");
}

// ==============================
// Test 3: extractCustomProps
// ==============================
{
	const custom = extractCustomProps({
		bpm_ro_id: "test",
		bpm_rw_desc: "desc",
		custom_key: "custom_value",
		another: 42,
	});
	assertDeepEqual(custom, { custom_key: "custom_value", another: 42 }, "3a: non-bpm props extracted");
}

// ==============================
// Test 4: decodeNote (full roundtrip)
// ==============================
{
	const content = [
		"---",
		"bpm_ro_id: test-plugin",
		"bpm_ro_name: Test Plugin",
		"bpm_rw_enabled: true",
		`bpm_schema_version: ${CURRENT_SCHEMA_VERSION}`,
		"custom_field: hello",
		"---",
		"",
		"Body content here",
	].join("\n");

	const decoded = decodeNote(content);
	assertEqual(decoded.frontmatter.bpm_ro_id, "test-plugin", "4a: decodeNote id");
	assertEqual(decoded.frontmatter.bpm_rw_enabled, true, "4b: decodeNote enabled boolean");
	assertEqual(decoded.frontmatter.custom_field, "hello", "4c: custom field preserved");
	assert(decoded.body.includes("Body content here"), "4d: body preserved");
	assertDeepEqual(decoded.customProps, { custom_field: "hello" }, "4e: customProps extracted");
}

// ==============================
// Test 5: buildMarkdown
// ==============================
{
	const fm = { bpm_ro_id: "test", bpm_rw_enabled: true };
	const md = buildMarkdown(fm, "\nBody");
	assert(md.startsWith("---\n"), "5a: starts with ---");
	assert(md.includes("bpm_ro_id: test"), "5b: contains field");
	assert(md.includes("\n---\n"), "5c: has closing ---");
	assert(md.endsWith("\nBody"), "5d: body at end");

	const md2 = buildMarkdown(fm, "Body");
	assert(md2.includes("---\nBody"), "5e: adds newline separator before body");
}

// ==============================
// Test 6: safeFileName
// ==============================
assertEqual(safeFileName("My Plugin"), "My Plugin", "6a: normal name");
assertEqual(safeFileName("Plugin/With\\Slash"), "Plugin-With-Slash", "6b: strips slashes");
assertEqual(safeFileName(""), "plugin", "6c: empty fallback");
assertEqual(safeFileName("   "), "plugin", "6d: whitespace fallback");
assertEqual(safeFileName("a<b>c:d|e"), "a-b-c-d-e", "6e: special chars");

// ==============================
// Test 7: strict boolean handling
// ==============================
{
	const decoded = decodeNote([
		"---",
		"bpm_ro_id: test",
		`bpm_rw_enabled: "false"`,
		`bpm_schema_version: ${CURRENT_SCHEMA_VERSION}`,
		"---",
		"",
	].join("\n"));
	assertEqual(decoded.frontmatter.bpm_rw_enabled, true, "7a: string 'false' treated as true (fallback)");
}

// ==============================
// Test 8: buildExportFrontmatter preserves custom
// ==============================
{
	const bpm = {
		bpm_ro_id: "test",
		bpm_ro_name: "Test",
		bpm_ro_group: "",
		bpm_ro_tags: [],
		bpm_ro_delay: "",
		bpm_ro_installed_via_bpm: false,
		bpm_rw_desc: "",
		bpm_rw_note: "",
		bpm_rw_enabled: true,
		bpm_rwc_repo: "",
		bpm_schema_version: CURRENT_SCHEMA_VERSION,
		bpm_version: "",
		bpm_author: "",
		bpm_id: "test",
	};
	const custom = { custom_field: "keep", tags: ["custom"] };
	const fm = buildExportFrontmatter(bpm, custom);
	assertEqual(fm.bpm_ro_id, "test", "8a: bpm field");
	assertEqual(fm.custom_field, "keep", "8b: custom field kept");
	assertEqual(fm.bpm_id, "test", "8c: bpm_id set");
}

// ==============================
// Summary
// ==============================
console.log(`\nTest results: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
