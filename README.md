# 喵体中文

DSH 的「喵体中文」插件包：五个 agent preset、一个官方设置页分区，以及管家 / 码农 / 可行性探针 / 独立校验者的团队流程。默认走 PTC 编码模式（模型写 `run_code` 程序调工具），可在设置页一键切回原生模式。

## 五个 preset

| preset | 用途 |
|---|---|
| 喵体中文（`zh-meow`） | 默认，原版单体。适合简单任务 |
| 喵体中文·管家（`zh-meow-steward`） | 细化任务、调度码农与校验者、收尾清理；可读文件，不跑命令 |
| 喵体中文·码农（`zh-meow-coder`） | 内部 preset，由管家自动调用；也能手动选 |
| 喵体中文·可行性探针（`zh-meow-probe`） | 内部 preset，由管家自动调用；验证某条路是否可行 |
| 喵体中文·独立校验者（`zh-meow-verifier`） | 内部 preset，由管家自动调用；也能手动选 |

新建会话默认是原版「喵体中文」。要走团队流程，在会话开始前选「喵体中文·管家」。

码农、探针与校验者必须注册成独立 preset，子 agent 才能用 `agentPreset` 挂载它们；DSH 0.2.1-rc.3 的 preset registry 没有 hidden 字段，所以它们仍会出现在选择器里，只是名字标了「（内部）」。另外，本插件在 `cordis.patch.yml` 末尾禁用了不常用的官方 preset「标准 / PTC / 极简」；想恢复时删掉最后三行 `- id: preset-standard` 等即可。

## 设置页

打开「设置 → 喵体中文」，可以配置：

- **编码模式**：PTC 模式（默认开启）/ 原生模式。
- **DeepSeek 前缀续写（Beta）**：总开关、动态 role 规则、OpenAI 兼容端点。
- **码农**：模型、思考强度。
- **独立校验者**：动态增删槽位；每个槽位可启用/停用，并配置模型、思考强度、校验模式。

模型与强度**留空表示继承** DSH 当前设置（子 agent 继承管家会话的 route / effort）。模型要覆盖时写成 `provider/model`，例如 `deepseek-official/deepseek-flash`。

两种校验模式：

- `two-round`：第一轮只给原版任务做初步判断，第二轮再给问答与复核要求。
- `one-shot`：一次拿到任务、问答、交付摘要与自检证据。

默认两个校验者：`v1` 强度 `high` 两轮、`v2` 强度 `max` 一次拿全。

没有启用校验者时，管家直接采用码农交付，并在汇报里注明未校验。

探针不读设置页：它继承管家会话的模型与强度，省掉一套只为一个轻角色存在的配置项。

如果设置页是空白的：先刷新页面；仍然空白时打开浏览器开发者工具看 Console 与 Network，并把错误贴给维护者。设置页是手写的 lazy-CJS bundle，订阅绑定或本地化注册出问题时通常会在 Console 里留下堆栈。

## DeepSeek 前缀续写（Beta）

默认关闭。打开「设置 → 喵体中文 → DeepSeek 前缀续写（Beta）」后，插件会自动注册一个独立的 `deepseek-beta` 供应商，模型选择器里出现「DeepSeek Beta（前缀续写）」，包含 `deepseek-flash` 与 `deepseek-v4-pro`。选中它才会走这条路由；原版 `deepseek-official` 不受影响。

这条路由使用 OpenAI 兼容的 `https://api.deepseek.com/beta`，不是原版的 Anthropic Messages 端点。DeepSeek 的对话前缀续写只在 OpenAI 兼容的 `/beta/chat/completions` 上开放，所以不能只改原版 URL。

### 动态前缀规则

设置页的规则是一个可增删的数组，每条由 `role` 与 `reasoning_content` 组成。每次请求先取原版最后一条消息的 `role`，按数组顺序匹配：

- 命中且内容非空 → 在该请求的 messages 末尾追加：

  ```json
  { "role": "assistant", "content": "", "reasoning_content": "<规则内容>", "prefix": true }
  ```

- 规则内容留空 → 这个 role 被临时禁用。
- 没有命中 → 不追加；关闭思考（`reasoningEffort` 为 `off`）时也不追加。
- 请求带工具定义（`tools` 非空）→ 不追加，见下面的互斥说明。

默认两条规则：`user` → 「让我想想喵~」，`tool` → 「让我看看喵~」。以后要给新 role 加前缀，直接在设置页添加一行即可，不需要改代码；重复 role 时第一条生效。插入消息自身的 `role` 固定是 `assistant`，这是 DeepSeek prefix 续写的要求。

### 与工具调用互斥

DeepSeek Beta 不允许 `prefix: true` 与 tool 定义同时出现在一个请求里，否则返回：

```text
HTTP 400 Function call should not be used with prefix
```

DSH 的 agent 请求默认携带工具定义，所以这类请求会自动跳过前缀注入、正常走工具调用；只有不带工具的请求（例如纯文本生成）才会插入前缀。这是服务端限制：`tool_choice: "none"`、`tools: []`、关闭 thinking 都不能绕过，只有 `tools` 缺失或为空数组时才能使用 prefix。

### 缓存命中

服务器返回的 `reasoning_content` 是续写部分。插件会把它接在已发送的 `reasoning_content` 之后，作为 assistant 消息的完整 reasoning 存入会话历史；下一轮请求再把完整值作为 `reasoning_content` 回传，才能和服务器缓存里的完整消息对上。如果服务器返回的已经是完整内容（包含前缀），插件会去掉重复前缀，不会拼两次。

### 端点与凭据

