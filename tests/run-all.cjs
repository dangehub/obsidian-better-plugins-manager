/**
 * tests/run-all.cjs
 * Comprehensive plugin-notes tests using typescript.transpileModule.
 * Failure to load ANY production module exits non-zero.
 * Run: npm test
 */

const ts = require('typescript');
const path = require('path');
const fs = require('fs');
const assert = require('assert');

// ---- Mock classes needed by obsidian ----
class TFileMock { constructor(p) { this.path = p; } }
class EventRefMock {}

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
  TFile: TFileMock,
  EventRef: EventRefMock,
};

// ---- Module loader (strict) ----
const moduleCache = new Map();
const srcDir = path.resolve(__dirname, '../src');

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
        if (fs.existsSync(resolved)) return require(resolved);
      }
      if (id.startsWith('src/')) {
        const resolved = path.join(srcDir, id.slice(4)) + '.ts';
        if (fs.existsSync(resolved)) return loadMod(resolved);
      }
      if (id === 'main') {
        const resolved = path.join(srcDir, 'main.ts');
        return loadMod(resolved);
      }
      const builtins = ['typescript', 'assert', 'path', 'fs', 'util', 'events'];
      if (builtins.includes(id)) return require(id);
      throw new Error(`Module loader: unexpected require('${id}') from ${path.relative(process.cwd(), absPath)}`);
    }, m, m.exports
  );
  moduleCache.set(absPath, m.exports);
  return m.exports;
}

// Force-load ALL production modules - any failure exits non-zero
const types = loadMod(path.join(srcDir, 'plugin-notes/types.ts'));
const exporter = loadMod(path.join(srcDir, 'plugin-notes/exporter.ts'));
const syncMod = loadMod(path.join(srcDir, 'plugin-notes/sync.ts'));
const serviceMod = loadMod(path.join(srcDir, 'plugin-notes/service.ts'));
const migrationsMod = loadMod(path.join(srcDir, 'migrations.ts'));

const { decodeNote, safeFileName, isValidExportPath, hasStrictBooleanEnabled, getStrictEnabledValue, parseFrontmatter, strictStringArray } = types;
const { buildDirIndex, exportPluginNote } = exporter;
const { SyncService } = syncMod;
const { PluginNotesService } = serviceMod;
const { migrate1015, runMigrations } = migrationsMod;

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
    settings, manifest: { id: 'better-plugins-manager' }, appPlugins, registerEvent: () => {},
    saveSettings: async () => { logCall('saveSettings', []); },
    app: { vault: { adapter }, workspace: {} },
  };
}

function makeSyncMgr(overrides = {}) {
  const m = makeMgr(overrides);
  m.app.vault.on = (evt, cb) => { logCall('vault.on', [evt]); return { ref: evt, cb }; };
  m.app.vault.offref = (ref) => { logCall('vault.offref', [ref.ref]); };
  return m;
}

// ---- Capture console.error for expected failures ----
function captureConsole() {
  const orig = console.error;
  const captured = [];
  console.error = (...args) => { captured.push(args.map(a => String(a).slice(0, 100)).join(' ')); };
  return { restore: () => { console.error = orig; }, captured };
}

// ---- Test harness (sequential) ----
let totalPassed = 0, totalFailed = 0;
const failures = [];
const testQueue = [];

function testAsync(name, fn) { testQueue.push({ name, fn }); }
function assertEq(a, e, m) { if (a !== e) throw new Error(`${m||''}: expected ${JSON.stringify(e)}, got ${JSON.stringify(a)}`); }
function assertDeepEqual(a, e, m) { const as = JSON.stringify(a), es = JSON.stringify(e); if (as !== es) throw new Error(`${m||''}: expected ${es}, got ${as}`); }

// ===================== TESTS =====================

