# 维护手册

给后续 agent 的升级与修复指南。DSH 升级后先读这里，再动代码。

## 文件职责

| 路径 | 职责 |
|---|---|
| `cordis.patch.yml` | 五个 preset 与两个顶层宿主行（`zh-meow-client`、`meow-team-config`） |
| `plugin/index.js` | 段落与工具描述中文化；PTC / 原生双模式执行器；`teamRole` 协议段落；漏翻报告 |
| `plugin/team-config.js` | Host 配置服务 `meowTeam`（schemastery Config，volatile 字段，含 `ptc` 开关） |
| `plugin/delegate.js` | 委派工具 `subagent_coder` / `subagent_verifier` / `subagent_probe`，探针前言 |
| `plugin/cleanup.js` | 收尾清理工具 `meow_cleanup`：取工作区根、注册工具、渲染结果 |
| `plugin/cleanup-core.js` | 清理的纯逻辑：路径校验、清单收集、keep、真删（可测，不 import DSH 包） |
| `plugin/route.js` | 纯函数：设置里的 `model` / `effort` → `agentOptions` |
| `client/index.js` | 手写 lazy-CJS 浏览器 bundle：设置页 |
| `index.js` | Host 空入口，占裸包名 Loader 行 |
| `plugin/locale/*.json` | 插件显示文案（设置 → 内置插件 的标题与描述，`meta.title` / `meta.description`）；`en.json` 是必需入口，其它语言按文件名识别 |
| `data/*.json` | 中文译文数据（段落、工具描述、参数） |
| `data/ptc.json` | PTC 模式替换表：`run_code` 文案、SDK 固定说明、提权指引（英文整句 → 中文） |
| `data/team/*.md` | 四个角色的协议正文（管家 / 码农 / 探针 / 校验者） |
| `tests/` | 协议、路由、preset 结构、客户端 bundle、清理逻辑的静态测试 |

## 角色与工具矩阵

| 角色 | preset | 读 / 搜 | 写 | 命令 | 编码模式 | 备注 |
|---|---|---|---|---|---|---|
| 管家 | `zh-meow-steward` | `read`（`readImage: false`）+ `tool-fs-search` | `write` 开、`edit` 关 | 无 | 固定原生（`ptc: native`） | 加 `meow_cleanup` 与三个委派工具 |
| 码农 | `zh-meow-coder` | 全开 | 全开 | 有 | 跟随设置 | 可再开一层子 agent（`maxDepth: 2`） |
| 探针 | `zh-meow-probe` | 全开 | 全开 | 有 | 跟随设置 | 不给 `tool-subagent`、`tool-ask-user`、`delegate` |
| 校验者 | `zh-meow-verifier` | 全开 | `write`/`edit` 关 | 有 | 跟随设置 | 不给子 agent 与 `ask_user_question` |

管家必须固定原生模式：PTC 的 `run_code` 程序能 `await import('node:fs')` / `node:child_process`，不受工具列表约束，会绕开「只写 `.meow-team/`、不跑命令」的边界。

`tests/presets.test.mjs` 用文本切片钉住这张表。改工具组合必须同步改测试。

## 关键 DSH API（0.2.1-rc.3）

