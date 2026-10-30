/**
 * 猫娘提示词中文化插件。
 *
 * 把模型可见的文本整体换成中文猫娘版：
 *   - system prompt 各段落（section）与可选的 persona 前缀，走
 *     `system-prompt/assemble` 瀑布；
 *   - 工具声明（顶层 description、参数字典里的 description），走本预设作用域
 *     自带的工具执行器：`describe()` 返回译文 schema，`execute()` 原样委托给
 *     底层执行器（原生或 PTC）；
 *   - PTC 模式（模型写 `run_code` 程序调工具）下的可见文本：`run_code` 的工具
 *     与参数描述、`tools:ptc-only` 规则、生成的 TypeScript/Python SDK 声明及其
 *     固定说明，译文表在 `data/ptc.json`；
 *   - 框架性英文（运行时上下文快照表头、工作目录/文件策略/审批/委派等上下文、
 *     工作区说明前言、skill 目录前言、目录变更通知、goal 轮次），走
 *     `data/frames.json` 的整句/正则替换表。运行时上下文在 `runtimeContext.project`
 *     入口翻译（它不经过 assemble），宿主生成的说明类消息在 `agent/pre-step`
 *     决策里改写，日志与请求因此保持一致。
 *
 * 执行器模式由「设置 → 喵体中文」里的 `ptc` 开关决定（默认开启 PTC）：每次组装
 * 都重新读配置，所以保存后下一轮生效；宿主没有挂 PTC runtime 或 PTC 包加载失败时
 * 自动退回原生模式，不会让预设挂载失败。
 *
 * 只改模型看得到的文字，不动任何标识符、枚举值、参数名与结构，
 * 所以工具的校验、调度、UI 呈现行为都保持原样。
 *
 * 译文数据放在包外的 `../data/`，方便直接编辑：
 *   - 框架性英文：`frames.json` 的 `{ "phrases": [{ "en", "zh" }], "patterns": [{ "pattern", "flags", "zh" }] }`
 *     （整句用 phrases；带路径、URL、轮次等动态值的用 patterns，`$1` 引用捕获组）
 *   - 工具文件（推荐写法，参数名表放在 `parameters` 下）：
 *     `{ "工具名": { "description": "顶层译文", "parameters": { "参数名": "参数译文", "对象参数名": { "description": "…", "properties": { "子属性名": "…" } }, "数组参数名": { "description": "…", "items": { "properties": { "元素属性名": "…" } } } }, "enumValues": {} } }`
 *   - 工具文件（兼容写法，参数名直接平铺在工具条目上；`description` 与 `enumValues` 被当成元字段，不能同时用作参数名）：
 *     `{ "工具名": { "description": "顶层译文", "enumValues": {}, "参数名": "参数译文", "数组参数名": { "description": "…", "items": { "元素属性名": "…" } } } }`
 *   - 段落文件：`{ "段落名": "段落译文" }`
 *   - 动态段落：`{ "段落名": { "dynamic": true, "text": "段落译文" } }`，只在原文非空时替换
 *
 * 已知的动态段落（上游注册用「返回空串」表示当前不适用，必须带标记）：
 * `plan:policy`、`tool:read`、`tool:write`、`tool:edit`、`tool:glob`、`tool:grep`。
 * 漏标的表现是模型在该段落不适用时仍读到它——例如非计划模式下读到整段计划模式规则。
 *
 * 历史包袱：`system-prompt/assemble` 从 DSH 0.2.1-rc.2 起只承载段落、上下文与
 * 变量（`PromptPresentation`），工具声明归执行器所有。旧实现从 `assembled.tools`
 * 取工具，升级后该字段为 `undefined`，每个模型请求都会抛 TypeError——这就是
 * 「预设突然坏掉」的直接原因。现在工具译文改由作用域执行器提供。
 * @module zh-meow/prompt-localizer
 */

import { readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { dirname, join } from 'node:path'
import { createRequire } from 'node:module'

/** Cordis 插件名。 */
export const name = 'zh-meow-localizer'

/** 本行需要读工具注册表、注册段落、参与组装瀑布。 */
export const inject = ['tools', 'systemPrompt']

/**
 * 插件配置。
 * @typedef {object} Config
 * @property {string} [persona] 非空时，用这段中文猫娘前缀替换 `deployment:persona-prefix` 段落。
 * @property {string} [descriptionSuffix] 追加到每条被改写描述末尾的标记文字（默认空）。
 * @property {boolean} [translateSections] 是否翻译 system prompt 段落（默认 true）。
 * @property {boolean} [translateFrames] 是否翻译运行时上下文、工作区说明前言、skill 目录前言等框架文字（默认 true）。
 * @property {boolean} [translateTools] 是否翻译工具声明（默认 true）。开启时本预设作用域
 *   会装一个「只改描述」的执行器，执行仍委托给底层执行器；PTC 模式下还会翻译
 *   `run_code` 与生成的 SDK。关掉时本插件不接管执行器，也就是说 PTC 模式不会生效。
 * @property {boolean} [reportUntranslated] 是否把没有译文的段落名/工具名写成漏翻自查报告（默认 false）。
 * @property {string} [ptc] PTC 模式偏好：`inherit`（默认，跟随「设置 → 喵体中文」的开关）、
 *   `ptc`（强制 PTC）、`native`（强制原生）。管家这类没有命令工具的角色必须用 `native`：
 *   PTC 的 Node 程序能直接读写文件、跑子进程，会绕开它的「只写任务文件、不跑命令」边界。
 */

/** PTC 模式偏好的合法取值。 */
const PTC_PREFERENCES = new Set(['inherit', 'ptc', 'native'])

/** 配置字段：名称、期望类型与默认值。 */
const CONFIG_FIELDS = [
  { name: 'persona', type: 'string', fallback: undefined },
  { name: 'descriptionSuffix', type: 'string', fallback: '' },
  { name: 'translateSections', type: 'boolean', fallback: true },
  { name: 'translateFrames', type: 'boolean', fallback: true },
  { name: 'translateTools', type: 'boolean', fallback: true },
  { name: 'reportUntranslated', type: 'boolean', fallback: false },
  { name: 'teamRole', type: 'string', fallback: '' },
  { name: 'ptc', type: 'string', fallback: 'inherit' },
]

/** 团队角色：空字符串表示这套 preset 不启用团队协议。 */
const TEAM_ROLES = new Set(['steward', 'coder', 'verifier', 'probe'])

/**
 * 运行时配置 schema。
 *
 * 这里用 Standard Schema 的形状（Cordis 的 `resolveConfig` 只读
 * `Config['~standard'].validate`），而不是引入 schemastery：本 bundle 因此
 * 零安装依赖，复制到别的机器上不需要任何 `node_modules`。
 */
export const Config = {
  '~standard': {
    version: 1,
    vendor: 'zh-meow',
    validate(value) {
      const input = value === null || value === undefined ? {} : value
      if (typeof input !== 'object' || Array.isArray(input)) {
        return { issues: [{ message: 'zh-meow-localizer: config must be an object' }] }
      }
      const known = new Set(CONFIG_FIELDS.map(field => field.name))
      const unknown = Object.keys(input).filter(key => !known.has(key))
      if (unknown.length > 0) {
        return { issues: [{ message: `zh-meow-localizer: unknown config key(s): ${unknown.join(', ')}` }] }
      }
      const out = {}
      for (const field of CONFIG_FIELDS) {
        const raw = input[field.name]
        if (raw === undefined) {
          if (field.fallback !== undefined) out[field.name] = field.fallback
          continue
        }
        if (typeof raw !== field.type) {
          return { issues: [{ message: `zh-meow-localizer: config.${field.name} must be a ${field.type}` }] }
        }
        if (field.name === 'teamRole' && raw.length > 0 && !TEAM_ROLES.has(raw)) {
          return { issues: [{ message: `zh-meow-localizer: config.teamRole must be one of ${[...TEAM_ROLES].join(', ')}` }] }
        }
        if (field.name === 'ptc' && !PTC_PREFERENCES.has(raw)) {
          return { issues: [{ message: `zh-meow-localizer: config.ptc must be one of ${[...PTC_PREFERENCES].join(', ')}` }] }
        }
        out[field.name] = raw
      }
      return { value: out }
    },
  },
}

const here = dirname(fileURLToPath(import.meta.url))
/** 译文数据目录：包目录旁边的 `data/`。 */
const DATA_DIR = join(here, '..', 'data')

/**
 * 漏翻自查报告的路径。
 *
 * 刻意放在包根而不是 `data/` 里：`data/` 下每个 `.json` 都会被当成译文数据
 * 读入，报告自己混进去会被解析成一条无意义的译文。
 *
 * 启用团队协议的 preset 各写一份（文件名带角色），否则三个 preset 每次装配
 * 都会互相覆盖同一份报告。
 * @param {string} [teamRole] 团队角色；空串表示不启用团队协议。
 * @returns 报告文件的绝对路径。
 */
export function reportPath(teamRole) {
  return typeof teamRole === 'string' && teamRole.length > 0
    ? join(DATA_DIR, '..', `.untranslated-report.${teamRole}.json`)
    : join(DATA_DIR, '..', '.untranslated-report.json')
}

/**
 * 判断一段文字看起来是不是已经是中文。
 *
 * 用来给自查报告降噪：第三方插件注册的中文段落（例如 `plugin:*`）本来就不需要
 * 译文，报告把它们标出来，人一眼就能跳过。
 */
const CJK = /[\u4e00-\u9fff]/

/**
 * 本插件自己注册、描述本来就是中文的模型面名称，不进漏翻报告。
 *
 * `meow:` 是协议段落，`subagent_coder` / `subagent_verifier` / `subagent_probe`
 * 是委派工具，`meow_cleanup` 是收尾清理工具。
 */
const SELF_OWNED_NAMES = new Set(['subagent_coder', 'subagent_verifier', 'subagent_probe', 'meow_cleanup'])

/**
 * 写出漏翻自查报告。
 *
 * 报告列出这次装配里「原文非空、但在译文数据里找不到条目」的段落名与工具名，
 * 也就是模型仍然读到英文的那些；每项附带原文片段，便于判断它是不是本来就已经
 * 是中文。内容没变就不重复落盘，避免每轮装配都写磁盘。
 * @param {{ sections: Map<string, string>, tools: Map<string, string> }} untranslated - 本次装配的漏翻项。
 * @param {{ warn?: (message: string, error: unknown) => void }} [logger] - 可选日志器，写盘失败时提示。
 * @param {string} [teamRole] - 团队角色，决定报告文件名。
 * @returns 无。
 */
function writeReport(untranslated, logger, teamRole) {
  /** 把 name → 原文片段 的表转成排好序的数组。 */
  const rows = table => [...table]
    .filter(([name]) => !name.startsWith('meow:') && !SELF_OWNED_NAMES.has(name) && !SELF_OWNED_SECTIONS.has(name))
    .sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)
    .map(([name, sample]) => ({ name, sample, looksChinese: CJK.test(sample) }))
  const body = `${JSON.stringify({
    sections: rows(untranslated.sections),
    tools: rows(untranslated.tools),
    note: '本文件由 zh-meow-localizer 生成：列出的段落/工具在译文数据里没有对应条目，模型读到的仍是原文。looksChinese 为 true 的项多半本来就是中文，可以忽略。',
  }, null, 2)}\n`
  const path = reportPath(teamRole)
  try {
    if (readFileSync(path, 'utf8') === body) return
  } catch {
    // 首次运行或读不出来：直接往下写。
  }
  try {
    writeFileSync(path, body)
  } catch (error) {
    logger?.warn?.('zh-meow-localizer: 写出漏翻报告失败', error)
  }
}

/**
 * 全局段落（不由预设插件注册，因此不会出现在 `data/sections.json`）的中文猫娘版。
 * 同名 key 在译文数据里出现时以数据为准。
 */
const BUILTIN_SECTIONS = {
  'harness:identity': '人家是一只由 DeepSeek Harness 驱动的 AI 猫娘喵。',
}

/** 设置服务不可用或槽位为空时的默认校验者。 */
const DEFAULT_VERIFIERS = [
  { id: 'v1', effort: 'high', mode: 'two-round', model: '' },
  { id: 'v2', effort: 'max', mode: 'one-shot', model: '' },
]

/**
 * 读取角色协议。
 * @param {string} role - 团队角色（steward / coder / verifier）。
 * @returns 协议正文；文件缺失或读不出来时返回空串。
 */
export function loadTeamProtocol(role) {
  if (typeof role !== 'string' || role.length === 0) return ''
  try {
    return readFileSync(join(DATA_DIR, 'team', `${role}.md`), 'utf8').trim()
  } catch {
    return ''
  }
}

/**
 * 描述一个校验者槽位的模式。
 * @param {string} mode - 槽位模式。
 * @returns 中文说明。
 */
function modeText(mode) {
  return mode === 'two-round'
    ? '两轮（第一轮只给原版任务，第二轮再给问答与复核要求）'
    : '一次拿全（原版任务 + 问答 + 交付摘要 + 自检证据）'
}

/**
 * 生成「本次启用的校验者」清单。
 * @param {Array<{ id: string, model?: string, effort?: string, mode?: string }>} verifiers - 启用的槽位。
 * @param {boolean} hasService - 设置服务是否可用。
 * @returns 清单正文。
 */
export function renderVerifierList(verifiers, hasService) {
  if (!hasService) {
    return '设置服务不可用，使用内置默认：槽位 v1（强度 high，两轮）与槽位 v2（强度 max，一次拿全）。'
  }
  if (!Array.isArray(verifiers) || verifiers.length === 0) {
    return '当前没有启用的校验者：直接采用码农交付，并在汇报里注明「未启用独立校验者」。'
  }
  const lines = verifiers.map((verifier) => {
    const model = typeof verifier.model === 'string' && verifier.model.length > 0
      ? verifier.model
      : '继承父 agent'
    const effort = typeof verifier.effort === 'string' && verifier.effort.length > 0
      ? verifier.effort
      : '继承父 agent'
    return `- 槽位 ${verifier.id}：模型 ${model}，强度 ${effort}，模式 ${modeText(verifier.mode)}`
  })
  return [
    '在同一轮里对下面每个槽位调用一次 `subagent_verifier`（`slot` 填槽位 id），等全部结论回来再综合：',
    ...lines,
  ].join('\n')
}