// ----- Group 1: types -----
testAsync('1a', () => assertEq(parseFrontmatter('Hello').frontmatter, null));
testAsync('1b', () => { const r = parseFrontmatter('---\nk: v\n---\nB'); assertEq(r.frontmatter.k, 'v'); });
testAsync('1c', () => { const r = parseFrontmatter('---\nno-kv\n---\nb'); assert(r.parseError); assertEq(r.frontmatter, null); });
testAsync('1d', () => { const d = decodeNote('---\nno-kv\n---\nb'); assert(d.isMalformed); });
testAsync('1e', () => { const d = decodeNote('---\nbpm_ro_id: p1\n---\n'); assert(d.isBpmNote); assertEq(d.frontmatter.bpm_ro_id, 'p1'); });
testAsync('1f', () => { const d = decodeNote('---\nbpm_ro_id: 123\n---\n'); assert(!d.isBpmNote); });
testAsync('1g', () => assert(!hasStrictBooleanEnabled({ bpm_rw_enabled: 'false' })));
testAsync('1h', () => { assert(hasStrictBooleanEnabled({ bpm_rw_enabled: false })); assertEq(getStrictEnabledValue({ bpm_rw_enabled: false }), false); });
testAsync('1i', () => { const d = decodeNote('---\nbpm_ro_id: t\nbpm_rw_enabled: "false"\n---\n'); assert(!hasStrictBooleanEnabled(d.rawValues)); });
testAsync('1j', () => { const d = decodeNote('---\nbpm_ro_id: t\nbpm_rw_enabled: false\n---\n'); assertEq(d.frontmatter.bpm_rw_enabled, false); assert(hasStrictBooleanEnabled(d.rawValues)); });
testAsync('1k', () => { assertEq(safeFileName('my-p'), 'my-p'); assertEq(safeFileName('', 'fb'), 'fb'); });
testAsync('1l', () => {
  assert(!isValidExportPath('/abs').valid); assert(!isValidExportPath('..').valid);
  assert(!isValidExportPath('../x').valid); assert(!isValidExportPath('.obsidian').valid);
  assert(!isValidExportPath('.obsidian/plugins').valid); assert(isValidExportPath('BPM-Export').valid);
  assert(!isValidExportPath('').valid); assert(!isValidExportPath('a\\..\\b').valid);
});
testAsync('1m', () => { const r = strictStringArray(['a', 1, 'b']); assert(!r.valid); });
testAsync('1n', () => { const r = strictStringArray(['a', 'b']); assert(r.valid); assertDeepEqual(r.items, ['a', 'b']); });

// ----- Group 2: exporter buildDirIndex -----
testAsync('2a', async () => { resetVault(); const idx = await buildDirIndex(makeMgr(), 'td'); assertEq(idx.idToFile.size, 0); assertEq(idx.conflictedIds.size, 0); });
testAsync('2b', async () => { resetVault(); callLog = []; await buildDirIndex(makeMgr(), 'td'); assertEq(callLog.filter(c => c.fn === 'list').length, 1); });
testAsync('2c', async () => {
  resetVault(); setFile('td/a.md', '---\nbpm_ro_id: dup\n---\n'); setFile('td/b.md', '---\nbpm_ro_id: dup\n---\n');
  const idx = await buildDirIndex(makeMgr(), 'td'); assert(idx.conflictedIds.has('dup')); assert(!idx.idToFile.has('dup'));
});
testAsync('2d', async () => { resetVault(); setFile('td/n.md', '---\nnot_bpm: x\n---\n'); const idx = await buildDirIndex(makeMgr(), 'td'); assertEq(idx.idToFile.size, 0); });
testAsync('2e', async () => { resetVault(); setFile('td/b.md', '---\nno-kv\n---\n'); const idx = await buildDirIndex(makeMgr(), 'td'); assertEq(idx.idToFile.size, 0); });

