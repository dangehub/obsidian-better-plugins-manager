/**
 * tests/run-all.cjs
 * Comprehensive plugin-notes tests using typescript.transpileModule.
 * Run: npm test
 */

const ts = require('typescript');
const path = require('path');
const fs = require('fs');
const assert = require('assert');

// ---- Mock obsidian ----
const mockNormalizePath = (p) => p.replace(/\\/g, '/').replace(/\/+/g, '/');
const mockObsidian = {
  normalizePath: mockNormalizePath,
  parseYaml: (str) => {
    if (!str || !str.trim()) return {};
    const lines = str.split('\n').filter(l => l.trim());
    if (!lines.some(l => l.indexOf(': ') > 0)) throw new Error('YAML parse error');
    const obj = {};
    lines.forEach(line => {
      const idx = line.indexOf(': '); if (idx > 0) {
        const key = line.slice(0, idx).trim(); let raw = line.slice(idx + 2).trim();
        if ((raw.startsWith('"') && raw.endsWith('"')) || (raw.startsWith("'") && raw.endsWith("'"))) { obj[key] = raw.slice(1, -1); return; }
        if (raw.startsWith('[') && raw.endsWith(']')) { obj[key] = raw.slice(1, -1).split(',').map(s => s.trim()).filter(Boolean).map(s => { if (s === 'true') return true; if (s === 'false') return false; return /^\d+$/.test(s) ? Number(s) : s; }); return; }
        if (raw === 'true') { obj[key] = true; return; } if (raw === 'false') { obj[key] = false; return; }
        if (/^\d+(\.\d+)?$/.test(raw)) { obj[key] = Number(raw); return; }
        obj[key] = raw;
      }
    });
    return obj;
  },
  stringifyYaml: (obj) => Object.entries(obj).map(([k, v]) => {
    if (Array.isArray(v)) return k + ': [' + v.join(', ') + ']';
    if (typeof v === 'boolean') return k + ': ' + v;
    if (v === null || v === undefined) return k + ': ';
    return k + ': ' + String(v);
  }).join('\n'),
};

// ---- Module loader ----
const moduleCache = new Map();
function loadMod(absPath) {
  if (moduleCache.has(absPath)) return moduleCache.get(absPath);
  const c = fs.readFileSync(absPath, 'utf-8').replace(/import\s+type\s*\{[^}]*\}\s*from\s+['"][^'"]+['"];?/g, '');
  const r = ts.transpileModule(c, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020, esModuleInterop: true, strict: false, skipLibCheck: true }, fileName: absPath });
  const m = { exports: {} };
  new Function('require', 'module', 'exports', r.outputText)(
    (id) => {
      if (id === 'obsidian') return mockObsidian;
      if (id.startsWith('.')) {
        const resolved = path.resolve(path.dirname(absPath), id);
        const withTs = resolved.endsWith('.ts') ? resolved : resolved + '.ts';
        if (fs.existsSync(withTs)) return loadMod(withTs);
      }
      try { return require(id); } catch { return undefined; }
    }, m, m.exports
  );
  moduleCache.set(absPath, m.exports);
  return m.exports;
}

const srcDir = path.resolve(__dirname, '../src');
const types = loadMod(path.join(srcDir, 'plugin-notes/types.ts'));
const exporter = loadMod(path.join(srcDir, 'plugin-notes/exporter.ts'));

const {
  decodeNote, safeFileName, isValidExportPath,
  hasStrictBooleanEnabled, getStrictEnabledValue,
  parseFrontmatter, strictStringArray, buildMarkdown,
} = types;

const { buildDirIndex, exportPluginNote } = exporter;

// ---- Mock Vault ----
const vaultFiles = new Map();
let callLog = [];
function resetVault() { vaultFiles.clear(); callLog = []; }
function logCall(fn, args) { callLog.push({ fn, args: args.map(a => typeof a === 'string' ? a.slice(0, 80) : a) }); }
function setFile(p, c) { vaultFiles.set(mockNormalizePath(p), c); }
function getFile(p) { return vaultFiles.get(mockNormalizePath(p)); }

