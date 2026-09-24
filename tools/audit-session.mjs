/**
 * 会话提示词英文残留审计。
 *
 * 从一条已经落盘的 DSH 会话日志里抽出「模型实际看到」的三类文本 ——
 * system prompt、工具 schema、每步追加的运行时上下文快照 —— 然后扫描里面
 * 还残留的英文句子。改完 `data/*.json` 之后跑一次，就能确认本地化没有漏网。
 *
 * 用法：
 *   node tools/audit-session.mjs                 # 取 DSH_HOME 下最近修改的会话
 *   node tools/audit-session.mjs <会话目录>       # 指定某个会话目录
 *   DSH_HOME=/path/to/home node tools/audit-session.mjs
 *
 * 说明：反引号里的命令与标识符（例如 `pnpm run dev:web`）会被忽略，
 * 它们本来就该保持原文；专有名词（DeepSeek Harness、Web GUI 等）同理。
 */
import { execFileSync } from 'node:child_process'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

/** 连续 3 个以上英文单词视为一句话。 */
const ENGLISH_SENTENCE = /[A-Za-z][A-Za-z'’-]*(?:\s+[A-Za-z'’,;.:-]*[A-Za-z][A-Za-z'’,;.:-]*){2,}/g

/** 允许保留的英文：专有名词与产品名。 */
const ALLOWED = /\b(?:DeepSeek Harness|DeepSeek|Web GUI|DSH|MCP|GUI|Office|Vite|HMR|JavaScript|TypeScript|JSON|URI|URL|API|SDK|Node\.js|Windows|PowerShell|Ralph|markdown)\b/g

/** 日志文件名，新版本优先。 */
const SESSION_FILES = ['session.v4.jsonl.zstd', 'session.v3.jsonl.zstd', 'session.v2.jsonl.zstd']

/**
 * 找到要审计的会话日志。
 * @param {string | undefined} explicit 命令行给的会话目录。
 * @returns 日志文件路径。
 */
function resolveSessionFile(explicit) {
  if (explicit !== undefined) {
    for (const name of SESSION_FILES) {
      const file = join(explicit, name)
      try {
        statSync(file)
        return file
      } catch {
        // 换下一个候选名
      }
    }
    throw new Error(`会话目录里没有找到 ${SESSION_FILES.join(' / ')}：${explicit}`)
  }
  const home = process.env.DSH_HOME ?? join(homedir(), '.dsh')
  const root = join(home, 'sessions')
  const candidates = []
  for (const workspace of readdirSync(root)) {
    const dir = join(root, workspace)
    for (const session of readdirSync(dir)) {
      for (const name of SESSION_FILES) {
        const file = join(dir, session, name)
        try {
          candidates.push({ file, mtime: statSync(file).mtimeMs })
        } catch {
          // 这个会话没有该版本的日志
        }
      }
    }
  }
  if (candidates.length === 0) throw new Error(`没有在 ${root} 下找到任何会话日志`)
  candidates.sort((a, b) => b.mtime - a.mtime)
  return candidates[0].file
}

/**
 * 读一条会话日志的全部事件。
 * @param {string} file 日志文件路径。
 * @returns 事件数组。
 */
function readEvents(file) {
  const raw = execFileSync('zstd', ['-dc', '--', file], { maxBuffer: 1024 * 1024 * 512 }).toString('utf8')
  const events = []
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue
    try {
      events.push(JSON.parse(line))
    } catch {
      // 尾部截断的半行忽略
    }
  }
  return events
}

/**
 * 扫描一段文本里的英文句子。
 * @param {string} text 待扫描文本。
 * @returns 命中的英文片段。
 */
function englishSentences(text) {
  const stripped = text.replace(/`[^`]*`/gu, ' ').replace(ALLOWED, ' ')
  return stripped.match(ENGLISH_SENTENCE) ?? []
}

/**
 * 收集一个工具 schema 里所有的描述文本。
 * @param {unknown} node schema 节点。
 * @param {string} path 展示用路径。
 * @param {{ path: string, text: string }[]} out 收集结果。
 */
function collectDescriptions(node, path, out) {
  if (node === null || typeof node !== 'object') return
  if (Array.isArray(node)) {
    node.forEach((value, index) => collectDescriptions(value, `${path}[${index}]`, out))
    return
  }
  for (const [key, value] of Object.entries(node)) {
    if (key === 'description' && typeof value === 'string') {
      out.push({ path: `${path}.description`, text: value })
      continue
    }
    collectDescriptions(value, path === '' ? key : `${path}.${key}`, out)
  }
}

const file = resolveSessionFile(process.argv[2])
const events = readEvents(file)

const systems = events.filter(event => event.type === 'system/message')
const headers = events.filter(event => event.type === 'request/header')
const runtime = events.filter((event) => {
  const parts = event.data?.message?.content ?? event.data?.content ?? []
  return event.type === 'user/message' && JSON.stringify(parts).includes('runtime context')
})

/** 待扫描的三类文本。 */
const targets = []
if (systems.length > 0) {
  const text = systems[systems.length - 1].data.message.content.map(part => part.text ?? '').join('\n\n')
  targets.push({ label: 'system prompt', text })
}
if (headers.length > 0) {
  const tools = headers[headers.length - 1].data.header.tools
  const collected = []
  for (const schema of tools) collectDescriptions(schema, schema.name, collected)
  for (const entry of collected) targets.push({ label: `tool ${entry.path}`, text: entry.text })
}
if (runtime.length > 0) {
  const parts = runtime[runtime.length - 1].data.message?.content ?? []
  targets.push({ label: 'runtime context', text: parts.map(part => part.text ?? '').join('\n\n') })
}

console.log(`会话：${file}`)
console.log(`扫描 ${targets.length} 处文本（system prompt 1 处、工具描述、运行时上下文）\n`)

let findings = 0
for (const target of targets) {
  for (const sentence of englishSentences(target.text)) {
    findings += 1
    console.log(`✗ ${target.label}：${sentence.slice(0, 120)}`)
  }
}

console.log(findings === 0
  ? '\n没有发现英文残留 ✓'
  : `\n发现 ${findings} 处英文残留（如果其中含命令或标识符以外的成句英文，说明 data/*.json 需要补译文）`)
