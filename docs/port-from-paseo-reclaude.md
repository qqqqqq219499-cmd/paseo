# 从 `paseo-reclaude` 搬迁对照表

> **落档日期**：2026-07-17  
> **目的**：后人一眼知道「这批能力是从哪拷的、落到 official 哪、哪些不能整文件覆盖」。

---

## 目录身份（别搞混）

| 本机路径                | 是什么                     | 远程（本机常见配置）                                                                     |
| ----------------------- | -------------------------- | ---------------------------------------------------------------------------------------- |
| **`E:\paseo`**          | 二开 / reclaude 源         | `upstream` → `https://github.com/sakurayun/paseo-reclaude`（本机也可能挂了 origin fork） |
| **`E:\paseo-official`** | 官方系仓库（当前干活目录） | `origin` → `getpaseo/paseo`；`fork` → 业主 fork                                          |

**搬迁方向**：`E:\paseo` → `E:\paseo-official`（只搬 fork 有意保留的能力，不是整仓对齐）。

**分支**：`feature/grok-accounts-zh-i18n`（在 official 上继续 Grok 多账号 + 中文 i18n 时并入了新主题与控件汉化）。

---

## 搬了什么（按功能块）

### 1. 新主题（`newTheme`）

| 项           | 内容                                                          |
| ------------ | ------------------------------------------------------------- |
| 源文档       | `E:\paseo\docs\new-theme.md`                                  |
| 落档文档     | `E:\paseo-official\docs\new-theme.md`（已复制，可作行为真源） |
| 设置项       | `newThemeEnabled`，默认 **开**，设备本地、不同步              |
| Unistyles 键 | `newTheme`（**不是**主题下拉选项；打开开关后盖过下拉）        |

**源 → 目标（核心）**

| 源（`E:\paseo\...`）                                                        | 目标（`E:\paseo-official\...`） | 备注                                                                                                                   |
| --------------------------------------------------------------------------- | ------------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| `packages/app/src/styles/theme.ts`                                          | 同路径                          | 只迁 `surfaceShell` / `shell` / `newTheme` / `colorSchemeForThemeName`；**勿整文件盖**（official 无 `lightClaude` 等） |
| `packages/app/src/styles/unistyles.ts`                                      | 同路径                          | 注册 `newTheme` 键                                                                                                     |
| `packages/app/src/styles/theme.test.ts`                                     | 同路径（可新建）                | `colorSchemeForThemeName`                                                                                              |
| `packages/app/src/hooks/use-settings/storage.ts` (+ test)                   | 同路径                          | `newThemeEnabled` 解析与默认                                                                                           |
| `packages/app/src/app/_layout.tsx`                                          | 同路径                          | 开开关 → `setTheme("newTheme")`                                                                                        |
| `packages/app/src/screens/settings/appearance/appearance-section.tsx`       | 同路径                          | 外观页「启用新主题」开关                                                                                               |
| `packages/app/src/screens/settings/appearance/apply-appearance.ts` (+ test) | 同路径                          | `ALL_THEME_KEYS` 含 `newTheme`                                                                                         |
| `packages/app/src/styles/settings.ts`                                       | 同路径                          | 设置页圆角卡样式                                                                                                       |
| `packages/app/src/screens/workspace/workspace-screen.tsx`                   | 同路径                          | 浮卡 + shell；**最小补丁，勿整文件盖**                                                                                 |
| `packages/app/src/screens/workspace/workspace-desktop-tabs-row.tsx`         | 同路径                          | floating chip tabs                                                                                                     |
| `packages/app/src/screens/settings-screen.tsx`                              | 同路径                          | 设置详情列浮卡                                                                                                         |
| `packages/app/src/components/headers/screen-header.tsx`                     | 同路径                          | `surfaceStyle` / `rowStyle` + 拖窗                                                                                     |
| `packages/app/src/components/left-sidebar.tsx`                              | 同路径                          | `newThemeEnabled` 分支 flat sessions                                                                                   |
| `packages/app/src/hooks/use-sidebar-sessions-list.ts` 等                    | 同路径（新建）                  | 见下表「会话侧栏」                                                                                                     |
| 各语言 `i18n/resources/*.ts`                                                | 同路径                          | `settings.appearance.newTheme.*`、`sidebar.sessionsList.*`                                                             |

**会话侧栏（新主题左侧 flat list）— 多在 official 新建**