function makeMgr(overrides = {}) {
  const settings = { DEBUG: false, PLUGIN_NOTES_EXPORT_DIR: 'BPM-Export', PLUGIN_NOTES_SYNC_MODE: 'export-only', PLUGIN_NOTES_ALLOW_ENABLED_WRITE: false, Plugins: [], BPM_INSTALLED: [], REPO_MAP: {}, ...overrides.settings };
  const appPlugins = {
    manifests: overrides.manifests || {},
    enabledPlugins: new Set(overrides.enabledPlugins || []),
    enablePluginAndSave: async (id) => { logCall('enablePluginAndSave', [id]); appPlugins.enabledPlugins.add(id); },
    disablePluginAndSave: async (id) => { logCall('disablePluginAndSave', [id]); appPlugins.enabledPlugins.delete(id); },
  };
  const adapter = {
    exists: async (p) => { logCall('exists', [p]); return vaultFiles.has(mockNormalizePath(p)); },
    read: async (p) => { logCall('read', [p]); const np = mockNormalizePath(p); if (!vaultFiles.has(np)) throw new Error('Not found'); return vaultFiles.get(np); },
    write: async (p, c) => { logCall('write', [p]); vaultFiles.set(mockNormalizePath(p), c); },
    list: async (p) => { logCall('list', [p]); const np = p; const files = [], folders = []; for (const [fp] of vaultFiles) { if (fp.startsWith(np + '/')) (fp.slice(np.length + 1).includes('/') ? folders : files).push(fp); } return { files, folders }; },
    mkdir: async (p) => { logCall('mkdir', [p]); },
    rename: async (o, n) => { logCall('rename', [o, n]); const np = mockNormalizePath(n), op = mockNormalizePath(o); if (vaultFiles.has(op)) { vaultFiles.set(np, vaultFiles.get(op)); vaultFiles.delete(op); } },
  };
  return {
    settings, manifest: { id: 'better-plugins-manager' },
    appPlugins, registerEvent: () => {},
    saveSettings: async () => { logCall('saveSettings', []); },
    app: { vault: { adapter }, workspace: {} },
  };
}

// ---- Test harness (sequential) ----
let totalPassed = 0, totalFailed = 0;
const failures = [];

function test(name, fn) {
  try {
    const result = fn();
    if (result && typeof result.then === 'function') {
      throw new Error('Use testAsync for async tests: ' + name);
    }
    totalPassed++; process.stdout.write('.');
  } catch (e) {
    totalFailed++; failures.push({ name, error: e.message || String(e) }); process.stdout.write('F');
  }
}

const testQueue = [];
function testAsync(name, fn) {
  testQueue.push({ name, fn });
}

function assertEq(a, e, m) { if (a !== e) throw new Error(`${m || ''}: expected ${JSON.stringify(e)}, got ${JSON.stringify(a)}`); }
function assertDeepEqual(a, e, m) { const as = JSON.stringify(a), es = JSON.stringify(e); if (as !== es) throw new Error(`${m || ''}: expected ${es}, got ${as}`); }

// ===================== TESTS =====================

// Group 1: parseFrontmatter / decodeNote
test('1a: no frontmatter', () => assertEq(parseFrontmatter('Hello').frontmatter, null));
test('1b: valid frontmatter', () => { const r = parseFrontmatter('---\nk: v\n---\nB'); assertEq(r.frontmatter.k, 'v'); });
test('1c: malformed yaml', () => { const r = parseFrontmatter('---\nno-kv\n---\nb'); assert(r.parseError); assertEq(r.frontmatter, null); });
test('1d: decodeNote malformed', () => { const d = decodeNote('---\nno-kv\n---\nb'); assert(d.isMalformed); });
test('1e: decodeNote BPM note', () => { const d = decodeNote('---\nbpm_ro_id: p1\n---\n'); assert(d.isBpmNote); assertEq(d.frontmatter.bpm_ro_id, 'p1'); });
test('1f: number id not accepted', () => { const d = decodeNote('---\nbpm_ro_id: 123\n---\n'); assert(!d.isBpmNote); });

