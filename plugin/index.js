/**
 * 猫娘提示词中文化插件。
 *
 * 把 `system-prompt/assemble` 组装出的、模型可见的文本整体换成中文猫娘版：
 *   - 每个工具的顶层 description 与参数字典里的 description；
 *   - system prompt 的各段落（section）；
 *   - 每步追加的运行时上下文快照（context）。
 *
 * 只改模型看得到的文字，不动任何标识符、枚举值、参数名与结构，
 * 所以工具的校验、调度、UI 呈现行为都保持原样。
 *
 * 译文数据放在包外的 `../data/*.json`，按文件名区分用途：
 *   - `sections.json`：段落译文表，`{ "段落名": 条目 }`；
 *   - `contexts.json`：运行时上下文规则表，`{ "上下文名": 规则条目 }`；
 *   - 其余 `*.json`：工具译文表，`{ "工具名": 条目 }`（字符串值仍按段落处理，
 *     兼容把段落混写进工具文件的老数据）。
 *
 * 条目可以是：
 *   - 字符串：该节点的描述译文；
 *   - `{ "dynamic": true, "text": "…" }`：只有原文非空时才整段替换
 *     （上游用「返回空串」表示该段落当前不适用）；
 *   - `{ "rules": [{ "pattern": "正则", "text": "替换文本" }] }`：按正则替换，
 *     用于同一段落/上下文在不同配置下文本不同的情况（例如 web_search 是否带
 *     web_fetch 提示、文件策略有三种模式）；`text` 里可以用 `$1` 反向引用；
 *   - 对象树：与源码 JSON Schema 同构，
 *     `{ "description": "…", "parameters": { 参数名: 条目 }, "properties": {…}, "items": 条目 }`。
 *     旧的平铺写法（把参数名直接写在条目里）仍然兼容。
 *
 * 已知的动态段落（上游注册用「返回空串」表示当前不适用，必须带标记或规则）：
 * `plan:policy`、`tool:read`、`tool:write`、`tool:edit`、`tool:glob`、`tool:grep`、
 * `tool:web_search`、`tool:web_fetch`、`tool:subagent`、`tool:subagent_fork`。
 * 漏标的表现是模型在该段落不适用时仍读到它——例如非计划模式下读到整段计划模式规则。
 *
 * 已知限制：运行时上下文快照的开场白
 * （`Current runtime context. This snapshot supersedes earlier runtime-context snapshots.`）
 * 由 `@deepseek-ai/dsh-system-prompt` 的 `joinContextSections` 在组装之后拼上，
 * 插件只能改各 context 自身的文本，改不到这句开场白。
 * @module zh-meow/prompt-localizer
 */

