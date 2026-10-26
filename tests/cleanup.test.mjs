/**
 * `meow_cleanup` 核心逻辑测试。
 *
 * 用真实临时目录跑，覆盖路径校验、dry run、keep 保留与「拒绝删除被跟踪文件」。
 * 这里只 import `cleanup-core.js`：`plugin/cleanup.js` 依赖 `@deepseek-ai/dsh-tools`，
 * 仓库没有 `node_modules` 时在纯 node 环境解析不到。
 */

import assert from 'node:assert/strict'
import test from 'node:test'
import { execFile } from 'node:child_process'
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'

import {
  keepMatcher,
  resolveInsideWorkspace,
  runCleanup,
  taskDirectory,
  toPosix,
} from '../plugin/cleanup-core.js'

const runFile = promisify(execFile)

/**
 * 造一个带任务目录的工作区。
 * @returns `{ root, task }` 工作区根与任务目录绝对路径。
 */
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'meow-cleanup-'))
  const task = join(root, '.meow-team', '0003-demo')
  await mkdir(join(task, 'probe'), { recursive: true })
  await writeFile(join(task, '01-task.md'), '任务')
  await writeFile(join(task, '20-handoff-1.md'), '交付')
  await writeFile(join(task, 'probe', 'sample.txt'), '实验')
  return { root, task }
}

/**
 * 判断本机有没有 git。
 * @returns 是否可用。
 */
async function hasGit() {
  try {
    await runFile('git', ['--version'])
    return true
  } catch {
    return false
  }
}

test('taskDirectory 只接受小写 id，并拼到 .meow-team 下', () => {
  assert.equal(toPosix(taskDirectory('ws', '0003-fix-null-ref')), 'ws/.meow-team/0003-fix-null-ref')
  assert.throws(() => taskDirectory('ws', '0003-fix/../../etc'), /只能包含小写字母/)
  assert.throws(() => taskDirectory('ws', '..'), /只能包含小写字母/)
  assert.throws(() => taskDirectory('ws', ''), /只能包含小写字母/)
  assert.throws(() => taskDirectory('ws', '0003-Upper'), /只能包含小写字母/)
})

test('resolveInsideWorkspace 拒绝越界、根目录与 .git', () => {
  assert.equal(resolveInsideWorkspace('ws', 'tmp/a.txt').rel, 'tmp/a.txt')
  assert.equal(resolveInsideWorkspace('ws', join('tmp', 'nested', 'b.txt')).rel, 'tmp/nested/b.txt')
  assert.throws(() => resolveInsideWorkspace('ws', '.'), /工作区根目录/)
  assert.throws(() => resolveInsideWorkspace('ws', join('..', 'evil')), /必须位于工作区内/)
  assert.throws(() => resolveInsideWorkspace('ws', '.git/config'), /不能指向 \.git/)
  assert.throws(() => resolveInsideWorkspace('ws', '   '), /不能为空/)
})

test('keepMatcher 命中文件与整棵子树', () => {
  const keep = keepMatcher(['01-task.md', 'probe/'])
  assert.equal(keep('01-task.md'), true)
  assert.equal(keep('probe/sample.txt'), true)
  assert.equal(keep('20-handoff-1.md'), false)
  assert.equal(keepMatcher(undefined)('01-task.md'), false)
})

test('dry run 只列清单，不动文件', async () => {
  const { root, task } = await fixture()
  try {
    const result = await runCleanup({ root, taskId: '0003-demo', dryRun: true })
    assert.equal(result.kind, 'cleanup')
    assert.equal(result.dryRun, true)
    assert.deepEqual(result.entries.sort(), [
      '.meow-team/0003-demo/01-task.md',
      '.meow-team/0003-demo/20-handoff-1.md',
      '.meow-team/0003-demo/probe/sample.txt',
    ])
    assert.ok((await stat(join(task, '01-task.md'))).isFile())
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('不带 keep 时删掉整个任务目录', async () => {
  const { root, task } = await fixture()
  try {
    const result = await runCleanup({ root, taskId: '0003-demo' })
    assert.equal(result.entries.length, 3)
    assert.deepEqual(result.kept, [])
    await assert.rejects(stat(task))
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('keep 保留指定文件，其余连同空目录一起收掉', async () => {
  const { root, task } = await fixture()
  try {
    const result = await runCleanup({ root, taskId: '0003-demo', keep: ['01-task.md'] })
    assert.deepEqual(result.kept, ['.meow-team/0003-demo/01-task.md'])
    assert.equal(await readFile(join(task, '01-task.md'), 'utf8'), '任务')
    await assert.rejects(stat(join(task, '20-handoff-1.md')))
    await assert.rejects(stat(join(task, 'probe')))
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('任务目录不存在时只记一条注意，不报错', async () => {
  const { root } = await fixture()
  try {
    const result = await runCleanup({ root, taskId: '0009-missing' })
    assert.deepEqual(result.entries, [])
    assert.match(result.notes[0], /任务目录不存在/)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('既没有 taskId 也没有 extraPaths 时报错', async () => {
  await assert.rejects(runCleanup({ root: 'ws' }), /至少要给 taskId 或 extraPaths/)
})

test('extraPaths 拒绝不在任何 git 仓库内的路径', async (t) => {
  if (!(await hasGit())) {
    t.skip('本机没有 git')
    return
  }
  const root = await mkdtemp(join(tmpdir(), 'meow-cleanup-nogit-'))
  try {
    await writeFile(join(root, 'scratch.txt'), 'temp')
    await assert.rejects(
      runCleanup({ root, extraPaths: ['scratch.txt'] }),
      /不在任何 git 仓库内/,
    )
    assert.ok((await stat(join(root, 'scratch.txt'))).isFile())
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('extraPaths 删未跟踪路径，拒绝被版本控制跟踪的路径', async (t) => {
  if (!(await hasGit())) {
    t.skip('本机没有 git')
    return
  }
  const root = await mkdtemp(join(tmpdir(), 'meow-cleanup-git-'))
  try {
    await writeFile(join(root, 'tracked.txt'), 'keep me')
    await writeFile(join(root, 'scratch.txt'), 'temp')
    await runFile('git', ['-C', root, 'init'], { windowsHide: true })
    await runFile('git', ['-C', root, 'add', 'tracked.txt'], { windowsHide: true })
    await runFile('git', [
      '-C', root,
      '-c', 'user.email=test@example.com',
      '-c', 'user.name=test',
      'commit', '-m', 'init',
    ], { windowsHide: true })

    await assert.rejects(
      runCleanup({ root, extraPaths: ['tracked.txt'] }),
      /被版本控制跟踪/,
    )
    assert.ok((await stat(join(root, 'tracked.txt'))).isFile())

    const result = await runCleanup({ root, extraPaths: ['scratch.txt'] })
    assert.deepEqual(result.entries, ['scratch.txt'])
    await assert.rejects(stat(join(root, 'scratch.txt')))
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