- 端点默认 `https://api.deepseek.com/beta`，可在设置页修改；前缀续写必须使用 `/beta` 路径。
- 凭据复用 `DEEPSEEK_API_KEY`（设置 → 模型或启动环境）；没有 key 时请求会报 `MISSING_CREDENTIAL`。
- 首版只声明文本输入：图片会由 DSH 投影成占位文本，不发送 image_url。
- 关闭总开关会注销这个供应商；仍选着它的会话需要切回其它模型。

## 编码模式（PTC）

「设置 → 喵体中文 → 编码模式」默认开启 PTC 模式：模型不再逐个直接调工具，而是写一段 `run_code` 程序（TypeScript）在程序里用 `await tools.name(args)` 调工具。这样一次能把多步读文件、跑命令、grep 串起来，中间结果不进对话，只有程序打印或返回的内容成为工具结果。

关掉它则回到原生模式：每个工具单独一次调用，模型看到的是逐个工具 schema。

两种模式的行为差异与注意事项：

| | PTC 模式（默认） | 原生模式 |
|---|---|---|
| 模型可见的工具 | 只有 `run_code` + 生成的 SDK 声明 | 每个工具一个 schema |
| 中间结果 | 不进对话，需自己 `return` / `console.log` | 每次调用都进对话 |
| 工具描述 | 先生成中文 SDK 声明（`data/ptc.json` + 工具译文表） | 逐条中文 schema |

- 开关存在 `meow-team-config` 的 `ptc` 字段（volatile），**保存后下一轮生效**，不需要重启宿主。
- **管家固定原生模式**：它没有命令工具，而 PTC 的 `run_code` 程序能直接 `await import('node:fs')` / `node:child_process`，等于把「不跑命令、不改项目文件」的边界拆掉。所以设置页开关只对原版、码农、探针、校验者生效。
- 宿主没有挂 PTC runtime（`ptcRuntime` 服务），或 `@deepseek-ai/dsh-tool-executor-ptc` 加载失败时，自动退回原生模式，并在宿主日志里留一条警告——预设不会因此挂载失败。
- 把 `translateTools` 关掉时本插件不接管执行器，PTC 模式也就不会生效（工具描述保持原文）。
- PTC 下模型读到的中文文本包括：`run_code` 的工具与参数描述、`tools:ptc-only` 规则、生成的 TypeScript/Python SDK 声明与固定说明、sandbox 提权指引。这些英文原句的替换表在 `data/ptc.json`。
- `run_code` 里嵌套的子调用沿用同一套策略与审批：外层程序的 `sandbox_permissions` 只对那一次完整执行生效，嵌套工具仍各自走策略。

## 角色边界

| 角色 | 读 | 写 | 跑命令 | 职责 |
|---|---|---|---|---|
| 管家 | 可以（只到「能写清任务」为止） | 只写 `.meow-team/` | 不能 | 细化任务、调度、收尾清理 |
| 码农 | 可以 | 可以 | 可以 | 实现、自检、交付 |
| 探针 | 可以 | 可以（限实验目录） | 可以 | 只回答「这条路行不行」 |
| 校验者 | 可以 | 不能 | 可以 | 只读复核，输出三态结论 |

管家读文件是为了把任务写准，不是替码农做设计：读入口、读配置、读目录，不追实现细节、不做实现分析，也不把代码粘进任务文件。这样它的上下文里不会塞满实现细节，主人批准的仍然是任务本身。

管家没有 shell：收尾删除走窄工具 `meow_cleanup`，只删 `.meow-team/<task-id>/` 与显式列出的未跟踪临时路径。`extraPaths` 会拒绝 `.git` 与被版本控制跟踪的文件，所以「删掉任务相关文件」这条路是堵死的。

## 团队流程

1. 管家先澄清任务，再用 `read` / `grep` / `glob` 确认路径、入口、命名与既有约定。
2. 需要验证「这条路能不能走」时，管家派 `subagent_probe`：一次一件事，回结论与证据。
3. 管家写 `.meow-team/<task-id>/01-task.md`，用 `present` + `ask_user_question` 请主人确认。
4. 管家调用 `subagent_coder` 派发码农。
5. 码农实现、自检、写 `20-handoff-<n>.md`；需要主人决定的问题通过 `send_message` 问管家。
6. 管家按设置清单，在同一轮里调用 `subagent_verifier` 开启全部校验者。
7. 全部 `PASS` 才进入收尾；`FAILED` 回传码农，`AMBIGUOUS` 回传主人。
8. 管家用 `meow_cleanup` 清理本次任务记录（先 `dryRun` 看清单，可用 `keep` 保留几份证据），再向主人汇报。

## 任务目录

`task-id` 用 `<四位序号>-<短 slug>`，序号自增：`glob` 匹配 `.meow-team/*/01-task.md`（`glob` 只返回文件、不返回目录），从路径里取最大四位序号加一。

```
.meow-team/<task-id>/
  01-task.md                管家：任务规格
  02-task.md                管家：修订（可选）
  10-questions-<n>.md       管家：转交的问题
  11-answers-<n>.md         管家：主人答复
  20-handoff-<n>.md         码农：交付说明
  30-review-<slot>-<n>.md   管家：每个校验者槽位的结论
  probe/                    探针：验证用的临时实验文件（收尾时删掉）
```

收尾清理时默认删掉整个任务目录；要留证据就传 `keep`，例如只保留 `01-task.md` 与 `20-handoff-1.md`。

如果不想让任务文件进 git，把 `.meow-team/` 加进项目的 `.gitignore`。

## 测试

```sh
node --test tests/
```