/** 框架性英文替换表：运行时上下文、工作区说明前言、skill 目录前言、通知与 goal 轮次。 */
const FRAMES_FILE = 'frames.json'

/**
 * PTC 模式译文表：`run_code` 工具描述、SDK 固定说明与提权指引。
 *
 * 单独一个文件（而不是塞进 `sections.json` / 工具文件）有两个原因：这些文本是
 * PTC 执行器在运行时拼出来的，不属于任何注册段落或工具；而且译文表要用
 * 「英文整句 → 中文」的替换形式，和 `frames.json` 同构。
 */
const PTC_FILE = 'ptc.json'

/** PTC 模式专属段落名：`tools:ptc-only` 是「只能调 run_code」的规则，`tools:sdk` 是生成的 SDK。 */
const PTC_ONLY_SECTION = 'tools:ptc-only'
const SDK_SECTION = 'tools:sdk'

/** 插件自己产出的两个 PTC 段落：原文已经是中文，不进漏翻报告。 */
const SELF_OWNED_SECTIONS = new Set([PTC_ONLY_SECTION, SDK_SECTION])

/** PTC 模式下唯一直接可调的工具名。 */
const RUN_CODE_TOOL = 'run_code'

/** 模型消息里允许被改写 `source.kind`：都是宿主生成的框架文字，不是用户正文。 */
const FRAMED_MESSAGE_SOURCES = new Set([
  'agent-instructions',
  'skill-catalog',
  'working-directory',
  'user-approval',
  'goal',
  'time-context',
])

/** 已经包过运行时上下文翻译的 agent；每个 agent 只包一次。 */
const patchedAgents = new WeakSet()

/** 解析好的替换表缓存。 */
let framesCache

/** 解析好的 PTC 替换表缓存。 */
let ptcCache

/**
 * 把一份替换表数据解析成可执行的规则。
 *
 * `frames.json` 与 `ptc.json` 共用这套格式：整句用 `phrases` 精确替换，带动态值
 * （路径、URL、轮次、超时数字）的句子用 `patterns`，`$1` 引用捕获组。写坏的
 * 正则只跳过那一条，不牵连整张表。
 * @param {unknown} parsed - 已解析的 JSON 数据。
 * @returns {{ phrases: Array<{ en: string, zh: string }>, patterns: Array<{ regex: RegExp, zh: string }> }} 规则表。
 */
export function parseReplacements(parsed) {
  if (!isPlainObject(parsed)) return { phrases: [], patterns: [] }
  const phrases = (Array.isArray(parsed.phrases) ? parsed.phrases : [])
    .filter(rule => isPlainObject(rule) && typeof rule.en === 'string' && rule.en.length > 0 && typeof rule.zh === 'string')
    .map(rule => ({ en: rule.en, zh: rule.zh }))
  const patterns = (Array.isArray(parsed.patterns) ? parsed.patterns : []).flatMap((rule) => {
    if (!isPlainObject(rule) || typeof rule.pattern !== 'string' || typeof rule.zh !== 'string') return []
    try {
      return [{ regex: new RegExp(rule.pattern, typeof rule.flags === 'string' ? rule.flags : 'u'), zh: rule.zh }]
    } catch {
      // 写坏的正则只跳过这一条，别牵连整张表。
      return []
    }
  })
  return { phrases, patterns }
}

/**
 * 读入 PTC 模式替换表。
 *
 * 结构：`{ ptcOnly: string, phrases: [...], patterns: [...] }`。文件缺失或坏掉时
 * 返回空表：PTC 文本保持英文，但执行器照常工作。
 * @returns {{ ptcOnly: string, phrases: object[], patterns: object[] }} PTC 替换表。
 */
export function loadPtcTable() {
  if (ptcCache !== undefined) return ptcCache
  const empty = { ptcOnly: '', phrases: [], patterns: [] }
  let parsed
  try {
    parsed = JSON.parse(readFileSync(join(DATA_DIR, PTC_FILE), 'utf8'))
  } catch {
    ptcCache = empty
    return empty
  }
  if (!isPlainObject(parsed)) {
    ptcCache = empty
    return empty
  }
  ptcCache = {
    ptcOnly: typeof parsed.ptcOnly === 'string' ? parsed.ptcOnly : '',
    ...parseReplacements(parsed),
  }
  return ptcCache
}

/**
 * 读入框架性英文替换表。
 *
 * 结构：`{ phrases: [{ en, zh }], patterns: [{ pattern, flags, zh }], skills: { 名称: 描述 } }`。
 * 整句用 phrases 精确替换；带动态值（路径、URL、轮次）的句子用 patterns；
 * `skills` 按 skill 名称替换目录里的描述。先跑 phrases 再跑 patterns，
 * 这样通知里的策略名能先变成中文。
 * @returns 替换表；文件缺失或坏掉时返回空表（保持英文，不影响挂载）。
 */
export function loadFrames() {
  if (framesCache !== undefined) return framesCache
  const empty = { phrases: [], patterns: [], skills: {} }
  let parsed
  try {
    parsed = JSON.parse(readFileSync(join(DATA_DIR, FRAMES_FILE), 'utf8'))
  } catch {
    framesCache = empty
    return empty
  }
  if (!isPlainObject(parsed)) {
    framesCache = empty
    return empty
  }
  const { phrases, patterns } = parseReplacements(parsed)
  const skills = {}
  if (isPlainObject(parsed.skills)) {
    for (const [name, description] of Object.entries(parsed.skills)) {
      if (typeof description === 'string' && description.length > 0) skills[name] = description
    }
  }
  framesCache = { phrases, patterns, skills }
  return framesCache
}

/**
 * 把框架性英文换成中文。
 *
 * 纯字符串变换，幂等：中文译文不会再命中英文规则，所以重复调用安全。
 * @param {string} text - 待替换的模型可见文本。
 * @param {{ phrases: Array<{ en: string, zh: string }>, patterns: Array<{ regex: RegExp, zh: string }> }} [frames] - 替换表，默认读缓存。
 * @returns 替换后的文本；没有命中时原样返回。
 */
export function applyFrames(text, frames = loadFrames()) {
  if (typeof text !== 'string' || text.length === 0) return text
  let out = text
  for (const rule of frames.phrases) {
    if (out.includes(rule.en)) out = out.split(rule.en).join(rule.zh)
  }
  for (const rule of frames.patterns) out = out.replace(rule.regex, rule.zh)
  return out
}

/**
 * 替换 skill 目录里的条目描述。
 *
 * 目录行形如 ``- `name`: description``；只按 skill 名称查表，名字（标识符）
 * 保持原样。表里没有的 skill 保留原文，不猜也不编。
 * @param {string} text - skill 目录消息正文。
 * @param {Record<string, string>} skills - skill 名称 → 中文描述。
 * @returns 替换后的正文；没有命中时原样返回。
 */
