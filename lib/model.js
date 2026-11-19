/**
 * dsh-table-studio — 表格模型（归一化、限额、序列化）。
 *
 * 一张表在本插件里永远只有一种形状：
 *   `{ columns: string[], rows: string[][] }`
 * 表头单独存放，不混在 rows 里；行长度与列数对齐。CSV 只是它的另一种写法，
 * 卡片、编辑器、工具回执全从这里派生，避免三处各写一套 trim/pad 逻辑。
 *
 * @module dsh-table-studio/lib/model
 */

import { toCsv, parseCsv } from './csv.js'

/** 硬限额：挡住「模型把十万行倒进卡片」这类事故。 */
export const LIMITS = {
  columns: 64,
  rows: 5000,
  cells: 60000,
  cellLength: 20000,
  titleLength: 120,
}

/** 可预期的用户错误（不吐栈，直接在回执里说人话）。 */
export class TableError extends Error {
  /**
   * @param {string} code - 机器可读的错误码。
   * @param {string} message - 人话说明。
   */
  constructor(code, message) {
    super(message)
    this.name = 'TableError'
    this.code = code
  }
}

/**
 * 生成一个可读的 id：`tbl_20261118_9f3ac1`。
 * @param {string} [prefix] - 前缀。
 * @param {Date} [now] - 时间源（测试可注入）。
 * @returns {string} 文档 id。
 */
export function newId(prefix = 'tbl', now = new Date()) {
  const stamp = [
    now.getFullYear(),
    String(now.getMonth() + 1).padStart(2, '0'),
    String(now.getDate()).padStart(2, '0'),
  ].join('')
  const rand = Math.random().toString(16).slice(2, 8).padEnd(6, '0')
  return `${prefix}_${stamp}_${rand}`
}

/**
 * 校验 id 能不能安全地当文件名用（防目录穿越）。
 * @param {unknown} value - 候选 id。
 * @returns {string} 合法 id。
 * @throws {TableError} 不合法时抛。
 */
export function assertId(value) {
  const id = typeof value === 'string' ? value.trim() : ''
  if (!/^[A-Za-z0-9_-]{4,80}$/.test(id)) {
    throw new TableError('bad-id', `文档 id 不合法：${JSON.stringify(value)}。id 形如 tbl_20261118_9f3ac1。`)
  }
  return id
}

/**
 * 单元格转字符串：数字原样，null/undefined 变空串，其余 String()。
 * @param {unknown} value - 原始值。
 * @returns {string} 字符串。
 */
export function cellText(value) {
  if (value === null || value === undefined) return ''
  if (typeof value === 'string') return value
  if (typeof value === 'number') return Number.isFinite(value) ? String(value) : ''
  if (typeof value === 'boolean') return value ? 'TRUE' : 'FALSE'
  return String(value)
}

/**
 * 把列数补齐到 `width`，行数补齐到 `height`。
 * @param {string[][]} rows - 原始行。
 * @param {number} width - 目标列数。
 * @param {number} [height] - 目标行数。
 * @returns {string[][]} 补齐后的行。
 */
function pad(rows, width, height = rows.length) {
  const out = []
  for (let r = 0; r < height; r += 1) {
    const source = rows[r] ?? []
    const row = []
    for (let c = 0; c < width; c += 1) row.push(cellText(source[c]))
    out.push(row)
  }
  return out
}

/**
 * 从「表头 + 行」归一化出一张表：裁掉尾部空行空列、补齐矩形、套上限。
 *
 * 尾部空行是 CSV 最常见的噪音（Excel 存盘常带一行空 CRLF），裁掉它
 * 才能让「3 行数据」显示成 3 行而不是 4 行。
 * @param {{ columns?: unknown[], rows?: unknown[], csv?: string, title?: unknown, note?: unknown, source?: unknown }} input - 原始输入。
 * @returns {{ columns: string[], rows: string[][], title: string, note: string, source: string }} 归一化结果。
 * @throws {TableError} 结构不可用或超限时抛。
 */
