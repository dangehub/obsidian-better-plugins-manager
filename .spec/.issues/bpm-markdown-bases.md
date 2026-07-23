---
concern: 审计并设计 BPM Markdown/Bases 导出能力的恢复
by: unknown
status: open
nodes: project, lifecycle, settings, source-install
created: 2026-07-23T12:51:52.024Z
---

只读审计当前代码与历史导出实现，判断恢复前是否需要重构；输出风险、兼容性和分阶段建议。当前轮不得修改产品源码或 Spec。历史关键提交：添加 5bb6746，移除 dbeca3a。

<!-- reply: unknown @ 2026-07-23T17:01:51.695Z -->
测试库验收反馈：BPM UI/更新检查可通过 RepoResolver 从 REPO_MAP、本地 community cache、官方 community-plugins.json 解析商店插件仓库，但 plugin-notes-export 只读取 settings.REPO_MAP，导致同一插件 UI 有 GitHub 地址而导出 bpm_rwc_repo 为空。验收要求：导出 service 与 UI 统一使用 RepoResolver；批量解析优先 REPO_MAP→本地缓存→最多一次官方列表请求，批量只保存 settings 一次，离线/未知插件不阻断导出；exporter 核心保持无网络；非商店插件继续使用显式 repo 映射。增加真实 RepoResolver/service/export 回归测试。

<!-- reply: unknown @ 2026-07-23T17:17:20.434Z -->
后续结构整理要求：本轮 repo 一致性修复并验收后，另开独立 Spec-only session，将当前相关 Spec 按清晰的树状业务节点关系重组；保持现有叶子 ID 稳定，不在代码修复 session 中混做。