export function applySkillDescriptions(text, skills) {
  if (typeof text !== 'string' || !text.includes('<available_skills>')) return text
  const names = Object.keys(skills)
  if (names.length === 0) return text
  return text.split('\n').map((line) => {
    const match = /^- `([^`]+)`:\s?(.*)$/u.exec(line)
    if (match === null) return line
    const zh = skills[match[1]]
    return zh === undefined ? line : `- \`${match[1]}\`: ${zh}`
  }).join('\n')
}

/**
 * 改写一条宿主生成的模型消息。
 *
 * 按 `source.kind` 白名单改写框架文字；用户输入的正文、工具结果、skill 文件
 * 内容一律不碰。唯一例外是子 agent 的「回传结果」指引块——它被追加在父 agent
 * 的任务消息里（`source.kind` 是 `user`），所以按块首的固定前缀识别，只改那一块。
 * @param {object} message - 一条用户消息。
 * @param {{ phrases: object[], patterns: object[], skills: Record<string, string> }} frames - 替换表。
 * @returns 改写后的消息；没有命中时返回原对象。
 */
function rewriteFramedMessage(message, frames) {
  if (!isPlainObject(message)) return message
  const content = message.content
  if (!Array.isArray(content)) return message
  const framed = FRAMED_MESSAGE_SOURCES.has(message.source?.kind)
  const skillCatalog = message.source?.kind === 'skill-catalog'
  let changed = false
  const next = content.map((block) => {
    if (!isPlainObject(block) || block.type !== 'text' || typeof block.text !== 'string') return block
    const childGuidance = isChildReturnGuidance(block.text)
    if (!framed && !childGuidance) return block
    let text = applyFrames(block.text, frames)
    if (skillCatalog) text = applySkillDescriptions(text, frames.skills)
    if (text === block.text) return block
    changed = true
    return { ...block, text }
  })
  return changed ? { ...message, content: next } : message
}

/** 子 agent 回传指引块的固定开头。 */
const CHILD_RETURN_GUIDANCE_PREFIX = 'Your parent agent id is '

/**
 * 判断一个文本块是不是宿主追加给子 agent 的「回传结果」指引。
 * @param {string} text - 文本块内容。
 * @returns 是否命中固定开头与 `send_message` 调用。
 */
function isChildReturnGuidance(text) {
  return text.startsWith(CHILD_RETURN_GUIDANCE_PREFIX) && text.includes('send_message(')
}

/**
 * 给一个 agent 的运行时上下文投影包上中文翻译。
 *
 * 运行时上下文快照由 agent-loop 在 `agent/pre-step` 之后重新渲染并投影，
 * 不走 `system-prompt/assemble`，所以只能在投影入口处翻译。包装后再交给
 * 原来的 `project()`，投影的去重状态记录的就是中文快照，不会每步重复推送。
 * @param {{ runtimeContext?: { project?: Function } }} agent - 当前 agent。
 * @param {{ phrases: object[], patterns: object[] }} frames - 替换表。
 * @returns 无。
 */
function ensureRuntimeContextTranslation(agent, frames) {
  if (agent === undefined || agent === null || patchedAgents.has(agent)) return
  const projection = agent.runtimeContext
  if (projection === undefined || typeof projection.project !== 'function') return
  const original = projection.project
  projection.project = function project(current, sections) {
    return original.call(this, applyFrames(current, frames), sections)
  }
  patchedAgents.add(agent)
}

/**
 * 读入所有译文数据文件。
 *
 * 目录不存在或某个文件坏掉都不该让预设挂载失败：读不懂就跳过该文件，
 * 让对应的提示词保持英文原样。
 * @returns `sections` 为段落译文表：段落名 → 译文条目（字符串，或带 `dynamic` 标记的动态条目）；
 * `tools` 为工具译文表：工具名 → 译文条目。
 */
export function loadTranslations() {
  /** @type {Record<string, { description?: string, parameters?: Record<string, string>, enumValues?: Record<string, string[]> }>} */
  const tools = {}
  /** @type {Record<string, string | DynamicSectionText>} */
  const sections = {}
  let names = []
  try {
    // frames.json 是框架性英文的替换表，ptc.json 是 PTC 模式替换表，都不是
    // 段落/工具译文，走各自的加载函数。
    names = readdirSync(DATA_DIR)
      .filter(file => file.endsWith('.json') && file !== FRAMES_FILE && file !== PTC_FILE)
      .sort()
  } catch {
    return { tools, sections }
  }
  for (const file of names) {
    let parsed
    try {
      parsed = JSON.parse(readFileSync(join(DATA_DIR, file), 'utf8'))
    } catch {
      continue
    }
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) continue
    for (const [key, value] of Object.entries(parsed)) {
      if (typeof value === 'string') {
        sections[key] = value
        continue
      }
      if (isDynamicSectionText(value)) {
        sections[key] = value
        continue
      }
      if (value !== null && typeof value === 'object') tools[key] = value
    }
  }
  return { tools, sections }
}

/**
 * 带条件的中文译文段落。
 *
 * 数据文件里写成对象而不是字符串，是为了让人一眼看出它不能无条件替换。
 * `dynamic` 标记该段落的原文由上游按需提供（当前不需要它时为 `''`），
 * 无条件替换会把空段落变成非空段落，而 `renderPrompt` 只过滤空文本，
 * 于是模型会在该段落本不适用时读到它，进而误判自身状态。
 * @typedef {object} DynamicSectionText
 * @property {true} dynamic 仅在原文非空时替换。
 * @property {string} text 中文译文。
 */

/**
 * 判断译文条目是不是带 `dynamic` 标记的动态段落。
 * @param {unknown} value 译文条目。
 * @returns {value is DynamicSectionText} 是否为有效的动态段落条目。
 */
function isDynamicSectionText(value) {
  return isPlainObject(value)
    && value.dynamic === true
    && typeof value.text === 'string'
    && value.text.length > 0
}

/**
 * 取一个段落的最终文本。
 *
 * 动态段落的原文为空表示「当前不适用」：此时原样保留，好让
 * `renderPrompt` 继续把它过滤掉。静态段落与原文非空的动态段落换成译文。
 * @param {{ name: string, text: string, interpolate?: boolean }} section 已解析文本的段落。
 * @param {Record<string, string | DynamicSectionText>} sectionText 段落译文表。
 * @returns 替换后的新段落；无改动时返回原值。
 */
function translateSection(section, sectionText) {
  const entry = sectionText[section.name]
  if (entry === undefined) return section
  if (typeof entry === 'string') {
    return entry.length === 0 ? section : { ...section, text: entry }
  }
  if (section.text.length === 0) return section
  return { ...section, text: entry.text }
}

