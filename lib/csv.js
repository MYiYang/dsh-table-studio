/**
 * dsh-table-studio — CSV 编解码（零依赖）。
 *
 * 这里只做一件事：把「文本」和「二维字符串矩阵」互相转，且按 RFC 4180
 * 处理引号、换行、分隔符。中文 CSV 最容易翻车的两处（Excel/WPS 导出的
 * GBK 编码、字段里带逗号）都在本文件收口，上层不重复判断。
 *
 * @module dsh-table-studio/lib/csv
 */

/** 支持的分隔符候选，按优先级排列。 */
const DELIMITERS = [',', '\t', ';', '|']

/**
 * 判断一个字节序列是否是合法的 UTF-8。
 * @param {Uint8Array} bytes - 原始字节。
 * @returns {boolean} 合法为 true。
 */
function isUtf8(bytes) {
  try {
    new TextDecoder('utf-8', { fatal: true }).decode(bytes)
    return true
  } catch {
    return false
  }
}

/**
 * 判编码：只回答「该用哪种解码器」，不负责解码。
 *
 * 判断顺序：BOM → 严格 UTF-8 → GBK。中文 Windows 上 Excel 导出的 CSV
 * 绝大多数是这三者之一，剩下的极端情况（Big5 等）按 UTF-8 兜底。
 * @param {Uint8Array | Buffer | string} input - 原始字节。
 * @returns {'utf-8' | 'utf-16le' | 'utf-16be' | 'gbk'} 编码标签。
 */
export function detectEncoding(input) {
  if (typeof input === 'string') return 'utf-8'
  const bytes = input instanceof Uint8Array ? input : new Uint8Array(input)
  if (bytes.length >= 2) {
    if (bytes[0] === 0xff && bytes[1] === 0xfe) return 'utf-16le'
    if (bytes[0] === 0xfe && bytes[1] === 0xff) return 'utf-16be'
  }
  if (bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) return 'utf-8'
  if (isUtf8(bytes)) return 'utf-8'
  return 'gbk'
}

/**
 * 把磁盘上的 CSV 字节解成文本：认 BOM，非 UTF-8 时退回 GBK。
 *
 * Excel/WPS 在中文 Windows 上「另存为 CSV」默认是 GBK（无 BOM），
 * 直接用 UTF-8 读会把「位置」读成乱码；反过来 UTF-8 的 BOM 若留在
 * 首格，第一列表头会变成「﻿位置」，按表头找列就全部落空。
 * @param {Uint8Array | Buffer | string} input - 文件内容。
 * @returns {string} 文本（已去 BOM）。
 */
export function decodeText(input) {
  if (typeof input === 'string') return input.replace(/^\uFEFF/, '')
  const bytes = input instanceof Uint8Array ? input : new Uint8Array(input)
  if (bytes.length === 0) return ''
  if (bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) {
    return new TextDecoder('utf-8').decode(bytes.subarray(3))
  }
  if (bytes[0] === 0xff && bytes[1] === 0xfe) {
    try {
      return new TextDecoder('utf-16le').decode(bytes.subarray(2))
    } catch {
      /* 落到 UTF-8 分支 */
    }
  }
  if (bytes[0] === 0xfe && bytes[1] === 0xff) {
    try {
      return new TextDecoder('utf-16be').decode(bytes.subarray(2))
    } catch {
      /* 落到 UTF-8 分支 */
    }
  }
  if (isUtf8(bytes)) return new TextDecoder('utf-8').decode(bytes)
  try {
    return new TextDecoder('gbk').decode(bytes)
  } catch {
    return new TextDecoder('utf-8').decode(bytes)
  }
}

/**
 * 猜分隔符：在前若干行里数「引号外的」候选字符，取最多者。
 *
 * 只看前 20 行，避免几万行的表把探测本身变成开销；空白表退回逗号。
 * @param {string} text - CSV 文本。
 * @returns {string} 分隔符。
 */