// Group 2: Strict boolean
test('2a: string false not strict', () => assert(!hasStrictBooleanEnabled({ bpm_rw_enabled: 'false' })));
test('2b: real false is strict', () => { assert(hasStrictBooleanEnabled({ bpm_rw_enabled: false })); assertEq(getStrictEnabledValue({ bpm_rw_enabled: false }), false); });
test('2c: string decoded not strict', () => { const d = decodeNote('---\nbpm_ro_id: t\nbpm_rw_enabled: "false"\n---\n'); assert(!hasStrictBooleanEnabled(d.rawValues)); });
test('2d: real false stays', () => { const d = decodeNote('---\nbpm_ro_id: t\nbpm_rw_enabled: false\n---\n'); assertEq(d.frontmatter.bpm_rw_enabled, false); assert(hasStrictBooleanEnabled(d.rawValues)); });

// Group 3: safeFileName / path validation
test('3a: safeFileName', () => { assertEq(safeFileName('my-p'), 'my-p'); assertEq(safeFileName('', 'fb'), 'fb'); });
test('3b: isValidExportPath', () => {
  assert(!isValidExportPath('/abs').valid); assert(!isValidExportPath('..').valid);
  assert(!isValidExportPath('../x').valid); assert(!isValidExportPath('.obsidian').valid);
  assert(!isValidExportPath('.obsidian/plugins').valid); assert(isValidExportPath('BPM-Export').valid);
  assert(!isValidExportPath('').valid);
});

// Group 4: buildDirIndex (async)
testAsync('4a: empty dir empty', async () => { resetVault(); const idx = await buildDirIndex(makeMgr(), 'td'); assertEq(idx.idToFile.size, 0); assertEq(idx.conflictedIds.size, 0); });
testAsync('4b: single list call', async () => { resetVault(); callLog = []; await buildDirIndex(makeMgr(), 'td'); assertEq(callLog.filter(c => c.fn === 'list').length, 1); });
testAsync('4c: duplicate conflicted', async () => {
  resetVault(); setFile('td/a.md', '---\nbpm_ro_id: dup\n---\n'); setFile('td/b.md', '---\nbpm_ro_id: dup\n---\n');
  const idx = await buildDirIndex(makeMgr(), 'td');
  assert(idx.conflictedIds.has('dup'), 'dup conflict'); assert(!idx.idToFile.has('dup'), 'dup removed');
});
testAsync('4d: unowned not indexed', async () => { resetVault(); setFile('td/n.md', '---\nnot_bpm: x\n---\n'); const idx = await buildDirIndex(makeMgr(), 'td'); assertEq(idx.idToFile.size, 0); });
testAsync('4e: malformed not indexed', async () => { resetVault(); setFile('td/b.md', '---\nno-kv\n---\n'); const idx = await buildDirIndex(makeMgr(), 'td'); assertEq(idx.idToFile.size, 0); });

