---
concern: 修复插件笔记导出文件名：使用插件显示名称而非插件 ID
by: unknown
status: open
nodes: project/plugin-management/plugin-notes-export
created: 2026-07-24T04:24:41.527Z
---

当前 exporter.ts resolveExportPath 使用 pluginId 作为文件名（如 oh-my-memo.md），而非人类可读的 mp.name（如 OhMyMemo.md）。修复：resolveExportPath 接受可选的 displayName 参数；文件名使用 safeFileName(displayName || pluginId)；索引查找仍用 pluginId；自动迁移现有 ID 命名的文件到新的显示名称路径。影响范围：src/plugin-notes/exporter.ts、src/plugin-notes/service.ts。现有测试用例需根据文件名行为变化调整断言。
