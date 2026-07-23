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

提供 BPM 插件元数据的 Markdown 前端导出能力，兼容 Obsidian Bases 视图。独立模块，不寄生在 `transfer-pack` 或 `main.ts`。

## 边界与保证

- **默认不操作**：导出目录为空字符串时不扫描、不读取、不写入任何文件。
- **目录隔离**：只在配置的相对路径目录内操作。目录外不进行任何文件操作。
- **不碰普通笔记**：无 `bpm_ro_id` 的无标识 Markdown 文件、YAML 解析错误的文件、非 BPM frontmatter 文件均不覆盖。
- **安全写入**：只使用 Vault/Adapter 公共 API（`exists`、`read`、`write`、`list`、`mkdir`、`rename`）。不使用 `fs/promises`、`path`、`getBasePath`、`Buffer`。
- **移动端**：所有功能基于 Vault API，不依赖桌面端文件系统。

## Schema 与字段约定

### frontmatter 字段

| 字段 | 类型 | 模式 | 说明 |
|------|------|------|------|
| `bpm_ro_id` | string | RO | 插件唯一标识 |
| `bpm_ro_name` | string | RO | 插件名称 |
| `bpm_ro_group` | string | RO | 分组 ID（旧兼容） |
| `bpm_ro_tags` | string[] | RO | 标签 ID 列表（旧兼容） |
| `bpm_ro_delay` | string | RO | 延迟配置 ID |
| `bpm_ro_installed_via_bpm` | boolean | RO | 是否通过 BPM 安装 |
| `bpm_rw_desc` | string | RW | 插件描述 |
| `bpm_rw_note` | string | RW | 用户备注 |
| `bpm_rw_enabled` | boolean | RW | 启用状态（严格 boolean） |
| `bpm_rw_group` | string | RW | 分组名（新增，可写） |
| `bpm_rw_tags` | string[] | RW | 标签列表（新增，可写） |
| `bpm_rwc_repo` | string | RWC | 仓库地址 |
| `bpm_schema_version` | number | RO | Schema 版本号（当前=1） |
| `bpm_version` | string | RO | 插件当前安装版本 |
| `bpm_author` | string | RO | 插件作者 |
| `bpm_id` | string | RO | 与 bpm_ro_id 一致 |

### 模式说明
- **RO**：只读，由 BPM 导出时写入，笔记修改不回写。
- **RW**：可读写，双向模式下笔记修改可写回 BPM。
- **RWC**：条件可写（仅当 REPO_MAP 中无此插件映射且非 BPM 安装时写回）。
- **旧笔记兼容**：旧 schema（无 `bpm_schema_version`）仍可读取；`bpm_rw_group`/`bpm_rw_tags` 从 `bpm_ro_group`/`bpm_ro_tags` 回退。旧 `bpm_rw_name` 映射到 `bpm_ro_name`。

### Bases 兼容
- `bpm_id` 与 `bpm_ro_id` 重复，便于 Base 表格展示。
- 所有字段以 `bpm_` 前缀命名，独立于用户自定义 frontmatter。
- 旧字段继续保留，新增字段不破坏既有 Base 视图。

## 文件命名与稳定身份

- **唯一身份**：使用 `plugin id` 作为稳定标识。文件名固定为 `${pluginId}.md`（基于安全转义的 id）。
- **不变文件名**：文件名基于 id 而非 name。name 变化不会导致文件重命名抖动。
- **旧文件迁移**：扫描目录时按 `bpm_ro_id` 匹配旧 name-based 文件。若目标 `<id>.md` 未被占用，安全重命名到 id 路径。重命名失败则保留原路径。
- **冲突处理**：
  - 多个文件指向同一 `bpm_ro_id` → 记录为 conflictedIds，该 id 的全部导出和写回跳过。
  - 目标文件名被其他 BPM 笔记或非 BPM 文件占用 → 跳过并报告。
  - 解析错误、无 frontmatter、无 bpm_ro_id 的文件 → 不覆盖，跳过。

## 单向/双向模式

### Export-only（默认）
- 只从 BPM → Markdown 写入/更新，不监听文件变化。
- 所有 RW 字段在导出时写入，笔记侧修改不回写。