export function detectDelimiter(text) {
  const sample = String(text ?? '').split(/\r\n|\n|\r/).slice(0, 20).join('\n')
  /** @type {Record<string, number>} */
  const counts = {}
  for (const delimiter of DELIMITERS) counts[delimiter] = 0
  let quoted = false
  for (let i = 0; i < sample.length; i += 1) {
    const char = sample[i]
    if (char === '"') {
      if (quoted && sample[i + 1] === '"') {
        i += 1
        continue
      }
      quoted = !quoted
      continue
    }
    if (quoted) continue
    if (char in counts) counts[char] += 1
  }
  let best = ','
  let bestCount = 0
  for (const delimiter of DELIMITERS) {
    if (counts[delimiter] > bestCount) {
      best = delimiter
      bestCount = counts[delimiter]
    }
  }
  return best
}

/**
 * 解析 CSV 文本为二维字符串矩阵。
 *
 * 容错取向：宁可多出一行空行，也不要吃掉用户的换行——所以引号内的
 * CR/LF 原样保留，引号外的 CRLF 视为行结束。
 * @param {string} text - CSV 文本。
 * @param {{ delimiter?: string }} [options] - delimiter 省略时自动探测。
 * @returns {string[][]} 行 × 列。
 */
export function parseCsv(text, options = {}) {
  const source = decodeText(text)
  const delimiter = typeof options.delimiter === 'string' && options.delimiter !== ''
    ? options.delimiter
    : detectDelimiter(source)
  /** @type {string[][]} */
  const rows = []
  /** @type {string[]} */
  let row = []
  let field = ''
  let quoted = false
  let started = false
  for (let i = 0; i < source.length; i += 1) {
    const char = source[i]
    if (quoted) {
      if (char === '"') {
        if (source[i + 1] === '"') {
          field += '"'
          i += 1
          continue
        }
        quoted = false
        continue
      }
      field += char
      continue
    }
    if (char === '"') {
      quoted = true
      started = true
      continue
    }
    if (char === delimiter) {
      row.push(field)
      field = ''
      started = true
      continue
    }
    if (char === '\r' || char === '\n') {
      if (char === '\r' && source[i + 1] === '\n') i += 1
      row.push(field)
      rows.push(row)
      row = []
      field = ''
      started = false
      continue
    }
    field += char
    started = true
  }
  if (started || field !== '' || row.length > 0) {
    row.push(field)
    rows.push(row)
  }
  return rows
}

/**
 * 转义单个字段：含分隔符 / 引号 / 换行 / 首尾空格时加引号。
 * @param {unknown} value - 单元格值。
 * @param {string} delimiter - 分隔符。
 * @returns {string} 可安全写入 CSV 的文本。
 */
function escapeField(value, delimiter) {
  const text = value === null || value === undefined ? '' : String(value)
  const needsQuote = text.includes('"') || text.includes(delimiter) || /[\r\n]/.test(text)
    || text !== text.trim()
  if (!needsQuote) return text
  return `"${text.replace(/"/g, '""')}"`
}

/**
 * 把二维矩阵序列化成 CSV 文本。
 * @param {unknown[][]} rows - 行 × 列。
 * @param {{ delimiter?: string, eol?: string, bom?: boolean, trailingNewline?: boolean }} [options] - 序列化选项。
 * @returns {string} CSV 文本。
 */
export function toCsv(rows, options = {}) {
  const delimiter = typeof options.delimiter === 'string' && options.delimiter !== '' ? options.delimiter : ','
  const eol = typeof options.eol === 'string' && options.eol !== '' ? options.eol : '\r\n'
  const list = Array.isArray(rows) ? rows : []
  const body = list
    .map((row) => (Array.isArray(row) ? row : [row]).map((cell) => escapeField(cell, delimiter)).join(delimiter))
    .join(eol)
  const withTail = body === '' || options.trailingNewline === false ? body : `${body}${eol}`
  // BOM 只给「下载给 Excel 打开」的那一份：带 BOM 的 UTF-8 是 Windows 上
  // 唯一能让 Excel/WPS 认出中文的写法；写回磁盘的中间文件不必带。
  return options.bom === true ? `\uFEFF${withTail}` : withTail
}

export { DELIMITERS }
