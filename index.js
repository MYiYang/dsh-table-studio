/**
 * dsh-table-studio — host 半侧。
 *
 * 一件东西：把「表」当文档管。会话里出一张表格卡（标题栏带复制 / 下载 /
 * 放大），放大进右侧画布，画布里是本地绑定的 fortune-sheet 的 Excel 风编辑器
 * （MIT，随包分发，不走任何 CDN；jspreadsheet 作兜底），改完可存回、可导出 CSV。
 * 多工作表与格式以 `sheets` 附件随文档落盘，模型侧仍只认第一张表的 columns/rows。
 *
 * 三块职责，别混：
 *   1. 存储（lib/store.js）：`$DSH_HOME/table-studio/docs/<id>.json` 是唯一真相；
 *   2. 工具（table_render / table_open / table_read / table_update / table_export）：
 *      模型只写，回执只是「收据」；
 *   3. 路由（`/dsh-table-studio/...`）：静态资源、编辑器页、文档 API、CSV 下载。
 *
 * 约定：工具失败不抛异常，返回 `{ok:false, code, message}`，由 `output.render`
 * 压成一行给模型；插件的任何一块挂不上都只记日志，绝不拖垮会话。
 *
 * @module dsh-table-studio
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { TableError, normalizeTable, tableShape, tableToCsv, tableToMarkdown } from './lib/model.js'
import { createStore, defaultRoot } from './lib/store.js'
import { registerBundledSkills } from './lib/skill.js'
import { registerTablePolicy } from './lib/policy.js'

export const inject = ['tools', 'webServer', 'connection']

/** 路由前缀。 */
const PREFIX = '/dsh-table-studio'
/** API 前缀。 */
const API = `${PREFIX}/api`
/** 包内 assets 目录。 */
const ASSET_DIR = fileURLToPath(new URL('./assets/', import.meta.url))

/** 只发白名单里的静态文件：地图式放行等于给整个包开后门。 */
const ASSET_TYPES = new Map([
  ['jspreadsheet.js', 'text/javascript; charset=utf-8'],
  ['jspreadsheet.css', 'text/css; charset=utf-8'],
  ['jsuites.js', 'text/javascript; charset=utf-8'],
  ['jsuites.css', 'text/css; charset=utf-8'],
  ['formula.js', 'text/javascript; charset=utf-8'],
  ['editor.js', 'text/javascript; charset=utf-8'],
  ['editor.css', 'text/css; charset=utf-8'],
  ['fortune.js', 'text/javascript; charset=utf-8'],
  ['fortune.css', 'text/css; charset=utf-8'],
])

/** 编辑器页的 CSP：只认同源脚本，够用且不给内联脚本留口子。 */
const EDITOR_CSP = [
  "default-src 'none'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob:",
  "font-src 'self' data:",
  "connect-src 'self'",
  "frame-src 'none'",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'none'",
].join('; ')

/**
 * 插件入口。
 * @param {any} ctx - cordis 上下文。
 * @param {{ storageDir?: string, skill?: boolean, policy?: boolean, debug?: boolean }} [config] - 插件配置。
 * @returns {void}
 */