import { readFileSync, readdirSync, statSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

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
 * @property {boolean} [translateContexts] 是否翻译运行时上下文快照（默认 true）。
 */

/** 配置字段：名称、期望类型与默认值。 */
const CONFIG_FIELDS = [
  { name: 'persona', type: 'string', fallback: undefined },
  { name: 'descriptionSuffix', type: 'string', fallback: '' },
  { name: 'translateSections', type: 'boolean', fallback: true },
  { name: 'translateContexts', type: 'boolean', fallback: true },
]

/**
 * 运行时配置 schema。
 *
 * 这里用 Standard Schema 的形状（Cordis 的 `resolveConfig` 只读
 * `Config['~standard'].validate`），而不是引入 schemastery：本 bundle 因此
 * 零外部依赖，复制到别的机器上不需要任何 `node_modules`。
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
 * 全局段落（不由预设插件注册，因此不会出现在 `data/sections.json`）的中文猫娘版。
 * 同名 key 在译文数据里出现时以数据为准。
 */
const BUILTIN_SECTIONS = {
  'harness:identity': '人家是一只由 DeepSeek Harness 驱动的 AI 猫娘喵。',
}

/**
 * 条目里的关键字：这些键不参与「平铺写法」的参数字典回退。
 *
 * `description` 是例外：它既是本节点的描述，也可能是名为 description 的参数，
 * 所以回退时额外把它补进参数字典（见 {@link propertyTableOf}）。
 */
const ENTRY_KEYWORDS = new Set(['description', 'parameters', 'properties', 'items', 'rules', 'dynamic', 'text', 'enumValues'])

/**
 * 判断一个值是不是可当作字典用的普通对象。
 * @param {unknown} value 待判断的值。
 * @returns 是否为非 null、非数组的对象。
 */
function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

/**
 * 译文数据缓存。
 *
 * `data/*.json` 被上游的 HMR 默认忽略规则挡在 watch 之外（`ignored` 里有 `data`），
 * 所以插件自己按「文件清单 + mtime + 大小」判断要不要重读：改完译文不用重启进程，
 * 下一个模型步骤就会用上新文本。
 * @type {{ key: string, value: { tools: Record<string, unknown>, sections: Record<string, unknown>, contexts: Record<string, unknown> } | undefined }}
 */
const dataCache = { key: '', value: undefined }

/**
 * 读入所有译文数据文件。
 *
 * 目录不存在或某个文件坏掉都不该让预设挂载失败：读不懂就跳过该文件，
 * 让对应的提示词保持英文原样。
 * @returns `sections` 为段落译文表、`contexts` 为上下文规则表、
 * `tools` 为工具译文表（值都是「条目」，见模块注释）。
 */
function loadTranslations() {
  let names = []
  try {
    names = readdirSync(DATA_DIR).filter(file => file.endsWith('.json')).sort()
  } catch {
    return { tools: {}, sections: {}, contexts: {} }
  }
  let signature = ''
  for (const file of names) {
    try {
      const stat = statSync(join(DATA_DIR, file))
      signature += `${file}:${String(stat.mtimeMs)}:${String(stat.size)};`
    } catch {
      signature += `${file}:missing;`
    }
  }
  if (dataCache.value !== undefined && dataCache.key === signature) return dataCache.value

  /** @type {Record<string, unknown>} */
  const tools = {}
  /** @type {Record<string, unknown>} */
  const sections = {}
  /** @type {Record<string, unknown>} */
  const contexts = {}
  for (const file of names) {
    let parsed
    try {
      parsed = JSON.parse(readFileSync(join(DATA_DIR, file), 'utf8'))
    } catch {
      continue
    }
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) continue
    if (file === 'contexts.json') {
      Object.assign(contexts, parsed)
      continue
    }
    if (file === 'sections.json') {
      Object.assign(sections, parsed)
      continue
    }
    for (const [key, value] of Object.entries(parsed)) {
      if (typeof value === 'string' || isDynamicSectionText(value) || isRulesEntry(value)) {
        sections[key] = value
        continue
      }
      if (isPlainObject(value)) tools[key] = value
    }
  }
  const value = { tools, sections, contexts }
  dataCache.key = signature
  dataCache.value = value
  return value
}

/**
 * 带条件的整段中文译文。
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
 * 一条正则替换规则。
 * @typedef {object} Rule
 * @property {string} pattern 用于匹配原文的正则（不带标志；`$1` 可在替换文本里反向引用）。
 * @property {string} text 替换文本。
 */

/**
 * 判断译文条目是不是「按正则替换」的规则条目。
 * @param {unknown} value 译文条目。
 * @returns {value is { rules: Rule[] }} 是否为有效的规则条目。
 */
function isRulesEntry(value) {
  return isPlainObject(value)
    && Array.isArray(value.rules)
    && value.rules.length > 0
    && value.rules.every(rule => isPlainObject(rule))
}

/**
 * 取一条规则条目的规则数组：既接受 `{ rules: [...] }`，也接受裸数组。
 * @param {unknown} entry 译文条目。
 * @returns {Rule[] | undefined} 规则数组；不是规则条目时返回 undefined。
 */
function rulesOf(entry) {
  if (Array.isArray(entry)) return entry.every(rule => isPlainObject(rule)) ? entry : undefined
  if (isRulesEntry(entry)) return entry.rules
  return undefined
}

/**
 * 按规则数组依次替换文本。
 *
 * 正则写错、规则形状不对都只跳过那一条：本地化数据不该让整个预设挂掉。
 * @param {string} text 原文。
 * @param {readonly Rule[]} rules 规则数组。
 * @returns 替换后的文本；没有命中时返回原字符串。
 */
function applyRules(text, rules) {
  let out = text
  for (const rule of rules) {
    if (typeof rule.pattern !== 'string' || typeof rule.text !== 'string') continue
    let pattern
    try {
      pattern = new RegExp(rule.pattern)
    } catch {
      continue
    }
    out = out.replace(pattern, rule.text)
  }
  return out
}

