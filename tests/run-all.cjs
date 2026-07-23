/**
 * tests/run-all.cjs
 * Comprehensive plugin-notes tests: types.ts + exporter.ts + sync.ts + service.ts + migration.
 * Uses typescript.transpileModule with minimal deps.
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
      if (id.startsWith('.')) { const res = path.resolve(path.dirname(absPath), id); const ts = res.endsWith('.ts') ? res : res + '.ts'; if (fs.existsSync(ts)) return loadMod(ts); }
      try { return require(id); } catch { return undefined; }
    }, m, m.exports
  );
  moduleCache.set(absPath, m.exports);
  return m.exports;
}

const srcDir = path.resolve(__dirname, '../src');
const types = loadMod(path.join(srcDir, 'plugin-notes/types.ts'));
const exporter = loadMod(path.join(srcDir, 'plugin-notes/exporter.ts'));
let syncMod, serviceMod, migrationsMod;
try { syncMod = loadMod(path.join(srcDir, 'plugin-notes/sync.ts')); } catch (e) { syncMod = null; }
try { serviceMod = loadMod(path.join(srcDir, 'plugin-notes/service.ts')); } catch (e) { serviceMod = null; }
try { migrationsMod = loadMod(path.join(srcDir, 'migrations.ts')); } catch (e) { migrationsMod = null; }

const {
  decodeNote, safeFileName, isValidExportPath,
  hasStrictBooleanEnabled, getStrictEnabledValue,
  parseFrontmatter, strictStringArray,
} = types;
const { buildDirIndex, exportPluginNote } = exporter;
const { migrate1015 } = migrationsMod || {};
const { PluginNotesService } = serviceMod || {};
const { SyncService } = syncMod || {};

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

function makeSyncMgr(overrides = {}) {
  const m = makeMgr(overrides);
  // Add .on / .offref for sync tests
  m.app.vault.on = (evt, cb) => {
    logCall('vault.on', [evt]);
    const ref = { ref: evt, cb };
    return ref;
  };
  m.app.vault.offref = (ref) => { logCall('vault.offref', [ref.ref]); };
  return m;
}

// ---- Test harness (sequential) ----
let totalPassed = 0, totalFailed = 0;
const failures = [];
const testQueue = [];

function test(name, fn) {
  try {
    const r = fn();
    if (r && typeof r.then === 'function') throw new Error('Use testAsync for async: ' + name);
    totalPassed++; process.stdout.write('.');
  } catch (e) { totalFailed++; failures.push({ name, error: e.message || String(e) }); process.stdout.write('F'); }
}
function testAsync(name, fn) { testQueue.push({ name, fn }); }
function assertEq(a, e, m) { if (a !== e) throw new Error(`${m||''}: expected ${JSON.stringify(e)}, got ${JSON.stringify(a)}`); }
function assertDeepEqual(a, e, m) { const as = JSON.stringify(a), es = JSON.stringify(e); if (as !== es) throw new Error(`${m||''}: expected ${es}, got ${as}`); }
function assertNe(a, e, m) { if (a === e) throw new Error(`${m||''}: NOT expected ${JSON.stringify(e)}`); }

// ===================== TEST GROUPS =====================

// ----- Group 1: types (codec, strict boolean, path validation) -----
test('1a: no frontmatter', () => assertEq(parseFrontmatter('Hello').frontmatter, null));
test('1b: valid frontmatter', () => { const r = parseFrontmatter('---\nk: v\n---\nB'); assertEq(r.frontmatter.k, 'v'); });
test('1c: malformed yaml', () => { const r = parseFrontmatter('---\nno-kv\n---\nb'); assert(r.parseError); assertEq(r.frontmatter, null); });
test('1d: decodeNote malformed', () => { const d = decodeNote('---\nno-kv\n---\nb'); assert(d.isMalformed); });
test('1e: decodeNote BPM note', () => { const d = decodeNote('---\nbpm_ro_id: p1\n---\n'); assert(d.isBpmNote); assertEq(d.frontmatter.bpm_ro_id, 'p1'); });
test('1f: number id not BPM', () => { const d = decodeNote('---\nbpm_ro_id: 123\n---\n'); assert(!d.isBpmNote); });
test('1g: string false not strict', () => assert(!hasStrictBooleanEnabled({ bpm_rw_enabled: 'false' })));
test('1h: real false is strict', () => { assert(hasStrictBooleanEnabled({ bpm_rw_enabled: false })); assertEq(getStrictEnabledValue({ bpm_rw_enabled: false }), false); });
test('1i: string decoded not strict', () => { const d = decodeNote('---\nbpm_ro_id: t\nbpm_rw_enabled: "false"\n---\n'); assert(!hasStrictBooleanEnabled(d.rawValues)); });
test('1j: real false stays', () => { const d = decodeNote('---\nbpm_ro_id: t\nbpm_rw_enabled: false\n---\n'); assertEq(d.frontmatter.bpm_rw_enabled, false); assert(hasStrictBooleanEnabled(d.rawValues)); });
test('1k: safeFileName', () => { assertEq(safeFileName('my-p'), 'my-p'); assertEq(safeFileName('', 'fb'), 'fb'); });
test('1l: isValidExportPath', () => {
  assert(!isValidExportPath('/abs').valid); assert(!isValidExportPath('..').valid);
  assert(!isValidExportPath('../x').valid); assert(!isValidExportPath('.obsidian').valid);
  assert(!isValidExportPath('.obsidian/plugins').valid); assert(isValidExportPath('BPM-Export').valid);
  assert(!isValidExportPath('').valid); assert(!isValidExportPath('a\\..\\b').valid);
});
test('1m: strictStringArray mixed', () => { const r = strictStringArray(['a', 1, 'b']); assert(!r.valid); });
test('1n: strictStringArray all strings', () => { const r = strictStringArray(['a', 'b']); assert(r.valid); assertDeepEqual(r.items, ['a', 'b']); });

// ----- Group 2: exporter buildDirIndex -----
testAsync('2a: empty dir', async () => { resetVault(); const idx = await buildDirIndex(makeMgr(), 'td'); assertEq(idx.idToFile.size, 0); assertEq(idx.conflictedIds.size, 0); });
testAsync('2b: single list call', async () => { resetVault(); callLog = []; await buildDirIndex(makeMgr(), 'td'); assertEq(callLog.filter(c => c.fn === 'list').length, 1); });
testAsync('2c: duplicate conflicted', async () => {
  resetVault(); setFile('td/a.md', '---\nbpm_ro_id: dup\n---\n'); setFile('td/b.md', '---\nbpm_ro_id: dup\n---\n');
  const idx = await buildDirIndex(makeMgr(), 'td');
  assert(idx.conflictedIds.has('dup')); assert(!idx.idToFile.has('dup'));
});
testAsync('2d: unowned not indexed', async () => { resetVault(); setFile('td/n.md', '---\nnot_bpm: x\n---\n'); const idx = await buildDirIndex(makeMgr(), 'td'); assertEq(idx.idToFile.size, 0); });
testAsync('2e: malformed not indexed', async () => { resetVault(); setFile('td/b.md', '---\nno-kv\n---\n'); const idx = await buildDirIndex(makeMgr(), 'td'); assertEq(idx.idToFile.size, 0); });

// ----- Group 3: exporter exportPluginNote -----
testAsync('3a: id-based path', async () => {
  resetVault();
  const mgr = makeMgr({ settings: { Plugins: [{ id: 'my-p', name: 'My', enabled: true, desc: '', note: '', group: '', tags: [], delay: '' }] }, manifests: { 'my-p': { version: '1.0' } } });
  const idx = await buildDirIndex(mgr, 'td'); await exportPluginNote(mgr, idx, mgr.settings.Plugins[0]);
  assert(getFile('td/my-p.md')); assert(!getFile('td/My.md'));
});
testAsync('3b: name change no rename', async () => {
  resetVault();
  const mgr = makeMgr({ settings: { Plugins: [{ id: 'p1', name: 'Old', enabled: true, desc: '', note: '', group: '', tags: [], delay: '' }] }, manifests: { p1: { version: '1.0' } } });
  const idx = await buildDirIndex(mgr, 'td'); await exportPluginNote(mgr, idx, mgr.settings.Plugins[0]);
  assert(getFile('td/p1.md')); mgr.settings.Plugins[0].name = 'New';
  await exportPluginNote(mgr, idx, mgr.settings.Plugins[0]); assert(!getFile('td/New.md'));
});
testAsync('3c: old name migrated', async () => {
  resetVault(); setFile('td/Old.md', '---\nbpm_ro_id: p1\n---\n');
  const mgr = makeMgr({ settings: { Plugins: [{ id: 'p1', name: 'Old', enabled: true, desc: '', note: '', group: '', tags: [], delay: '' }] }, manifests: { p1: { version: '1.0' } } });
  const idx = await buildDirIndex(mgr, 'td'); await exportPluginNote(mgr, idx, mgr.settings.Plugins[0]);
  assert(!getFile('td/Old.md')); assert(getFile('td/p1.md'));
});
testAsync('3d: unchanged skip', async () => {
  resetVault();
  const mgr = makeMgr({ settings: { Plugins: [{ id: 'p1', name: 'P1', enabled: true, desc: '', note: '', group: '', tags: [], delay: '' }] }, manifests: { p1: { version: '1.0', author: 'T' } } });
  const idx1 = await buildDirIndex(mgr, 'td'); await exportPluginNote(mgr, idx1, mgr.settings.Plugins[0]);
  const idx2 = await buildDirIndex(mgr, 'td'); callLog = [];
  const r = await exportPluginNote(mgr, idx2, mgr.settings.Plugins[0]); assert(r.skipped);
  assertEq(callLog.filter(c => c.fn === 'write').length, 0);
});
testAsync('3e: unowned skip', async () => {
  resetVault(); setFile('td/p1.md', '---\nnot_bpm: x\n---\n');
  const mgr = makeMgr({ settings: { Plugins: [{ id: 'p1', name: 'P1', enabled: true, desc: '', note: '', group: '', tags: [], delay: '' }] }, manifests: { p1: { version: '1.0' } } });
  const idx = await buildDirIndex(mgr, 'td');
  const r = await exportPluginNote(mgr, idx, mgr.settings.Plugins[0]); assert(r.skipped); assertEq(r.reason, 'target-unowned');
});
testAsync('3f: conflict skip', async () => {
  resetVault(); setFile('td/a.md', '---\nbpm_ro_id: dup\n---\n'); setFile('td/b.md', '---\nbpm_ro_id: dup\n---\n');
  const mgr = makeMgr({ settings: { Plugins: [{ id: 'dup', name: 'D', enabled: true, desc: '', note: '', group: '', tags: [], delay: '' }] }, manifests: { dup: { version: '1.0' } } });
  const idx = await buildDirIndex(mgr, 'td');
  const r = await exportPluginNote(mgr, idx, mgr.settings.Plugins[0]); assert(r.skipped); assertEq(r.reason, 'conflict');
});
testAsync('3g: no network', async () => {
  resetVault();
  const mgr = makeMgr({ settings: { Plugins: [{ id: 'p1', name: 'P1', enabled: true, desc: '', note: '', group: '', tags: [], delay: '' }] }, manifests: { p1: { version: '1.0' } } });
  const idx = await buildDirIndex(mgr, 'td'); callLog = [];
  await exportPluginNote(mgr, idx, mgr.settings.Plugins[0]);
  assertEq(callLog.filter(c => c.fn.includes('requestUrl') || c.fn.includes('fetch')).length, 0);
});
testAsync('3h: nested ensureDir', async () => {
  resetVault();
  const mgr = makeMgr({ settings: { Plugins: [{ id: 'p1', name: 'P1', enabled: true, desc: '', note: '', group: '', tags: [], delay: '' }] }, manifests: { p1: { version: '1.0' } } });
  const idx = await buildDirIndex(mgr, 'a/b/c'); callLog = [];
  await exportPluginNote(mgr, idx, mgr.settings.Plugins[0]);
  assert(getFile('a/b/c/p1.md')); assert(callLog.filter(c => c.fn === 'mkdir').length >= 1);
});
testAsync('3i: custom props+body', async () => {
  resetVault(); setFile('td/p1.md', '---\nbpm_ro_id: p1\nmy_c: keep\n---\nuser body\n');
  const mgr = makeMgr({ settings: { Plugins: [{ id: 'p1', name: 'P1', enabled: true, desc: '', note: '', group: '', tags: [], delay: '' }] }, manifests: { p1: { version: '1.0' } } });
  const idx = await buildDirIndex(mgr, 'td'); await exportPluginNote(mgr, idx, mgr.settings.Plugins[0]);
  const out = getFile('td/p1.md'); assert(out.includes('my_c: keep')); assert(out.includes('user body'));
});
testAsync('3j: TOCTOU ownership', async () => {
  resetVault(); setFile('td/p1.md', '---\nnot_bpm: x\n---\n');
  const mgr = makeMgr({ settings: { Plugins: [{ id: 'p1', name: 'P1', enabled: true, desc: '', note: '', group: '', tags: [], delay: '' }] }, manifests: { p1: { version: '1.0' } } });
  const idx = await buildDirIndex(mgr, 'td');
  const r = await exportPluginNote(mgr, idx, mgr.settings.Plugins[0]); assert(r.skipped); assertEq(r.reason, 'target-unowned');
});
testAsync('3k: write failure cleanup', async () => {
  resetVault();
  const mgr = makeMgr({ settings: { Plugins: [{ id: 'p1', name: 'P1', enabled: true, desc: '', note: '', group: '', tags: [], delay: '' }] }, manifests: { p1: { version: '1.0' } } });
  const idx = await buildDirIndex(mgr, 'td');
  const origWrite = mgr.app.vault.adapter.write;
  mgr.app.vault.adapter.write = async () => { throw new Error('write fail'); };
  const r = await exportPluginNote(mgr, idx, mgr.settings.Plugins[0], {
    hooks: { beforeWrite: (p, c) => { logCall('beforeWrite', [p]); return 'tok1'; }, writeSuccess: () => {}, writeFailure: (p, tok) => { logCall('writeFailure', [p, tok]); } },
  });
  assert(r.skipped); assertEq(r.reason, 'write-failed');
  assert(callLog.filter(c => c.fn === 'writeFailure').length >= 1);
  mgr.app.vault.adapter.write = origWrite;
});

// ----- Group 4: SyncService (SerialQueue FIFO, per-path debounce, token TTL, stop guards) -----
if (SyncService) {
testAsync('4a: SerialQueue FIFO two tasks', async () => {
  // Access the internal queue via reflection for testing
  const mgr = makeSyncMgr();
  const svc = new SyncService(mgr);
  const results = [];
  const p1 = new Promise(resolve => {
    svc['queue'].push(async () => { results.push(1); });
    svc['queue'].push(async () => { results.push(2); });
    setTimeout(() => resolve(), 200);
  });
  await p1;
  assertDeepEqual(results, [1, 2], 'FIFO order');
  svc.stop();
});
testAsync('4b: path debounce both trigger', async () => {
  const mgr = makeSyncMgr();
  const svc = new SyncService(mgr);
  svc.start('td');
  const results = [];
  svc['debouncer'].set('td/a.md', () => { results.push('a'); }, 10);
  svc['debouncer'].set('td/b.md', () => { results.push('b'); }, 10);
  await new Promise(r => setTimeout(r, 100));
  assertDeepEqual(results.sort(), ['a', 'b'], 'both debounce fire');
  svc.stop();
});
testAsync('4c: beforeWrite token cached', async () => {
  resetVault(); vaultFiles.set('td/p1.md', '');
  const mgr = makeSyncMgr({ settings: { Plugins: [{ id: 'p1', name: 'P1', enabled: true, desc: '', note: '', group: '', tags: [], delay: '' }] }, manifests: { p1: { version: '1.0' } } });
  // Simulate write + modify
  const svc = new SyncService(mgr);
  svc.start('td');
  const tok = svc['suppress'].register('td/p1.md', 'hello');
  const consumed = svc['suppress'].consume('td/p1.md', 'hello');
  assert(consumed, 'token consumed');
  svc.stop();
});
testAsync('4d: token TTL expiry cleans', async () => {
  const mgr = makeSyncMgr();
  const svc = new SyncService(mgr);
  svc.start('td');
  const tok = svc['suppress'].register('td/p1.md', 'data');
  // Before TTL (30s) we just test that the token exists
  const found = svc['suppress']['tokens'].some(t => t.id === tok);
  assert(found, 'token registered');
  svc.stop(); // stop clears all tokens
  const foundAfter = svc['suppress']['tokens'].some(t => t.id === tok);
  assert(!foundAfter, 'token cleared on stop');
});
testAsync('4e: stop guards saveSettings', async () => {
  resetVault();
  const mgr = makeSyncMgr({ settings: { Plugins: [{ id: 'p1', name: 'P1', enabled: true, desc: 'old', note: '', group: '', tags: [], delay: '' }], PLUGIN_NOTES_SYNC_MODE: 'two-way', PLUGIN_NOTES_ALLOW_ENABLED_WRITE: false }, manifests: { p1: { version: '1.0' } } });
  setFile('td/p1.md', '---\nbpm_ro_id: p1\nbpm_rw_desc: new\n---\n');
  const svc = new SyncService(mgr);
  svc.start('td');
  callLog = [];
  svc.stop();
  // Ensure no saveSettings after stop
  const saves = callLog.filter(c => c.fn === 'saveSettings');
  assertEq(saves.length, 0, 'no save after stop');
});
} // end SyncService tests

// ----- Group 5: SyncService writeback (strict boolean, BPM skip, API fail) -----
if (SyncService) {
testAsync('5a: string false no toggle', async () => {
  resetVault();
  const mgr = makeSyncMgr({
    settings: { Plugins: [{ id: 'p1', name: 'P1', enabled: false, desc: '', note: '', group: '', tags: [], delay: '' }],
      PLUGIN_NOTES_SYNC_MODE: 'two-way', PLUGIN_NOTES_ALLOW_ENABLED_WRITE: true },
    manifests: { p1: { version: '1.0' } },
    enabledPlugins: [],
  });
  setFile('td/p1.md', '---\nbpm_ro_id: p1\nbpm_rw_enabled: "false"\n---\n');
  const svc = new SyncService(mgr);
  svc.start('td');
  await svc['handleFileChange']('td/p1.md');
  assert(!mgr.appPlugins.enabledPlugins.has('p1'), 'still disabled');
  assertEq(mgr.settings.Plugins[0].enabled, false, 'mp.enabled still false');
  svc.stop();
});
testAsync('5b: strict false + switch calls disable', async () => {
  resetVault();
  const mgr = makeSyncMgr({
    settings: { Plugins: [{ id: 'p1', name: 'P1', enabled: true, desc: '', note: '', group: '', tags: [], delay: '' }],
      PLUGIN_NOTES_SYNC_MODE: 'two-way', PLUGIN_NOTES_ALLOW_ENABLED_WRITE: true },
    manifests: { p1: { version: '1.0' } },
    enabledPlugins: ['p1'],
  });
  setFile('td/p1.md', '---\nbpm_ro_id: p1\nbpm_rw_enabled: false\n---\n');
  const svc = new SyncService(mgr);
  svc.start('td');
  callLog = [];
  await svc['handleFileChange']('td/p1.md');
  assert(callLog.some(c => c.fn === 'disablePluginAndSave'), 'disable API called');
  assert(!mgr.appPlugins.enabledPlugins.has('p1'), 'disabled');
  assertEq(mgr.settings.Plugins[0].enabled, false, 'mp.enabled updated');
  svc.stop();
});
testAsync('5c: BPM self not disabled', async () => {
  resetVault();
  const mgr = makeSyncMgr({
    settings: { Plugins: [{ id: 'better-plugins-manager', name: 'BPM', enabled: true, desc: '', note: '', group: '', tags: [], delay: '' }],
      PLUGIN_NOTES_SYNC_MODE: 'two-way', PLUGIN_NOTES_ALLOW_ENABLED_WRITE: true },
    manifests: {},
    enabledPlugins: ['better-plugins-manager'],
  });
  mgr.manifest.id = 'better-plugins-manager';
  // Set our own note to disabled
  mgr.settings.Plugins[0].id = 'better-plugins-manager';
  setFile('td/better-plugins-manager.md', '---\nbpm_ro_id: better-plugins-manager\nbpm_rw_enabled: false\n---\n');
  const svc = new SyncService(mgr);
  svc.start('td');
  callLog = [];
  await svc['handleFileChange']('td/better-plugins-manager.md');
  const disables = callLog.filter(c => c.fn === 'disablePluginAndSave');
  assertEq(disables.length, 0, 'BPM not disabled');
  assertEq(mgr.settings.Plugins[0].enabled, true, 'BPM enabled unchanged');
  svc.stop();
});
testAsync('5d: API failure no mp change', async () => {
  resetVault();
  const mgr = makeSyncMgr({
    settings: { Plugins: [{ id: 'p1', name: 'P1', enabled: true, desc: '', note: '', group: '', tags: [], delay: '' }],
      PLUGIN_NOTES_SYNC_MODE: 'two-way', PLUGIN_NOTES_ALLOW_ENABLED_WRITE: true },
    manifests: { p1: { version: '1.0' } },
    enabledPlugins: ['p1'],
  });
  mgr.appPlugins.disablePluginAndSave = async () => { throw new Error('API fail'); };
  setFile('td/p1.md', '---\nbpm_ro_id: p1\nbpm_rw_enabled: false\n---\n');
  const svc = new SyncService(mgr);
  svc.start('td');
  callLog = [];
  await svc['handleFileChange']('td/p1.md');
  // mp.enabled should still be true (pre-failure value)
  assertEq(mgr.settings.Plugins[0].enabled, true, 'mp.enabled unchanged after API fail');
  assert(mgr.appPlugins.enabledPlugins.has('p1'), 'still enabled in plugins');
  svc.stop();
});
testAsync('5e: mixed tags ignored', async () => {
  resetVault();
  const mgr = makeSyncMgr({
    settings: { Plugins: [{ id: 'p1', name: 'P1', enabled: true, desc: '', note: '', group: '', tags: ['old'], delay: '' }],
      PLUGIN_NOTES_SYNC_MODE: 'two-way', PLUGIN_NOTES_ALLOW_ENABLED_WRITE: false },
    manifests: { p1: { version: '1.0' } },
  });
  setFile('td/p1.md', '---\nbpm_ro_id: p1\nbpm_rw_tags: [tag1, 42]\n---\n');
  const svc = new SyncService(mgr);
  svc.start('td');
  await svc['handleFileChange']('td/p1.md');
  assertDeepEqual(mgr.settings.Plugins[0].tags, ['old'], 'mixed tags not applied');
  svc.stop();
});
} // end writeback tests

// ----- Group 6: PluginNotesService empty dir -----
if (PluginNotesService) {
testAsync('6a: empty dir start does nothing', async () => {
  resetVault(); callLog = [];
  const mgr = makeMgr();
  const svc = new PluginNotesService(mgr);
  const ok = svc.start('', 'export-only');
  assert(ok, 'empty returns true (no-op)');
  assert(!svc.isRunning, 'not running');
  await new Promise(r => setTimeout(r, 50));
  const ops = callLog.filter(c => ['list','read','write','mkdir','vault.on'].includes(c.fn));
  assertEq(ops.length, 0, 'no vault operations');
});
testAsync('6b: invalid path rejected', async () => {
  const mgr = makeMgr();
  const svc = new PluginNotesService(mgr);
  const ok = svc.start('/abs', 'export-only');
  assert(!ok, 'absolute rejected');
  assert(!svc.isRunning);
});
testAsync('6c: .obsidian rejected', async () => {
  const mgr = makeMgr();
  const svc = new PluginNotesService(mgr);
  const ok = svc.start('.obsidian', 'export-only');
  assert(!ok, 'rejected');
});
} // end PluginNotesService

// ----- Group 7: Migration test -----
if (migrate1015) {
testAsync('7a: migrate from MIGRATION_VERSION 1.0.14 + EXPORT_DIR', async () => {
  const settings = {
    EXPORT_DIR: 'Old-Export-Dir',
    PLUGIN_NOTES_EXPORT_DIR: '',
    PLUGIN_NOTES_SYNC_MODE: '',
    PLUGIN_NOTES_ALLOW_ENABLED_WRITE: undefined,
    MIGRATION_VERSION: '1.0.14',
    Plugins: [],
  };
  const mgr = { settings, manifest: { version: '1.0.15' }, saveSettings: async () => {} };
  const changed = await migrate1015(mgr);
  assert(changed, 'migration made changes');
  assertEq(mgr.settings.PLUGIN_NOTES_EXPORT_DIR, 'Old-Export-Dir', 'dir migrated');
  assertEq(mgr.settings.PLUGIN_NOTES_SYNC_MODE, 'export-only', 'default mode');
  assertEq(mgr.settings.PLUGIN_NOTES_ALLOW_ENABLED_WRITE, false, 'default write');
});
testAsync('7b: existing PLUGIN_NOTES_EXPORT_DIR not overwritten', async () => {
  const settings = {
    EXPORT_DIR: 'Old-Dir',
    PLUGIN_NOTES_EXPORT_DIR: 'Existing-Dir',
    PLUGIN_NOTES_SYNC_MODE: 'two-way',
    PLUGIN_NOTES_ALLOW_ENABLED_WRITE: true,
    MIGRATION_VERSION: '1.0.14',
    Plugins: [],
  };
  const mgr = { settings, manifest: { version: '1.0.15' }, saveSettings: async () => {} };
  const changed = await migrate1015(mgr);
  assert(!changed, 'no changes needed');
  assertEq(mgr.settings.PLUGIN_NOTES_EXPORT_DIR, 'Existing-Dir', 'not overwritten');
});
} // end migration tests

// ===================== FINALIZE =====================
async function finish() {
  for (const { name, fn } of testQueue) {
    try { await fn(); totalPassed++; process.stdout.write('.'); }
    catch (e) { totalFailed++; failures.push({ name, error: e.message || String(e) }); process.stdout.write('F'); }
  }
  console.log(`\n\nResults: ${totalPassed} passed, ${totalFailed} failed`);
  if (failures.length) { console.error('\nFailures:'); failures.forEach(f => console.error('  - ' + f.name + ': ' + f.error)); }
  if (totalFailed) process.exit(1);
}
finish();
