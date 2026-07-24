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
- 正式发布前使用 `npm version --no-git-tag-version TARGET_VERSION`（其中 `TARGET_VERSION` 是纯 `x.y.z`，不含 `v` 前缀）触发 npm version lifecycle。该命令设置 `npm_package_version` 环境变量，自动调用 `package.json` 的 `version` script 从而运行 `version-bump.mjs`，同步 manifest、package-lock 与 versions.json。
- `--no-git-tag-version` 阻止 npm 自动创建 commit 和 tag，但 `version` script 中的 `git add manifest.json versions.json package-lock.json` 仍会暂存这些变更。实施 agent 必须审查暂存内容后再手动提交。正式 tag 由审查通过后，实施 agent 在 main 分支上使用 `git tag TARGET_VERSION && git push origin TARGET_VERSION` 单独创建。

## version-bump.mjs 行为

- 以 `npm_package_version`（即 `package.json` 中的版本）为目标版本。
- **前置校验**：`npm_package_version` 必须存在且匹配纯 `x.y.z` 正则，否则以非零退出并输出错误信息。
- 将 `manifest.json` 的 `version` 更新为目标版本。
- `versions.json` **仅在新版本 key 不存在时**追加一条 `"targetVersion": "minAppVersion"` 映射。脚本可重复执行，不会覆盖已有映射。
- `package-lock.json` 的根 `version` 和 `packages[""].version` 同步为目标版本。

## GitHub Actions Release Workflow

- 触发方式：
  - `on.push.tags: ["*"]`：推送匹配任意 tag 时自动触发。
  - `workflow_dispatch`：作为恢复路径，允许在 tag push 未触发时手动运行。**必须**在 Actions 下拉列表中选择一个已有 tag，不能选择 branch。
- 权限：`contents: write`（创建/更新 Release）、`id-token: write`（OIDC）、`attestations: write`（构建来源证明）。
- Build 步骤：
  1. `actions/checkout@v4`，`fetch-depth: 0`（获取完整历史与 tag，用于 Changelog 对比链接）。
  2. `actions/setup-node@v4`，Node 20，启用 npm cache。
  3. `npm ci`（严格安装锁定依赖）。
  4. `npm test`（运行自动化测试套件）。
  5. `npm run build`（生产构建，生成 `main.js`）。
- 版本与 ref 验证（必须全部通过）：
  - 从 `manifest.json` 读取 `version` 作为 VERSION。
  - VERSION 必须匹配纯 `x.y.z` 格式，否则失败并输出 `::error::`。
  - `github.ref_type` **必须**为 `tag`。若从 branch 运行（包括 `workflow_dispatch` 误选 branch），输出清晰错误并退出，禁止隐式创建 tag 或 release。
  - `github.ref_name` 必须与 VERSION 完全一致（无 `v` 前缀）。
- Release Assets：
  - **必须**的文件：`main.js`、`manifest.json`、`styles.css`，缺一不可。验证步骤检查三个文件均在构建后存在，任一缺失则 workflow 失败。
  - 使用 `actions/attest-build-provenance@v2` 为 assets 提供构建来源证明。
- Release 创建与更新（使用 `gh release create`/`gh release upload` + `gh release edit`）：
  - Release title 和 tag 精确为 VERSION（不含 `v`）。
  - 必须是正式的（非 draft、非 prerelease）。
  - **若 Release 已存在**：使用 `--clobber` 重新上传 assets；使用 `gh release edit` 更新 `--title`、`--notes`、`--draft=false`、`--prerelease=false`，确保 title 和 notes 与当前版本一致。
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