- `system-prompt/assemble` 瀑布只承载 `sections` / `contexts` / `variables`，**不含 tools**。工具描述由执行器的 `describe()` 提供；`plugin/index.js` 用 `createModeExecutor` 包装原生执行器（并在 PTC 模式下包装 PTC 执行器）。
- 执行器：`ctx.tools.setExecutor(executor)`，每个作用域只允许一个，返回 effect disposer；执行器自带的 `sections`（`tools:ptc-only`、`tools:sdk`）会注册成系统提示词段落，`text` 回调拿到的是本步可见的工具定义。
- PTC：`@deepseek-ai/dsh-tool-executor-ptc` 导出 `PtcExecutor`、`renderToolsSdk`、`renderToolsSdkPy`；执行器要求部署挂 `ptcRuntime`（`@deepseek-ai/dsh-ptc-runtime-node`，base bundle 默认挂）。`run_code` 的 `description` 是 getter：flavor 文案 + `runtime.executionInstructions` + 目录句 + 提权指引，所以译文只能做整句替换（`data/ptc.json`），不能用静态字段。
- 模式开关：`meow-team-config` 的 `ptc` 是 volatile 字段，`plugin/index.js` 每次组装都通过 `ctx.get('meowTeam')?.ptcMode()` 重新解析；缺 PTC 包或 runtime 时退回原生模式。
- `ctx.systemPrompt.section({ name, order, text })` 在预设作用域注册段落；`getSectionOrder('TEAM_POLICY')` 返回 600。`section()` 自带 effect 清理。
- `tool-subagent` 的配置字段：`provider`、`toolName`、`agentPreset`、`allowedAgentPresets`、`agentOptions`、`maxDepth`。
- 子 agent 启动：`ctx.subagents.startActivation({ provider, label, request: { parent, prompt, agentPreset, agentOptions, maxDepth }, signal, delivery: 'parent' })`。request 里**没有** permission / sandbox 字段：子 agent 的工具与权限完全由它的 preset 决定，所以「探针不得改任务文件」只能靠 preset 工具集加协议约束。
- continuable 子 agent 的初始 prompt 会由 `withContinuableReturnGuidance` 追加父 agent id 与 `send_message` 指引。
- 设置表单：`settings.section` slot（`ui-settings-general` 渲染）+ `ctx.configForms.get(entryId)`；写操作是 `{ op: 'set', path: string[], value: JsonValue }`。Host 端 Config 必须是 schemastery，字段加 `.volatile()` 才能即时编辑。
- 客户端 bundle：`window.__ModuleLoader__.load({ id, factory })` 的 lazy-CJS factory，`require('react')` 来自基座模块表。
- `configForms.get(entryId)` 返回带 `this` 的控制器；传给 React 的 `useSyncExternalStore` 前必须包一层（`() => form.getSnapshot()`、`(listener) => form.subscribe(listener)`），并给第三个 `getServerSnapshot` 参数。
- preset registry 没有 `hidden` 字段；要移除一个官方 preset，只能在 patch 里对它的 Loader 条目写 `disabled: true`。内部 preset 必须保留注册（子 agent 的 `agentPreset` 要挂载它们），无法从选择器隐藏。
- `tool-fs` 的 `read` / `readImage` / `write` / `edit` 是独立开关。
- 工作区根：`ctx.workingDirectory.ensure(agent, signal)`。`meow_cleanup` 靠它定位 `.meow-team/`。

## 升级后检查清单

1. `node --test tests/` 全绿。
2. GUI 的 preset 列表出现五个「喵体中文」项，默认仍是原版。
3. 设置页出现「喵体中文」分区；能增删校验者、改模型/强度。
4. 检查 `.untranslated-report.json` 与 `.untranslated-report.<role>.json`：新增的英文段落或工具是否漏翻。
5. 用一个小任务跑一次团队 smoke：任务文件、码农自检、按清单开启校验者、全部 PASS 后清理任务目录、汇报。
6. 把校验者删到 0，再跑一次：确认直接采用码农交付。
7. 跑一次探针：确认它能跑命令、能在 `.meow-team/<task-id>/probe/` 里试写，并且**没有**在仓库里留下改动。
8. 确认动态段落（`plan:policy`、`tool:read/write/edit/glob/grep`）仍带 `dynamic` 标记，空原文时不被替换。
9. 确认校验者清单只出现在管家 prompt 里（`tests/plugin.team.test.mjs` 有一条专门钉这个）。
10. 跑一次 PTC smoke：新会话默认应只看到 `run_code` 一个工具，SDK 说明是中文；在设置页关掉 PTC 后下一轮变回逐个工具 schema。再看宿主日志有无「没有可用的 PTC runtime」的警告。
11. 对照 `packages/core/tool-executor-ptc/src/ptc.ts`、`ts-types.ts`、`py-types.ts` 与 `packages/ptc-runtime/ptc-runtime-node/src/execution.ts`：若上游改了 PTC 文案措辞，`data/ptc.json` 的 `en` 句子会失配，模型重新读到英文。

## 已知脆弱点

