/**
 * tests/resolver.cjs
 * RepoResolver public-behavior tests only.
 * Runs in a fresh process to avoid polluting shared mock state.
 * Run: node tests/resolver.cjs
 */

const ts = require('typescript');
const path = require('path');
const fs = require('fs');

const mockNormalizePath = (p) => p.replace(/\\/g, '/').replace(/\/+/g, '/');
const mockObsidian = {
  normalizePath: mockNormalizePath,
  requestUrl: async () => ({ json: [], status: 200 }),
  parseYaml: () => ({}),
  stringifyYaml: (obj) => Object.entries(obj||{}).map(([k,v]) => {
    if (Array.isArray(v)) return k + ': [' + v.join(', ') + ']';
    if (typeof v === 'boolean') return k + ': ' + v;
    return k + ': ' + String(v);
  }).join('\n'),
  TFile: class { constructor(p) { this.path = p; } },
  EventRef: class {},
};

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
      if (id === 'main') return loadMod(path.join(srcDir, 'main.ts'));
      if (id.startsWith('src/')) return loadMod(path.join(srcDir, id.slice(4)) + '.ts');
      const builtins = ['typescript', 'assert', 'path', 'fs', 'util', 'events'];
      if (builtins.includes(id)) return require(id);
      throw new Error('Unknown: ' + id);
    }, m, m.exports
  );
  moduleCache.set(absPath, m.exports);
  return m.exports;
}

const { RepoResolver } = loadMod(path.join(srcDir, 'repo-resolver.ts'));

let totalPassed = 0, totalFailed = 0;
function checkEq(a, e, m) { if (a !== e) { totalFailed++; console.error(`FAIL ${m}: expected ${JSON.stringify(e)}, got ${JSON.stringify(a)}`); } else { totalPassed++; process.stdout.write('.'); } }
function checkTrue(cond, m) { if (!cond) { totalFailed++; console.error(`FAIL ${m}`); } else { totalPassed++; process.stdout.write('.'); } }

function makeVaultAdapter(files = {}) {
  const store = { ...files };
  return {
    exists: async (p) => p in store,
    read: async (p) => { if (!(p in store)) throw new Error('NF'); return store[p]; },
    write: async (p, c) => { store[p] = c; },
    list: async () => ({ files: [], folders: [] }),
    mkdir: async () => {},
  };
}