/**
 * 改写一个 schema 节点的描述。
 *
 * 译文条目与源码 JSON Schema 的 `properties`/`items` 同构：
 *   - 参数名 → 该参数的描述字符串；
 *   - 参数本身是对象（数组参数）→ `{ "description": ..., "items": { 子属性名: 译文 } }`。
 *
 * `entry` 是本节点的描述来源，`base` 是本节点「子属性名 → 译文」的来源。
 * 两者在数组元素那一层会分叉：元素自己的描述在 `entry.description`，
 * 而元素的各个子属性名却在 `base`（即上一层的 `items`）里。
 * 只替换 `description`；`type`、`required`、`enum` 取值、
 * `additionalProperties` 等一律原样保留。
 * @param {unknown} node - 当前 schema 节点。
 * @param {unknown} entry - 本节点的译文（字符串或含 description 的对象）。
 * @param {Record<string, unknown>} base - 本节点子属性名的译文表。
 * @param {string} suffix - 追加到描述末尾的标记。
 * @returns 改写后的新值；无改动时返回原值。
 */
function translateNode(node, entry, base, suffix) {
  if (node === null || typeof node !== 'object' || Array.isArray(node)) return node
  /** @type {Record<string, unknown>} */
  const out = {}
  let changed = false
  for (const [key, value] of Object.entries(node)) {
    if (key === 'properties' && isPlainObject(value)) {
      /** @type {Record<string, unknown>} */
      const properties = {}
      let propertiesChanged = false
      for (const [propertyName, propertySchema] of Object.entries(value)) {
        const propertyEntry = base[propertyName]
        const child = translateNode(
          propertySchema,
          propertyEntry,
          descendantBase(propertyEntry),
          suffix,
        )
        properties[propertyName] = child
        if (child !== propertySchema) propertiesChanged = true
      }
      out[key] = propertiesChanged ? properties : value
      changed = changed || propertiesChanged
      continue
    }
    if (key === 'items' && isPlainObject(value)) {
      // 元素层：描述仍来自本节点，子属性名改从本节点的 `items` 取。
      const child = translateNode(value, entry, descendantBase(entry), suffix)
      out[key] = child
      changed = changed || child !== value
      continue
    }
    if (key === 'description' && typeof value === 'string') {
      const mapped = lookupDescription(entry)
      if (mapped !== undefined) {
        out[key] = suffix.length > 0 ? `${mapped}${suffix}` : mapped
        changed = true
        continue
      }
    }
    out[key] = value
  }
  return changed ? out : node
}

/**
 * 取译文条目里的子属性表。
 *
 * 译文条目与源码 JSON Schema 同构，子属性名的位置有两种写法：
 *   - 推荐写法（`parameters` 嵌套）：对象参数用 `properties`，数组参数用
 *     `items.properties`；
 *   - 兼容写法（平铺）：数组参数的 `items` 下直接就是子属性名。
 * @param {unknown} entry - 译文条目。
 * @returns 子属性名 → 译文；没有这层时返回空对象。
 */
function descendantBase(entry) {
  if (!isPlainObject(entry)) return {}
  if (isPlainObject(entry.properties)) return entry.properties
  if (isPlainObject(entry.items)) {
    return isPlainObject(entry.items.properties) ? entry.items.properties : entry.items
  }
  return {}
}

/**
 * 取工具条目里的「参数名 → 译文」表。
 *
 * 两种写法都认：
 *   - 推荐写法：参数名表放在工具条目的 `parameters` 下。只有这种写法能表达一个
 *     真的叫 `description` 的参数，不会和条目自己的元字段打架。
 *   - 兼容写法：参数名直接平铺在工具条目上，`description` 与 `enumValues` 是
 *     这个条目的元字段，因此不参与参数匹配。
 * @param {unknown} entry - 工具译文条目。
 * @returns 参数名 → 译文；没有参数时返回空对象。
 */
function parameterTable(entry) {
  if (!isPlainObject(entry)) return {}
  if (isPlainObject(entry.parameters)) return entry.parameters
  const table = {}
  for (const [key, value] of Object.entries(entry)) {
    if (key === 'description' || key === 'enumValues') continue
    table[key] = value
  }
  return table
}

/**
 * 取当前译文条目自己的描述文字。
 * @param {unknown} entry - 译文条目；可以是纯字符串。
 * @returns 译文；没有可用描述时返回 undefined。
 */
function lookupDescription(entry) {
  if (typeof entry === 'string') return entry.length > 0 ? entry : undefined
  if (!isPlainObject(entry)) return undefined
  const value = entry.description
  return typeof value === 'string' && value.length > 0 ? value : undefined
}

/**
 * 判断一个值是不是可当作字典用的普通对象。
 * @param {unknown} value - 待判断的值。
 * @returns 是否为非 null、非数组的对象。
 */
function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

/**
 * 把注册表里的工具定义收窄成模型可见的 schema。
 *
 * 与 `projectToolSchema` 的字段白名单一致：只保留 name / description /
 * parameters / deferLoading，执行回调与呈现回调都不进 schema。
 * @param {{ name: string, description: string, parameters?: unknown, deferLoading?: boolean }} definition - 工具定义。
 * @returns 新的 schema 对象。
 */
function projectDefinition(definition) {
  return {
    name: definition.name,
    description: definition.description,
    parameters: definition.parameters,
    ...definition.deferLoading === true ? { deferLoading: true } : {},
  }
}

/**
 * 改写一条模型可见的工具 schema。
 * @param {{ name: string, description: string, parameters: unknown }} schema - 组装出的工具 schema。
 * @param {Record<string, unknown>} entry - 该工具的译文条目。
 * @param {string} suffix - 追加到描述末尾的标记。
 * @returns 改写后的 schema；没有命中译文时返回原对象。
 */
function translateToolSchema(schema, entry, suffix) {
  if (!isPlainObject(entry)) return schema
  const mapped = lookupDescription(entry)
  const description = mapped === undefined
    ? schema.description
    : (suffix.length > 0 ? `${mapped}${suffix}` : mapped)
  // 参数名的译文表在工具条目的 `parameters` 下，而不是工具条目本身：
  // 传错这一层会让每个参数的描述都取不到译文（历史缺陷：工具级描述是中文、
  // 参数描述却整片保留英文）。
  const parameters = translateNode(schema.parameters, entry, parameterTable(entry), suffix)
  if (description === schema.description && parameters === schema.parameters) return schema
  return { ...schema, description, parameters }
}

/**
 * 造一个只改描述的工具执行器。
 *
 * 工具声明现在归执行器所有：`system-prompt/assemble` 拿不到工具，因此译文必须
 * 在 `describe()` 这一层给出。执行（参数校验、分发、日志、取消）全部原样委托给
 * 原生执行器，本包装器只替换 schema 里的文字。
 * @param {{ execute: (input: unknown) => Promise<unknown> }} native - 原生执行器，负责真正的批次执行。
 * @param {Record<string, unknown>} toolTable - 工具译文表。
 * @param {string} suffix - 追加到描述末尾的标记。
 * @param {(untranslated: Map<string, string>) => void} [onDescribe] - 每次描述后报告本批漏翻工具。
 * @returns 可直接交给 `ctx.tools.setExecutor()` 的执行器。
 */