/**
 * 取一个段落的最终文本。
 *
 * 原文为空表示「当前不适用」：此时一律原样保留，好让 `renderPrompt` 继续把它
 * 过滤掉（静态段落也不例外——上游用空串表达不适用，替换会把不适用的段落变回可见）。
 * @param {{ name: string, text: string, interpolate?: boolean }} section 已解析文本的段落。
 * @param {Record<string, unknown>} sectionText 段落译文表。
 * @returns 替换后的新段落；无改动时返回原值。
 */
function translateSection(section, sectionText) {
  const entry = sectionText[section.name]
  if (entry === undefined || section.text.length === 0) return section
  if (typeof entry === 'string') {
    return entry.length === 0 ? section : { ...section, text: entry }
  }
  if (isDynamicSectionText(entry)) return { ...section, text: entry.text }
  const rules = rulesOf(entry)
  if (rules !== undefined) {
    const text = applyRules(section.text, rules)
    return text === section.text ? section : { ...section, text }
  }
  return section
}

/**
 * 按规则替换一条运行时上下文快照。
 *
 * 上下文是每步重新渲染的：只有文本真的变了才新建对象，避免无谓的装配差异。
 * @param {{ name: string, text: string }} context 组装出的上下文快照。
 * @param {Record<string, unknown>} contextText 上下文规则表。
 * @returns 替换后的新上下文；无改动时返回原值。
 */
function translateContext(context, contextText) {
  const entry = contextText[context.name]
  if (entry === undefined || context.text.length === 0) return context
  const rules = rulesOf(entry)
  if (rules === undefined) return context
  const text = applyRules(context.text, rules)
  return text === context.text ? context : { ...context, text }
}

/**
 * 取一个译文条目里的子节点字典。
 *
 * 优先级：`parameters`（显式参数表）→ `properties`（与 JSON Schema 同名的写法）
 * → 条目里除关键字外的所有键（旧的平铺写法，参数名直接写在条目里）。
 * 平铺写法里 `description` 两面都要用：既是本节点描述，也可能是名为
 * description 的参数译文，所以额外补进字典。
 * @param {unknown} entry 译文条目。
 * @returns 子节点名 → 译文条目；没有子节点时返回空对象。
 */
function propertyTableOf(entry) {
  if (!isPlainObject(entry)) return {}
  if (isPlainObject(entry.parameters)) return entry.parameters
  if (isPlainObject(entry.properties)) return entry.properties
  const table = {}
  for (const [key, value] of Object.entries(entry)) {
    if (ENTRY_KEYWORDS.has(key)) continue
    table[key] = value
  }
  if (typeof entry.description === 'string' || isPlainObject(entry.description)) {
    table.description = entry.description
  }
  return table
}

/**
 * 取数组节点 `items` 用的译文条目。
 *
 * 两种数据写法都支持：
 *   - 与 schema 同构的元素条目：`{ "description": …, "properties": { 子属性名: 条目 } }`
 *     （判据是它带 `properties`/`parameters`，元素自己的描述写在 `description` 里）；
 *   - 旧的简写：`items` 下直接写元素子属性名（例：`{ "content": "…", "status": "…" }`），
 *     此时元素自身的描述没有译文。
 * @param {unknown} entry 数组节点的译文条目。
 * @returns 元素条目的译文条目；没有 items 或形状不认时返回 undefined。
 */
function itemsEntryOf(entry) {
  if (!isPlainObject(entry)) return undefined
  const items = entry.items
  if (typeof items === 'string') return items
  if (!isPlainObject(items)) return undefined
  if (isPlainObject(items.properties) || isPlainObject(items.parameters)) return items
  return { parameters: items }
}

/**
 * 取本节点描述该换成什么文本。
 * @param {unknown} entry 本节点的译文条目（字符串、带 description 的对象或规则条目）。
 * @param {string} current 上游给的原文描述。
 * @param {string} suffix 追加到描述末尾的标记。
 * @returns 替换后的描述；没有可用译文时返回 undefined。
 */
function descriptionOf(entry, current, suffix) {
  const withSuffix = text => (suffix.length > 0 ? `${text}${suffix}` : text)
  if (typeof entry === 'string') return entry.length > 0 ? withSuffix(entry) : undefined
  if (!isPlainObject(entry)) return undefined
  if (typeof entry.description === 'string') {
    return entry.description.length > 0 ? withSuffix(entry.description) : undefined
  }
  const rules = rulesOf(entry.description) ?? rulesOf(entry)
  if (rules === undefined) return undefined
  const text = applyRules(current, rules)
  return text === current ? undefined : withSuffix(text)
}

