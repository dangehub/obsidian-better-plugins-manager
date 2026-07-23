/**
 * Apply the 5 semantic hunks to main.ts while preserving original line endings.
 */
const fs = require('fs');
const path = require('path');

const filePath = path.resolve(__dirname, '../src/main.ts');
let content = fs.readFileSync(filePath, 'utf-8');

// Detect EOL
const eol = content.includes('\r\n') ? '\r\n' : '\n';

// Helper: find first line matching a pattern and insert before/after
function insertAfter(pattern, text) {
  const lines = content.split(eol);
  const idx = lines.findIndex(l => l.includes(pattern));
  if (idx === -1) throw new Error('Pattern not found: ' + pattern);
  const insertLines = text.split('\n');
  lines.splice(idx + 1, 0, ...insertLines);
  content = lines.join(eol);
}

function insertBefore(pattern, text) {
  const lines = content.split(eol);
  const idx = lines.findIndex(l => l.includes(pattern));
  if (idx === -1) throw new Error('Pattern not found: ' + pattern);
  const insertLines = text.split('\n');
  lines.splice(idx, 0, ...insertLines);
  content = lines.join(eol);
}

function replaceBlock(startPattern, newBlock) {
  const lines = content.split(eol);
  const startIdx = lines.findIndex(l => l.includes(startPattern));
  if (startIdx === -1) throw new Error('Start not found: ' + startPattern);
  const newLines = newBlock.split('\n');
  lines.splice(startIdx, 1, ...newLines);
  content = lines.join(eol);
}

// Hunk 1: import
insertAfter(
  "import { ObsidianAppWithInternals, ObsidianPluginRegistry, RibbonNativeItem, WindowWithMoment, WorkspaceWithRibbon } from './obsidian-internals';",
  "import { PluginNotesService } from './plugin-notes/service';"
);

// Hunk 2: field
insertAfter(
  'public systemRibbonManager?: SystemRibbonManager;',
  '    public pluginNotesService?: PluginNotesService;'
);

// Hunk 3: onload startup
insertAfter(
  'this.agreement = new Agreement(this);',
  '\n        // 启动插件笔记导出服务\n        this.pluginNotesService = new PluginNotesService(this);\n        this.pluginNotesService.start(\n            this.settings.PLUGIN_NOTES_EXPORT_DIR,\n            this.settings.PLUGIN_NOTES_SYNC_MODE || "export-only"\n        );'
);

// Hunk 4: onunload stop
insertBefore(
  '// 临走前再清理一次',
  '        // 停止插件笔记导出服务\n        this.pluginNotesService?.stop();'
);

// Hunk 5: savePluginAndExport
replaceBlock(
  '// 保存单个插件配置。保留方法名以兼容旧调用点。',
  '    // 保存单个插件配置，并委托插件笔记导出服务。保留方法名以兼容旧调用点。\n    public async savePluginAndExport(pluginId: string) {\n        await this.saveSettings();\n        // 导出失败不影响设置保存\n        if (this.pluginNotesService) {\n            try {\n                await this.pluginNotesService.exportSingle(pluginId);\n            } catch (e) {\n                if (this.settings.DEBUG) {\n                    console.error(\'[BPM] savePluginAndExport: export failed for \"\' + pluginId + \'\"\', e);\n                }\n            }\n        }\n    }'
);

fs.writeFileSync(filePath, content, 'utf-8');
console.log('Applied 5 hunks to main.ts');