### Two-way 模式
- 监听导出目录直接子级的 .md 文件变化。
- **per-path debounce 500ms**：A.md 后紧接 B.md 各有独立定时器，不丢失。
- **串行队列 + generation guard**：文件处理串行执行；stop 后清空队列，新任务跳过。
- **自写抑制**：写入前登记 path+content token；modify 时内容完全匹配则消费跳过。
- **严格类型校验**：只有原始 YAML 值为 `typeof === "boolean"` 才允许 enabled 写回。字符串 `"false"`、数字、null 均忽略。
- **受控写回**：
  - `bpm_rw_desc`（string）、`bpm_rw_note`（string）：直接写回。
  - `bpm_rw_group`（string）：优先写回，旧笔记回退到 `bpm_ro_group`。
  - `bpm_rw_tags`（string[]）：优先写回，旧笔记回退到 `bpm_ro_tags`。
  - `bpm_rwc_repo`：仅当 REPO_MAP 中无映射且非 BPM 安装时写回。
- **enabled 写回**：需额外开启 `PLUGIN_NOTES_ALLOW_ENABLED_WRITE`。原子操作：先调 API（enablePluginAndSave/disablePluginAndSave），成功后才更新 `mp.enabled`；API 失败不污染记录。BPM 自身始终跳过。
- **BPM 自身不可禁用**：即使 enabled 写回开启，BPM 自身也跳过。

## 增量与性能

- 全量导出只扫描一次导出目录（`adapter.list()` 单次调用），构建 `id → file` 索引。
- 只管理直接子级文件，不递归子目录。
- 内容未变化不写入：比较新旧内容全等，相同则跳过。
- 不调用网络 API（repoResolver 等仅用于显式流程）。

## 保留用户内容

- 保留 Markdown 正文（body）不变。
- 保留非 `bpm_` 前缀的自定义 frontmatter 属性。
- 解析错误、无标识文件不覆盖。

## 目录验证

- 空字符串视为关闭。
- 拒绝绝对路径、`.`、`..`、`../` 遍历、`.obsidian` 及其子目录。
- 设置页使用本地 draft 直到点击保存按钮验证通过。
- 无效路径在设置中不应持久化，且 restart 返回 false。

## 生命周期

- `main.ts` 持有 `PluginNotesService` 单一实例。
- `onload` → `service.start(dir, mode)`。
- `onunload` → `service.stop()`：清理 watcher、per-path timers、队列（generation guard）。
- 设置目录或同步模式变化 → `service.restart(dir, mode)`。
- 停止后确保无后续副作用（队列清空、generation++、timer 清空）。

## 兼容入口

- `savePluginAndExport(pluginId)` 保留在 main.ts，委托给 `service.exportSingle()`。导出失败不影响设置保存。

## 设置迁移

- 新增 `PLUGIN_NOTES_EXPORT_DIR` 替代过时 `EXPORT_DIR`。
- 迁移 `migrate1015`（版本 1.0.15）：复制旧 `EXPORT_DIR` → `PLUGIN_NOTES_EXPORT_DIR`。
- 新增 `PLUGIN_NOTES_SYNC_MODE`（`"export-only"` 默认）。新增 `PLUGIN_NOTES_ALLOW_ENABLED_WRITE`（`false` 默认）。
- **调度保证**：`runMigrations` 只运行 `lastMigationVersion < migration.version <= 当前插件版本` 的迁移。目标版本未发布的迁移项不会被执行。

## 测试

- 纯函数测试（frontmatter 编解码、路径验证、安全文件名）。
- mock Vault/Adapter 测试（目录索引、冲突跳过、不变文件名）。
- 测试覆盖：
  - 空目录 0 操作
  - 路径验证（绝对路径、遍历、.obsidian）
  - id 稳定文件名与旧 name 文件迁移
  - 无标识 md、malformed YAML、重复 id、目标冲突均不覆盖
  - 批量只建立一次索引
  - 相同内容不写
  - 自定义属性和正文保留
  - raw `"false"` 不启用，真实 false 可禁用
  - BPM 自身不可禁用
  - per-path debounce 不丢文件
  - stop 后无副作用

## 实现文件

```
src/plugin-notes/
  types.ts       — 数据模型、frontmatter 编解码、路径验证
  exporter.ts    — 目录索引、增量写入、冲突与文件保护
  sync.ts        — per-path debounce、serial queue、path+content token 自写抑制
  service.ts     — 服务入口，main.ts 持有
```
