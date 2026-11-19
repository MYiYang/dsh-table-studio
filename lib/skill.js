/**
 * dsh-table-studio — 自带 skill 的注册器。
 *
 * skill 即插件的契约：告诉模型「做表就该走 table_render / table_open」，
 * 而不是拿 markdown 表格糊一遍。注册成 provider 而非往 `~/.dsh/skills`
 * 拷文件——装上插件规则就在，卸掉就跟着走。
 *
 * @module dsh-table-studio/lib/skill
 */

import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

/** 目录名必须符合宿主 skill 命名语法。 */
const SKILL_NAME = /^[a-z0-9]+(?:-[a-z0-9]+)*$/

/**
 * 本包 `skills/` 目录的绝对路径。
 * @returns {string} 目录。
 */
export function bundledSkillsDir() {
  return join(dirname(dirname(fileURLToPath(import.meta.url))), 'skills')
}

/**
 * 剥掉 SKILL.md 顶部的 YAML frontmatter（只认标量）。
 * @param {string} raw - 文件内容。
 * @returns {{ meta: Record<string, string>, body: string }} 头 + 正文。
 */
export function parseFrontmatter(raw) {
  const text = String(raw ?? '').replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n')
  if (!text.startsWith('---\n')) return { meta: {}, body: text.trim() }
  const end = text.indexOf('\n---', 3)
  if (end === -1) return { meta: {}, body: text.trim() }
  const header = text.slice(4, end)
  const bodyStart = text.indexOf('\n', end + 1)
  const body = bodyStart === -1 ? '' : text.slice(bodyStart + 1)
  /** @type {Record<string, string>} */
  const meta = {}
  for (const line of header.split('\n')) {
    if (line.trim() === '' || /^\s/.test(line)) continue
    const colon = line.indexOf(':')
    if (colon <= 0) continue
    const key = line.slice(0, colon).trim()
    let value = line.slice(colon + 1).trim()
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1)
    }
    if (key !== '') meta[key] = value
  }
  return { meta, body: body.trim() }
}

/**
 * 读 `skills/<name>/SKILL.md`。
 * @param {{ dir?: string, log?: (level: string, message: string) => void }} [options] - 选项。
 * @returns {{ skills: object[], skipped: string[] }} 载入结果。
 */
export function loadBundledSkills(options = {}) {
  const log = options.log ?? (() => {})
  const dir = options.dir ?? bundledSkillsDir()
  /** @type {object[]} */
  const skills = []
  /** @type {string[]} */
  const skipped = []
  if (!existsSync(dir)) return { skills, skipped }
  for (const name of readdirSync(dir)) {
    if (!SKILL_NAME.test(name)) {
      skipped.push(name)
      continue
    }
    const file = join(dir, name, 'SKILL.md')
    try {
      if (!existsSync(file) || !statSync(file).isFile()) {
        skipped.push(name)
        continue
      }
      const { meta, body } = parseFrontmatter(readFileSync(file, 'utf8'))
      const skillName = meta.name !== undefined && SKILL_NAME.test(meta.name) ? meta.name : name
      const description = meta.description ?? ''
      if (description === '') {
        log('warn', `skill ${name} 没有 description，跳过`)
        skipped.push(name)
        continue
      }
      skills.push({
        name: skillName,
        description,
        ...(meta.whenToUse === undefined ? {} : { whenToUse: meta.whenToUse }),
        path: file,
        content: body,
      })
    } catch (error) {
      log('warn', `skill ${name} 载入失败：${error instanceof Error ? error.message : String(error)}`)
      skipped.push(name)
    }
  }
  return { skills, skipped }
}

/**
 * 把载入的 skill 拼成 `ctx.skills.register()` 认识的形状。
 * @param {{ name: string, description: string, whenToUse?: string, path: string, content: string }} skill - skill。
 * @returns {Record<string, unknown>} 注册载荷。
 */
export function skillRegistration(skill) {
  return {
    name: skill.name,
    description: skill.description,
    ...(skill.whenToUse === undefined ? {} : { whenToUse: skill.whenToUse }),
    content: skill.content,
    source: 'runtime',
    invocation: { modelInvocable: true, userInvocable: true },
    resourceBase: { kind: 'directory', path: dirname(skill.path) },
    path: skill.path,
  }
}

/**
 * 等 `skills` 服务到位后注册自带 skill；拿不到就只记一行日志。
 * @param {any} ctx - cordis 上下文。
 * @param {{ dir?: string, log?: (level: string, message: string) => void }} [options] - 选项。
 * @returns {{ registered: boolean, skills: string[] }} 结果。
 */
export function registerBundledSkills(ctx, options = {}) {
  const log = options.log ?? (() => {})
  const loaded = loadBundledSkills({ dir: options.dir, log })
  const names = loaded.skills.map((skill) => skill.name)
  if (loaded.skills.length === 0) return { registered: false, skills: names }
  if (typeof ctx?.inject !== 'function') {
    log('warn', `table-studio: 宿主没有 ctx.inject()，${names.length} 个自带 skill 未注册`)
    return { registered: false, skills: names }
  }
  try {
    ctx.inject(['skills'], (scope) => {
      try {
        const registry = scope?.skills
        if (registry === undefined || typeof registry.register !== 'function') {
          log('warn', 'table-studio: skills 注册表没有 register()，自带 skill 跳过')
          return
        }
        for (const skill of loaded.skills) {
          const dispose = registry.register(skillRegistration(skill))
          if (typeof dispose === 'function' && typeof scope.effect === 'function') {
            scope.effect(() => dispose, `table-studio: skill ${skill.name}`)
          }
        }
        log('debug', `table-studio: 自带 skill 已注册：${names.join(', ')}`)
      } catch (error) {
        log('warn', `table-studio: 自带 skill 注册失败：${error instanceof Error ? error.message : String(error)}`)
      }
    })
  } catch (error) {
    log('warn', `table-studio: skills 注入失败：${error instanceof Error ? error.message : String(error)}`)
    return { registered: false, skills: names }
  }
  return { registered: true, skills: names }
}
