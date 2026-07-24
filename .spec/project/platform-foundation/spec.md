---
title: 平台基础
status: active
hue: 190
desc: BPM 作为 Obsidian 插件的生命周期管理、偏好设置和国际化能力
---

# platform-foundation — 平台基础

platform-foundation 管理 BPM 在 Obsidian 宿主环境中的基础能力，涵盖插件从加载到销毁的生命周期、用户偏好持久化以及多语言适配。这些能力不直接面向插件管理的业务功能，而是为所有上层功能提供稳定的运行底座。

## 子节点

| 节点 | 职责 |
|------|------|
| [[lifecycle]] | 插件启动、自检、迁移、延迟启动、自动接管、卸载清理 |
| [[settings]] | 设置页面 UI、用户偏好持久化、数据模型定义 |
| [[localization]] | 多语言翻译系统与语言文件 |
