/**
 * `meow_cleanup` 的核心逻辑：路径解析、清单收集、真删。
 *
 * 单独拆出来是为了可测：`plugin/cleanup.js` 要 import `@deepseek-ai/dsh-tools`，
 * 而这个包在仓库里没有 `node_modules` 时解析不到，测试只能覆盖这一层。
 * 这里只依赖 node 内置模块，纯函数 + 文件系统操作，不碰 DSH 服务。
 *
 * @module zh-meow/cleanup-core
 */

import { execFile } from 'node:child_process'
import { readdir, rm, rmdir, stat, unlink } from 'node:fs/promises'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { promisify } from 'node:util'

const runFile = promisify(execFile)

/** 任务目录根：`<工作区>/.meow-team`。 */
export const TASK_ROOT = '.meow-team'

/** 任务 id 只允许小写字母、数字与连字符，天然挡掉路径分隔符与 `..`。 */
const TASK_ID = /^[0-9a-z]+(?:-[0-9a-z]+)*$/

/**
 * 把路径统一成 `/` 分隔，用于展示与 `keep` 匹配。
 * @param {string} path 任意平台的路径。
 * @returns 正斜杠分隔的路径。
 */
export function toPosix(path) {
  return path.replace(/\\/g, '/')
}

/**
 * 由工作区根与任务 id 拼出任务目录。
 * @param {string} root 工作区根目录。
 * @param {string} taskId 任务目录名，例如 `0003-fix-null-ref`。
 * @returns 任务目录的绝对路径。
 */
export function taskDirectory(root, taskId) {
  if (typeof taskId !== 'string' || !TASK_ID.test(taskId)) {
    throw new Error(`taskId 只能包含小写字母、数字和连字符，收到 ${JSON.stringify(taskId)}`)
  }
  return join(root, TASK_ROOT, taskId)
}

/**
 * 把一个路径解析成「工作区内的相对路径」，越界就报错。
 *
 * 这是 `extraPaths` 的唯一入口：删错的代价不可逆，所以宁可在解析阶段就拒绝。
 * @param {string} root 工作区根目录。
 * @param {string} target 绝对路径或相对工作区的路径。
 * @param {string} [label] 报错时使用的名字。
 * @returns `{ absolute, rel }`，`rel` 为正斜杠分隔的相对路径。
 */
export function resolveInsideWorkspace(root, target, label = '路径') {
  if (typeof target !== 'string' || target.trim().length === 0) {
    throw new Error(`${label} 不能为空`)
  }
  const absolute = isAbsolute(target) ? resolve(target) : resolve(root, target)
  const rel = relative(root, absolute)
  if (rel.length === 0) throw new Error(`${label} 不能是工作区根目录本身`)
  if (rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
    throw new Error(`${label} 必须位于工作区内：${target}`)
  }
  if (toPosix(rel).split('/')[0] === '.git') throw new Error(`${label} 不能指向 .git`)
  return { absolute, rel: toPosix(rel) }
}

/**
 * 造一个 `keep` 判定函数。
 *
 * `keep` 里的每一项都是「相对任务目录」的路径，命中它的文件与它的子树都保留。
 * @param {unknown} keep 工具参数里的 `keep`。
 * @returns 判定 `(相对路径) => 是否保留`。
 */
export function keepMatcher(keep) {
  const prefixes = (Array.isArray(keep) ? keep : [])
    .filter(value => typeof value === 'string' && value.trim().length > 0)
    .map(value => toPosix(value.trim()).replace(/^\.\//, '').replace(/\/+$/, ''))
  return rel => prefixes.some(prefix => rel === prefix || rel.startsWith(`${prefix}/`))
}

/**
 * 判断一个路径是否存在。
 * @param {string} path 目标路径。
 * @returns 是否存在。
 */
async function exists(path) {
  try {
    await stat(path)
    return true
  } catch {
    return false
  }
}

/**
 * 递归列出目录下的所有文件（不含目录本身）。
 * @param {string} directory 起始目录。
 * @returns 文件的绝对路径数组。
 */
export async function listFiles(directory) {
  const out = []
  const walk = async (dir) => {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name)
      if (entry.isDirectory()) await walk(path)
      else out.push(path)
    }
  }
  await walk(directory)
  return out
}

/**
 * 自底向上删掉空目录；非空或已不存在就保留。
 * @param {string} directory 起始目录。
 * @returns 无。
 */
export async function pruneEmptyDirectories(directory) {
  let children
  try {
    children = await readdir(directory, { withFileTypes: true })
  } catch {
    return
  }
  for (const child of children) {
    if (child.isDirectory()) await pruneEmptyDirectories(join(directory, child.name))
  }
  try {
    await rmdir(directory)
  } catch {
    // 还有保留文件，或者别的进程刚写了东西进来：保留这个目录。
  }
}

/**
 * 找到某个路径所属的 git 仓库根。
 *
 * 工作区根不一定就是仓库根：`D:\project` 这样的多仓库工作区里，每个子目录各是
 * 一个仓库。所以从目标自身（目录）或它的父目录（文件）开始向上找最近的 `.git`。
 * @param {string} root 工作区根目录。
 * @param {string} absolute 工作区内的绝对路径。
 * @returns 仓库根；找不到时返回 undefined。
 */