export function createTranslatingExecutor(native, toolTable, suffix = '', onDescribe) {
  return {
    describe(definitions) {
      const untranslated = new Map()
      const schemas = definitions.map((definition) => {
        // 空描述要么是上游的占位，要么是纯 schema 工具，都不该出现在报告里。
        if (definition.description.length > 0 && toolTable[definition.name] === undefined) {
          untranslated.set(definition.name, definition.description.slice(0, 120))
        }
        return translateToolSchema(projectDefinition(definition), toolTable[definition.name], suffix)
      })
      onDescribe?.(untranslated)
      return { schemas }
    },
    execute(input) {
      return native.execute(input)
    },
  }
}

/**
 * 递归改写 schema 里每个 `description`。
 *
 * 只碰 `description` 这个键：`type`、`required`、`enum` 取值、`const` 与结构字段
 * 一律原样保留，数组里的元素按位置递归（元素本身是字符串时不处理，避免把枚举
 * 取值当成描述翻掉）。
 * @param {unknown} node - 当前 schema 节点（或子节点）。
 * @param {(text: string) => string} transform - 单条描述的改写函数。
 * @returns 改写后的新值；无改动时返回原值。
 */
function mapSchemaDescriptions(node, transform) {
  if (Array.isArray(node)) {
    let changed = false
    const next = node.map((item) => {
      const mapped = mapSchemaDescriptions(item, transform)
      if (mapped !== item) changed = true
      return mapped
    })
    return changed ? next : node
  }
  if (!isPlainObject(node)) return node
  /** @type {Record<string, unknown>} */
  const out = {}
  let changed = false
  for (const [key, value] of Object.entries(node)) {
    if (key === 'description' && typeof value === 'string') {
      const mapped = transform(value)
      out[key] = mapped
      if (mapped !== value) changed = true
      continue
    }
    const mapped = mapSchemaDescriptions(value, transform)
    out[key] = mapped
    if (mapped !== value) changed = true
  }
  return changed ? out : node
}

/**
 * 翻译 PTC 的 `run_code` schema。
 *
 * `run_code` 的描述由执行器在运行时拼出来（语言 flavor + runtime 执行说明 +
 * 目录规则 + 提权指引），所以译文走 `data/ptc.json` 的整句替换，而不是静态字段。
 * 参数描述同理：`code` / `description` / `timeoutMs` / `sandbox_permissions` /
 * `justification` 各是一句固定文本（超时那句带动态默认值与上限，用正则）。
 * @param {{ name: string, description: string, parameters: unknown }} schema - 执行器给出的 `run_code` schema。
 * @param {{ phrases: object[], patterns: object[] }} ptcTable - PTC 替换表。
 * @param {string} [suffix] - 追加到顶层描述末尾的标记。
 * @returns 改写后的 schema；没有命中译文时返回原对象。
 */
export function translatePtcSchema(schema, ptcTable, suffix = '') {
  if (!isPlainObject(schema)) return schema
  const original = schema.description
  const mapped = typeof original === 'string' ? applyFrames(original, ptcTable) : original
  // 与原生分支一致：只有真的换过描述才追加标记，没命中译文的描述保持原样。
  const description = typeof mapped === 'string' && mapped !== original && suffix.length > 0 ? `${mapped}${suffix}` : mapped
  const parameters = mapSchemaDescriptions(schema.parameters, text => applyFrames(text, ptcTable))
  if (description === schema.description && parameters === schema.parameters) return schema
  return { ...schema, description, parameters }
}

/**
 * 渲染中文的 PTC SDK 声明。
 *
 * 先按工具译文表改写每个定义的描述，再交给上游的 SDK 渲染器：这样生成的
 * TypeScript/Python 声明与真实绑定完全同构，只有描述是中文。渲染完再用
 * `data/ptc.json` 把固定说明句子（`## Writing code for run_code`、调用规则、
 * bash 示例引导等）换成中文。
 * @param {readonly object[]} definitions - 本步可见的工具定义。
 * @param {{ render: (schemas: object[]) => string, ptcTable: object, toolTable: Record<string, unknown>, suffix: string, onDescribe?: (untranslated: Map<string, string>) => void }} options - 渲染器与译文表。
 * @returns 中文 SDK 段落文本。
 */
export function renderLocalizedSdk(definitions, options) {
  const { render, ptcTable, toolTable, suffix, onDescribe } = options
  const untranslated = new Map()
  const schemas = definitions.map((definition) => {
    if (definition.description.length > 0 && toolTable[definition.name] === undefined) {
      untranslated.set(definition.name, definition.description.slice(0, 120))
    }
    const projected = translateToolSchema(projectDefinition(definition), toolTable[definition.name], suffix)
    return { ...projected, output: definition.output?.schema }
  })
  onDescribe?.(untranslated)
  return applyFrames(render(schemas), ptcTable)
}

/**
 * 主人是否想要 PTC 模式。
 *
 * 设置服务不可用或配置读不出来时按默认（开启）处理：模式开关是个优化项，
 * 不该因为设置页故障把工具换掉。
 * @param {{ get?: (name: string) => unknown }} ctx - 预设作用域上下文。
 * @returns true 表示优先 PTC；false 表示主人明确关掉。
 */
export function prefersPtc(ctx) {
  const service = typeof ctx.get === 'function' ? ctx.get('meowTeam') : undefined
  if (!isPlainObject(service) || typeof service.ptcMode !== 'function') return true
  try {
    return service.ptcMode() !== false
  } catch {
    return true
  }
}

/**
 * 解析当前该用哪种执行器。
 *
 * 每次调用都重新读设置服务的 volatile 引用，所以「设置 → 喵体中文」里切换
 * PTC 开关后，下一轮组装就会换执行器。PTC 包或 runtime 不可用时退回原生模式：
 * 模式开关是主人的意愿，能不能兑现由宿主能力决定。
 * @param {{ get?: (name: string) => unknown }} ctx - 预设作用域上下文。
 * @param {boolean} ptcReady - PTC 执行器与 SDK 渲染器是否加载成功。
 * @param {'inherit' | 'ptc' | 'native'} [preference] - preset 级偏好；`native` 强制原生（管家用这个）。
 * @returns {'ptc' | 'native'} 当前模式。
 */
export function resolveExecutorMode(ctx, ptcReady, preference = 'inherit') {
  if (preference === 'native') return 'native'
  const wantsPtc = preference === 'ptc' ? true : prefersPtc(ctx)
  if (!wantsPtc || !ptcReady) return 'native'
  if (typeof ctx.get === 'function' && ctx.get('ptcRuntime') === undefined) return 'native'
  return 'ptc'
}

/**
 * 造一个双模式执行器：PTC 模式下暴露 `run_code` 与中文 SDK，原生模式下直接
 * 暴露中文工具声明。两种模式共用同一个实例，所以设置页切换开关时不需要重装
 * 执行器，也不会撞上「每个作用域只允许一个执行器」的限制。
 *
 * 选路发生在每次 `describe()`、`execute()` 与段落渲染时，而不是构造时；PTC
 * 执行器本身也按需创建，避免在 runtime 尚未挂载的启动阶段就失败。
 * @param {{ resolveMode: () => 'ptc' | 'native', native: { describe: Function, execute: Function }, getPtc?: () => ({ describe: Function, execute: Function } | undefined), ptcTable: object, toolTable: Record<string, unknown>, suffix: string, renderSdk: (definitions: readonly object[]) => string, sectionOrder: (name: string) => number, onDescribe?: (untranslated: Map<string, string>) => void }} options - 执行器、译文表与渲染入口。
 * @returns 可直接交给 `ctx.tools.setExecutor()` 的执行器。
 */