export function normalizeTable(input = {}) {
  let columns = Array.isArray(input.columns) ? input.columns.map(cellText) : []
  let rows = Array.isArray(input.rows) ? input.rows.map((row) => (Array.isArray(row) ? row.map(cellText) : [cellText(row)])) : []

  if (columns.length === 0 && rows.length === 0) {
    const csv = typeof input.csv === 'string' ? input.csv : ''
    if (csv.trim() === '') {
      throw new TableError('empty-table', '没有表格内容：请给 columns + rows，或给一段带表头的 csv 文本。')
    }
    const matrix = parseCsv(csv)
    columns = (matrix[0] ?? []).map(cellText)
    rows = matrix.slice(1).map((row) => row.map(cellText))
  }

  if (columns.length === 0) {
    // 只有 rows：第一行当表头——模型时常忘了分开写。
    if (rows.length === 0) throw new TableError('empty-table', '表格没有列：columns 不能为空。')
    columns = rows[0]
    rows = rows.slice(1)
  }

  if (columns.length > LIMITS.columns) {
    throw new TableError('too-many-columns', `列数 ${columns.length} 超过上限 ${LIMITS.columns}，请拆成多张表。`)
  }
  if (rows.length > LIMITS.rows) {
    throw new TableError('too-many-rows', `行数 ${rows.length} 超过上限 ${LIMITS.rows}，请分页渲染。`)
  }
  if (columns.length * Math.max(rows.length, 1) > LIMITS.cells) {
    throw new TableError('too-many-cells', `单元格 ${columns.length}×${rows.length} 超过上限 ${LIMITS.cells}，请拆表。`)
  }

  const width = columns.length
  // 尾部空列：模型常把「表头多写一个空列」带进来。
  while (width > 1 && columns[width - 1].trim() === '' && rows.every((row) => cellText(row[width - 1]).trim() === '')) {
    columns.pop()
    for (const row of rows) row.length = width - 1
    break
  }

  const normalized = pad(rows, columns.length)
  while (normalized.length > 0 && normalized[normalized.length - 1].every((cell) => cell.trim() === '')) {
    normalized.pop()
  }
  for (const row of normalized) {
    for (const cell of row) {
      if (cell.length > LIMITS.cellLength) {
        throw new TableError('cell-too-long', `单个单元格超过 ${LIMITS.cellLength} 字符，请拆分内容。`)
      }
    }
  }

  const title = typeof input.title === 'string' ? input.title.trim().slice(0, LIMITS.titleLength) : ''
  return {
    columns: columns.map((name, index) => (name.trim() === '' ? `列${index + 1}` : name)),
    rows: normalized,
    title: title === '' ? '表格' : title,
    note: typeof input.note === 'string' ? input.note.trim() : '',
    source: typeof input.source === 'string' ? input.source.trim() : '',
  }
}

/**
 * 把表转成 CSV 文本（含表头行）。
 * @param {{ columns: string[], rows: string[][] }} table - 表。
 * @param {{ bom?: boolean, delimiter?: string }} [options] - 序列化选项。
 * @returns {string} CSV 文本。
 */
export function tableToCsv(table, options = {}) {
  return toCsv([table.columns, ...table.rows], options)
}

/**
 * 从 CSV 文本建表：第一行当表头。
 * @param {string} text - CSV 文本。
 * @param {{ title?: string, source?: string }} [meta] - 附加信息。
 * @returns {{ columns: string[], rows: string[][], title: string, note: string, source: string }} 表。
 * @throws {TableError} 空内容时抛。
 */
export function tableFromCsv(text, meta = {}) {
  return normalizeTable({ csv: text, title: meta.title, source: meta.source })
}

/**
 * 转成 Markdown 表格（给模型读，或贴进回复正文）。
 * @param {{ columns: string[], rows: string[][] }} table - 表。
 * @returns {string} Markdown。
 */
export function tableToMarkdown(table) {
  const escape = (text) => String(text).replace(/\|/g, '\\|').replace(/\r?\n/g, ' ')
  const head = `| ${table.columns.map(escape).join(' | ')} |`
  const rule = `| ${table.columns.map(() => '---').join(' | ')} |`
  const body = table.rows.map((row) => `| ${row.map(escape).join(' | ')} |`)
  return [head, rule, ...body].join('\n')
}

/**
 * 表的一句摘要，用于回执与卡片角标。
 * @param {{ columns: string[], rows: string[][] }} table - 表。
 * @returns {string} 例如 `3 列 × 12 行`。
 */
export function tableShape(table) {
  return `${table.columns.length} 列 × ${table.rows.length} 行`
}