export function apply(ctx, config = {}) {
  /** @param {string} level - 级别。 @param {string} message - 内容。 */
  const log = (level, message) => {
    try {
      const sink = ctx.logger?.[level]
      if (typeof sink === 'function') sink.call(ctx.logger, `[dsh-table-studio] ${message}`)
    } catch {
      /* 日志失败不算失败 */
    }
  }

  const root = typeof config.storageDir === 'string' && config.storageDir.trim() !== ''
    ? config.storageDir.trim()
    : defaultRoot()
  const store = createStore({ root, log })
  /**
   * 客户端自报状态的权威副本（首次用到时从 client.json 读入）。
   * @type {any}
   */
  let bootState = null

  // ── HTTP 小工具 ────────────────────────────────────────────────────────────

  /**
   * @param {import('node:http').ServerResponse} res - 响应。
   * @param {number} status - 状态码。
   * @param {unknown} value - JSON 体。
   */
  function writeJson(res, status, value) {
    const body = Buffer.from(`${JSON.stringify(value)}\n`, 'utf8')
    res.writeHead(status, {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
      'content-length': body.length,
    })
    res.end(body)
  }

  /**
   * @param {import('node:http').ServerResponse} res - 响应。
   * @param {number} status - 状态码。
   * @param {string} type - MIME。
   * @param {Buffer | string} body - 内容。
   * @param {Record<string, string>} [extra] - 额外响应头。
   */
  function writeBody(res, status, type, body, extra = {}) {
    const buffer = Buffer.isBuffer(body) ? body : Buffer.from(body, 'utf8')
    res.writeHead(status, {
      'content-type': type,
      'content-length': buffer.length,
      ...extra,
    })
    res.end(buffer)
  }

  /**
   * 读 JSON 请求体（限额 12MB，够放一张几万行的表）。
   * @param {import('node:http').IncomingMessage} req - 请求。
   * @returns {Promise<any>} 解析后的对象（失败给空对象）。
   */
  function readJsonBody(req, limit = 12 * 1024 * 1024) {
    return new Promise((resolve) => {
      /** @type {Buffer[]} */
      const chunks = []
      let size = 0
      req.on('data', (chunk) => {
        size += chunk.length
        if (size > limit) {
          req.destroy()
          resolve({})
          return
        }
        chunks.push(chunk)
      })
      req.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8').trim()
        if (text === '') return resolve({})
        try {
          const parsed = JSON.parse(text)
          resolve(parsed && typeof parsed === 'object' ? parsed : {})
        } catch {
          resolve({})
        }
      })
      req.on('error', () => resolve({}))
    })
  }

  /**
   * 这道请求是不是 DSH 页面自己发的（同源 + 凭据）。
   * @param {import('node:http').IncomingMessage} req - 请求。
   * @returns {boolean} 放行为 true。
   */
  function admits(req) {
    try {
      return ctx.connection.requestRejection(req) === undefined
    } catch {
      return false
    }
  }

  // ── 会话与文档 ────────────────────────────────────────────────────────────

  /**
   * 从执行上下文取会话。
   * @param {any} exec - 工具执行上下文。
   * @returns {{ id: string | null, cwd: string }} 会话。
   */
  function sessionOf(exec) {
    const session = exec?.agent?.session
    const id = typeof session?.id === 'string' && session.id !== '' ? session.id : null
    let cwd = typeof session?.cwd === 'string' && session.cwd !== '' ? session.cwd : ''
    if (cwd === '' && id !== null) cwd = sessionCwd(id)
    return { id, cwd: cwd === '' ? process.cwd() : cwd }
  }

  /**
   * 只拿到 sessionId 时反查工作目录。
   * @param {string} sessionId - 会话 id。
   * @returns {string} 目录。
   */
  function sessionCwd(sessionId) {
    try {
      const workingDirectory = ctx.get('workingDirectory')
      const sessionObject = ctx.get('sessions')?.get?.(sessionId)
      if (workingDirectory && sessionObject) return workingDirectory.get(sessionObject) || process.cwd()
    } catch {
      /* 退回进程目录 */
    }
    return process.cwd()
  }

  /**
   * 把文档裁成给前端 / 模型看的载荷。数据大到没必要重复传时省略 `rows`。
   * @param {any} doc - 文档。
   * @param {{ withData?: boolean }} [options] - 选项。
   * @returns {any} 载荷。
   */
  function payloadOf(doc, options = {}) {
    const shape = tableShape(doc)
    /** @type {any} */
    const payload = {
      ok: true,
      id: doc.id,
      title: doc.title,
      columns: doc.columns,
      rows: doc.rows.length,
      columnCount: doc.columns.length,
      shape,
      note: doc.note ?? '',
      source: doc.source ?? '',
      updatedAt: doc.updatedAt ?? '',
      api: `${API}/doc/${doc.id}`,
    }
    if (options.withData !== false) {
      payload.data = { columns: doc.columns, rows: doc.rows }
      // 编辑器原样交回的多工作表 / 格式数据：只给编辑器用，卡片不读。
      if (Array.isArray(doc.sheets) && doc.sheets.length > 0) payload.sheets = doc.sheets
    }
    return payload
  }

  /**
   * 编辑器交回的 fortune-sheet 工作表数组：挡掉超大载荷，其余原样收下。
   *
   * 这堆东西只服务于「下次打开还原格式与多张表」，不是模型侧的权威数据；
   * 超过 8MB 说明用户把整本表当单元格塞进来了，宁可退回纯值，也不写爆文档。
   * @param {unknown} value - 请求体里的 sheets。
   * @returns {unknown[] | null | undefined} 数组=替换，null=清掉，undefined=不动。
   */
  function sanitizeSheets(value) {
    if (value === null) return null
    if (!Array.isArray(value)) return undefined
    let size = 0
    try {
      size = Buffer.byteLength(JSON.stringify(value), 'utf8')
    } catch {
      return undefined
    }
    if (size > 8 * 1024 * 1024) {
      log('warn', `工作表数据过大（${(size / 1024 / 1024).toFixed(1)}MB），本次只保存纯值`)
      return undefined
    }
    return value
  }

  /**
   * 会话当前那张表；没有就用给定内容开一张。
   * @param {{ id: string | null, cwd: string }} session - 会话。
   * @param {any} args - 工具参数。
   * @returns {any} 文档。
   */
  function docFor(session, args) {
    const id = typeof args?.id === 'string' ? args.id.trim() : ''
    if (id !== '') {
      const found = store.read(id)
      if (found === null) throw new TableError('not-found', `找不到表格 ${id}：id 可能拼错，或这张表已被删除。`)
      return found
    }
    const current = session.id === null ? '' : store.current(session.id)
    if (current !== '') {
      const found = store.read(current)
      if (found !== null) return found
    }
    throw new TableError('doc-required', '没有指定 id，本会话也还没有打开过表格：先 table_render 或 table_open。')
  }

  // ── 路由 ──────────────────────────────────────────────────────────────────

  /** @type {Array<() => void>} */
  const routeDisposers = []

  /**
   * 注册一条路由；失败只记日志（路由挂不上不该拦住工具）。
   * @param {any} route - webServer 路由描述。
   * @param {string} label - 日志标签。
   */
  function mount(route, label) {
    try {
      const dispose = ctx.webServer.register(route)
      if (typeof dispose === 'function') routeDisposers.push(dispose)
      log('debug', `路由已挂载：${label}`)
    } catch (error) {
      log('warn', `路由 ${label} 挂载失败：${error instanceof Error ? error.message : String(error)}`)
    }
  }

  /** 静态资源：白名单 + 只读。 */
  for (const [name, type] of ASSET_TYPES) {
    mount({
      kind: 'exact',
      path: `${PREFIX}/assets/${name}`,
      resource: async (request) => {
        const method = request?.method ?? 'GET'
        if (method !== 'GET' && method !== 'HEAD') {
          return new Response(null, { status: 405, headers: { allow: 'GET, HEAD' } })
        }
        let body = null
        try {
          body = readFileSync(join(ASSET_DIR, name))
        } catch {
          return new Response(`${name} 未随包分发`, { status: 404 })
        }
        // 第三方库（fortune / jspreadsheet / jSuites / formula）一年不变，尽管长缓存；
        // 自己的 editor.js / editor.css 每次改都要立刻生效，所以 no-store——
        // 否则改了样式或胶水，浏览器还拿着一天的旧副本，看起来就像「没修好」。
        const vendored = name === 'jspreadsheet.js' || name === 'jspreadsheet.css'
          || name === 'jsuites.js' || name === 'jsuites.css' || name === 'formula.js'
          || name === 'fortune.js' || name === 'fortune.css'
        return new Response(method === 'HEAD' ? null : body, {
          status: 200,
          headers: {
            'content-type': type,
            'cache-control': vendored ? 'public, max-age=31536000, immutable' : 'no-store',
          },
        })
      },
    }, `asset ${name}`)
  }

  /** 编辑器页：整页 HTML，自己带 CSP。 */
  mount({
    kind: 'exact',
    path: `${PREFIX}/editor`,
    handler: (req, res) => {
      // 这一页只是外壳：脚本与样式全是同源静态资源，读不到任何数据（数据接口
      // 仍逐条过 admits）。所以这里不设凭据门——少一道门就少一种「画布一片
      // 空白」的失败方式，尤其是 iframe 导航这种带 cookie、却不带 Origin 的请求。
      if (req.method !== 'GET' && req.method !== 'HEAD') {
        writeJson(res, 405, { ok: false, code: 'method-not-allowed' })
        return
      }
      try {
        const html = readFileSync(join(ASSET_DIR, 'editor.html'), 'utf8')
        writeBody(res, 200, 'text/html; charset=utf-8', req.method === 'HEAD' ? '' : html, {
          'content-security-policy': EDITOR_CSP,
          'cache-control': 'no-store',
        })
      } catch (error) {
        log('warn', `编辑器页读取失败：${error instanceof Error ? error.message : String(error)}`)
        writeJson(res, 500, { ok: false, code: 'editor-missing' })
      }
    },
  }, 'editor page')

  /** 文档与 API：一个前缀路由吃下全部。 */
  mount({
    kind: 'prefix',
    path: API,
    handler: async (req, res) => {
      if (!admits(req)) {
        writeJson(res, 403, { ok: false, code: 'forbidden' })
        return
      }
      const url = new URL(req.url ?? '/', 'http://dsh.internal')
      if (!url.pathname.startsWith(`${API}/`)) {
        writeJson(res, 404, { ok: false, code: 'not-found' })
        return
      }
      const parts = url.pathname.slice(API.length + 1).split('/').filter(Boolean)
      const head = parts[0] ?? ''
      try {
        if (head === 'health' && req.method === 'GET') {
          writeJson(res, 200, { ok: true, name: 'dsh-table-studio', root: store.root, docs: store.list({ limit: 200 }).length })
          return
        }

        if (head === 'docs' && req.method === 'GET') {
          writeJson(res, 200, { ok: true, docs: store.list({ sessionId: url.searchParams.get('sessionId') ?? '', limit: 50 }) })
          return
        }

        // 会话当前该显示哪张表：编辑器挂载时先问这里。
        if (head === 'session' && parts.length === 1 && req.method === 'GET') {
          const sessionId = url.searchParams.get('sessionId') ?? ''
          const current = store.current(sessionId)
          const doc = current === '' ? null : store.read(current)
          writeJson(res, 200, {
            ok: true,
            sessionId,
            id: doc?.id ?? '',
            doc: doc === null ? null : payloadOf(doc),
          })
          return
        }

        // 编辑器新建空表（用户不经过模型也能起一张）。
        if (head === 'create' && req.method === 'POST') {
          const body = await readJsonBody(req)
          const doc = store.create({
            columns: Array.isArray(body.columns) && body.columns.length > 0 ? body.columns : ['列1', '列2', '列3'],
            rows: Array.isArray(body.rows) ? body.rows : [],
            title: typeof body.title === 'string' ? body.title : '表格',
            sessionId: typeof body.sessionId === 'string' ? body.sessionId : '',
            cwd: sessionCwd(typeof body.sessionId === 'string' ? body.sessionId : ''),
          })
          if (typeof body.sessionId === 'string' && body.sessionId !== '') store.setCurrent(body.sessionId, doc.id)
          writeJson(res, 200, { ok: true, doc: payloadOf(doc) })
          return
        }

        // 从工作区 CSV 文件导入。
        if (head === 'import' && req.method === 'POST') {
          const body = await readJsonBody(req)
          const path = typeof body.path === 'string' ? body.path.trim() : ''
          if (path === '') {
            writeJson(res, 400, { ok: false, code: 'path-required' })
            return
          }
          const cwd = typeof body.cwd === 'string' && body.cwd !== '' ? body.cwd : sessionCwd(typeof body.sessionId === 'string' ? body.sessionId : '')
          const { doc, encoding } = store.importFile(path.startsWith('/') || /^[A-Za-z]:/.test(path) ? path : join(cwd, path), {
            title: typeof body.title === 'string' ? body.title : '',
          })
          if (typeof body.sessionId === 'string' && body.sessionId !== '') store.setCurrent(body.sessionId, doc.id)
          writeJson(res, 200, { ok: true, encoding, doc: payloadOf(doc) })
          return
        }

        if (head === 'doc' && parts.length >= 2) {
          const id = parts[1]
          const doc = store.read(id)
          if (doc === null) {
            writeJson(res, 404, { ok: false, code: 'not-found', message: `找不到表格 ${id}` })
            return
          }
          if (parts[2] === 'csv' && req.method === 'GET') {
            const bom = url.searchParams.get('bom') !== '0'
            const text = tableToCsv(doc, { bom })
            const filename = `${safeFileName(doc.title)}.csv`
            writeBody(res, 200, 'text/csv; charset=utf-8', text, {
              'content-disposition': `attachment; filename="table.csv"; filename*=UTF-8''${encodeURIComponent(filename)}`,
              'cache-control': 'no-store',
            })
            return
          }
          if (parts.length === 2 && req.method === 'GET') {
            writeJson(res, 200, payloadOf(doc))
            return
          }
          if (parts.length === 2 && (req.method === 'POST' || req.method === 'PUT')) {
            const body = await readJsonBody(req)
            const sheets = 'sheets' in body ? sanitizeSheets(body.sheets) : undefined
            const next = store.update(id, {
              columns: body.columns,
              rows: body.rows,
              title: body.title,
              note: body.note,
              ...(sheets === undefined ? {} : { sheets }),
            })
            if (typeof body.sessionId === 'string' && body.sessionId !== '') store.setCurrent(body.sessionId, next.id)
            writeJson(res, 200, payloadOf(next))
            return
          }
          writeJson(res, 405, { ok: false, code: 'method-not-allowed' })
          return
        }

        // 客户端自报家门：用来回答「到底刷没刷新、页面跑的是哪一版、卡片画没画出来」。
        //
        // 这里最容易翻车的是「读—改—写」：同一次渲染会连发 card 与 open-tab 两条，
        // 两个请求各自读盘、各自写回，后写的会把先写的条目吞掉。所以内存里留一份
        // 权威状态，同步合并后再整体落盘——落盘谁先谁后都不丢条目。
        if (head === 'boot' && req.method === 'POST') {
          const body = await readJsonBody(req, 64 * 1024)
          try {
            mkdirSync(store.root, { recursive: true })
            const file = join(store.root, 'client.json')
            if (bootState === null) {
              /** @type {any} */
              let seed = {}
              if (existsSync(file)) {
                try {
                  seed = JSON.parse(readFileSync(file, 'utf8'))
                } catch {
                  seed = {}
                }
              }
              bootState = { version: '', at: '', ua: '', last: {}, ...(seed && typeof seed === 'object' ? seed : {}) }
              if (bootState.last === null || typeof bootState.last !== 'object') bootState.last = {}
            }
            const kind = typeof body.kind === 'string' && body.kind !== '' ? body.kind : 'apply'
            const now = new Date().toISOString()
            bootState.version = typeof body.version === 'string' && body.version !== '' ? body.version : bootState.version
            bootState.at = now
            bootState.ua = typeof body.ua === 'string' && body.ua !== '' ? body.ua.slice(0, 200) : bootState.ua
            if (!Array.isArray(bootState.events)) bootState.events = []
            bootState.events.push({
              kind,
              at: now,
              ...(typeof body.note === 'string' ? { note: body.note.slice(0, 160) } : {}),
              ...(typeof body.id === 'string' ? { id: body.id } : {}),
            })
            if (bootState.events.length > 80) bootState.events.splice(0, bootState.events.length - 80)
            bootState.last[kind] = {
              at: now,
              ...(typeof body.note === 'string' ? { note: body.note.slice(0, 200) } : {}),
              ...(Array.isArray(body.callIds) ? { callIds: body.callIds.slice(0, 50).map(String) } : {}),
              ...(typeof body.count === 'number' ? { count: body.count } : {}),
              ...(typeof body.id === 'string' ? { id: body.id } : {}),
            }
            writeFileSync(file, `${JSON.stringify(bootState, null, 2)}
`, 'utf8')
            writeJson(res, 200, { ok: true })
          } catch (error) {
            writeJson(res, 500, { ok: false, code: 'boot-failed', message: String(error) })
          }
          return
        }

        // 客户端崩溃信标：页面里看不到 console 时，这是唯一的取证口。
        if (head === 'note' && req.method === 'POST') {
          const body = await readJsonBody(req, 256 * 1024)
          try {
            const file = join(store.root, `note-${Date.now()}.json`)
            mkdirSync(store.root, { recursive: true })
            writeFileSync(file, `${JSON.stringify({ ...body, at: new Date().toISOString() }, null, 2)}\n`, 'utf8')
            writeJson(res, 200, { ok: true, file })
          } catch (error) {
            writeJson(res, 500, { ok: false, code: 'note-failed', message: String(error) })
          }
          return
        }

        writeJson(res, 404, { ok: false, code: 'not-found' })
      } catch (error) {
        const code = error instanceof TableError ? error.code : (error && typeof error === 'object' && 'code' in error ? String(error.code) : 'internal')
        log('warn', `API ${url.pathname} 失败：${error instanceof Error ? error.message : String(error)}`)
        writeJson(res, code === 'not-found' ? 404 : 400, { ok: false, code, message: error instanceof Error ? error.message : String(error) })
      }
    },
  }, 'api')

  ctx.effect(() => () => {
    for (const dispose of routeDisposers.splice(0)) {
      try {
        dispose()
      } catch {
        /* 卸载失败不该报错 */
      }
    }
  }, 'table-studio: routes')

  // ── 工具 ──────────────────────────────────────────────────────────────────

  /**
   * 统一把「可预期的失败」压成一行给模型。
   * @param {any} value - 回执。
   * @returns {Array<{ type: 'text', text: string }>} 内容块。
   */
  function renderReceipt(value) {
    const v = value && typeof value === 'object' ? value : {}
    if (v.ok === false) return [{ type: 'text', text: `${v.code ?? 'error'}：${v.message ?? '失败'}` }]
    const bits = []
    if (typeof v.title === 'string' && v.title !== '') bits.push(`「${v.title}」`)
    if (typeof v.shape === 'string') bits.push(v.shape)
    if (typeof v.id === 'string') bits.push(`id ${v.id}`)
    if (v.opened === true) bits.push('已打开右侧画布')
    if (typeof v.file === 'string') bits.push(v.file)
    if (typeof v.note === 'string' && v.note !== '') bits.push(v.note)
    return [{ type: 'text', text: bits.length > 0 ? bits.join(' · ') : 'ok' }]
  }

  /** 输出契约：形状宽松，具体语义由各工具自己保证。 */
  const OUTPUT_SCHEMA = { type: 'object', additionalProperties: true }

  /** 校验并建表；TableError 转成回执。 */
  function buildTable(args) {
    return normalizeTable({
      columns: args?.columns,
      rows: args?.rows,
      csv: args?.csv,
      title: args?.title,
      note: args?.note,
      source: args?.source,
    })
  }

  /**
   * @param {(args: any, exec: any) => Promise<any>} execute - 实现。
   * @returns {(args: any, exec: any) => Promise<any>} 带兜底的实现。
   */
  function guarded(execute) {
    return async (args, exec) => {
      try {
        return await execute(args ?? {}, exec)
      } catch (error) {
        if (error instanceof TableError) return { ok: false, code: error.code, message: error.message }
        const code = error && typeof error === 'object' && 'code' in error ? String(error.code) : 'internal'
        const message = error instanceof Error ? error.message : String(error)
        log('warn', `工具执行失败：${message}`)
        return { ok: false, code, message }
      }
    }
  }

  /** @type {Array<any>} */
  const toolDefs = [
    {
      name: 'table_render',
      description: [
        '把一份表格渲染成会话里的表格卡：标题栏「表格」带复制 / 下载 / 放大三个按钮；下载直接存进默认下载目录，点放大进右侧 Excel 风表格编辑器。',
        '比 markdown 表格多出可编辑、可导出、可二次修改。',
        '数据用 columns + rows 给（第一列即表头，不要重复写进 rows），也可以直接给 csv 文本（首行当表头）。',
      ].join(''),
      parameters: {
        type: 'object',
        properties: {
          title: { type: 'string', description: '卡片标题，默认「表格」。' },
          columns: { type: 'array', items: { type: 'string' }, description: '表头，例如 ["位置","中医名称","对应西医常见"]。' },
          rows: {
            type: 'array',
            description: '数据行，每行长度与 columns 对齐；数字会转成文本。',
            items: { type: 'array', items: {} },
          },
          csv: { type: 'string', description: '也可以直接给 CSV/TSV 文本（首行为表头），与 columns/rows 二选一。' },
          note: { type: 'string', description: '表下的一句话说明（口径、来源）。' },
          source: { type: 'string', description: '数据来源，例如 `etl_dws.dws_xxx` 或文件路径。' },
        },
        additionalProperties: false,
      },
      output: { schema: OUTPUT_SCHEMA, render: (args, value) => renderReceipt(value) },
      execute: guarded(async (args, exec) => {
        const session = sessionOf(exec)
        const table = buildTable(args)
        const doc = store.create({ ...table, sessionId: session.id ?? '', cwd: session.cwd })
        if (session.id !== null) store.setCurrent(session.id, doc.id)
        return payloadOf(doc)
      }),
    },
    {
      name: 'table_open',
      description: [
        '在右侧画布打开 Excel 风表格编辑器（工具条、公式栏、多工作表）。三种来源选一种：已有的表格 id、工作区里的 CSV 文件路径、或直接给 columns/rows。',
        '打开后用户可以在画布里直接改单元格、增删行列。',
      ].join(''),
      parameters: {
        type: 'object',
        properties: {
          id: { type: 'string', description: '已有表格 id（table_render 回执里的 tbl_…）。' },
          path: { type: 'string', description: 'CSV/TSV 文件路径（相对路径按当前工作目录解析）。' },
          title: { type: 'string', description: '标题（新建或导入时用）。' },
          columns: { type: 'array', items: { type: 'string' }, description: '表头。' },
          rows: { type: 'array', items: { type: 'array', items: {} }, description: '数据行。' },
          csv: { type: 'string', description: 'CSV 文本（首行表头）。' },
        },
        additionalProperties: false,
      },
      output: { schema: OUTPUT_SCHEMA, render: (args, value) => renderReceipt(value) },
      execute: guarded(async (args, exec) => {
        const session = sessionOf(exec)
        const id = typeof args.id === 'string' ? args.id.trim() : ''
        /** @type {any} */
        let doc = null
        if (id !== '') {
          doc = store.read(id)
          if (doc === null) return { ok: false, code: 'not-found', message: `找不到表格 ${id}` }
        } else if (typeof args.path === 'string' && args.path.trim() !== '') {
          const raw = args.path.trim()
          const absolute = /^([A-Za-z]:|[\\/])/.test(raw) ? raw : join(session.cwd, raw)
          if (!existsSync(absolute)) {
            return { ok: false, code: 'file-not-found', message: `文件不存在：${absolute}` }
          }
          const imported = store.importFile(absolute, { title: typeof args.title === 'string' ? args.title : '' })
          doc = imported.doc
        } else {
          const table = buildTable(args)
          doc = store.create({ ...table, sessionId: session.id ?? '', cwd: session.cwd })
        }
        if (session.id !== null) store.setCurrent(session.id, doc.id)
        return { ...payloadOf(doc), opened: true }
      }),
    },
    {
      name: 'table_read',
      description: '读回一张表的内容（默认 CSV 文本，另可要 markdown 或 json）。用户可能在画布里改过，二次加工前先读一遍。',
      parameters: {
        type: 'object',
        properties: {
          id: { type: 'string', description: '表格 id；省略则用本会话当前那张。' },
          format: { type: 'string', enum: ['csv', 'markdown', 'json'], description: '默认 csv。' },
        },
        additionalProperties: false,
      },
      output: {
        schema: OUTPUT_SCHEMA,
        render: (_args, value) => {
          const v = value ?? {}
          if (v.ok === false) return renderReceipt(v)
          const body = typeof v.text === 'string' ? v.text : ''
          const header = `表格「${v.title ?? ''}」· ${v.shape ?? ''}${v.missing === true ? ' · 表是空的' : ''}`
          return [
            { type: 'text', text: header },
            { type: 'text', text: `\`\`\`${v.format === 'json' ? 'json' : v.format === 'markdown' ? 'markdown' : 'csv'}\n${body}\n\`\`\`` },
          ]
        },
      },
      execute: guarded(async (args, exec) => {
        const session = sessionOf(exec)
        const doc = docFor(session, args)
        const format = args.format === 'markdown' || args.format === 'json' ? args.format : 'csv'
        const text = format === 'markdown'
          ? tableToMarkdown(doc)
          : format === 'json'
            ? JSON.stringify({ id: doc.id, title: doc.title, columns: doc.columns, rows: doc.rows }, null, 2)
            : tableToCsv(doc, { bom: false, trailingNewline: false })
        return {
          ok: true,
          id: doc.id,
          title: doc.title,
          shape: tableShape(doc),
          format,
          text,
          missing: doc.rows.length === 0,
        }
      }),
    },
    {
      name: 'table_update',
      description: '整表覆盖写回（改单元格、加列、改标题）。给齐 columns 与 rows；只想改一格也要给整行。',
      parameters: {
        type: 'object',
        properties: {
          id: { type: 'string', description: '表格 id；省略则用本会话当前那张。' },
          title: { type: 'string', description: '新标题。' },
          columns: { type: 'array', items: { type: 'string' }, description: '新表头。' },
          rows: { type: 'array', items: { type: 'array', items: {} }, description: '新数据行。' },
          csv: { type: 'string', description: '或直接给整段 CSV（首行表头）。' },
          note: { type: 'string', description: '表下说明。' },
        },
        additionalProperties: false,
      },
      output: { schema: OUTPUT_SCHEMA, render: (args, value) => renderReceipt(value) },
      execute: guarded(async (args, exec) => {
        const session = sessionOf(exec)
        const doc = docFor(session, args)
        const table = buildTable({
          columns: args.columns ?? doc.columns,
          rows: args.rows ?? (typeof args.csv === 'string' ? undefined : doc.rows),
          csv: args.csv,
          title: args.title ?? doc.title,
          note: args.note ?? doc.note,
          source: doc.source,
        })
        const next = store.update(doc.id, { ...table, sheets: null })
        return payloadOf(next)
      }),
    },
    {
      name: 'table_export',
      description: '把表导出成 CSV 文件写到工作区（带 BOM，Excel/WPS 打开中文不乱码）。省略路径时落到工作目录下「标题.csv」。',
      parameters: {
        type: 'object',
        properties: {
          id: { type: 'string', description: '表格 id；省略则用本会话当前那张。' },
          path: { type: 'string', description: '目标路径；相对路径按工作目录解析。省略则用 <标题>.csv。' },
        },
        additionalProperties: false,
      },
      output: { schema: OUTPUT_SCHEMA, render: (args, value) => renderReceipt(value) },
      execute: guarded(async (args, exec) => {
        const session = sessionOf(exec)
        const doc = docFor(session, args)
        const target = typeof args.path === 'string' && args.path.trim() !== ''
          ? args.path.trim()
          : `${safeFileName(doc.title)}.csv`
        const written = store.exportFile(doc.id, target, { cwd: session.cwd })
        return { ok: true, id: doc.id, title: doc.title, shape: tableShape(doc), file: written.file, bytes: written.bytes }
      }),
    },
  ]

  for (const tool of toolDefs) {
    const register = () => {
      try {
        return ctx.tools.register({
          name: tool.name,
          description: tool.description,
          parameters: tool.parameters,
          output: tool.output,
          execute: tool.execute,
        })
      } catch (error) {
        log('warn', `工具 ${tool.name} 注册失败：${error instanceof Error ? error.message : String(error)}`)
        return () => {}
      }
    }
    ctx.effect(register, `table-studio: ${tool.name}`)
  }

  // ── 自带 skill ────────────────────────────────────────────────────────────

  if (config.skill !== false) {
    const state = registerBundledSkills(ctx, { log })
    log('debug', `自带 skill：${state.registered ? state.skills.join(', ') : '未注册'}`)
  }

  // ── 全局约束：所有表格展示走本插件 ────────────────────────────────────────
  //
  // 自带 skill 只有被加载时才生效；这条约束进系统提示，每一步都在，且随插件
  // 注册/卸载。config.policy === false 可单独关掉它（skill 仍保留）。
  if (config.policy !== false) {
    const policy = registerTablePolicy(ctx, {
      log,
      // 落一份 policy.json：没屏幕时也能确认「约束到底挂没挂上」。
      onResult: (result) => {
        try {
          mkdirSync(store.root, { recursive: true })
          writeFileSync(join(store.root, 'policy.json'), `${JSON.stringify({ ...result, at: new Date().toISOString() }, null, 2)}
`, 'utf8')
        } catch (error) {
          log('warn', `表格约束状态落盘失败：${error instanceof Error ? error.message : String(error)}`)
        }
      },
    })
    log('debug', `表格约束：${policy.registered ? policy.section : '未注册'}`)
  }

  log('info', `已就绪：文档目录 ${store.root}，路由 ${PREFIX}`)
}

/**
 * 文件名清洗：标题里常带 `/`、`:`、换行，直接当文件名会写失败。
 * @param {unknown} title - 原始标题。
 * @returns {string} 安全文件名（不含扩展名）。
 */
function safeFileName(title) {
  const base = String(title ?? '').replace(/[\\/:*?"<>|\r\n\t]+/g, '_').replace(/^[.\s]+|[.\s]+$/g, '').slice(0, 60)
  return base === '' ? 'table' : base
}