export function createModeExecutor(options) {
  const { resolveMode, native, getPtc, ptcTable, toolTable, suffix, renderSdk, sectionOrder, onDescribe } = options
  const translatingNative = createTranslatingExecutor(native, toolTable, suffix, onDescribe)
  /** 当前真正生效的 PTC 执行器；模式为 native 时恒为 undefined。 */
  const activePtc = () => resolveMode() === 'ptc' ? getPtc?.() : undefined
  return {
    // 两个 PTC 段落常驻注册：原生模式下文本为空串，`renderPrompt` 会把空段落
    // 过滤掉；这样切换模式不需要增删段落（提示词前缀因此更稳定）。
    sections: [
      {
        name: PTC_ONLY_SECTION,
        order: sectionOrder(PTC_ONLY_SECTION),
        interpolate: false,
        text: () => activePtc() === undefined ? '' : ptcTable.ptcOnly,
      },
      {
        name: SDK_SECTION,
        order: sectionOrder(SDK_SECTION),
        interpolate: false,
        text: definitions => activePtc() === undefined ? '' : renderSdk(definitions),
      },
    ],
    describe(definitions) {
      const ptc = activePtc()
      if (ptc === undefined) return translatingNative.describe(definitions)
      const input = ptc.describe(definitions)
      return { ...input, schemas: input.schemas.map(schema => translatePtcSchema(schema, ptcTable, suffix)) }
    },
    execute(input) {
      return (activePtc() ?? native).execute(input)
    },
  }
}

/**
 * 按预设 Loader 的解析基准加载一个包。
 *
 * 插件文件位于 bundle 目录（例如 `D:\zh-meow`），裸包名按 Node 默认规则解析不到
 * DSH 的安装位置。宿主启动时会安装一层运行期解析拦截，能把 `@deepseek-ai/*`
 * 映射到安装目录，所以先直接 `import()`；拦截没覆盖到的情况下，再退回用
 * 声明该预设的 Loader 的 `baseUrl` 起一个 require。
 * @param {import('@deepseek-ai/cordis').Context} ctx - 预设作用域上下文，携带 `baseUrl`。
 * @param {string} specifier - 包名。
 * @returns 模块命名空间；两条路都失败时返回 undefined。
 */
async function importHostPackage(ctx, specifier) {
  try {
    return await import(specifier)
  } catch {
    // 落回下面的 baseUrl 解析。
  }
  const baseUrl = ctx.baseUrl
  if (typeof baseUrl !== 'string' || baseUrl.length === 0) return undefined
  try {
    const require = createRequire(new URL('package.json', baseUrl))
    const resolved = require.resolve(specifier)
    return await import(pathToFileURL(resolved).href)
  } catch {
    return undefined
  }
}

/**
 * 加载宿主自带的原生工具执行器。
 * @param {import('@deepseek-ai/cordis').Context} ctx - 预设作用域上下文。
 * @returns 执行器构造函数；解析不到时返回 undefined。
 */
async function loadNativeExecutor(ctx) {
  const mod = await importHostPackage(ctx, '@deepseek-ai/dsh-tool-executor-native')
  if (typeof mod?.NativeToolExecutor === 'function') return mod.NativeToolExecutor
  ctx.logger?.warn?.('zh-meow-localizer: 无法加载原生工具执行器，工具描述保持原文')
  return undefined
}

/**
 * 加载 PTC 工具执行器与 SDK 渲染器。
 *
 * 这是「可选能力」：旧版 DSH 或精简部署里可能根本没有这个包。加载失败不是
 * 错误，只是让模式解析退回原生执行器。
 * @param {import('@deepseek-ai/cordis').Context} ctx - 预设作用域上下文。
 * @returns `{ PtcExecutor, renderToolsSdk, renderToolsSdkPy }`；缺任意一项时返回 undefined。
 */
async function loadPtcModules(ctx) {
  const mod = await importHostPackage(ctx, '@deepseek-ai/dsh-tool-executor-ptc')
  if (typeof mod?.PtcExecutor !== 'function') return undefined
  if (typeof mod.renderToolsSdk !== 'function' || typeof mod.renderToolsSdkPy !== 'function') return undefined
  return { PtcExecutor: mod.PtcExecutor, renderToolsSdk: mod.renderToolsSdk, renderToolsSdkPy: mod.renderToolsSdkPy }
}

/**
 * 在预设作用域里装好「只改描述」的双模式执行器。
 *
 * 原生执行器是硬依赖：拿不到就不接管，工具描述保持原文。PTC 执行器是软依赖：
 * 加载失败或 runtime 缺失时自动退回原生模式，只记一条警告。
 * 失败都不影响预设挂载：段落翻译照常工作。
 * @param {import('@deepseek-ai/cordis').Context} ctx - 预设作用域上下文。
 * @param {Record<string, unknown>} toolTable - 工具译文表。
 * @param {string} suffix - 追加到描述末尾的标记。
 * @param {(untranslated: Map<string, string>) => void} onDescribe - 报告本批漏翻工具。
 * @param {'inherit' | 'ptc' | 'native'} [ptcPreference] - preset 级 PTC 偏好；管家传 `native`。
 * @returns 无。
 */
