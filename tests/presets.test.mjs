/**
 * 五个 preset 的结构与工具矩阵测试。
 *
 * 直接用文本切片断言，避免给这个零依赖包引入 YAML 解析器。
 */

import assert from 'node:assert/strict'
import test from 'node:test'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const patch = readFileSync(join(root, 'cordis.patch.yml'), 'utf8')

/**
 * 取出两个标记之间的 YAML 片段。
 * @param {string} start 起始标记。
 * @param {string} [end] 结束标记；省略表示到文件末尾。
 * @returns 片段文本。
 */
function between(start, end) {
  const from = patch.indexOf(start)
  assert.ok(from >= 0, `找不到起始标记 ${start}`)
  const to = end === undefined ? patch.length : patch.indexOf(end, from)
  assert.ok(to > from, `找不到结束标记 ${end}`)
  return patch.slice(from, to)
}

const original = between('preset-zh-meow\n', 'preset-zh-meow-steward')
const steward = between('preset-zh-meow-steward', 'preset-zh-meow-coder')
const coder = between('preset-zh-meow-coder', 'preset-zh-meow-probe')
const probe = between('preset-zh-meow-probe', 'preset-zh-meow-verifier')
const verifier = between('preset-zh-meow-verifier')

test('顶层声明客户端行与配置行', () => {
  assert.match(patch, /id: zh-meow-client/)
  assert.match(patch, /name: '@local\/dsh-zh-meow'\n/)
  assert.match(patch, /id: meow-team-config/)
  assert.match(patch, /name: '@local\/dsh-zh-meow\/team-config'/)
})

test('原版 preset 保持单体能力且不启用团队协议', () => {
  assert.match(original, /id: zh-meow\n/)
  assert.match(original, /name: 喵体中文\n/)
  assert.match(original, /order: 2/)
  assert.match(original, /dsh-tool-fs-search/)
  assert.match(original, /subagent_fork/)
  assert.match(original, /dsh-tool-workflow/)
  assert.ok(!original.includes('teamRole'))
})

test('管家：可读可搜、只写任务文件、带清理与探针工具', () => {
  assert.match(steward, /id: zh-meow-steward/)
  assert.match(steward, /name: 喵体中文·管家/)
  assert.match(steward, /order: 3/)
  assert.match(steward, /teamRole: steward/)
  // 前期细化任务要能自己确认路径、入口与既有约定。
  assert.match(steward, /read: true/)
  assert.match(steward, /readImage: false/)
  assert.match(steward, /write: true/)
  assert.match(steward, /edit: false/)
  assert.match(steward, /dsh-tool-fs-search/)
  assert.match(steward, /name: '@local\/dsh-zh-meow\/delegate'/)
  assert.match(steward, /name: '@local\/dsh-zh-meow\/cleanup'/)
  assert.match(steward, /dsh-tool-subagent-control/)
  // 收尾清理走窄工具，不给管家命令工具：否则它就有能力做实现。
  assert.ok(!steward.includes('dsh-tool-bash'))
  assert.ok(!steward.includes('dsh-tool-pwsh'))
  assert.ok(!steward.includes('dsh-tool-skill'))
  assert.ok(!steward.includes('dsh-tool-web'))
})

test('码农：完整执行工具 + 可再开一层子 agent + 能联系管家', () => {
  assert.match(coder, /id: zh-meow-coder/)
  assert.match(coder, /name: 喵体中文·码农/)
  assert.match(coder, /order: 4/)
  assert.match(coder, /teamRole: coder/)
  assert.match(coder, /dsh-tool-fs-search/)
  assert.match(coder, /dsh-tool-bash/)
  assert.match(coder, /dsh-tool-pwsh/)
  assert.match(coder, /dsh-tool-skill/)
  assert.match(coder, /dsh-tool-web/)
  assert.match(coder, /name: '@deepseek-ai\/dsh-tool-subagent'/)
  assert.match(coder, /maxDepth: 2/)
  assert.match(coder, /dsh-tool-subagent-control/)
  assert.ok(!coder.includes('dsh-tool-ask-user'))
})

test('探针：读写全开但只做验证，不派子 agent、不问主人', () => {
  assert.match(probe, /id: zh-meow-probe/)
  assert.match(probe, /name: 喵体中文·可行性探针（内部）/)
  assert.match(probe, /order: 6/)
  assert.match(probe, /teamRole: probe/)
  assert.match(probe, /dsh-agent-instructions/)
  assert.match(probe, /dsh-tool-fs-search/)
  assert.match(probe, /dsh-tool-bash/)
  assert.match(probe, /dsh-tool-pwsh/)
  // 「完整读写权限」= 不给 tool-fs 传关闭开关。
  assert.ok(!probe.includes('read: false'))
  assert.ok(!probe.includes('write: false'))
  assert.ok(!probe.includes('edit: false'))
  assert.ok(!probe.includes('dsh-tool-ask-user'))
  assert.ok(!probe.includes("name: '@deepseek-ai/dsh-tool-subagent'"))
  assert.ok(!probe.includes('dsh-zh-meow/delegate'))
})

test('校验者：只读 + 可跑命令，无写/编辑/子 agent', () => {
  assert.match(verifier, /id: zh-meow-verifier/)
  assert.match(verifier, /name: 喵体中文·独立校验者/)
  assert.match(verifier, /order: 5/)
  assert.match(verifier, /teamRole: verifier/)
  assert.match(verifier, /read: true/)
  assert.match(verifier, /write: false/)
  assert.match(verifier, /edit: false/)
  assert.match(verifier, /dsh-tool-bash/)
  assert.ok(!verifier.includes("name: '@deepseek-ai/dsh-tool-subagent'"))
  assert.ok(!verifier.includes('dsh-tool-ask-user'))
  assert.ok(!verifier.includes('dsh-tool-todo'))
  assert.ok(!verifier.includes('dsh-tool-skill'))
})

test('五个 preset id 唯一', () => {
  const ids = [...patch.matchAll(/^\s+id: (zh-meow(?:-[a-z]+)?)$/gm)].map(match => match[1])
  assert.deepEqual(ids.sort(), ['zh-meow', 'zh-meow-coder', 'zh-meow-probe', 'zh-meow-steward', 'zh-meow-verifier'])
})
