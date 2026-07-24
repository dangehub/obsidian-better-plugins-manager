---
title: release-automation
status: active
hue: 315
desc: 基于 GitHub Actions 的自动化发布管线：版本一致、构建校验、Release 创建与更新日志
related:
  - .github/workflows/release.yml
  - version-bump.mjs
  - manifest.json
  - package.json
  - versions.json
  - release-notes/
---
# release-automation — 发布自动化

release-automation 治理 BPM 的正式发布流程，涵盖版本一致性、tag 规则、CI 构建、Release 创建、Assets 上传及更新日志管理。它不涉及产品功能逻辑，仅负责发布工程。

## 版本一致性与 Tag 规则

- 唯一版本来源：`manifest.json` 中的 `version` 字段是权威版本。
- `package.json`、`package-lock.json`（根 `version` 与 `packages[""]` 下的 `version`）、`versions.json` 与 `manifest.json` 严格一致。
- tag 格式为纯 SemVer `x.y.z`，**不允许** `v` 前缀、beta、prerelease 或 build metadata。
- 每次正式发布前必须执行 `node version-bump.mjs` 以确保所有版本文件同步。

## version-bump.mjs 行为

- 以 `npm_package_version`（即 `package.json` 中的版本）为目标版本。
- 将 `manifest.json` 的 `version` 更新为目标版本。
- `versions.json` **仅在新版本 key 不存在时**追加一条 `"targetVersion": "minAppVersion"` 映射。脚本可重复执行，不会覆盖已有映射。
- `package-lock.json` 的根 `version` 和 `packages[""].version` 同步为目标版本。

## GitHub Actions Release Workflow

- 触发方式：
  - `on.push.tags: ["*"]`：推送匹配任意 tag 时自动触发。
  - `workflow_dispatch`：作为恢复路径，允许在 tag push 未触发时手动运行。
- 权限：`contents: write`（创建/更新 Release）、`id-token: write`（OIDC）、`attestations: write`（构建来源证明）。
- Build 步骤：
  1. `actions/checkout@v4`，`fetch-depth: 0`（获取完整历史与 tag，用于 Changelog 对比链接）。
  2. `actions/setup-node@v4`，Node 20，启用 npm cache。
  3. `npm ci`（严格安装锁定依赖）。
  4. `npm test`（运行自动化测试套件）。
  5. `npm run build`（生产构建，生成 `main.js`）。
- 版本验证（必须通过）：
  - 从 `manifest.json` 读取 `version` 作为 VERSION。
  - VERSION 必须匹配 SemVer 纯 `x.y.z` 格式。
  - 如果是 tag 触发，`github.ref_name` 必须与 VERSION 完全一致（无 `v` 前缀）。
- Release Assets：
  - 必须存在的文件：`main.js`、`manifest.json`。
  - 可选文件：`styles.css`（若存在则包含）。
  - 使用 `actions/attest-build-provenance@v2` 为 assets 提供构建来源证明。
- Release 创建（使用 `gh release create`/`gh release upload`）：
  - Release title 和 tag 精确为 VERSION（不含 `v`）。
  - 必须是正式的（非 draft、非 prerelease）。
  - 若 Release 已存在，则使用 `--clobber` 重新上传 assets，并确保发布状态（不能保留 draft/prerelease）。
- Release Notes：
  - 优先读取 `release-notes/<VERSION>.md` 作为 Release body。
  - 追加 Full Changelog 对比链接：`https://github.com/${GITHUB_REPOSITORY}/compare/<PREV_TAG>...<VERSION>`。

## 中文更新日志

- 更新日志文件位于 `release-notes/<VERSION>.md`，使用简体中文。
- 内容基于 `git log` 和实际改动重组，避免逐条罗列提交。突出功能亮点、架构变化、迁移说明和已知限制。
- 诚实披露 AI 辅助程度，不写未验证功能或营销套话。
- 标明 fork 来源及上游版本。

## 发布后验证

发布后应在隔离 vault 中验证：
1. 下载的 Release assets 与构建产物一致（`main.js`、`manifest.json`、`styles.css`）。
2. 插件加载无报错，核心功能正常。
3. 版本号在 Obsidian 设置中显示正确。
