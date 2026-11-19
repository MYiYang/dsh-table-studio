/**
 * dsh-table-studio — 文档存储。
 *
 * 落盘位置：`$DSH_HOME/table-studio/`
 *   docs/<id>.json      一张表一个文件（人可读，便于备份/接管）
 *   sessions.json       session → 当前表 id，右侧编辑器靠它知道该显示哪张
 *
 * 为什么不用 `.dsh/` 放工作区：表格是会话产物，跟着项目目录走会污染
 * 用户的仓库（`git status` 里冒出一堆 JSON），而这张表也可能被多个
 * 会话引用。所以统一收在家目录。
 *
 * @module dsh-table-studio/lib/store
 */

import { mkdirSync, readFileSync, writeFileSync, readdirSync, renameSync, rmSync, existsSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { decodeText, detectEncoding } from './csv.js'
import { assertId, newId, normalizeTable, tableFromCsv, tableToCsv } from './model.js'

/** 文档格式版本：将来迁移模型时用得上。 */
export const DOC_VERSION = 1

/**
 * 解析家目录：优先 `DSH_HOME`，退回 `~/.dsh`。
 * @returns {string} 目录绝对路径。
 */
export function defaultRoot() {
  const home = process.env.DSH_HOME ?? process.env.DSH_DATA_HOME
  if (typeof home === 'string' && home.trim() !== '') return join(home.trim(), 'table-studio')
  return join(homedir(), '.dsh', 'table-studio')
}

/**
 * 建存储。
 * @param {{ root?: string, log?: (level: string, message: string) => void }} [options] - 配置。
 * @returns {ReturnType<typeof buildStore>} 存储实例。
 */
export function createStore(options = {}) {
  return buildStore(options)
}

/**
 * @param {{ root?: string, log?: (level: string, message: string) => void }} options - 配置。
 */
function buildStore({ root = defaultRoot(), log = () => {} } = {}) {
  const docsDir = join(root, 'docs')
  const sessionsFile = join(root, 'sessions.json')
  /** @type {Map<string, string>} sessionId → docId */
  let sessions = null

  /** 确保目录存在；失败只记日志，不阻断（读操作会自己报错）。 */
  function ensure() {
    try {
      mkdirSync(docsDir, { recursive: true })
    } catch (error) {
      log('warn', `无法创建 ${docsDir}：${error instanceof Error ? error.message : String(error)}`)
    }
  }
  ensure()

  /**
   * 原子写：先写 `.tmp` 再改名，避免编辑器并发保存写出半截 JSON。
   * @param {string} file - 目标文件。
   * @param {string} text - 内容。
   */
  function writeAtomic(file, text) {
    const temp = `${file}.${process.pid}.${Date.now()}.tmp`
    writeFileSync(temp, text, 'utf8')
    renameSync(temp, file)
  }

  /**
   * 读 session 索引（懒加载 + 一次缓存）。
   * @returns {Map<string, string>} 索引。
   */
  function loadSessions() {
    if (sessions !== null) return sessions
    sessions = new Map()
    try {
      if (existsSync(sessionsFile)) {
        const parsed = JSON.parse(readFileSync(sessionsFile, 'utf8'))
        for (const [key, value] of Object.entries(parsed ?? {})) {
          if (typeof value === 'string' && value !== '') sessions.set(key, value)
        }
      }
    } catch (error) {
      log('warn', `sessions.json 读取失败：${error instanceof Error ? error.message : String(error)}`)
    }
    return sessions
  }

  /** 把 session 索引写回磁盘。 */
  function flushSessions() {
    const map = loadSessions()
    try {
      writeAtomic(sessionsFile, `${JSON.stringify(Object.fromEntries(map.entries()), null, 2)}\n`)
    } catch (error) {
      log('warn', `sessions.json 写入失败：${error instanceof Error ? error.message : String(error)}`)
    }
  }

  /**
   * 把内存模型写成文档文件。
   *
   * `sheets` 是编辑器原样交回的 fortune-sheet 工作表数组（含格式、列宽、多张
   * 工作表）。它是「第一次打开时把编辑器恢复成原样」的附加资产：模型侧的
   * columns/rows 仍是权威，CSV 导出、卡片预览都只认它们。没有就整条不写，
   * 免得磁盘上留一串空字段。
   * @param {any} doc - 文档模型。
   * @returns {any} 落盘后的文档。
   */
  function save(doc) {
    ensure()
    const record = {
      version: DOC_VERSION,
      id: doc.id,
      title: doc.title,
      columns: doc.columns,
      rows: doc.rows,
      note: doc.note ?? '',
      source: doc.source ?? '',
      sessionId: doc.sessionId ?? '',
      cwd: doc.cwd ?? '',
      createdAt: doc.createdAt ?? new Date().toISOString(),
      updatedAt: doc.updatedAt ?? new Date().toISOString(),
    }
    const sheets = normalizeSheets(doc.sheets)
    if (sheets !== null) record.sheets = sheets
    writeAtomic(join(docsDir, `${record.id}.json`), `${JSON.stringify(record, null, 2)}\n`)
    return record
  }

  /**
   * 工作表数组的收口：只认「数组、每项是对象、有名字」，其余一律当成没有。
   *
   * 这个字段完全由前端编辑器产生，host 不解析其中细节；但它是用户数据，
   * 不能让 NaN / 函数 / 十几层深的对象进 JSON。
   * @param {unknown} value - 候选值。
   * @returns {any[] | null} 干净的数组；没有则为 null。
   */
  function normalizeSheets(value) {
    if (!Array.isArray(value) || value.length === 0 || value.length > 32) return null
    const out = []
    for (const sheet of value) {
      if (!sheet || typeof sheet !== 'object' || Array.isArray(sheet)) return null
      if (typeof sheet.name !== 'string' || sheet.name.trim() === '') return null
      out.push(sheet)
    }
    return out
  }

  /**
   * 读一张表。
   * @param {string} id - 文档 id。
   * @returns {any | null} 文档；不存在或损坏返回 null。
   */
  function read(id) {
    let safe = ''
    try {
      safe = assertId(id)
    } catch {
      return null
    }
    try {
      const parsed = JSON.parse(readFileSync(join(docsDir, `${safe}.json`), 'utf8'))
      if (!parsed || typeof parsed !== 'object' || !Array.isArray(parsed.columns) || !Array.isArray(parsed.rows)) return null
      return parsed
    } catch {
      return null
    }
  }

  /**
   * 列表：按更新时间倒序。
   * @param {{ sessionId?: string, limit?: number }} [options] - 过滤。
   * @returns {Array<{ id: string, title: string, columns: number, rows: number, updatedAt: string }>} 摘要列表。
   */
  function list(options = {}) {
    ensure()
    const out = []
    let names = []
    try {
      names = readdirSync(docsDir).filter((name) => name.endsWith('.json'))
    } catch {
      return out
    }
    for (const name of names) {
      const doc = read(name.slice(0, -'.json'.length))
      if (doc === null) continue
      if (options.sessionId !== undefined && options.sessionId !== '' && doc.sessionId !== options.sessionId) continue
      out.push({
        id: doc.id,
        title: doc.title,
        columns: doc.columns.length,
        rows: doc.rows.length,
        updatedAt: doc.updatedAt ?? '',
      })
    }
    out.sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)))
    return typeof options.limit === 'number' ? out.slice(0, Math.max(0, options.limit)) : out
  }

  /**
   * 新建一张表并落盘。
   * @param {{ columns?: unknown[], rows?: unknown[], csv?: string, title?: string, note?: string, source?: string, sessionId?: string, cwd?: string, id?: string, sheets?: unknown }} input - 内容。
   * @returns {any} 文档。
   */
  function create(input) {
    const table = normalizeTable(input)
    const stamp = new Date().toISOString()
    return save({
      id: typeof input.id === 'string' && input.id !== '' ? assertId(input.id) : newId(),
      ...table,
      ...(input.sheets === undefined ? {} : { sheets: input.sheets }),
      sessionId: input.sessionId ?? '',
      cwd: input.cwd ?? '',
      createdAt: stamp,
      updatedAt: stamp,
    })
  }

  /**
   * 覆盖更新一张表（可改标题、列、行；`sheets` 三态：数组=替换，null=清掉，省略=不动）。
   * @param {string} id - 文档 id。
   * @param {{ columns?: unknown[], rows?: unknown[], csv?: string, title?: string, note?: string, sheets?: unknown }} patch - 新内容。
   * @returns {any} 文档。
   */
  function update(id, patch) {
    const current = read(id)
    if (current === null) {
      const error = new Error(`找不到表格 ${id}`)
      error.code = 'not-found'
      throw error
    }
    const table = normalizeTable({
      columns: patch.columns ?? current.columns,
      rows: patch.rows ?? current.rows,
      title: patch.title ?? current.title,
      note: patch.note ?? current.note,
      source: current.source,
    })
    /** @type {any} */
    const next = { ...current, ...table, updatedAt: new Date().toISOString() }
    if (patch.sheets === null) delete next.sheets
    else if (patch.sheets !== undefined) next.sheets = patch.sheets
    return save(next)
  }

  /**
   * 记下某个会话当前在看哪张表。
   * @param {string} sessionId - 会话 id。
   * @param {string} docId - 文档 id。
   * @returns {void}
   */
  function setCurrent(sessionId, docId) {
    if (typeof sessionId !== 'string' || sessionId === '') return
    loadSessions().set(sessionId, assertId(docId))
    flushSessions()
  }

  /**
   * 取某个会话当前的表 id。
   * @param {string} sessionId - 会话 id。
   * @returns {string} 文档 id；没有则空串。
   */
  function current(sessionId) {
    if (typeof sessionId !== 'string' || sessionId === '') return ''
    return loadSessions().get(sessionId) ?? ''
  }

  /**
   * 从磁盘读一个 CSV/TSV 文件建表。
   * @param {string} filePath - 文件路径。
   * @param {{ title?: string }} [meta] - 标题等。
   * @returns {{ doc: any, encoding: string }} 结果。
   */
  function importFile(filePath, meta = {}) {
    const absolute = resolve(filePath)
    const stat = statSync(absolute)
    if (!stat.isFile()) {
      const error = new Error(`不是文件：${absolute}`)
      error.code = 'not-file'
      throw error
    }
    if (stat.size > 32 * 1024 * 1024) {
      const error = new Error(`文件过大（${(stat.size / 1024 / 1024).toFixed(1)}MB），上限 32MB`)
      error.code = 'file-too-large'
      throw error
    }
    const bytes = readFileSync(absolute)
    const encoding = detectEncoding(bytes)
    const text = decodeText(bytes)
    const table = tableFromCsv(text, {
      title: meta.title ?? absolute.split(/[\\/]/).pop() ?? '表格',
      source: absolute,
    })
    const stamp = new Date().toISOString()
    const doc = save({ id: newId(), ...table, createdAt: stamp, updatedAt: stamp })
    return { doc, encoding }
  }

  /**
   * 把表写成 CSV 文件（带 BOM，Excel/WPS 打开不乱码）。
   * @param {string} id - 文档 id。
   * @param {string} filePath - 目标路径（相对路径按 cwd 解析）。
   * @param {{ cwd?: string, bom?: boolean }} [options] - 选项。
   * @returns {{ file: string, bytes: number }} 结果。
   */
  function exportFile(id, filePath, options = {}) {
    const doc = read(id)
    if (doc === null) {
      const error = new Error(`找不到表格 ${id}`)
      error.code = 'not-found'
      throw error
    }
    const base = typeof options.cwd === 'string' && options.cwd !== '' ? options.cwd : process.cwd()
    const absolute = resolve(base, filePath)
    mkdirSync(dirname(absolute), { recursive: true })
    const text = tableToCsv(doc, { bom: options.bom !== false })
    writeFileSync(absolute, text, 'utf8')
    return { file: absolute, bytes: Buffer.byteLength(text, 'utf8') }
  }

  /**
   * 删一张表。
   * @param {string} id - 文档 id。
   * @returns {boolean} 删掉了为 true。
   */
  function remove(id) {
    try {
      rmSync(join(docsDir, `${assertId(id)}.json`))
      return true
    } catch {
      return false
    }
  }

  return { root, docsDir, save, read, list, create, update, setCurrent, current, importFile, exportFile, remove }
}