/**
 * 改写一个 schema 节点。
 *
 * 只替换 `description`；`type`、`required`、`enum` 取值、`additionalProperties`
 * 等一律原样保留。子节点按 `properties`／`items` 递归下去。
 * @param {unknown} node 当前 schema 节点。
 * @param {unknown} entry 当前节点的译文条目。
 * @param {string} suffix 追加到描述末尾的标记。
 * @returns 改写后的新值；无改动时返回原值。
 */
function translateNode(node, entry, suffix) {
  if (node === null || typeof node !== 'object' || Array.isArray(node)) return node
  if (entry === undefined) return node
  /** @type {Record<string, unknown>} */
  const out = { ...node }
  let changed = false
  if (typeof node.description === 'string') {
    const mapped = descriptionOf(entry, node.description, suffix)
    if (mapped !== undefined && mapped !== node.description) {
      out.description = mapped
      changed = true
    }
  }
  if (isPlainObject(node.properties)) {
    const table = propertyTableOf(entry)
    /** @type {Record<string, unknown>} */
    const properties = {}
    let propertiesChanged = false
    for (const [name, child] of Object.entries(node.properties)) {
      const next = translateNode(child, table[name], suffix)
      properties[name] = next
      if (next !== child) propertiesChanged = true
    }
    if (propertiesChanged) {
      out.properties = properties
      changed = true
    }
  }
  if (isPlainObject(node.items)) {
    const next = translateNode(node.items, itemsEntryOf(entry), suffix)
    if (next !== node.items) {
      out.items = next
      changed = true
    }
  }
  if (isPlainObject(node.parameters)) {
    // 工具 schema 的根节点把参数字典放在 `parameters` 下：这个字典节点自己没有译文
    // （它的描述不是模型可见文案），子节点字典来自条目的 parameters/properties/平铺键。
    const next = translateNode(node.parameters, { parameters: propertyTableOf(entry) }, suffix)
    if (next !== node.parameters) {
      out.parameters = next
      changed = true
    }
  }
  return changed ? out : node
}

/**
 * 改写一条模型可见的工具 schema。
 * @param {{ name: string, description: string, parameters: Record<string, unknown> }} schema 组装出的工具 schema。
 * @param {unknown} entry 该工具的译文条目。
 * @param {string} suffix 追加到描述末尾的标记。
 * @returns 改写后的 schema；没有命中译文时返回原对象。
 */
function translateToolSchema(schema, entry, suffix) {
  if (!isPlainObject(entry)) return schema
  const translated = translateNode(schema, entry, suffix)
  return translated === schema ? schema : translated
}

/**
 * 应用本插件。
 * @param {import('@deepseek-ai/cordis').Context} ctx - 预设作用域上下文。
 * @param {Config} config - 见 {@link Config}。
 */
export function apply(ctx, config = {}) {
  const suffix = typeof config.descriptionSuffix === 'string' ? config.descriptionSuffix : ''
  const translateSections = config.translateSections ?? true
  const translateContexts = config.translateContexts ?? true
  const persona = typeof config.persona === 'string' && config.persona.trim().length > 0 ? config.persona : undefined

  ctx.on('system-prompt/assemble', async (assembly, _context, next) => {
    const assembled = await next()
    // 每次装配都取一次译文表（带 mtime 缓存）：改完 data/*.json 不必重启进程。
    const { tools: toolTable, sections: sectionTable, contexts: contextTable } = loadTranslations()
    const sectionText = { ...BUILTIN_SECTIONS, ...sectionTable }
    const tools = assembled.tools.map(schema => translateToolSchema(schema, toolTable[schema.name], suffix))
    let sections = assembled.sections
    if (translateSections || persona !== undefined) {
      sections = assembled.sections.map((section) => {
        if (persona !== undefined && section.name === 'deployment:persona-prefix') {
          return { ...section, text: persona, interpolate: true }
        }
        return translateSection(section, sectionText)
      })
    }
    let contexts = assembled.contexts
    if (translateContexts && contexts.length > 0) {
      const mapped = contexts.map(context => translateContext(context, contextTable))
      if (mapped.some((context, index) => context !== contexts[index])) contexts = mapped
    }
    return { ...assembled, tools, sections, contexts }
  })
}