async function run() {
  // 1: REPO_MAP only — no network
  {
    const settings = { REPO_MAP: { known: 'owner/r' }, TAGS: [], DEBUG: false };
    let netCalls = 0;
    mockObsidian.requestUrl = async () => { netCalls++; return { json: [], status: 200 }; };
    const resolver = new RepoResolver({ settings, manifest: { id: 'bpm', version: '1.0.14' },
      app: { vault: { adapter: makeVaultAdapter() } }, saveSettings: async () => {},
      appPlugins: { manifests: {}, enabledPlugins: new Set() }, registerEvent: () => {} });
    const r1 = await resolver.resolveRepos(['known']);
    checkEq(r1['known'], 'owner/r', '1a settings map');
    checkEq(netCalls, 0, '1b no network for known-only');
    const r2 = await resolver.resolveRepos(['known', 'unknown']);
    checkTrue(!r2['unknown'], '1c unknown null');
    checkEq(netCalls, 1, '1d one request for unknown');
  }

  // 2: Community list hit — writes to settings, saves once
  {
    const settings = { REPO_MAP: {}, TAGS: [], DEBUG: false };
    let saves = 0;
    mockObsidian.requestUrl = async () => ({ json: [{ id: 'store-p', repo: 'owner/sp' }], status: 200 });
    const resolver = new RepoResolver({ settings, manifest: { id: 'bpm', version: '1.0.14' },
      app: { vault: { adapter: makeVaultAdapter() } }, saveSettings: async () => { saves++; },
      appPlugins: { manifests: {}, enabledPlugins: new Set() }, registerEvent: () => {} });
    const result = await resolver.resolveRepos(['store-p', 'other']);
    checkEq(result['store-p'], 'owner/sp', '2a community hit');
    checkTrue(!result['other'], '2b other null');
    checkEq(settings.REPO_MAP['store-p'], 'owner/sp', '2c written');
    checkEq(saves, 1, '2d one save');
  }

  // 3: Multiple missing — single request + single save
  {
    const settings = { REPO_MAP: { a: 'known/a' }, TAGS: [], DEBUG: false };
    let saves = 0, reqCalls = 0;
    mockObsidian.requestUrl = async () => { reqCalls++; return { json: [{ id: 's1', repo: 'store/s1' }, { id: 's2', repo: 'store/s2' }], status: 200 }; };
    const resolver = new RepoResolver({ settings, manifest: { id: 'bpm', version: '1.0.14' },
      app: { vault: { adapter: makeVaultAdapter() } }, saveSettings: async () => { saves++; },
      appPlugins: { manifests: {}, enabledPlugins: new Set() }, registerEvent: () => {} });
    const result = await resolver.resolveRepos(['a', 's1', 's2']);
    checkEq(result['a'], 'known/a', '3a');
    checkEq(result['s1'], 'store/s1', '3b');
    checkEq(result['s2'], 'store/s2', '3c');
    checkEq(reqCalls, 1, '3d one request');
    checkEq(saves, 1, '3e one save');
  }

  // 4: REPO_MAP not overwritten
  {
    const settings = { REPO_MAP: { existing: 'manual/repo' }, TAGS: [], DEBUG: false };
    mockObsidian.requestUrl = async () => ({ json: [{ id: 'existing', repo: 'store/different' }], status: 200 });
    const resolver = new RepoResolver({ settings, manifest: { id: 'bpm', version: '1.0.14' },
      app: { vault: { adapter: makeVaultAdapter() } }, saveSettings: async () => {},
      appPlugins: { manifests: {}, enabledPlugins: new Set() }, registerEvent: () => {} });
    const result = await resolver.resolveRepos(['existing']);
    checkEq(result['existing'], 'manual/repo', '4a not overwritten');
    checkEq(settings.REPO_MAP['existing'], 'manual/repo', '4b original preserved');
  }

  // 5: Network failure
  {
    const settings = { REPO_MAP: {}, TAGS: [], DEBUG: false };
    mockObsidian.requestUrl = async () => { throw new Error('net fail'); };
    const resolver = new RepoResolver({ settings, manifest: { id: 'bpm', version: '1.0.14' },
      app: { vault: { adapter: makeVaultAdapter() } }, saveSettings: async () => {},
      appPlugins: { manifests: {}, enabledPlugins: new Set() }, registerEvent: () => {} });
    const result = await resolver.resolveRepos(['unknown']);
    checkTrue(!result['unknown'], '5a net fail');
  }

  // 6: Custom repo (oh-my-memo)
  {
    const settings = { REPO_MAP: { 'oh-my-memo': 'dangehub/obsidian-oh-my-memo' }, TAGS: [], DEBUG: false };
    const resolver = new RepoResolver({ settings, manifest: { id: 'bpm', version: '1.0.14' },
      app: { vault: { adapter: makeVaultAdapter() } }, saveSettings: async () => {},
      appPlugins: { manifests: {}, enabledPlugins: new Set() }, registerEvent: () => {} });
    const result = await resolver.resolveRepos(['oh-my-memo']);
    checkEq(result['oh-my-memo'], 'dangehub/obsidian-oh-my-memo', '6a custom');
  }

  // 7: Cache-loaded batch — saves once; second call no save
  {
    const settings = { REPO_MAP: {}, TAGS: [], DEBUG: false };
    let saves = 0;
    const vault = { adapter: makeVaultAdapter({ ['.obsidian/better-plugins-manager-community-plugins-cache.json']: '{"cached-p": "cache/repo"}' }), configDir: '.obsidian' };
    mockObsidian.requestUrl = async () => ({ json: [], status: 200 });
    const resolver = new RepoResolver({ settings, manifest: { id: 'bpm', version: '1.0.14' },
      app: { vault }, saveSettings: async () => { saves++; },
      appPlugins: { manifests: {}, enabledPlugins: new Set() }, registerEvent: () => {} });
    const r1 = await resolver.resolveRepos(['cached-p']);
    checkEq(r1['cached-p'], 'cache/repo', '7a cache hit');
    checkEq(settings.REPO_MAP['cached-p'], 'cache/repo', '7b written');
    checkEq(saves, 1, '7c saves once');
    saves = 0;
    const r2 = await resolver.resolveRepos(['cached-p']);
    checkEq(r2['cached-p'], 'cache/repo', '7d second');
    checkEq(saves, 0, '7e no save second');
  }

  // 8: saveSettings failure still returns result
  {
    const settings = { REPO_MAP: {}, TAGS: [], DEBUG: false };
    let shouldThrow = true;
    mockObsidian.requestUrl = async () => ({ json: [{ id: 'p1', repo: 'owner/p1' }], status: 200 });
    const resolver = new RepoResolver({ settings, manifest: { id: 'bpm', version: '1.0.14' },
      app: { vault: { adapter: makeVaultAdapter() } }, saveSettings: async () => { if (shouldThrow) throw new Error('save fail'); },
      appPlugins: { manifests: {}, enabledPlugins: new Set() }, registerEvent: () => {} });
    const result = await resolver.resolveRepos(['p1']);
    checkEq(result['p1'], 'owner/p1', '8a result despite save fail');
    checkEq(settings.REPO_MAP['p1'], 'owner/p1', '8b memory preserved');
  }

  console.log(`\nResolver tests: ${totalPassed} passed, ${totalFailed} failed`);
  if (totalFailed) process.exit(1);
}

run().catch(e => { console.error('FATAL:', e); process.exit(1); });