// Group 5: exportPluginNote (async)
testAsync('5a: id-based path', async () => {
  resetVault();
  const mgr = makeMgr({ settings: { Plugins: [{ id: 'my-p', name: 'My', enabled: true, desc: '', note: '', group: '', tags: [], delay: '' }] }, manifests: { 'my-p': { version: '1.0' } } });
  const idx = await buildDirIndex(mgr, 'td'); await exportPluginNote(mgr, idx, mgr.settings.Plugins[0]);
  assert(getFile('td/my-p.md'), 'id path'); assert(!getFile('td/My.md'), 'not name');
});
testAsync('5b: name change no rename', async () => {
  resetVault();
  const mgr = makeMgr({ settings: { Plugins: [{ id: 'p1', name: 'Old', enabled: true, desc: '', note: '', group: '', tags: [], delay: '' }] }, manifests: { p1: { version: '1.0' } } });
  const idx = await buildDirIndex(mgr, 'td'); await exportPluginNote(mgr, idx, mgr.settings.Plugins[0]);
  assert(getFile('td/p1.md')); mgr.settings.Plugins[0].name = 'New';
  await exportPluginNote(mgr, idx, mgr.settings.Plugins[0]);
  assert(!getFile('td/New.md'), 'no rename');
});
testAsync('5c: old name migrated', async () => {
  resetVault(); setFile('td/Old.md', '---\nbpm_ro_id: p1\n---\n');
  const mgr = makeMgr({ settings: { Plugins: [{ id: 'p1', name: 'Old', enabled: true, desc: '', note: '', group: '', tags: [], delay: '' }] }, manifests: { p1: { version: '1.0' } } });
  const idx = await buildDirIndex(mgr, 'td'); await exportPluginNote(mgr, idx, mgr.settings.Plugins[0]);
  assert(!getFile('td/Old.md'), 'old gone'); assert(getFile('td/p1.md'), 'new id');
});
testAsync('5d: unchanged skip', async () => {
  resetVault();
  // First export to get the exact generated content
  const mgr = makeMgr({ settings: { Plugins: [{ id: 'p1', name: 'P1', enabled: true, desc: '', note: '', group: '', tags: [], delay: '' }] }, manifests: { p1: { version: '1.0', author: 'T' } } });
  const idx1 = await buildDirIndex(mgr, 'td'); await exportPluginNote(mgr, idx1, mgr.settings.Plugins[0]);
  const content = getFile('td/p1.md');
  // Now the file exists with that content - export again
  const idx2 = await buildDirIndex(mgr, 'td'); callLog = [];
  const r = await exportPluginNote(mgr, idx2, mgr.settings.Plugins[0]);
  assert(r.skipped, 'unchanged should skip');
  assertEq(callLog.filter(c => c.fn === 'write').length, 0, 'no write');
});
testAsync('5e: unowned skip', async () => {
  resetVault(); setFile('td/p1.md', '---\nnot_bpm: x\n---\n');
  const mgr = makeMgr({ settings: { Plugins: [{ id: 'p1', name: 'P1', enabled: true, desc: '', note: '', group: '', tags: [], delay: '' }] }, manifests: { p1: { version: '1.0' } } });
  const idx = await buildDirIndex(mgr, 'td');
  const r = await exportPluginNote(mgr, idx, mgr.settings.Plugins[0]);
  assert(r.skipped, 'skip unowned'); assertEq(r.reason, 'target-unowned', 'reason');
});
testAsync('5f: conflict skip', async () => {
  resetVault(); setFile('td/a.md', '---\nbpm_ro_id: dup\n---\n'); setFile('td/b.md', '---\nbpm_ro_id: dup\n---\n');
  const mgr = makeMgr({ settings: { Plugins: [{ id: 'dup', name: 'D', enabled: true, desc: '', note: '', group: '', tags: [], delay: '' }] }, manifests: { dup: { version: '1.0' } } });
  const idx = await buildDirIndex(mgr, 'td');
  const r = await exportPluginNote(mgr, idx, mgr.settings.Plugins[0]);
  assert(r.skipped, 'conflict skip'); assertEq(r.reason, 'conflict', 'reason conflict');
});
testAsync('5g: no network', async () => {
  resetVault();
  const mgr = makeMgr({ settings: { Plugins: [{ id: 'p1', name: 'P1', enabled: true, desc: '', note: '', group: '', tags: [], delay: '' }] }, manifests: { p1: { version: '1.0' } } });
  const idx = await buildDirIndex(mgr, 'td'); callLog = [];
  await exportPluginNote(mgr, idx, mgr.settings.Plugins[0]);
  assertEq(callLog.filter(c => c.fn.includes('requestUrl') || c.fn.includes('fetch')).length, 0);
});
testAsync('5h: nested ensureDir', async () => {
  resetVault();
  const mgr = makeMgr({ settings: { Plugins: [{ id: 'p1', name: 'P1', enabled: true, desc: '', note: '', group: '', tags: [], delay: '' }] }, manifests: { p1: { version: '1.0' } } });
  const idx = await buildDirIndex(mgr, 'a/b/c'); callLog = [];
  await exportPluginNote(mgr, idx, mgr.settings.Plugins[0]);
  assert(getFile('a/b/c/p1.md'), 'file'); assert(callLog.filter(c => c.fn === 'mkdir').length >= 1, 'mkdir');
});
testAsync('5i: custom props and body preserved', async () => {
  resetVault(); setFile('td/p1.md', '---\nbpm_ro_id: p1\nmy_c: keep\n---\nuser body\n');
  const mgr = makeMgr({ settings: { Plugins: [{ id: 'p1', name: 'P1', enabled: true, desc: '', note: '', group: '', tags: [], delay: '' }] }, manifests: { p1: { version: '1.0' } } });
  const idx = await buildDirIndex(mgr, 'td'); await exportPluginNote(mgr, idx, mgr.settings.Plugins[0]);
  const out = getFile('td/p1.md');
  assert(out.includes('my_c: keep'), 'custom prop'); assert(out.includes('user body'), 'user body');
});
testAsync('5j: TOCTOU ownership', async () => {
  resetVault(); setFile('td/p1.md', '---\nnot_bpm: x\n---\n');
  const mgr = makeMgr({ settings: { Plugins: [{ id: 'p1', name: 'P1', enabled: true, desc: '', note: '', group: '', tags: [], delay: '' }] }, manifests: { p1: { version: '1.0' } } });
  const idx = await buildDirIndex(mgr, 'td');
  const r = await exportPluginNote(mgr, idx, mgr.settings.Plugins[0]);
  assert(r.skipped, 'skip'); assertEq(r.reason, 'target-unowned', 'reason');
});
testAsync('5k: write failure cleanup', async () => {
  resetVault();
  const mgr = makeMgr({ settings: { Plugins: [{ id: 'p1', name: 'P1', enabled: true, desc: '', note: '', group: '', tags: [], delay: '' }] }, manifests: { p1: { version: '1.0' } } });
  const idx = await buildDirIndex(mgr, 'td');
  const origWrite = mgr.app.vault.adapter.write;
  mgr.app.vault.adapter.write = async () => { throw new Error('write fail'); };
  const r = await exportPluginNote(mgr, idx, mgr.settings.Plugins[0], {
    hooks: { beforeWrite: (p, c) => { logCall('beforeWrite', [p]); }, writeSuccess: () => {}, writeFailure: (p) => { logCall('writeFailure', [p]); } },
  });
  assert(r.skipped); assertEq(r.reason, 'write-failed');
  assert(callLog.filter(c => c.fn === 'writeFailure').length >= 1, 'cleanup called');
  mgr.app.vault.adapter.write = origWrite;
});

// Group 6: strict tags
test('6a: mixed not valid', () => { const r = strictStringArray(['a', 1, 'b']); assert(!r.valid); });
test('6b: all strings valid', () => { const r = strictStringArray(['a', 'b']); assert(r.valid); assertDeepEqual(r.items, ['a', 'b']); });

// ===================== FINALIZE =====================
async function finish() {
  for (const { name, fn } of testQueue) {
    try {
      await fn();
      totalPassed++; process.stdout.write('.');
    } catch (e) {
      totalFailed++; failures.push({ name, error: e.message || String(e) }); process.stdout.write('F');
    }
  }
  console.log(`\n\nResults: ${totalPassed} passed, ${totalFailed} failed`);
  if (failures.length) { console.error('\nFailures:'); failures.forEach(f => console.error('  - ' + f.name + ': ' + f.error)); }
  if (totalFailed) process.exit(1);
}
finish();