| 源（`E:\paseo\packages\app\src\...`）               | 目标   | 备注                           |
| --------------------------------------------------- | ------ | ------------------------------ |
| `hooks/use-sidebar-sessions-list.ts`                | 同路径 | 历史+实时会话合并              |
| `hooks/sidebar-sessions-grouping.ts` (+ test)       | 同路径 | 按项目分组                     |
| `hooks/sidebar-session-placements.ts` (+ test)      | 同路径 | placement                      |
| `hooks/use-status-mode-workspaces.ts`               | 同路径 | 项目自定义名                   |
| `components/sidebar/sidebar-sessions-list.tsx`      | 同路径 | 列表 UI                        |
| `components/sidebar/sidebar-sessions-toolbar.tsx`   | 同路径 | 顶栏三按钮                     |
| `components/sidebar/sidebar-workspace-sessions.tsx` | 同路径 | 会话行                         |
| `components/sidebar/session-status-icon.tsx`        | 同路径 | 状态图标                       |
| `utils/navigate-to-agent-directory-entry.ts`        | 同路径 | 跳转；**按 official API 改过** |

**右侧 chrome（token 驱动）**

| 源                                  | 目标   | 备注                             |
| ----------------------------------- | ------ | -------------------------------- |
| `components/explorer-sidebar.tsx`   | 同路径 | `shell.chromeDivider` / floating |
| `components/file-explorer-pane.tsx` | 同路径 | 同上                             |
| `git/diff-pane.tsx`                 | 同路径 | 同上                             |
| `git/pull-request-panel/pane.tsx`   | 同路径 | 同上                             |
| `git/source-control-pane.tsx`       | —      | **official 无此文件，未搬**      |

---

### 2. 窗口拖拽（Electron 空白处可拖窗）

| 项   | 内容                                                                |
| ---- | ------------------------------------------------------------------- |
| 问题 | 仅 `TitlebarDragRegion` 绝对层会被 RN Web 布局盖住，空白点不到 drag |
| 修法 | chrome 容器加 `electronDragStyle`，内容卡加 `electronNoDragStyle`   |

| 源 / 参考                                   | 目标                       | 备注                                             |
| ------------------------------------------- | -------------------------- | ------------------------------------------------ |
| fork 整侧栏 `TitlebarDragRegion` 注释与用法 | `left-sidebar.tsx`         | 整栏 drag                                        |
| （official 增强）                           | `titlebar-drag-region.tsx` | 导出 `electronDragStyle` / `electronNoDragStyle` |
|                                             | `screen-header.tsx`        | header 可拖 + `box-none`                         |
|                                             | `workspace-screen.tsx`     | shell drag、centerCard no-drag                   |
|                                             | `settings-screen.tsx`      | 同上                                             |
|                                             | `explorer-sidebar.tsx`     | 右侧栏 drag                                      |

---

### 3. 模型控件 + 设置中文（汉化加深）

| 项           | 内容                                                                                    |
| ------------ | --------------------------------------------------------------------------------------- |
| 源           | `E:\paseo\packages\app\src\composer\agent-controls\localize.ts`                         |
| 落           | `E:\paseo-official\packages\app\src\composer\agent-controls\localize.ts`                |
| 接线         | `mode-control.tsx`、`index.tsx`、`utils.ts`（思考档位走 i18n）                          |
| 消息「用时」 | 源：`message.tsx` 用 `t("message.footer.workedFor")`；官方原先硬编码 `Worked for`，已改 |
| 文案         | `i18n/resources/zh-CN.ts` 为主；`en` 等补齐键结构（key 全语言对齐）                     |

**用户可见对照（搬完后）**

| 英文                       | 中文                                          |
| -------------------------- | --------------------------------------------- |
| Worked for 15s             | 用时 15s                                      |
| Extra high                 | 超高                                          |
| Default permissions        | 默认权限                                      |
| 思考档 / 模式 / 部分设置页 | 见 `zh-CN` 中 `agentControls.*`、`settings.*` |

---

## 明确没整文件覆盖的原因

- official 与 fork **版本差大**（例如 unistyles breakpoints、无 `lightClaude`、工作区/侧栏组件 API 不同）。
- 会话「+ / 开项目」等在 official 用现有导航 API 接，**行为可能和 fork 不完全一致**。
- `source-control-pane` 仅 fork 有，official 未搬。

---

## 怎么再从源目录续搬

1. 先在 **`E:\paseo`** 用 `rg` 搜功能关键字（如 `newTheme`、`localizeAgentModeLabel`）。
2. 对照本表目标路径；**能对上就补丁合并，对不上就对照 API 手写**。
3. 行为说明优先读：`E:\paseo-official\docs\new-theme.md`。
4. 改完在 official 跑：相关 `vitest` + `packages/app` typecheck + 关键文件 lint。

---

## 本机一句话备忘

```
源：E:\paseo          （sakurayun/paseo-reclaude 二开）
宿：E:\paseo-official （getpaseo 官方系 + 本机 feature 分支）
已搬：新主题 + 会话侧栏 + 拖窗 + 模型/设置汉化（见上表）
未搬：fork 独有 source-control-pane；其它与官方重叠且未列入合并策略的改动
```

合并策略原话（fork 文档侧）：真二开才留 —— **中文、会话分叉、Grok 多账号、newTheme**；其余官方优先。见 `E:\paseo\docs\desktop-package-and-install.md` 摘要。
