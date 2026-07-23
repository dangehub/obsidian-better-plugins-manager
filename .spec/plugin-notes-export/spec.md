---
title: plugin-notes-export
status: active
hue: 120
desc: 插件信息 Markdown 导出与 Obsidian Bases 集成
code: src/plugin-notes/
related:
  - src/main.ts
  - src/settings/data.ts
  - src/settings/ui/manager-basis.ts
  - src/migrations.ts
  - src/plugin-notes/service.ts
  - src/plugin-notes/types.ts
  - src/plugin-notes/exporter.ts
  - src/plugin-notes/sync.ts
---
# plugin-notes-export — 插件信息 Markdown 导出与 Bases 集成

提供 BPM 插件元数据的 Markdown 前端导出能力，兼容 Obsidian Bases 视图。作为独立模块存在，不寄生在 `transfer-pack` 或 `main.ts`。

## 边界与保证

- **默认不操作**：导出目录为空字符串时，不扫描、不读取、不写入任何笔记文件。
- **目录隔离**：只在用户显式配置的导出目录内创建、读取、更新带有 `bpm_` 前缀 frontmatter 的 Markdown 文件。目录外不进行任何操作。
- **不碰普通笔记**：不读取或修改用户 vault 中非导出目录内的笔记。
- **安全写入**：只使用 Obsidian Vault/Adapter 公共 API（`exists`、`read`、`write`、`list`、`mkdir`、`rename`），不使用 `fs/promises`、`path`、`getBasePath`、`Node Buffer`。
- **移动端可用**：所有功能基于 Vault API，不依赖桌面端文件系统能力。

## Schema 与字段约定

### frontmatter 字段

| 字段 | 类型 | 模式 | 说明 |
|------|------|------|------|
| `bpm_ro_id` | string | RO | 插件唯一标识（obsidian plugin id） |
| `bpm_ro_name` | string | RO | 插件名称 |
| `bpm_ro_group` | string | RO | 分组 ID |
| `bpm_ro_tags` | string[] | RO | 标签 ID 列表 |
| `bpm_ro_delay` | string | RO | 延迟配置 ID |
| `bpm_ro_installed_via_bpm` | boolean | RO | 是否通过 BPM 安装 |
| `bpm_rw_desc` | string | RW | 插件描述 |
| `bpm_rw_note` | string | RW | 用户备注 |
| `bpm_rw_enabled` | boolean | RW | 启用状态 |
| `bpm_rwc_repo` | string | RWC | 仓库地址（条件可写） |
| `bpm_schema_version` | number | RO | Schema 版本号（新增稳定） |
| `bpm_version` | string | RO | 插件当前安装版本 |
| `bpm_author` | string | RO | 插件作者 |
| `bpm_id` | string | RO | 与 bpm_ro_id 一致，冗余便于 Bases 展示 |

### 模式说明
- **RO**：只读，由 BPM 维护，笔记修改不写回 BPM
- **RW**：可读写，双向模式下笔记修改可写回 BPM
- **RWC**：条件可写（仅当官方未匹配且非 BPM 安装时允许写回）

### Bases 兼容设计
- `bpm_id` 与 `bpm_ro_id` 重复，允许 Base 表格显示一个稳定可读的标识字段。
- 所有字段以 `bpm_` 前缀命名，独立于用户自定义 frontmatter。
- 旧字段（`bpm_ro_id/name/group/tags/delay/installed_via_bpm`, `bpm_rw_desc/note/enabled`, `bpm_rwc_repo`）继续保留。
- 新增 `bpm_schema_version`（当前 = 1）、`bpm_version`、`bpm_author`、`bpm_id` 作为补充。

## 文件命名与稳定身份

- **唯一身份**：使用 `plugin id` 作为稳定标识，`bpm_ro_id` 是查找的 ground truth。
- **文件名策略**：默认使用 `${name}.md`（插件名称），但当 name 变化时不会自动重命名旧文件。
- **旧文件匹配**：扫描导出目录，按 `bpm_ro_id` 匹配旧文件（包括基于 name 命名的文件），安全复用或重命名。
- **冲突处理**：
  - 多个文件指向同一 `bpm_ro_id` → 保留第一个匹配的，跳过后续。
  - 目标文件名被另一插件占用 → 写入时附加后缀，记录日志。
  - 解析错误、重复 id、路径冲突 → 跳过不覆盖，记录到 console。
- **migration 兼容**：识别旧 schema（无 `bpm_schema_version`）文件，继续读取并更新到新 schema。

## 单向/双向模式

### Export-only（默认，安全模式）
- 只从 BPM → Markdown 写入/更新。
- 不监听文件变化，不进行双向同步。
- `enabled`、`desc`、`note` 等 RW 字段在导出时写入但笔记侧的修改不会回写。

### Two-way 模式
- 监听导出目录内的 Markdown 文件变化。
- **受控写回**：默认只写回 `bpm_rw_desc`、`bpm_rw_note`、`bpm_ro_group`、`bpm_ro_tags`（四字段）。
- **条件写回**：`bpm_rwc_repo` 只有在当前 REPO_MAP 中无此插件映射且非 BPM 安装时才写回。
- **enabled 写回**：需要额外开启“允许从笔记更改插件启用状态”设置，默认关闭。
- **BPM 自身不可禁用**：`bpm_rw_enabled` 写回时，跳过 BPM 自身。
- **类型校验**：所有布尔值严格检查 `typeof === "boolean"`，不接受字符串 `"false"`。

## 增量与性能

- 批量操作（全量导出、启动时检查）只扫描一次导出目录，构建 `id → file` 索引。
- 内容未变化不写入：比较新旧内容，相同则跳过。
- 200+ 插件场景下不出现每插件全目录扫描。

## 保留用户内容

- 保留 Markdown 正文（body）不变，除非是旧 schema 文件需补充正文默认值。
- 保留非 `bpm_` 前缀的自定义 frontmatter 属性。
- 解析错误时不覆盖文件，记录日志并跳过。

## 生命周期

- `main.ts` 持有服务实例，在 `onload` 中 `start()`，在 `onunload` 中 `stop()`。
- 设置目录变化或同步模式变化时，服务自动重启（调用 `restart()`）。
- `onunload` 必须清理：watcher 注销、定时器清空、队列排空。

## 兼容入口

- `savePluginAndExport(pluginId)` 保留在 main.ts，委托给新服务。导出失败不影响插件设置保存。

## 设置迁移

- 新增 `PLUGIN_NOTES_EXPORT_DIR` 替代已过时的 `EXPORT_DIR`。
- 迁移 `runMigrations` 将旧 `EXPORT_DIR` 值复制到 `PLUGIN_NOTES_EXPORT_DIR`。
- 新增 `PLUGIN_NOTES_SYNC_MODE`（"export-only" | "two-way"），默认 "export-only"。
- 新增 `PLUGIN_NOTES_ALLOW_ENABLED_WRITE`，默认 false。

## 实现文件

```
src/plugin-notes/
  types.ts       — 数据模型、frontmatter schema、编解码器
  exporter.ts    — 目录索引、快照、增量写入、全量导出
  sync.ts        — 双向同步：watcher、debounce、串行队列、自写抑制
  service.ts     — 服务类，管理生命周期，main.ts 持有
```

可根据实际复杂度在单个文件中合并，但禁止把历史实现重新堆进 1655 行 main.ts，也不扩大 manager-modal.ts。