- rc.2 曾把工具声明放进 `system-prompt/assemble` 的 `assembled.tools`；升级后该字段为 `undefined`，旧实现会在每个模型请求抛 TypeError。现在的实现不读它。
- `tool-subagent-control` 的 `/list-agents` 子路径在某些版本被移除；不要重复挂载，`list_agents` 由主入口注册。
- `backgroundMode` 不是 0.2.1-rc.3 的 tool-subagent 配置字段；spawn provider 本身是 continuable。
- `settings.section` 的注册参数、`configForms` 的 `set` 语义、客户端基座模块名都可能随版本变化；升级后优先检查这三处。
- `startActivation` 的 spec 字段（`request.maxDepth`、`delivery`）可能变化；对照 `packages/subagent/subagent/src/index.ts`。
- 父 agent id 的注入文案由 `withContinuableReturnGuidance` 提供；若上游改名，码农「直接问管家」的指引需要同步。
- `meow_cleanup` 用 `node:fs` 直接删，**不经过 `ctx.fs` 沙箱**：它的安全边界完全由 `cleanup-core.js` 的路径校验撑着（工作区内、非根、非 `.git`、`extraPaths` 不得被 git 跟踪）。改这个文件时把 `tests/cleanup.test.mjs` 一起跑。
- `meow_cleanup` 依赖 `ctx.get('workingDirectory')`；宿主若改组成没有该服务的部署，工具会报可读错误，不会静默删错地方。
- `.meow-team` 路径写死在 `cleanup-core.js` 的 `TASK_ROOT`；要换位置得同时改协议与测试。
- 探针的「不实现、不改任务相关文件」是**协议约束**，不是技术隔离：DSH 的子 agent 没有单独的 permission 字段。工具注册在前言里的 `PROBE_PREAMBLE` 是第二道保险，但它挡不住刻意越界，所以收尾时要看一眼 `git status`。
- `data/ptc.json` 的英文句子是从上游源码逐句抄来的，**不是**从运行时抓的：DSH 升级若改了措辞，替换会静默失效（模型看到英文，不报错）。改完 PTC 文案后按「升级后检查清单」第 11 条对照一遍。
- PTC 的 `tools:sdk` 文本靠上游 `renderToolsSdk` / `renderToolsSdkPy` 生成声明、我们只预翻译 schema 描述：上游若改了渲染入口的导出名或签名，`loadPtcModules` 会判定 PTC 不可用并退回原生（不是崩溃），但 PTC 模式会悄无声息地消失。
- 模式开关的生效时机是「下一次提示词组装」：它不重装执行器，也不触发 `tools/change`。若将来 DSH 让执行器的 `sections` 只在注册时求值一次，这个设计会退化成「切换后段落不更新」，届时要改成按模式重装执行器。

## 修改步骤

1. 改协议：只改 `data/team/*.md`，不改代码；跑 `node --test tests/` 确认关键词断言仍然成立。
2. 改工具组合：改 `cordis.patch.yml` 对应 preset 段，同步更新 `tests/presets.test.mjs` 的文本断言。
3. 改模型控制：改 `plugin/route.js` 与 `tests/delegate.test.mjs`；保持「空字符串 = 继承」。
4. 改清理逻辑：改 `plugin/cleanup-core.js` 与 `tests/cleanup.test.mjs`；`plugin/cleanup.js` 只做工具注册与渲染。
5. 改设置页：改 `client/index.js`；保持 lazy-CJS 格式与 `settings.section` 注册，同步更新 `tests/client-bundle.test.mjs`。
6. 改译文：改 `data/*.json`；跑测试并查看漏翻报告。
7. 改 PTC 文案：改 `data/ptc.json`（`phrases` 整句、`patterns` 带动态数字、`ptcOnly` 规则句）；同步跑 `tests/plugin.ptc.test.mjs`。英文原句必须与上游源码逐字一致，否则不会命中。
8. 改 preset 可见性：官方 preset 可以在 `cordis.patch.yml` 末尾用 `- id: preset-standard` + `disabled: true` 禁用；恢复时删掉对应行。码农 / 探针 / 校验者是内部 preset，不能禁用。

## 回滚

```sh
cd D:\zh-meow
git log --oneline
git reset --hard <基线提交>
```

profile 里 `@local/dsh-zh-meow` 是 link，回滚文件后重启宿主即可恢复。