async function installToolTranslator(ctx, toolTable, suffix, onDescribe, ptcPreference = 'inherit') {
  if (Object.keys(toolTable).length === 0) return
  if (typeof ctx.tools?.setExecutor !== 'function') return
  const NativeToolExecutor = await loadNativeExecutor(ctx)
  if (NativeToolExecutor === undefined) return
  // 强制原生模式的 preset（管家）不需要 PTC 包：省掉一次 import，也不会误报降级警告。
  const ptcModules = ptcPreference === 'native' ? undefined : await loadPtcModules(ctx)
  const ptcTable = loadPtcTable()
  /** 懒创建：runtime 可能比预设晚挂载，构造失败就永久退回原生模式。 */
  let ptcExecutor
  let ptcFailed = false
  /** PTC 降级提示只打一次，避免每轮组装都刷日志。 */
  let warnedFallback = false

  const resolveMode = () => {
    const mode = resolveExecutorMode(ctx, ptcModules !== undefined, ptcPreference)
    const wantsPtc = ptcPreference === 'ptc' || (ptcPreference === 'inherit' && prefersPtc(ctx))
    if (mode === 'native' && ptcModules !== undefined && !warnedFallback && wantsPtc) {
      warnedFallback = true
      ctx.logger?.warn?.('zh-meow-localizer: 没有可用的 PTC runtime，PTC 模式退回原生执行器')
    }
    return mode
  }

  /**
   * 渲染中文 SDK 段落。
   * @param {readonly object[]} definitions - 本步可见的工具定义。
   * @returns SDK 段落文本；runtime 缺失或语言不支持时返回空串。
   */
  const renderSdk = (definitions) => {
    if (ptcModules === undefined) return ''
    const runtime = typeof ctx.get === 'function' ? ctx.get('ptcRuntime') : undefined
    if (!isPlainObject(runtime)) return ''
    const render = runtime.language === 'python'
      ? schemas => ptcModules.renderToolsSdkPy(schemas)
      : schemas => ptcModules.renderToolsSdk(schemas, runtime.programFormat)
    try {
      return renderLocalizedSdk(definitions, { render, ptcTable, toolTable, suffix, onDescribe })
    } catch (error) {
      ctx.logger?.warn?.('zh-meow-localizer: 渲染中文 PTC SDK 失败，本段保留原文', error)
      return ''
    }
  }

  /** 懒创建 PTC 执行器；失败时降级为原生模式。 */
  const getPtc = () => {
    if (ptcModules === undefined || ptcFailed) return undefined
    if (ptcExecutor !== undefined) return ptcExecutor
    try {
      ptcExecutor = new ptcModules.PtcExecutor(ctx)
      return ptcExecutor
    } catch (error) {
      ptcFailed = true
      ctx.logger?.warn?.('zh-meow-localizer: PTC 执行器初始化失败，改用原生执行器', error)
      return undefined
    }
  }

  /**
   * 取 PTC 段落的固定顺序。
   *
   * 常量由上游 `systemPrompt` 拥有：拿不到时退回 PTC 模式公开的顺序值，并夹在
   * 合法数字上——顺序错只是段落位置偏一点，比整个执行器注册失败好得多。
   * @param {string} name - 段落名。
   * @returns 有限数字顺序。
   */
  const sectionOrder = (name) => {
    try {
      const order = ctx.systemPrompt.getSectionOrder(name)
      if (Number.isFinite(order)) return order
    } catch {
      // 旧版宿主没有这两个常量，走下面的默认值。
    }
    return name === PTC_ONLY_SECTION ? 800 : 5000
  }

  try {
    const native = new NativeToolExecutor(ctx)
    ctx.tools.setExecutor(createModeExecutor({
      resolveMode,
      native,
      getPtc,
      ptcTable,
      toolTable,
      suffix,
      renderSdk,
      sectionOrder,
      onDescribe,
    }))
  } catch (error) {
    ctx.logger?.warn?.('zh-meow-localizer: 安装工具描述执行器失败，工具描述保持原文', error)
  }
}

/**
 * 应用本插件。
 * @param {import('@deepseek-ai/cordis').Context} ctx - 预设作用域上下文。
 * @param {Config} config - 见 {@link Config}。
 * @returns 安装完成的 Promise（执行器要异步加载）。
 */
export async function apply(ctx, config = {}) {
  const suffix = typeof config.descriptionSuffix === 'string' ? config.descriptionSuffix : ''
  const translateSections = config.translateSections ?? true
  const translateFrames = config.translateFrames ?? true
  const translateTools = config.translateTools ?? true
  const reportUntranslated = config.reportUntranslated ?? false
  const teamRole = typeof config.teamRole === 'string' ? config.teamRole : ''
  const { tools: toolTable, sections: sectionTable } = loadTranslations()
  const sectionText = { ...BUILTIN_SECTIONS, ...sectionTable }
  const persona = typeof config.persona === 'string' && config.persona.trim().length > 0 ? config.persona : undefined

  // 团队协议段落：文本每次组装都重新读设置服务，所以「设置 → 喵体中文」里
  // 增删校验者或改强度后，下一个 turn 就生效。
  //
  // 校验者清单只给管家：`subagent_verifier` 由 `zh-meow-delegate` 注册，而它只
  // 挂在管家 preset 上。码农、校验者、探针的 prompt 里出现「调用 subagent_verifier」
  // 就是让他们去调一个不存在的工具，所以这里提前收窄。
  if (teamRole.length > 0 && typeof ctx.systemPrompt?.section === 'function') {
    const protocol = loadTeamProtocol(teamRole)
    if (protocol.length === 0) {
      ctx.logger?.warn?.(`zh-meow-localizer: 找不到 data/team/${teamRole}.md，团队协议段落不注册`)
    } else {
      ctx.systemPrompt.section({
        name: 'meow:team',
        order: ctx.systemPrompt.getSectionOrder('TEAM_POLICY'),
        text: () => {
          if (teamRole !== 'steward') return protocol
          const service = typeof ctx.get === 'function' ? ctx.get('meowTeam') : undefined
          let verifiers = DEFAULT_VERIFIERS
          let hasService = false
          if (service !== undefined && typeof service.verifiers === 'function') {
            const rows = service.verifiers()
            if (Array.isArray(rows)) {
              verifiers = rows
              hasService = true
            }
          }
          return `${protocol}\n\n## 本次启用的校验者（来自「设置 → 喵体中文」）\n\n${renderVerifierList(verifiers, hasService)}`
        },
      })
    }
  }

  /** 最近一次工具描述里没有译文的工具；由执行器的 describe 更新。 */
  let untranslatedTools = new Map()

  // 先订阅瀑布，再异步装执行器：瀑布只改段落、上下文与变量，绝不碰工具声明。
  ctx.on('system-prompt/assemble', async (assembly, _context, next) => {
    const assembled = await next()
    const untranslated = { sections: new Map(), tools: untranslatedTools }
    let sections = assembled.sections
    if (translateSections || persona !== undefined) {
      sections = assembled.sections.map((section) => {
        if (persona !== undefined && section.name === 'deployment:persona-prefix') {
          return { ...section, text: persona, interpolate: true }
        }
        // translateSections 关闭时只换 persona，别的段落原样返回。
        if (!translateSections) return section
        // 原文为空表示这个段落当前不适用，落进报告只会是一串噪音。
        if (reportUntranslated && section.text.length > 0 && sectionText[section.name] === undefined) {
          untranslated.sections.set(section.name, section.text.slice(0, 120))
        }
        return translateSection(section, sectionText)
      })
    }
    if (reportUntranslated) writeReport(untranslated, ctx.logger, teamRole)
    return { ...assembled, sections }
  })

  // 框架文字：运行时上下文快照在投影入口翻译（它不走 assemble），
  // 宿主生成的说明类消息在 pre-step 的决策里改写（日志与请求保持一致）。
  if (translateFrames) {
    const frames = loadFrames()
    ctx.on('agent/pre-step', async (payload, next) => {
      const decision = await next()
      ensureRuntimeContextTranslation(payload?.agent, frames)
      if (decision?.kind !== 'enter' || !Array.isArray(decision.messages)) return decision
      return { ...decision, messages: decision.messages.map(message => rewriteFramedMessage(message, frames)) }
    }, { prepend: true })
  }

  if (translateTools) {
    await installToolTranslator(ctx, toolTable, suffix, (report) => {
      untranslatedTools = report
    }, typeof config.ptc === 'string' ? config.ptc : 'inherit')
  }
}
