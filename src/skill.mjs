/**
 * 把 shejing 的 SKILL.md 作为**运行时技能**注册给 DSH。
 *
 * 走的是官方 `dsh-skill-badge` 用的那套：注册一个 provider，从自己的包目录里
 * 读文档，不往 `~/.dsh/skills` 写任何文件。这样别人 `dsh plugin add` 装完插件
 * 就自动能用到摄鲸流程，不需要手动软链接。
 *
 * 本机开发期仍然可以让 `~/.dsh/skills/shejing` 软链到本仓库——那是个
 * rank 400 的用户根，比这里的 rank 600 优先，两边内容同源，不冲突。
 */

import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'

const SKILL_BODY_URL = new URL('../skills/shejing/SKILL.md', import.meta.url)
const RESOURCE_BASE = {
  kind: 'directory',
  path: fileURLToPath(new URL('../skills/shejing/', import.meta.url)),
}
const PROVIDER_NAME = 'dsh-shejing'
/** 与 BUNDLED_SKILL_RANK 一致：打包提供的技能。 */
const RANK = 600

/** CJK 之间不该出现折叠标量引入的空格。 */
function foldCjk(text) {
  return text.replace(/(?<=[\u3000-\u303f\u4e00-\u9fff\uff00-\uffef])\s+(?=[\u3000-\u303f\u4e00-\u9fff\uff00-\uffef])/g, '')
}

/**
 * 极简 YAML 前置元数据解析：只支持 `key: 值` 与 `key: >-` / `key: |` 折叠块，
 * 这正是本仓库 SKILL.md 使用的子集。解析失败时返回空对象，由调用方兜底。
 */
export function parseFrontmatter(source) {
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(source)
  if (match === null) return { data: {}, body: source }

  const data = {}
  const lines = match[1].split(/\r?\n/)
  let index = 0
  while (index < lines.length) {
    const line = lines[index]
    index += 1
    const kv = /^([A-Za-z0-9_-]+):\s*(.*)$/.exec(line)
    if (kv === null) continue
    const [, key, rawValue] = kv
    if (rawValue === '>-' || rawValue === '>' || rawValue === '|' || rawValue === '|-') {
      const collected = []
      while (index < lines.length && (lines[index].trim() === '' || /^\s+\S/.test(lines[index]))) {
        collected.push(lines[index].trim())
        index += 1
      }
      while (collected.length > 0 && collected[collected.length - 1] === '') collected.pop()
      const literal = rawValue.startsWith('|')
      data[key] = literal ? collected.join('\n') : foldCjk(collected.join(' '))
    } else {
      data[key] = rawValue.replace(/^['"]|['"]$/g, '')
    }
  }
  return { data, body: source.slice(match[0].length) }
}

async function loadSkill() {
  const source = await readFile(SKILL_BODY_URL, 'utf8')
  const { data, body } = parseFrontmatter(source)
  const name = typeof data.name === 'string' && data.name !== '' ? data.name : 'shejing'
  const description = typeof data.description === 'string' ? data.description : '摄鲸照片工作流。'
  const whenToUse = typeof data.whenToUse === 'string' ? data.whenToUse : undefined
  const candidate = {
    name,
    description,
    ...(whenToUse === undefined ? {} : { whenToUse }),
    invocation: { modelInvocable: true, userInvocable: true },
    provider: PROVIDER_NAME,
    source: 'bundled',
    resourceBase: RESOURCE_BASE,
    rank: RANK,
    locator: SKILL_BODY_URL,
    path: fileURLToPath(SKILL_BODY_URL),
  }
  return {
    candidate,
    definition: {
      name,
      description,
      ...(whenToUse === undefined ? {} : { whenToUse }),
      invocation: candidate.invocation,
      provider: PROVIDER_NAME,
      source: 'bundled',
      resourceBase: RESOURCE_BASE,
      path: candidate.path,
      content: body,
    },
  }
}

export const skillProvider = {
  name: PROVIDER_NAME,
  async list() {
    return [(await loadSkill()).candidate]
  },
  async get() {
    return (await loadSkill()).definition
  },
}

/** 把 provider 挂到 ctx.skills 上；返回 disposer。 */
export function registerSkill(ctx) {
  return ctx.skills.registerProvider(() => skillProvider)
}