// ----- Group 3: exporter exportPluginNote -----
testAsync('3a', async () => {
  resetVault(); const mgr = makeMgr({ settings: { Plugins: [{ id: 'my-p', name: 'My', enabled: true, desc: '', note: '', group: '', tags: [], delay: '' }] }, manifests: { 'my-p': { version: '1.0' } } });
  const idx = await buildDirIndex(mgr, 'td'); await exportPluginNote(mgr, idx, mgr.settings.Plugins[0]);
  assert(getFile('td/my-p.md')); assert(!getFile('td/My.md'));
});
testAsync('3b', async () => {
  resetVault(); const mgr = makeMgr({ settings: { Plugins: [{ id: 'p1', name: 'Old', enabled: true, desc: '', note: '', group: '', tags: [], delay: '' }] }, manifests: { p1: { version: '1.0' } } });
  const idx = await buildDirIndex(mgr, 'td'); await exportPluginNote(mgr, idx, mgr.settings.Plugins[0]);
  assert(getFile('td/p1.md')); mgr.settings.Plugins[0].name = 'New';
  await exportPluginNote(mgr, idx, mgr.settings.Plugins[0]); assert(!getFile('td/New.md'));
});
testAsync('3c', async () => {
  resetVault(); setFile('td/Old.md', '---\nbpm_ro_id: p1\n---\n');
  const mgr = makeMgr({ settings: { Plugins: [{ id: 'p1', name: 'Old', enabled: true, desc: '', note: '', group: '', tags: [], delay: '' }] }, manifests: { p1: { version: '1.0' } } });
  const idx = await buildDirIndex(mgr, 'td'); await exportPluginNote(mgr, idx, mgr.settings.Plugins[0]);
  assert(!getFile('td/Old.md')); assert(getFile('td/p1.md'));
});
testAsync('3d', async () => {
  resetVault(); const mgr = makeMgr({ settings: { Plugins: [{ id: 'p1', name: 'P1', enabled: true, desc: '', note: '', group: '', tags: [], delay: '' }] }, manifests: { p1: { version: '1.0', author: 'T' } } });
  const idx1 = await buildDirIndex(mgr, 'td'); await exportPluginNote(mgr, idx1, mgr.settings.Plugins[0]);
  const idx2 = await buildDirIndex(mgr, 'td'); callLog = [];
  const r = await exportPluginNote(mgr, idx2, mgr.settings.Plugins[0]); assert(r.skipped);
  assertEq(callLog.filter(c => c.fn === 'write').length, 0);
});
testAsync('3e', async () => {
  resetVault(); setFile('td/p1.md', '---\nnot_bpm: x\n---\n');
  const mgr = makeMgr({ settings: { Plugins: [{ id: 'p1', name: 'P1', enabled: true, desc: '', note: '', group: '', tags: [], delay: '' }] }, manifests: { p1: { version: '1.0' } } });
  const idx = await buildDirIndex(mgr, 'td');
  const r = await exportPluginNote(mgr, idx, mgr.settings.Plugins[0]); assert(r.skipped); assertEq(r.reason, 'target-unowned');
});
testAsync('3f', async () => {
  resetVault(); setFile('td/a.md', '---\nbpm_ro_id: dup\n---\n'); setFile('td/b.md', '---\nbpm_ro_id: dup\n---\n');
  const mgr = makeMgr({ settings: { Plugins: [{ id: 'dup', name: 'D', enabled: true, desc: '', note: '', group: '', tags: [], delay: '' }] }, manifests: { dup: { version: '1.0' } } });
  const idx = await buildDirIndex(mgr, 'td');
  const r = await exportPluginNote(mgr, idx, mgr.settings.Plugins[0]); assert(r.skipped); assertEq(r.reason, 'conflict');
});
testAsync('3g', async () => {
  resetVault(); const mgr = makeMgr({ settings: { Plugins: [{ id: 'p1', name: 'P1', enabled: true, desc: '', note: '', group: '', tags: [], delay: '' }] }, manifests: { p1: { version: '1.0' } } });
  const idx = await buildDirIndex(mgr, 'td'); callLog = [];
  await exportPluginNote(mgr, idx, mgr.settings.Plugins[0]);
  assertEq(callLog.filter(c => c.fn.includes('requestUrl') || c.fn.includes('fetch')).length, 0);
});
testAsync('3h', async () => {
  resetVault(); const mgr = makeMgr({ settings: { Plugins: [{ id: 'p1', name: 'P1', enabled: true, desc: '', note: '', group: '', tags: [], delay: '' }] }, manifests: { p1: { version: '1.0' } } });
  const idx = await buildDirIndex(mgr, 'a/b/c'); callLog = [];
  await exportPluginNote(mgr, idx, mgr.settings.Plugins[0]);
  assert(getFile('a/b/c/p1.md')); assert(callLog.filter(c => c.fn === 'mkdir').length >= 1);
});
testAsync('3i', async () => {
  resetVault(); setFile('td/p1.md', '---\nbpm_ro_id: p1\nmy_c: keep\n---\nuser body\n');
  const mgr = makeMgr({ settings: { Plugins: [{ id: 'p1', name: 'P1', enabled: true, desc: '', note: '', group: '', tags: [], delay: '' }] }, manifests: { p1: { version: '1.0' } } });
  const idx = await buildDirIndex(mgr, 'td'); await exportPluginNote(mgr, idx, mgr.settings.Plugins[0]);
  const out = getFile('td/p1.md'); assert(out.includes('my_c: keep')); assert(out.includes('user body'));
});
testAsync('3j', async () => {
  resetVault(); setFile('td/p1.md', '---\nnot_bpm: x\n---\n');
  const mgr = makeMgr({ settings: { Plugins: [{ id: 'p1', name: 'P1', enabled: true, desc: '', note: '', group: '', tags: [], delay: '' }] }, manifests: { p1: { version: '1.0' } } });
  const idx = await buildDirIndex(mgr, 'td');
  const r = await exportPluginNote(mgr, idx, mgr.settings.Plugins[0]); assert(r.skipped); assertEq(r.reason, 'target-unowned');
});
testAsync('3k', async () => {
  resetVault(); const mgr = makeMgr({ settings: { Plugins: [{ id: 'p1', name: 'P1', enabled: true, desc: '', note: '', group: '', tags: [], delay: '' }] }, manifests: { p1: { version: '1.0' } } });
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

// ----- Group 4: SyncService -----
testAsync('4a FIFO', async () => {
  const mgr = makeSyncMgr(); const svc = new SyncService(mgr);
  const results = [];
  svc['queue'].push(async () => { results.push(1); });
  svc['queue'].push(async () => { results.push(2); });
  await new Promise(r => setTimeout(r, 200));
  assertDeepEqual(results, [1, 2]); svc.stop();
});
testAsync('4b TTL', async () => {
  const mgr = makeSyncMgr(); const svc = new SyncService(mgr);
  svc.start('td'); svc['suppress'].ttlMs = 10;
  const tok = svc['suppress'].register('td/p1.md', 'data');
  assert(svc['suppress'].tokens.some(t => t.id === tok));
  await new Promise(r => setTimeout(r, 50));
  assert(!svc['suppress'].tokens.some(t => t.id === tok)); svc.stop();
});
testAsync('4c stop during read', async () => {
  resetVault(); let readResolve;
  const readPromise = new Promise(r => { readResolve = r; });
  const mgr = makeSyncMgr({
    settings: { Plugins: [{ id: 'p1', name: 'P1', enabled: true, desc: 'old', note: '', group: '', tags: [], delay: '' }],
      PLUGIN_NOTES_SYNC_MODE: 'two-way', PLUGIN_NOTES_ALLOW_ENABLED_WRITE: false },
    manifests: { p1: { version: '1.0' } },
  });
  const origRead = mgr.app.vault.adapter.read;
  mgr.app.vault.adapter.read = async (p) => { logCall('read-hang', [p]); await readPromise; return '---\nbpm_ro_id: p1\nbpm_rw_desc: new\n---\n'; };
  const svc = new SyncService(mgr); svc.start('td');
  setFile('td/p1.md', '---\nbpm_ro_id: p1\nbpm_rw_desc: initial\n---\n');
  const handlerPromise = svc['handleFileChange']('td/p1.md');
  await new Promise(r => setTimeout(r, 50));
  svc.stop(); readResolve(); await handlerPromise;
  assertEq(mgr.settings.Plugins[0].desc, 'old');
  mgr.app.vault.adapter.read = origRead;
});
testAsync('4d self-write', async () => {
  resetVault();
  const mgr = makeSyncMgr({
    settings: { PLUGIN_NOTES_EXPORT_DIR: 'td', PLUGIN_NOTES_SYNC_MODE: 'two-way', PLUGIN_NOTES_ALLOW_ENABLED_WRITE: false,
      Plugins: [{ id: 'p1', name: 'P1', enabled: true, desc: 'desc', note: '', group: '', tags: [], delay: '' }], BPM_INSTALLED: [], REPO_MAP: {} },
    manifests: { p1: { version: '1.0' } },
  });
  let modifyCb = null;
  const origOn = mgr.app.vault.on;
  mgr.app.vault.on = (evt, cb) => { logCall('vault.on', [evt]); if (evt === 'modify') modifyCb = cb; return { ref: evt, cb }; };
  const svc = new SyncService(mgr); svc.start('td');
  const idx = await buildDirIndex(mgr, 'td');
  await exportPluginNote(mgr, idx, mgr.settings.Plugins[0], { hooks: svc.writeHooks });
  assert(modifyCb !== null);
  const writtenContent = getFile('td/p1.md'); assert(writtenContent);
  callLog = [];
  modifyCb(new TFileMock('td/p1.md'));
  await new Promise(r => setTimeout(r, 800));
  assertEq(callLog.filter(c => c.fn === 'saveSettings').length, 0);
  svc.stop(); mgr.app.vault.on = origOn;
});
testAsync('4e per-path+queue', async () => {
  resetVault();
  const mgr = makeSyncMgr({
    settings: { PLUGIN_NOTES_EXPORT_DIR: 'td', PLUGIN_NOTES_SYNC_MODE: 'two-way', PLUGIN_NOTES_ALLOW_ENABLED_WRITE: false,
      Plugins: [{ id: 'p1', name: 'P1', enabled: true, desc: 'old1', note: '', group: '', tags: [], delay: '' },
               { id: 'p2', name: 'P2', enabled: true, desc: 'old2', note: '', group: '', tags: [], delay: '' }], BPM_INSTALLED: [], REPO_MAP: {} },
    manifests: { p1: { version: '1.0' }, p2: { version: '1.0' } },
  });
  let modifyCb = null;
  const origOn = mgr.app.vault.on;
  mgr.app.vault.on = (evt, cb) => { if (evt === 'modify') modifyCb = cb; return { ref: evt, cb }; };
  const svc = new SyncService(mgr); svc.start('td');
  setFile('td/p1.md', '---\nbpm_ro_id: p1\nbpm_rw_desc: old1\n---\n');
  setFile('td/p2.md', '---\nbpm_ro_id: p2\nbpm_rw_desc: old2\n---\n');
  setFile('td/p1.md', '---\nbpm_ro_id: p1\nbpm_rw_desc: new1\n---\n');
  setFile('td/p2.md', '---\nbpm_ro_id: p2\nbpm_rw_desc: new2\n---\n');
  callLog = [];
  modifyCb(new TFileMock('td/p1.md')); modifyCb(new TFileMock('td/p2.md'));
  await new Promise(r => setTimeout(r, 800));
  assertEq(mgr.settings.Plugins[0].desc, 'new1'); assertEq(mgr.settings.Plugins[1].desc, 'new2');
  assert(callLog.filter(c => c.fn === 'saveSettings').length >= 1);
  svc.stop(); mgr.app.vault.on = origOn;
});
testAsync('4f precise cleanup', async () => {
  const svc = new SyncService(makeSyncMgr()); svc.start('td');
  const tok1 = svc['suppress'].register('td/p1.md', 'c1');
  const tok2 = svc['suppress'].register('td/p1.md', 'c2');
  assertEq(svc['suppress'].tokens.length, 2);
  svc['suppress'].removeExact(tok2);
  assertEq(svc['suppress'].tokens.length, 1);
  assertEq(svc['suppress'].tokens[0].id, tok1); svc.stop();
});

// ----- Group 5: writeback -----
testAsync('5a string false', async () => {
  resetVault();
  const mgr = makeSyncMgr({ settings: { Plugins: [{ id: 'p1', name: 'P1', enabled: false, desc: '', note: '', group: '', tags: [], delay: '' }],
    PLUGIN_NOTES_SYNC_MODE: 'two-way', PLUGIN_NOTES_ALLOW_ENABLED_WRITE: true }, manifests: { p1: { version: '1.0' } }, enabledPlugins: [] });
  setFile('td/p1.md', '---\nbpm_ro_id: p1\nbpm_rw_enabled: "false"\n---\n');
  const svc = new SyncService(mgr); svc.start('td');
  await svc['handleFileChange']('td/p1.md');
  assert(!mgr.appPlugins.enabledPlugins.has('p1')); assertEq(mgr.settings.Plugins[0].enabled, false); svc.stop();
});
testAsync('5b strict false', async () => {
  resetVault();
  const mgr = makeSyncMgr({ settings: { Plugins: [{ id: 'p1', name: 'P1', enabled: true, desc: '', note: '', group: '', tags: [], delay: '' }],
    PLUGIN_NOTES_SYNC_MODE: 'two-way', PLUGIN_NOTES_ALLOW_ENABLED_WRITE: true }, manifests: { p1: { version: '1.0' } }, enabledPlugins: ['p1'] });
  setFile('td/p1.md', '---\nbpm_ro_id: p1\nbpm_rw_enabled: false\n---\n');
  const svc = new SyncService(mgr); svc.start('td'); callLog = [];
  await svc['handleFileChange']('td/p1.md');
  assert(callLog.some(c => c.fn === 'disablePluginAndSave')); assert(!mgr.appPlugins.enabledPlugins.has('p1')); svc.stop();
});
testAsync('5c BPM self', async () => {
  resetVault();
  const mgr = makeSyncMgr({ settings: { Plugins: [{ id: 'better-plugins-manager', name: 'BPM', enabled: true, desc: '', note: '', group: '', tags: [], delay: '' }],
    PLUGIN_NOTES_SYNC_MODE: 'two-way', PLUGIN_NOTES_ALLOW_ENABLED_WRITE: true }, manifests: {}, enabledPlugins: ['better-plugins-manager'] });
  mgr.manifest.id = 'better-plugins-manager'; mgr.settings.Plugins[0].id = 'better-plugins-manager';
  setFile('td/better-plugins-manager.md', '---\nbpm_ro_id: better-plugins-manager\nbpm_rw_enabled: false\n---\n');
  const svc = new SyncService(mgr); svc.start('td'); callLog = [];
  await svc['handleFileChange']('td/better-plugins-manager.md');
  assertEq(callLog.filter(c => c.fn === 'disablePluginAndSave').length, 0); assertEq(mgr.settings.Plugins[0].enabled, true); svc.stop();
});
testAsync('5d API fail', async () => {
  resetVault();
  const mgr = makeSyncMgr({ settings: { Plugins: [{ id: 'p1', name: 'P1', enabled: true, desc: '', note: '', group: '', tags: [], delay: '' }],
    PLUGIN_NOTES_SYNC_MODE: 'two-way', PLUGIN_NOTES_ALLOW_ENABLED_WRITE: true }, manifests: { p1: { version: '1.0' } }, enabledPlugins: ['p1'] });
  mgr.appPlugins.disablePluginAndSave = async () => { throw new Error('API fail'); };
  setFile('td/p1.md', '---\nbpm_ro_id: p1\nbpm_rw_enabled: false\n---\n');
  const svc = new SyncService(mgr); svc.start('td');
  const cap = captureConsole();
  await svc['handleFileChange']('td/p1.md'); cap.restore();
  assertEq(mgr.settings.Plugins[0].enabled, true); assert(mgr.appPlugins.enabledPlugins.has('p1')); svc.stop();
});
testAsync('5e mixed tags', async () => {
  resetVault();
  const mgr = makeSyncMgr({ settings: { Plugins: [{ id: 'p1', name: 'P1', enabled: true, desc: '', note: '', group: '', tags: ['old'], delay: '' }],
    PLUGIN_NOTES_SYNC_MODE: 'two-way', PLUGIN_NOTES_ALLOW_ENABLED_WRITE: false }, manifests: { p1: { version: '1.0' } } });
  setFile('td/p1.md', '---\nbpm_ro_id: p1\nbpm_rw_tags: [tag1, 42]\n---\n');
  const svc = new SyncService(mgr); svc.start('td');
  await svc['handleFileChange']('td/p1.md');
  assertDeepEqual(mgr.settings.Plugins[0].tags, ['old']); svc.stop();
});

// ----- Group 6: PluginNotesService -----
testAsync('6a empty dir', async () => {
  resetVault(); callLog = []; const svc = new PluginNotesService(makeMgr());
  assert(svc.start('', 'export-only')); assert(!svc.isRunning);
  await new Promise(r => setTimeout(r, 50));
  assertEq(callLog.filter(c => ['list','read','write','mkdir','vault.on'].includes(c.fn)).length, 0);
});
testAsync('6b invalid path', async () => { const svc = new PluginNotesService(makeMgr()); assert(!svc.start('/abs', 'export-only')); assert(!svc.isRunning); });
testAsync('6c .obsidian', async () => { const svc = new PluginNotesService(makeMgr()); assert(!svc.start('.obsidian', 'export-only')); });

// ----- Group 7: Migration -----
testAsync('7a runMigrations 1.0.14 + MV=1.0.14: no 1.0.15', async () => {
  const s = { EXPORT_DIR: 'Legacy', PLUGIN_NOTES_EXPORT_DIR: '', PLUGIN_NOTES_SYNC_MODE: 'two-way', PLUGIN_NOTES_ALLOW_ENABLED_WRITE: true, MIGRATION_VERSION: '1.0.14', Plugins: [] };
  const m = { settings: s, manifest: { version: '1.0.14' }, saveSettings: async () => { logCall('saveSettings', []); }, appPlugins: {}, app: { vault: { adapter: { list: async()=>({files:[],folders:[]}), read: async()=>'', exists: async()=>false, write: async()=>{} } } }, registerEvent: ()=>{} };
  callLog = [];
  await runMigrations(m);
  assertEq(s.PLUGIN_NOTES_EXPORT_DIR, '', 'not migrated');
  assertEq(s.MIGRATION_VERSION, '1.0.14', 'stays 1.0.14');
});
testAsync('7b runMigrations 1.0.15 + MV=1.0.14: runs 1.0.15', async () => {
  const s = { EXPORT_DIR: 'Legacy', PLUGIN_NOTES_EXPORT_DIR: '', PLUGIN_NOTES_SYNC_MODE: '', PLUGIN_NOTES_ALLOW_ENABLED_WRITE: undefined, MIGRATION_VERSION: '1.0.14', Plugins: [] };
  const m = { settings: s, manifest: { version: '1.0.15' }, saveSettings: async () => { logCall('saveSettings', []); }, appPlugins: {}, app: { vault: { adapter: { list: async()=>({files:[],folders:[]}), read: async()=>'', exists: async()=>false, write: async()=>{} } } }, registerEvent: ()=>{} };
  callLog = [];
  await runMigrations(m);
  assertEq(s.PLUGIN_NOTES_EXPORT_DIR, 'Legacy', 'migrated');
  assertEq(s.PLUGIN_NOTES_SYNC_MODE, 'export-only', 'mode set');
  assertEq(s.PLUGIN_NOTES_ALLOW_ENABLED_WRITE, false, 'write set');
  assertEq(s.MIGRATION_VERSION, '1.0.15', 'advanced to 1.0.15');
});
testAsync('7c runMigrations MV=99.0.0 > current: no change', async () => {
  const s = { EXPORT_DIR: '', PLUGIN_NOTES_EXPORT_DIR: '', PLUGIN_NOTES_SYNC_MODE: '', PLUGIN_NOTES_ALLOW_ENABLED_WRITE: undefined, MIGRATION_VERSION: '99.0.0', Plugins: [] };
  const m = { settings: s, manifest: { version: '1.0.14' }, saveSettings: async () => { logCall('saveSettings', []); }, appPlugins: {}, app: { vault: { adapter: { list: async()=>({files:[],folders:[]}), read: async()=>'', exists: async()=>false, write: async()=>{} } } }, registerEvent: ()=>{} };
  callLog = [];
  await runMigrations(m);
  assertEq(s.MIGRATION_VERSION, '99.0.0', 'preserved');
});
testAsync('7d migrate1015 from 1.0.14', async () => {
  const s = { EXPORT_DIR: 'Old-Dir', PLUGIN_NOTES_EXPORT_DIR: '', PLUGIN_NOTES_SYNC_MODE: '', PLUGIN_NOTES_ALLOW_ENABLED_WRITE: undefined, MIGRATION_VERSION: '1.0.14', Plugins: [] };
  const m = { settings: s, manifest: { version: '1.0.15' }, saveSettings: async () => {} };
  const c = await migrate1015(m); assert(c); assertEq(s.PLUGIN_NOTES_EXPORT_DIR, 'Old-Dir');
  assertEq(s.PLUGIN_NOTES_SYNC_MODE, 'export-only'); assertEq(s.PLUGIN_NOTES_ALLOW_ENABLED_WRITE, false);
});
testAsync('7e no overwrite', async () => {
  const s = { EXPORT_DIR: 'Old', PLUGIN_NOTES_EXPORT_DIR: 'Existing', PLUGIN_NOTES_SYNC_MODE: 'two-way', PLUGIN_NOTES_ALLOW_ENABLED_WRITE: true, MIGRATION_VERSION: '1.0.14', Plugins: [] };
  const m = { settings: s, manifest: { version: '1.0.15' }, saveSettings: async () => {} };
  const c = await migrate1015(m); assert(!c); assertEq(s.PLUGIN_NOTES_EXPORT_DIR, 'Existing');
});

// 8: PluginNotesService + Exporter integration — repo in frontmatter
testAsync('8a exportAll with repo', async () => {
  resetVault();
  let resolveCalls = 0;
  const settings = { PLUGIN_NOTES_EXPORT_DIR: 'BPM-Export', PLUGIN_NOTES_SYNC_MODE: 'export-only', PLUGIN_NOTES_ALLOW_ENABLED_WRITE: false,
    Plugins: [{ id: 'memo', name: 'Memo', enabled: true, desc: '', note: '', group: '', tags: [], delay: '' }],
    BPM_INSTALLED: [], REPO_MAP: {}, TAGS: [], DEBUG: false };
  const mgr = makeMgr({ settings, manifests: { memo: { version: '1.0', author: 'T' } } });
  mgr.settings = settings;
  mgr.repoResolver = {
    resolveRepos: async (ids) => {
      resolveCalls++;
      for (const id of ids) { mgr.settings.REPO_MAP[id] = 'dangehub/obsidian-oh-my-memo'; }
      return { 'memo': 'dangehub/obsidian-oh-my-memo' };
    },
  };
  const svc = new PluginNotesService(mgr);
  svc.start('BPM-Export', 'export-only');
  await svc.exportAll();
  assert(resolveCalls >= 1, '8a resolver called');
  const written = getFile('BPM-Export/memo.md');
  assert(!!written, '8b file written');
  const decoded = decodeNote(written);
  assertEq(decoded.frontmatter.bpm_rwc_repo, 'dangehub/obsidian-oh-my-memo', '8c repo in frontmatter');
  svc.stop();
});
testAsync('8b exportAll with resolver throw', async () => {
  resetVault();
  const settings = { PLUGIN_NOTES_EXPORT_DIR: 'BPM-Export', PLUGIN_NOTES_SYNC_MODE: 'export-only', PLUGIN_NOTES_ALLOW_ENABLED_WRITE: false,
    Plugins: [{ id: 'unknown-p', name: 'Unknown', enabled: true, desc: '', note: '', group: '', tags: [], delay: '' }],
    BPM_INSTALLED: [], REPO_MAP: {}, TAGS: [], DEBUG: false };
  const mgr = makeMgr({ settings, manifests: { 'unknown-p': { version: '1.0' } } });
  mgr.settings = settings;
  mgr.repoResolver = { resolveRepos: async () => { throw new Error('resolver fail'); } };
  const svc = new PluginNotesService(mgr);
  svc.start('BPM-Export', 'export-only');
  await svc.exportAll();
  const written = getFile('BPM-Export/unknown-p.md');
  assert(!!written, '8d file written despite resolver fail');
  const decoded = decodeNote(written);
  assertEq(decoded.frontmatter.bpm_rwc_repo, '', '8e repo empty when unknown');
  svc.stop();
});

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