async function findRepositoryRoot(root, absolute) {
  const info = await stat(absolute).catch(() => undefined)
  let dir = info !== undefined && info.isDirectory() ? absolute : dirname(absolute)
  for (;;) {
    if (await exists(join(dir, '.git'))) return dir
    if (resolve(dir) === resolve(root)) return undefined
    const parent = dirname(dir)
    if (parent === dir) return undefined
    dir = parent
  }
}

/**
 * 查一个相对路径下有没有被 git 跟踪的文件。
 *
 * `available: false` 表示「判断不成立」：路径不在任何 git 仓库内，或者宿主没有
 * git。调用方必须把它当成拒绝理由——`extraPaths` 宁可删不掉，也不能删错。
 * @param {string} root 工作区根目录。
 * @param {string} rel 相对工作区的路径。
 * @returns `{ available, files }`：是否拿到了 git 的判定，以及命中的已跟踪文件。
 */
export async function trackedFiles(root, rel) {
  const absolute = join(root, rel)
  const repository = await findRepositoryRoot(root, absolute)
  if (repository === undefined) return { available: false, files: [] }
  const inside = toPosix(relative(repository, absolute))
  try {
    const { stdout } = await runFile('git', ['-C', repository, 'ls-files', '--', inside], { windowsHide: true })
    const files = stdout.split('\n').map(line => line.trim()).filter(line => line.length > 0)
    return { available: true, files }
  } catch {
    return { available: false, files: [] }
  }
}

/**
 * 执行一次清理。
 * @param {object} request 清理请求。
 * @param {string} request.root 工作区根目录。
 * @param {string} [request.taskId] 任务目录名。
 * @param {string[]} [request.extraPaths] 任务目录之外的临时路径。
 * @param {unknown} [request.keep] 相对任务目录、要保留的路径。
 * @param {boolean} [request.dryRun] 只列清单不真删。
 * @returns `{ kind, dryRun, entries, kept, notes }`。
 */
export async function runCleanup(request) {
  const { root, taskId, extraPaths, keep, dryRun = false } = request
  const extras = Array.isArray(extraPaths) ? extraPaths : []
  if ((taskId === undefined || taskId === '') && extras.length === 0) {
    throw new Error('meow_cleanup 至少要给 taskId 或 extraPaths 之一')
  }

  const notes = []
  /** 待清理目标：目录或单个文件，带展示名与 keep 判定。 */
  const targets = []

  if (typeof taskId === 'string' && taskId.length > 0) {
    const directory = taskDirectory(root, taskId)
    if (await exists(directory)) {
      targets.push({ absolute: directory, label: `${TASK_ROOT}/${taskId}`, keep: keepMatcher(keep) })
    } else {
      notes.push(`任务目录不存在，跳过：${TASK_ROOT}/${taskId}`)
    }
  }

  for (const raw of extras) {
    const { absolute, rel } = resolveInsideWorkspace(root, raw, 'extraPaths 项')
    const tracked = await trackedFiles(root, rel)
    if (!tracked.available) {
      throw new Error(
        `无法确认 ${rel} 是否被版本控制跟踪（这条路径不在任何 git 仓库内），拒绝删除；`
        + '请交给码农清理，或让主人手动处理',
      )
    }
    if (tracked.files.length > 0) {
      throw new Error(
        `extraPaths 项被版本控制跟踪，拒绝删除：${rel}（命中 ${tracked.files.length} 个已跟踪文件；`
        + '这类改动请交给码农处理）',
      )
    }
    if (await exists(absolute)) {
      targets.push({ absolute, label: rel, keep: undefined })
    } else {
      notes.push(`路径不存在，跳过：${rel}`)
    }
  }

  const entries = []
  const kept = []
  for (const target of targets) {
    const info = await stat(target.absolute)
    const files = info.isDirectory() ? await listFiles(target.absolute) : [target.absolute]
    for (const path of files) {
      const rel = info.isDirectory() ? toPosix(relative(target.absolute, path)) : ''
      const label = info.isDirectory() ? `${target.label}/${rel}` : target.label
      if (target.keep !== undefined && info.isDirectory() && target.keep(rel)) {
        kept.push(label)
        continue
      }
      entries.push({ absolute: path, label, target })
    }
  }

  if (!dryRun) {
    for (const target of targets) {
      // 没有 keep 的目标（任务目录之外的临时路径）整个删掉，包括目录本身。
      if (target.keep === undefined) {
        await rm(target.absolute, { recursive: true, force: true })
        continue
      }
      // 有 keep 的目标逐个删文件，剩下的空目录自底向上收掉。
      for (const entry of entries) {
        if (entry.target === target) await unlink(entry.absolute)
      }
      await pruneEmptyDirectories(target.absolute)
    }
  }

  return {
    kind: 'cleanup',
    dryRun,
    entries: entries.map(entry => entry.label),
    kept,
    notes,
  }
}
