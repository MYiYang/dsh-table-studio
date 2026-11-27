/**
 * dsh-table-studio — client 半侧。
 *
 * 两个界面：
 *   1. 会话里的表格卡：标题栏「表格」+ 复制 / 下载 / 放大三枚图标，
 *      和用户给的参考图同一副长相；
 *   2. 右侧画布：iframe 里跑本地绑定的 fortune-sheet 的 Excel 风编辑器
 *      （工具条 + 公式栏 + 工作表标签；资源全在 `/dsh-table-studio/assets/`，
 *      没有任何 CDN 依赖；jspreadsheet 作兜底）。
 *
 * 下载铁律：卡片与画布上的「下载」都走 DSH 的 fileActions（Desktop 直接落到
 * 默认下载目录，不弹「另存为」）；「下载完成」提示里的「立即查看」直接开右侧
 * 表格编辑器，不再绕预览弹层。
 *
 * 铁律：
 *   - 卡片的取数三路兜底：工具结构化回执 → 回执文本里的 id → 工具参数；
 *     任何一路能用就画得出来，画不出来才显示「读不到表」。
 *   - 全部颜色走 `--dsw-alias-*`，不留死色值；深浅色跟随宿主。
 *   - apply 外层只 console 一次、绝不重抛：客户端半侧抛错会被 shell 整块吃掉。
 *
 * @module dsh-table-studio/client
 */
window.__ModuleLoader__.load({
  id: 'dsh-table-studio',
  factory(require) {
    const React = require('react')
    const h = React.createElement
    const { useCallback, useEffect, useMemo, useRef, useState } = React

    /** 路由前缀，必须与 index.js 一致。 */
    const PREFIX = '/dsh-table-studio'
    /** API 前缀。 */
    const API = `${PREFIX}/api`
    /** tab 定义 id，同时是 body/title 两个槽的 key。 */
    const TAB_ID = 'dsh-table-studio/editor'
    /** 传给 sidebarRight.openTab 的 kind。 */
    const TAB_KIND = 'table-studio-editor'
    /**
     * 表在右栏里的资源地址前缀。
     *
     * 用资源地址（`dsh-resource://<type>/<id>`）而不是页面地址：右栏的页面类型
     * 一个窗格里只认一个（再开只做 reveal），于是第二张表会把第一张顶掉；
     * 资源按地址辨识内容，一个 docId 一个地址，天然一表一 tab，重复打开同一张
     * 表也只是把那个 tab 激活。刷新后 contentId 还在，编辑器据此还原是哪张表。
     */
    const TAB_SCHEME = 'dsh-resource://dsh-table-studio'
    /** 客户端版本：刷新页面后看一眼就知道跑的是哪一版。 */
    const CLIENT_VERSION = '0.5.10'
    /**
     * `react-dom`：只为了 `createPortal`。放大预览是 `position: fixed` 的整屏浮层，
     * 可 DSH 的对话 / 侧栏容器带 overflow 与 transform；留在卡片里画，浮层会被那个
     * 祖先框住、被裁成一条窄缝——真机上「下载 CSV / 在画布里编辑」被挤得折行就是这么来的。
     * 拿不到就退回原来「画在卡片里」的画法，不拿一个浮层赌整个客户端半侧。
     */
    const reactDom = (() => {
      try {
        const module = require('react-dom')
        return module !== null && typeof module === 'object' && typeof module.createPortal === 'function' ? module : null
      } catch (error) {
        return null
      }
    })()

    /** 卡片最多渲染多少行（再多只提示，避免把几千行塞进 DOM）。 */
    const MAX_RENDER_ROWS = 300

    // ── 基础工具 ────────────────────────────────────────────────────────────

    /**
     * 同源请求。
     * @param {string} path - 相对 API 的路径。
     * @param {RequestInit} [init] - fetch 选项。
     * @returns {Promise<any>} JSON（失败给 ok:false）。
     */
    async function api(path, init) {
      const options = { credentials: 'same-origin', ...(init ?? {}) }
      if (options.body !== undefined && typeof options.body !== 'string') {
        options.headers = { 'content-type': 'application/json', ...(options.headers ?? {}) }
        options.body = JSON.stringify(options.body)
      }
      const controller = typeof AbortController === 'function' ? new AbortController() : null
      const timer = controller === null ? null : setTimeout(() => controller.abort(), 6000)
      let response
      try {
        response = await fetch(`${API}${path}`, controller === null ? options : { ...options, signal: controller.signal })
      } finally {
        if (timer !== null) clearTimeout(timer)
      }
      try {
        return await response.json()
      } catch {
        return { ok: false, code: 'bad-json', message: `HTTP ${response.status}` }
      }
    }

    /** 单元格转文本。 */
    function cell(value) {
      if (value === null || value === undefined) return ''
      return String(value)
    }

    /**
     * CSV 单元格转义（与服务端同一套规则）。
     * @param {unknown} value - 值。
     * @returns {string} 转义后文本。
     */
    function escapeCsv(value) {
      const text = cell(value)
      if (/[",\r\n]/.test(text) || text !== text.trim()) return `"${text.replace(/"/g, '""')}"`
      return text
    }

    /**
     * 表 → CSV（带 BOM）。
     * @param {{ columns: string[], rows: string[][] }} table - 表。
     * @returns {string} CSV 文本。
     */
    function toCsvText(table) {
      const lines = [table.columns, ...table.rows].map((row) => row.map(escapeCsv).join(','))
      return `\uFEFF${lines.join('\r\n')}\r\n`
    }

    /**
     * 表 → TSV（粘进 Excel/WPS 直接分列）。
     * @param {{ columns: string[], rows: string[][] }} table - 表。
     * @returns {string} TSV 文本。
     */
    function toTsvText(table) {
      return [table.columns, ...table.rows]
        .map((row) => row.map((value) => cell(value).replace(/\t/g, ' ')).join('\t'))
        .join('\n')
    }

    /**
     * 复制文本：先走剪贴板 API，失败退回 textarea + execCommand。
     * @param {string} text - 要复制的文本。
     * @returns {Promise<boolean>} 成功与否。
     */
    async function copyText(text) {
      try {
        if (navigator?.clipboard?.writeText) {
          await navigator.clipboard.writeText(text)
          return true
        }
      } catch {
        /* 落到兜底 */
      }
      try {
        const area = document.createElement('textarea')
        area.value = text
        area.setAttribute('readonly', '')
        area.style.position = 'fixed'
        area.style.opacity = '0'
        document.body.appendChild(area)
        area.select()
        const ok = document.execCommand('copy')
        area.remove()
        return ok
      } catch {
        return false
      }
    }

    /**
     * 触发一次浏览器下载。
     * @param {Blob} blob - 内容。
     * @param {string} filename - 文件名。
     * @returns {void}
     */
    function downloadBlob(blob, filename) {
      const url = URL.createObjectURL(blob)
      const anchor = document.createElement('a')
      anchor.href = url
      anchor.download = filename
      document.body.appendChild(anchor)
      anchor.click()
      anchor.remove()
      setTimeout(() => URL.revokeObjectURL(url), 60_000)
    }

    /** 标题 → 安全文件名。 */
    function safeName(title) {
      const base = String(title ?? '').replace(/[\\/:*?"<>|\r\n\t]+/g, '_').replace(/^[.\s]+|[.\s]+$/g, '').slice(0, 60)
      return base === '' ? 'table' : base
    }

    // ── 静默落盘 ────────────────────────────────────────────────────────────

    /**
     * 取 DSH 的 `fileActions` 客户端服务；拿不到（老版本 / 非 Web 载体）给 null。
     * @param {any} ctx - client ctx。
     * @returns {any | null} 服务。
     */
    function fileActionsOf(ctx) {
      try {
        const service = ctx?.get?.('fileActions')
        return service && typeof service.save === 'function' ? service : null
      } catch {
        return null
      }
    }

    /**
     * 把文件存进「默认下载目录」，不再让用户选路径。
     *
     * Desktop 下走 DSH 自己的 `fileActions.save(..., 'download')`：文件直接落到
     * 系统下载目录，完成后返回绝对路径（不再弹 Chromium 的「另存为」对话框）；
     * Web 下它本来就是浏览器下载，同样不弹选择框。服务不可用才退回 a[download]。
     * @param {any} ctx - client ctx（拿 fileActions）。
     * @param {Blob} blob - 内容。
     * @param {string} name - 建议文件名。
     * @param {string} [mediaType] - MIME。
     * @returns {Promise<{ ok: boolean, canceled?: boolean, status: string, path: string, name: string, code?: string }>} 结果。
     */
    async function saveFileSilently(ctx, blob, name, mediaType = 'text/csv') {
      const actions = fileActionsOf(ctx)
      if (actions !== null) {
        let url = ''
        try {
          url = URL.createObjectURL(blob)
          const result = await actions.save({ url, name, mediaType }, 'download')
          const status = typeof result?.status === 'string' ? result.status : 'requested'
          if (status === 'cancelled') return { ok: false, canceled: true, status, path: '', name }
          return {
            ok: true,
            status,
            path: typeof result?.path === 'string' ? result.path : '',
            name,
          }
        } catch (error) {
          return { ok: false, status: 'failed', path: '', name, code: String(error?.message ?? error) }
        } finally {
          // Desktop 要等下载真正完成才返回，所以对象 URL 必须留够时间再回收。
          if (url !== '') setTimeout(() => URL.revokeObjectURL(url), 60_000)
        }
      }
      downloadBlob(blob, name)
      return { ok: true, status: 'requested', path: '', name, code: 'fallback-download' }
    }

    /**
     * 下载结果 → 给人看的一句话（路径优先，最多截到一行放得下）。
     * @param {{ path?: string, name?: string, status?: string }} result - 结果。
     * @returns {string} 文案。
     */
    function savedHint(result) {
      const path = typeof result?.path === 'string' ? result.path : ''
      if (path !== '') return path
      const name = typeof result?.name === 'string' ? result.name : ''
      return result?.status === 'saved' ? name : ''
    }

    /**
     * 从工具块的任一形态里取参数。
     * @param {any} block - tool.call.toolview 的 block。
     * @returns {any | null} 参数对象。
     */
    function argsOf(block) {
      if (!block || typeof block !== 'object') return null
      const candidates = [block.args, block.call?.args, block.input]
      for (const candidate of candidates) {
        if (candidate && typeof candidate === 'object' && !Array.isArray(candidate)) return candidate
      }
      const raw = block.argsRaw ?? block.call?.argsRaw ?? ''
      if (typeof raw === 'string' && raw.trim() !== '') {
        try {
          const parsed = JSON.parse(raw)
          if (parsed && typeof parsed === 'object') return parsed
        } catch {
          /* 参数还在流式传输时是半截 JSON，正常现象 */
        }
      }
      return null
    }

    /**
     * 回执文本（各版本形状不同，全都拼起来找线索）。
     * @param {any} block - 工具块。
     * @returns {string} 文本。
     */
    function textOf(block) {
      if (!block || typeof block !== 'object') return ''
      const parts = []
      if (typeof block.text === 'string') parts.push(block.text)
      if (typeof block.output === 'string') parts.push(block.output)
      const lists = [block.content, block.result?.content, block.call?.content]
      for (const list of lists) {
        if (!Array.isArray(list)) continue
        for (const part of list) {
          if (part && part.type === 'text' && typeof part.text === 'string') parts.push(part.text)
        }
      }
      return parts.join('\n')
    }

    /**
     * 结构化回执（各版本形状不同）。
     * @param {any} block - 工具块。
     * @returns {any | null} 回执对象。
     */
    function valueOf(block) {
      if (!block || typeof block !== 'object') return null
      const candidates = [block.result?.value, block.value, block.result?.structuredContent, block.structuredContent, block.output]
      for (const candidate of candidates) {
        if (candidate && typeof candidate === 'object' && !Array.isArray(candidate)) return candidate
      }
      return null
    }

    /**
     * 极简 CSV 解析（卡片兜底用；服务端那份才是权威实现）。
     * @param {string} text - CSV 文本。
     * @returns {string[][]} 矩阵。
     */
    function parseCsvLoose(text) {
      const rows = []
      let row = []
      let field = ''
      let quoted = false
      const source = String(text ?? '').replace(/^\uFEFF/, '')
      for (let i = 0; i < source.length; i += 1) {
        const char = source[i]
        if (quoted) {
          if (char === '"') {
            if (source[i + 1] === '"') {
              field += '"'
              i += 1
            } else quoted = false
          } else field += char
          continue
        }
        if (char === '"') {
          quoted = true
          continue
        }
        if (char === ',' || char === '\t') {
          row.push(field)
          field = ''
          continue
        }
        if (char === '\n' || char === '\r') {
          if (char === '\r' && source[i + 1] === '\n') i += 1
          row.push(field)
          rows.push(row)
          row = []
          field = ''
          continue
        }
        field += char
      }
      if (field !== '' || row.length > 0) {
        row.push(field)
        rows.push(row)
      }
      return rows
    }

    /**
     * 从工具参数直接拼一张表（服务端回执里没带数据时的兜底）。
     * @param {any} args - 工具参数。
     * @returns {{ columns: string[], rows: string[][] } | null} 表。
     */
    function tableOfArgs(args) {
      if (!args || typeof args !== 'object') return null
      if (Array.isArray(args.columns) && args.columns.length > 0) {
        const columns = args.columns.map(cell)
        const rows = Array.isArray(args.rows) ? args.rows.map((row) => (Array.isArray(row) ? row.map(cell) : [cell(row)])) : []
        return { columns, rows }
      }
      if (typeof args.csv === 'string' && args.csv.trim() !== '') {
        const matrix = parseCsvLoose(args.csv)
        if (matrix.length === 0) return null
        const width = Math.max(...matrix.map((row) => row.length))
        const padded = matrix.map((row) => {
          const copy = row.slice()
          while (copy.length < width) copy.push('')
          return copy
        })
        return { columns: padded[0], rows: padded.slice(1) }
      }
      return null
    }

    /**
     * 卡片的三路取数：结构化回执 → 文本里的 id → 工具参数。
     * @param {any} block - 工具块。
     * @returns {{ id: string, title: string, note: string, data: { columns: string[], rows: string[][] } | null, running: boolean }} 卡片数据。
     */
    function cardData(block) {
      const value = valueOf(block)
      const args = argsOf(block)
      const id = typeof value?.id === 'string' && value.id !== ''
        ? value.id
        : (textOf(block).match(/tbl_\d{8}_[a-z0-9]+/i)?.[0] ?? '')
      const title = typeof value?.title === 'string' && value.title !== ''
        ? value.title
        : (typeof args?.title === 'string' && args.title !== '' ? args.title : '表格')
      const note = typeof value?.note === 'string' && value.note !== ''
        ? value.note
        : (typeof args?.note === 'string' ? args.note : '')
      const full = value?.data && Array.isArray(value.data.columns) && Array.isArray(value.data.rows)
        ? { columns: value.data.columns.map(cell), rows: value.data.rows.map((row) => row.map(cell)) }
        : null
      const data = full ?? tableOfArgs(args)
      const running = block === undefined || block === null || (!('kind' in (block ?? {})) && !('text' in (block ?? {})) && !('content' in (block ?? {})))
      return { id, title, note, data, running }
    }

    // ── 图标（自绘，不依赖图集） ───────────────────────────────────────────

    /** 复制图标：两张叠起来的圆角方片。 */
    function IconCopy() {
      return h('svg', {
        width: 14,
        height: 14,
        viewBox: '0 0 16 16',
        fill: 'none',
        stroke: 'currentColor',
        strokeWidth: 1.2,
        strokeLinejoin: 'round',
        'aria-hidden': 'true',
      },
        h('rect', { x: 5.6, y: 5.6, width: 7.8, height: 7.8, rx: 1.6 }),
        h('path', { d: 'M10.4 5.6V3.7A1.7 1.7 0 0 0 8.7 2H3.7A1.7 1.7 0 0 0 2 3.7v5a1.7 1.7 0 0 0 1.7 1.7h1.9' }),
      )
    }

    /** 下载图标：箭头落进托盘。 */
    function IconDownload() {
      return h('svg', {
        width: 14,
        height: 14,
        viewBox: '0 0 16 16',
        fill: 'none',
        stroke: 'currentColor',
        strokeWidth: 1.2,
        strokeLinecap: 'round',
        strokeLinejoin: 'round',
        'aria-hidden': 'true',
      },
        h('path', { d: 'M8 2.4v6.8' }),
        h('path', { d: 'M5.3 6.7 8 9.4l2.7-2.7' }),
        h('path', { d: 'M2.8 11.2v1.1a1.3 1.3 0 0 0 1.3 1.3h7.8a1.3 1.3 0 0 0 1.3-1.3v-1.1' }),
      )
    }

    /** 放大图标：对角双箭头。 */
    function IconExpand() {
      return h('svg', {
        width: 14,
        height: 14,
        viewBox: '0 0 16 16',
        fill: 'none',
        stroke: 'currentColor',
        strokeWidth: 1.2,
        strokeLinecap: 'round',
        strokeLinejoin: 'round',
        'aria-hidden': 'true',
      },
        h('path', { d: 'M9.6 2.8h3.6v3.6' }),
        h('path', { d: 'M13.2 2.8 8.6 7.4' }),
        h('path', { d: 'M6.4 13.2H2.8V9.6' }),
        h('path', { d: 'M2.8 13.2 7.4 8.6' }),
      )
    }

    // ── 出错留痕 ────────────────────────────────────────────────────────────

    /**
     * 向 host 报一声「我这会儿在干什么」：加载（apply）、卡片画出来了（card）、
     * 轮末画出来了（tail）。浏览器端看不见屏幕时，这是唯一能证明「渲染真的发生了」的证据。
     * @param {string} kind - apply / card / tail。
     * @param {{ callIds?: string[], count?: number, id?: string, note?: string }} [extra] - 附加信息。
     * @returns {void}
     */
    function report(kind, extra = {}) {
      try {
        fetch(`${API}/boot`, {
          method: 'POST',
          credentials: 'same-origin',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            version: CLIENT_VERSION,
            kind,
            ua: typeof navigator === 'object' ? String(navigator?.userAgent ?? '') : '',
            ...extra,
          }),
        }).catch(() => {})
      } catch {
        /* 报不上去也不算失败 */
      }
    }

    /**
     * 把客户端故障投到 host 的 `/api/note`：浏览器控制台看不见时，这是唯一的取证口。
     * @param {string} kind - 故障类型。
     * @param {any} error - 错误对象或文案。
     * @param {string} [extra] - 附加信息（例如组件栈）。
     * @returns {void}
     */
    function beacon(kind, error, extra) {
      try {
        const message = typeof error === 'string' ? error : String(error?.message ?? error ?? '')
        const stack = typeof error?.stack === 'string' ? error.stack : String(extra ?? '')
        fetch(`${API}/note`, {
          method: 'POST',
          credentials: 'same-origin',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ clientFailure: kind, message, stack, version: CLIENT_VERSION }),
        }).catch(() => {})
      } catch {
        /* 留痕失败不算失败 */
      }
    }

    /** 基类兜底：共享模块表里没有 `Component` 时也不至于在模块加载期炸掉。 */
    const BoundaryBase = typeof React.Component === 'function' ? React.Component : class { }

    /**
     * 卡片级错误边界：一张卡画崩了只该显示一行红字，不该把整段回复吃掉。
     * 同时把错误投给 host，方便事后查（渲染期异常不会走到 window.onerror）。
     */
    class CardBoundary extends BoundaryBase {
      constructor(props) {
        super(props)
        this.state = { error: null }
      }

      /**
       * @param {any} error - 抛出来的错误。
       * @returns {{error: any}} 下一个状态。
       */
      static getDerivedStateFromError(error) {
        return { error }
      }

      /**
       * @param {any} error - 错误。
       * @param {any} info - React 的组件栈。
       * @returns {void}
       */
      componentDidCatch(error, info) {
        beacon('render', error, String(info?.componentStack ?? ''))
      }

      /** @returns {any} 子节点或失败文案。 */
      render() {
        if (this.state.error === null) return this.props.children
        const message = String(this.state.error?.message ?? this.state.error)
        return h('div', { className: 'tst-empty', 'data-table-studio': 'error' }, `表格卡渲染失败：${message}`)
      }
    }

    /**
     * 给槽位组件套一层边界。
     * @param {any} Component - 真正的卡片组件。
     * @returns {(props: any) => any} 包好的组件。
     */
    function withBoundary(Component) {
      return function BoundedCard(props) {
        return h(CardBoundary, null, h(Component, props))
      }
    }

    // ── 样式 ────────────────────────────────────────────────────────────────

    const CSS = `
.tst-card {
  --tst-line: var(--dsw-alias-border-l1, #e5e6eb);
  --tst-fg: var(--dsw-alias-label-primary, #1f2329);
  --tst-muted: var(--dsw-alias-label-secondary, #646a73);
  --tst-layer: var(--dsw-alias-bg-layer-1, #ffffff);
  --tst-layer-2: var(--dsw-alias-bg-layer-2, #f6f7f9);
  --tst-hover: var(--dsw-alias-interactive-bg-hover, rgba(31, 35, 41, 0.06));
  margin: 6px 0;
  border: 1px solid var(--tst-line);
  border-radius: 10px;
  background: var(--tst-layer);
  overflow: hidden;
  max-width: 100%;
}
.tst-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  padding: 6px 10px 6px 14px;
  background: var(--tst-layer-2);
  border-bottom: 1px solid var(--tst-line);
}
.tst-head-left { display: flex; align-items: center; gap: 6px; min-width: 0; }
.tst-label {
  font-size: 13px;
  line-height: 20px;
  color: var(--tst-muted);
  white-space: nowrap;
}
.tst-title {
  font-size: 13px;
  line-height: 20px;
  color: var(--tst-fg);
  font-weight: 500;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.tst-tools { display: flex; align-items: center; gap: 2px; flex: 0 0 auto; }
.tst-icon-btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 24px;
  height: 24px;
  padding: 0;
  border: 0;
  border-radius: 6px;
  background: transparent;
  color: var(--tst-muted);
  cursor: pointer;
  transition: background 0.12s ease, color 0.12s ease;
}
.tst-icon-btn:hover { background: var(--tst-hover); color: var(--tst-fg); }
.tst-icon-btn:focus-visible { outline: 2px solid var(--dsw-alias-brand-primary, #4d6bfe); outline-offset: 1px; }
/* 表体是唯一滚动容器：列多时横向出条、行多时纵向出条，两条都在表脚之上。
   滚动条常显（细条 + 浅色滑块），否则官人根本不知道右边还有几列。 */
.tst-body {
  max-height: 420px;
  overflow: auto;
  /* Chromium 121+ 认这两个标准属性，会盖过下面的 ::-webkit-scrollbar；
     颜色给到中灰（别用边框色，那几乎看不见），深浅主题都能辨。 */
  scrollbar-width: thin;
  scrollbar-color: rgba(100, 106, 115, 0.5) transparent;
}
.tst-preview-body {
  scrollbar-width: thin;
  scrollbar-color: rgba(100, 106, 115, 0.5) transparent;
}
.tst-body::-webkit-scrollbar,
.tst-preview-body::-webkit-scrollbar { width: 10px; height: 10px; }
.tst-body::-webkit-scrollbar-thumb,
.tst-preview-body::-webkit-scrollbar-thumb {
  border: 2px solid transparent;
  border-radius: 8px;
  background: rgba(100, 106, 115, 0.5) padding-box;
}
.tst-body::-webkit-scrollbar-thumb:hover,
.tst-preview-body::-webkit-scrollbar-thumb:hover { background: rgba(100, 106, 115, 0.8) padding-box; }
.tst-body::-webkit-scrollbar-track,
.tst-preview-body::-webkit-scrollbar-track,
.tst-body::-webkit-scrollbar-corner,
.tst-preview-body::-webkit-scrollbar-corner { background: transparent; }
.tst-table { border-collapse: separate; border-spacing: 0; width: 100%; font-size: 12px; }
/* 卡片里的表按内容撑开：每列有下限（不再被压成一条缝），超长内容仍有上限；
   整表宽过卡片时由 .tst-body 出横向滚动条，而不是把列等分后又截成省略号。 */
.tst-card .tst-table { table-layout: auto; width: max-content; min-width: 100%; }
.tst-card .tst-table th,
.tst-card .tst-table td { min-width: 96px; }
.tst-table th,
.tst-table td {
  padding: 10px 14px;
  border-bottom: 1px solid var(--tst-line);
  border-right: 1px solid var(--tst-line);
  text-align: left;
  vertical-align: middle;
  color: var(--tst-fg);
  line-height: 20px;
  white-space: nowrap;
  max-width: 360px;
  overflow: hidden;
  text-overflow: ellipsis;
}
.tst-table th:last-child,
.tst-table td:last-child { border-right: 0; }
.tst-table thead th {
  position: sticky;
  top: 0;
  z-index: 1;
  background: var(--tst-layer);
  font-weight: 600;
  color: var(--tst-fg);
}
.tst-table tbody tr:last-child td { border-bottom: 0; }
.tst-table tbody tr:hover td { background: var(--tst-layer-2); }
.tst-foot {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  padding: 7px 14px;
  border-top: 1px solid var(--tst-line);
  background: var(--tst-layer-2);
  font-size: 11px;
  line-height: 16px;
  color: var(--tst-muted);
}
.tst-skeleton { padding: 10px 12px; display: grid; gap: 6px; }
.tst-skeleton-row {
  height: 12px;
  border-radius: 4px;
  background: linear-gradient(90deg, var(--tst-layer-2), var(--tst-line), var(--tst-layer-2));
  background-size: 200% 100%;
  animation: tst-shimmer 1.2s ease-in-out infinite;
}
@keyframes tst-shimmer { from { background-position: 200% 0; } to { background-position: -200% 0; } }
.tst-empty { padding: 14px 12px; font-size: 12px; color: var(--tst-muted); }
/* 「已复制」这类一次性提示：放在标题栏里（三枚图标左侧），用 z-index 压过
   粘性表头。放表体上方会被 sticky thead 盖住，官人看不到等于没提示。 */
.tst-flash {
  position: absolute;
  right: 92px;
  top: 6px;
  z-index: 6;
  max-width: min(320px, calc(100% - 160px));
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  padding: 4px 8px;
  border-radius: 6px;
  background: var(--dsw-alias-bg-overlay, rgba(31, 35, 41, 0.86));
  color: var(--dsw-alias-label-primary-foreground, #fff);
  font-size: 11px;
  line-height: 16px;
  pointer-events: none;
  opacity: 0;
  transition: opacity 0.16s ease;
}
.tst-flash[data-show='1'] { opacity: 1; }
.tst-toast {
  position: fixed;
  left: 50%;
  bottom: 28px;
  max-width: min(620px, 88vw);
  transform: translateX(-50%);
  z-index: 2147483200;
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 9px 12px 9px 14px;
  border: 1px solid var(--dsw-alias-border-l1, #e5e6eb);
  border-radius: 12px;
  background: var(--dsw-alias-bg-layer-1, #fff);
  box-shadow: 0 8px 28px rgba(0, 0, 0, 0.18);
  font-size: 13px;
  line-height: 18px;
  color: var(--dsw-alias-label-primary, #1f2329);
}
.tst-toast-check {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 18px;
  height: 18px;
  border-radius: 50%;
  background: #22c55e;
  color: #ffffff;
  font-size: 12px;
  line-height: 1;
}
.tst-toast-body {
  display: flex;
  flex: 1 1 auto;
  flex-direction: column;
  gap: 1px;
  min-width: 0;
  max-width: min(420px, 58vw);
}
.tst-toast-text { white-space: nowrap; }
.tst-toast-path {
  font-size: 11px;
  line-height: 15px;
  color: var(--dsw-alias-label-secondary, #646a73);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  direction: rtl;
  text-align: left;
}
.tst-toast-action {
  flex: 0 0 auto;
  padding: 0 2px;
  border: 0;
  background: transparent;
  color: var(--dsw-alias-brand-primary, #4d6bfe);
  font-family: inherit;
  font-size: 13px;
  white-space: nowrap;
  cursor: pointer;
}
.tst-toast-action:hover { text-decoration: underline; }
.tst-toast-close {
  padding: 0 2px;
  border: 0;
  background: transparent;
  color: var(--dsw-alias-label-secondary, #646a73);
  font-family: inherit;
  font-size: 16px;
  line-height: 1;
  cursor: pointer;
}

.tst-overlay {
  position: fixed;
  inset: 0;
  z-index: 2147483000;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 24px;
  background: rgba(0, 0, 0, 0.45);
}
.tst-preview {
  display: flex;
  flex-direction: column;
  width: min(1080px, 92vw);
  /* 祖先再窄也不许把弹层压成一条缝：最多铺满可用宽度。 */
  max-width: 100%;
  max-height: 88vh;
  border: 1px solid var(--dsw-alias-border-l1, #e5e6eb);
  border-radius: 12px;
  overflow: hidden;
  background: var(--dsw-alias-bg-layer-1, #fff);
  box-shadow: 0 18px 48px rgba(0, 0, 0, 0.34);
}
.tst-preview-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  padding: 10px 14px;
  border-bottom: 1px solid var(--dsw-alias-border-l1, #e5e6eb);
  background: var(--dsw-alias-bg-layer-2, #f6f7f9);
}
.tst-preview-heading { display: flex; align-items: center; gap: 10px; min-width: 0; }
.tst-preview-title {
  font-size: 13px;
  font-weight: 600;
  color: var(--dsw-alias-label-primary, #1f2329);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.tst-preview-shape {
  flex: 0 0 auto;
  padding: 1px 7px;
  border: 1px solid var(--dsw-alias-border-l1, #e5e6eb);
  border-radius: 999px;
  color: var(--dsw-alias-label-secondary, #646a73);
  font-size: 11px;
  line-height: 16px;
}
.tst-preview-body { flex: 1 1 auto; overflow: auto; min-height: 0; }
/* 大图里的表同样按内容撑开：列多就横向滚动，不把十几列挤成一排省略号。 */
.tst-preview-body .tst-table { table-layout: auto; width: max-content; min-width: 100%; }
.tst-preview-body .tst-table th,
.tst-preview-body .tst-table td { min-width: 110px; }
.tst-table-lg th,
.tst-table-lg td {
  padding: 9px 14px;
  font-size: 13px;
  line-height: 20px;
}
.tst-table-lg thead th {
  position: sticky;
  top: 0;
  z-index: 1;
  background: var(--dsw-alias-bg-layer-1, #fff);
  font-weight: 600;
}
.tst-preview-foot {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px;
  padding: 10px 14px;
  border-top: 1px solid var(--dsw-alias-border-l1, #e5e6eb);
  background: var(--dsw-alias-bg-layer-2, #f6f7f9);
}
.tst-preview-note {
  flex: 1 1 120px;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: 11px;
  color: var(--dsw-alias-label-secondary, #646a73);
}
.tst-pbtn {
  height: 26px;
  padding: 0 10px;
  /* 按钮定高 26px，文字一折行就会被裁成半截（真机上「下载 CSV」「在画布里编辑」
     被挤成两三行的元凶）。宁可整行放不下换到下一行，也不许把字挤在一起。 */
  flex: 0 0 auto;
  white-space: nowrap;
  border: 1px solid var(--dsw-alias-border-l1, #e5e6eb);
  border-radius: 6px;
  background: transparent;
  color: var(--dsw-alias-label-primary, #1f2329);
  font-family: inherit;
  font-size: 12px;
  cursor: pointer;
}
.tst-pbtn:hover { background: var(--dsw-alias-interactive-bg-hover, rgba(31, 35, 41, 0.06)); }
.tst-pbtn:disabled { opacity: 0.5; cursor: default; }
.tst-pbtn-primary {
  border-color: transparent;
  background: var(--dsw-alias-brand-primary, #4d6bfe);
  color: var(--dsw-alias-label-primary-foreground, #fff);
}
.tst-pbtn-primary:hover { filter: brightness(1.06); }
.tst-close {
  height: 24px;
  padding: 0 10px;
  border: 1px solid var(--dsw-alias-border-l1, #e5e6eb);
  border-radius: 6px;
  background: transparent;
  color: var(--dsw-alias-label-secondary, #646a73);
  font-size: 12px;
  cursor: pointer;
}
.tst-close:hover { background: var(--dsw-alias-bg-layer-2, #f6f7f9); color: var(--dsw-alias-label-primary, #1f2329); }
.tst-compact {
  display: flex;
  align-items: center;
  gap: 6px;
  margin: 4px 0;
  padding: 4px 10px;
  border: 1px solid var(--dsw-alias-border-l1, #e5e6eb);
  border-radius: 8px;
  background: var(--dsw-alias-bg-layer-2, #f6f7f9);
  color: var(--dsw-alias-label-secondary, #646a73);
  font-size: 11px;
  line-height: 16px;
}
.tst-compact-text { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.tst-tail { display: flex; flex-direction: column; gap: 8px; }
.tst-tail-item { min-width: 0; }
.tst-pane { display: flex; flex-direction: column; height: 100%; min-height: 0; background: var(--dsw-alias-bg-layer-1, #fff); }
.tst-frame { flex: 1 1 auto; width: 100%; border: 0; background: transparent; }
.tst-pane-empty {
  display: flex;
  flex: 1 1 auto;
  flex-direction: column;
  gap: 10px;
  align-items: center;
  justify-content: center;
  padding: 24px;
  color: var(--dsw-alias-label-secondary, #646a73);
  font-size: 12px;
  text-align: center;
}
.tst-pane-btn {
  height: 28px;
  padding: 0 12px;
  border: 1px solid var(--dsw-alias-border-l1, #e5e6eb);
  border-radius: 6px;
  background: var(--dsw-alias-bg-layer-1, #fff);
  color: var(--dsw-alias-label-primary, #1f2329);
  font-size: 12px;
  cursor: pointer;
}
.tst-pane-btn:hover { background: var(--dsw-alias-bg-layer-2, #f6f7f9); }
/* tab chip 上的字是表名，长短不一：限宽 + 省略号，别把一个长表名顶得整个 tab 变形。 */
.tst-tab-title {
  display: inline-block;
  max-width: 180px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  vertical-align: bottom;
  font-size: 12px;
  color: inherit;
}
`

    /**
     * 把任意 CSS 颜色解析成 [r,g,b]（认 #rgb / #rrggbb / rgb() / rgba()）。
     * @param {string} value - 颜色字符串。
     * @returns {[number, number, number] | null} 解析结果。
     */
    function parseColor(value) {
      const text = String(value ?? '').trim()
      if (text === '') return null
      const hex = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(text)
      if (hex !== null) {
        const body = hex[1]
        if (body.length === 3) {
          return [0, 1, 2].map((i) => parseInt(body[i] + body[i], 16))
        }
        return [0, 2, 4].map((i) => parseInt(body.slice(i, i + 2), 16))
      }
      const rgb = /^rgba?\(\s*([0-9.]+)\s*,\s*([0-9.]+)\s*,\s*([0-9.]+)/i.exec(text)
      if (rgb !== null) return [Number(rgb[1]), Number(rgb[2]), Number(rgb[3])]
      return null
    }

    /**
     * 算一段文字压在某个底色上该用深色还是浅色。
     * @param {string} background - 底色。
     * @returns {string} 前景色。
     */
    function onColor(background) {
      const rgb = parseColor(background)
      if (rgb === null) return '#ffffff'
      // 相对亮度（sRGB 近似即可：这里只决定用白字还是深字）。
      const [r, g, b] = rgb.map((channel) => {
        const value = channel / 255
        return value <= 0.03928 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4
      })
      const luminance = 0.2126 * r + 0.7152 * g + 0.0722 * b
      return luminance > 0.55 ? '#1f2329' : '#ffffff'
    }

    /**
     * 读 DSH 主题令牌，算出一份给 iframe 用的调色板。
     * @returns {{ bg: string, surface: string, fg: string, muted: string, line: string, accent: string, header: string, font: string, dark: boolean }} 调色板。
     */
    function readPalette() {
      const sources = []
      try {
        sources.push(getComputedStyle(document.documentElement))
        if (document.body) sources.push(getComputedStyle(document.body))
      } catch {
        /* 无样式环境（单测） */
      }
      const read = (name, fallback) => {
        for (const style of sources) {
          const value = style?.getPropertyValue?.(name)?.trim()
          if (typeof value === 'string' && value !== '') return value
        }
        return fallback
      }
      const dark = (() => {
        try {
          const body = document.body
          const root = document.documentElement
          if (!body || !root) return false
          if (body.dataset?.dsDarkTheme !== undefined || root.dataset?.dsDarkTheme !== undefined) return true
          if (root.classList?.contains('dark') || body.classList?.contains('dark')) return true
          const scheme = getComputedStyle(body).colorScheme ?? ''
          return scheme.includes('dark')
        } catch {
          return false
        }
      })()
      const accent = read('--dsw-alias-brand-primary', '#4d6bfe')
      return {
        accent,
        onAccent: onColor(accent),
        bg: read('--dsw-alias-bg-layer-1', dark ? '#1b1c1f' : '#ffffff'),
        surface: read('--dsw-alias-bg-layer-2', dark ? '#23252a' : '#f6f7f9'),
        header: read('--dsw-alias-bg-layer-2', dark ? '#23252a' : '#f2f3f5'),
        fg: read('--dsw-alias-label-primary', dark ? '#e8eaed' : '#1f2329'),
        muted: read('--dsw-alias-label-secondary', dark ? '#9aa0aa' : '#646a73'),
        line: read('--dsw-alias-border-l1', dark ? '#31333a' : '#e5e6eb'),
        font: sources[0]?.fontFamily ?? '',
        dark,
      }
    }

    /**
     * 把调色板推给 iframe。
     * @param {HTMLIFrameElement | null} frame - iframe。
     * @returns {void}
     */
    function pushTheme(frame) {
      try {
        frame?.contentWindow?.postMessage({ __ts: 'theme', palette: readPalette() }, '*')
      } catch {
        /* iframe 还没就绪 */
      }
    }

    // ── 会话里的表格卡 ──────────────────────────────────────────────────────

    /**
     * 一张表在右栏里的地址。
     * @param {string} docId - 表 id。
     * @returns {string} 资源地址。
     */
    function addressOfDoc(docId) {
      return `${TAB_SCHEME}/${encodeURIComponent(docId)}`
    }

    /**
     * 从右栏 tab 的 contentId 反解出表 id；不是本插件的地址就给空串。
     * @param {string} address - tab 的 contentId（或导航地址）。
     * @returns {string} 表 id，认不出为空串。
     */
    function docIdOfAddress(address) {
      const text = typeof address === 'string' ? address : ''
      const head = `${TAB_SCHEME}/`
      if (!text.startsWith(head)) return ''
      const rest = text.slice(head.length).split(/[/?#]/)[0]
      if (rest === '') return ''
      try {
        return decodeURIComponent(rest)
      } catch {
        return rest
      }
    }

    /**
     * 表 id → 表名。tab 的标题要同步可读（注册时的 `title(address)` 是同步接口），
     * 所以卡片一打开就先把表名记在这里；刷新后缓存空了，由 TabTitle 异步补。
     */
    const docTitles = new Map()
    /** 缓存上限：tab 开开关关，别让一张无界表把内存养肥。 */
    const DOC_TITLES_LIMIT = 256

    /**
     * 记一条「表 id → 表名」，顺手压掉最老的条目。
     * @param {string} docId - 表 id。
     * @param {string} title - 表名。
     * @returns {void}
     */
    function rememberDocTitle(docId, title) {
      if (typeof docId !== 'string' || docId === '') return
      if (typeof title !== 'string' || title === '') return
      if (docTitles.has(docId)) docTitles.delete(docId)
      docTitles.set(docId, title)
      while (docTitles.size > DOC_TITLES_LIMIT) {
        const oldest = docTitles.keys().next().value
        if (oldest === undefined) break
        docTitles.delete(oldest)
      }
    }

    /**
     * 一个地址对应的 tab 标题：认得出表就用表名，认不出退回「表格」。
     * @param {string} address - 资源地址。
     * @returns {string} tab 标题。
     */
    function tabTitleOf(address) {
      const name = docTitles.get(docIdOfAddress(address))
      return typeof name === 'string' && name !== '' ? name : '表格'
    }

    /**
     * 本插件在某个会话里开着几个 tab：只用于自报（client.json 里看得见），
     * 侧栏没这个能力时返回 undefined，不硬凑数字。
     * @param {any} controller - sidebarRight 控制器。
     * @param {string} sessionId - 会话 id。
     * @returns {number | undefined} tab 数。
     */
    function tabCountOf(controller, sessionId) {
      if (typeof sessionId !== 'string' || sessionId === '') return undefined
      try {
        const tabs = typeof controller?.tabsIn === 'function' ? controller.tabsIn(sessionId) : null
        if (!Array.isArray(tabs)) return undefined
        return tabs.filter((tab) => tab?.kind === TAB_KIND).length
      } catch {
        return undefined
      }
    }

    /** 轮末投影的 kind。 */
    const TABLES_KIND = 'table-studio'
    /** 轮末投影已画过的 callId：工具卡据此退成一行，同一张表不该出现两次。 */
    const tailRendered = new Set()
    /** 谁在听「轮末画过了」这件事。 */
    const tailListeners = new Set()
    const TAIL_RENDERED_LIMIT = 512
    /** client ctx：轮末卡片没有注入 props，靠它自己找侧栏。 */
    let hostCtx = null

    /**
     * 登记「这些 callId 已在轮末画过」，并叫醒订阅者。
     * @param {string[]} callIds - callId 列表。
     * @returns {boolean} 有无变化。
     */
    function markTailRendered(callIds) {
      if (!Array.isArray(callIds)) return false
      let changed = false
      for (const callId of callIds) {
        if (typeof callId !== 'string' || callId === '' || tailRendered.has(callId)) continue
        tailRendered.add(callId)
        changed = true
      }
      while (tailRendered.size > TAIL_RENDERED_LIMIT) {
        const oldest = tailRendered.values().next().value
        if (oldest === undefined) break
        tailRendered.delete(oldest)
      }
      if (changed) {
        for (const listener of [...tailListeners]) {
          try {
            listener()
          } catch {
            /* 订阅者自己炸，不许连坐 */
          }
        }
      }
      return changed
    }

    /**
     * 这张工具卡是不是已经在轮末画过了。
     * @param {string} callId - 工具调用 id。
     * @returns {boolean} 画过为 true。
     */
    function useTailRendered(callId) {
      const [revision, setRevision] = useState(0)
      useEffect(() => {
        if (typeof callId !== 'string' || callId === '') return undefined
        const bump = () => setRevision((value) => value + 1)
        tailListeners.add(bump)
        // 挂载时可能已经登记过：补一次，否则会停在旧结论上。
        if (tailRendered.has(callId)) bump()
        return () => {
          tailListeners.delete(bump)
        }
      }, [callId])
      void revision
      return typeof callId === 'string' && callId !== '' && tailRendered.has(callId)
    }

    /** 自动开画布的记账键前缀（按浏览器会话记，刷新一次不会反复弹）。 */
    const AUTO_OPEN_KEY = 'dsh-table-studio:opened:'

    /**
     * 每张表只自动拉一次画布：表出来了，右侧编辑器跟着出来。
     *
     * 用 sessionStorage 记账而不是内存变量：卡片会随历史重画，只靠内存会在每次
     * 刷新时把画布再弹一遍，那就不叫「顺手」了。
     * @param {string} id - 表 id。
     * @param {Function} opener - 打开右栏的函数。
     * @param {string} [title] - 表名，给 tab 取标题用。
     * @returns {boolean} 这次是否真的去开了。
     */
    function autoOpenOnce(id, opener, title = '') {
      if (typeof id !== 'string' || id === '') return false
      if (typeof opener !== 'function') {
        report('open-tab', { note: 'no-opener-prop' })
        return false
      }
      /** @type {Storage | null} */
      let storage = null
      try {
        storage = window.sessionStorage ?? null
      } catch {
        storage = null
      }
      const key = `${AUTO_OPEN_KEY}${CLIENT_VERSION}:${id}`
      try {
        if (storage?.getItem(key) === '1') {
          report('open-tab', { note: 'storage-skip' })
          return false
        }
      } catch {
        /* 存不了就每次都试，反正 opener 自己会判断 */
      }
      let opened = false
      try {
        opened = opener({ docId: id, title }) === true
      } catch {
        opened = false
      }
      if (opened) {
        try {
          storage?.setItem(key, '1')
        } catch {
          /* ignore */
        }
      }
      return opened
    }

    /**
     * 卡片本体：标题栏三枚图标 + 表体 + 表脚 + 放大浮层。
     *
     * 工具卡与轮末卡共用这一份：外观只有一处，改样式不会两边走样。
     * @param {{ id?: string, title?: string, note?: string, data?: any, sessionId?: string, openEditor?: Function }} props - 卡片数据。
     * @returns {any} React 节点。
     */
    function TableCardView(props) {
      const id = typeof props?.id === 'string' ? props.id : ''
      const title = typeof props?.title === 'string' && props.title !== '' ? props.title : '表格'
      const note = typeof props?.note === 'string' ? props.note : ''
      const sessionId = typeof props?.sessionId === 'string' ? props.sessionId : ''
      /** 打开右栏的函数：槽注入了就用，没注入就自己造一个（hostCtx 在 apply 时记下）。 */
      const resolveOpener = useCallback(() => {
        if (typeof props?.openEditor === 'function') return props.openEditor
        if (hostCtx === null) return null
        return (params) => makeOpener(hostCtx, sessionId)(params)
      }, [props?.openEditor, sessionId])
      const [data, setData] = useState(props?.data ?? null)
      const [error, setError] = useState('')
      const [flash, setFlash] = useState('')
      const [overlay, setOverlay] = useState(false)
      /** 下载完成的浮提示：{ name, path, status } 或 null（path 只有 Desktop 完成时才有）。 */
      const [notice, setNotice] = useState(null)
      const noticeTimer = useRef(0)

      useEffect(() => {
        setData(props?.data ?? null)
      }, [props?.data])

      useEffect(() => {
        if (id === '' || props?.data) return undefined
        let alive = true
        api(`/doc/${encodeURIComponent(id)}`)
          .then((result) => {
            if (!alive) return
            if (result?.ok === true && result.data) {
              setData({
                columns: (result.data.columns ?? []).map(cell),
                rows: (result.data.rows ?? []).map((row) => (Array.isArray(row) ? row.map(cell) : [])),
              })
              setError('')
            } else {
              setError(result?.message ?? '读不到这张表')
            }
          })
          .catch((failure) => {
            if (alive) setError(String(failure?.message ?? failure))
          })
        return () => {
          alive = false
        }
      }, [id, props?.data])

      useEffect(() => {
        if (notice === null) return undefined
        if (noticeTimer.current) clearTimeout(noticeTimer.current)
        noticeTimer.current = setTimeout(() => setNotice(null), 10_000)
        return () => {
          if (noticeTimer.current) clearTimeout(noticeTimer.current)
        }
      }, [notice])

      const toast = useCallback((text) => {
        setFlash(text)
        setTimeout(() => setFlash(''), 1600)
      }, [])

      const onCopy = useCallback(async () => {
        if (data === null) return
        const ok = await copyText(toTsvText(data))
        toast(ok ? `已复制 ${data.columns.length} 列 × ${data.rows.length} 行` : '复制失败：剪贴板被拒绝')
      }, [data, toast])

      // 「下载」= 直接存进默认下载目录（Desktop 不弹「另存为」）+ 弹「下载完成 ·
      // 立即查看」提示；点「立即查看」直接开右侧表格编辑器，不再绕一层预览。
      const saveCsv = useCallback(async (withNotice = true) => {
        if (data === null) return { ok: false }
        const blob = new Blob([toCsvText(data)], { type: 'text/csv;charset=utf-8' })
        const name = `${safeName(title)}.csv`
        const result = await saveFileSilently(hostCtx, blob, name, 'text/csv')
        report('file-download', {
          id,
          note: result.ok ? (savedHint(result) || name) : `failed:${result.code ?? result.status ?? 'unknown'}`,
        })
        if (!result.ok) {
          if (result.canceled !== true) toast(`保存失败：${result.code ?? '未知原因'}`)
          return result
        }
        if (withNotice) setNotice({ name, path: result.path ?? '', status: result.status ?? 'requested' })
        return result
      }, [data, title, id, toast])

      const onDownload = useCallback(() => {
        void saveCsv(true)
      }, [saveCsv])

      // 「放大」= 只看大图，不进编辑。
      const onExpand = useCallback(() => {
        report('preview-open', { id, note: 'from-expand-icon' })
        setOverlay(true)
      }, [id])

      // 画出来了就报一声：host 侧的 client.json 里会留下 last.card，
      // 用来在「看不见屏幕」时判定卡片确实渲染过、画的是哪一张、几行。
      const painted = data !== null
      useEffect(() => {
        if (!painted) return
        report('card', { id, count: data.rows.length, note: `${data.columns.length} 列` })
      }, [painted, id])

      // 默认不拉画布：官人的语义是「表出来我看大图」，被拽进编辑器是打扰。
      // 唯独 `table_open`（模型明确要「打开画布」）会带 autoOpen:true，此时直接开、
      // 且不做会话级去重——那是一次显式请求，重复调用就该重复打开。
      useEffect(() => {
        if (!painted) return
        if (props?.autoOpen === true) {
          const opener = resolveOpener()
          if (opener !== null) opener({ docId: id, title })
          return
        }
        if (props?.autoOpen === 'once') autoOpenOnce(id, resolveOpener(), title)
      }, [painted, id, props?.autoOpen, resolveOpener])

      useEffect(() => {
        if (!overlay) return undefined
        const onKey = (event) => {
          if (event.key === 'Escape') setOverlay(false)
        }
        window.addEventListener('keydown', onKey)
        return () => window.removeEventListener('keydown', onKey)
      }, [overlay])

      // 标题栏照参考图：只有「表格」二字，表名挪到表脚去——图里没有表名，
      // 硬塞一个就与参考图不像了。
      const head = h('div', { className: 'tst-head' },
        h('div', { className: 'tst-head-left' },
          h('span', { className: 'tst-label' }, '表格'),
        ),
        h('div', { className: 'tst-tools' },
          h('button', {
            className: 'tst-icon-btn',
            type: 'button',
            title: '复制（制表符分隔，可直接粘到 Excel）',
            'aria-label': '复制表格',
            onClick: onCopy,
            disabled: data === null,
          }, h(IconCopy)),
          h('button', {
            className: 'tst-icon-btn',
            type: 'button',
            title: '下载 CSV',
            'aria-label': '下载 CSV',
            onClick: onDownload,
            disabled: data === null,
          }, h(IconDownload)),
          h('button', {
            className: 'tst-icon-btn',
            type: 'button',
            title: '放大：在右侧画布里编辑',
            'aria-label': '放大表格',
            onClick: onExpand,
          }, h(IconExpand)),
        ),
      )

      let body
      if (error !== '' && data === null) {
        body = h('div', { className: 'tst-empty' }, `读不到这张表：${error}`)
      } else if (data === null) {
        body = h('div', { className: 'tst-skeleton' },
          h('div', { className: 'tst-skeleton-row', style: { width: '58%' } }),
          h('div', { className: 'tst-skeleton-row', style: { width: '82%' } }),
          h('div', { className: 'tst-skeleton-row', style: { width: '72%' } }),
        )
      } else {
        const shown = data.rows.slice(0, MAX_RENDER_ROWS)
        body = h('div', { className: 'tst-body' },
          h('table', { className: 'tst-table' },
            h('thead', null,
              h('tr', null, data.columns.map((name, index) => h('th', { key: `h${index}`, title: name }, name || `列${index + 1}`))),
            ),
            h('tbody', null,
              shown.map((row, rowIndex) => h('tr', { key: `r${rowIndex}` },
                data.columns.map((_, columnIndex) => {
                  const value = row[columnIndex] ?? ''
                  return h('td', { key: `c${columnIndex}`, title: value }, value)
                }),
              )),
            ),
          ),
        )
      }

      const footBits = []
      if (title !== '' && title !== '表格') footBits.push(title)
      if (data !== null) {
        footBits.push(`${data.columns.length} 列 × ${data.rows.length} 行`)
        if (data.rows.length > MAX_RENDER_ROWS) footBits.push(`只显示前 ${MAX_RENDER_ROWS} 行，点放大看全表`)
      }
      if (note !== '') footBits.push(note)

      const overlayNode = overlay
        ? h(PreviewOverlay, {
          title,
          note,
          id,
          data,
          onClose: () => setOverlay(false),
          onDownload: () => saveCsv(false),
          onEdit: () => {
            const opener = resolveOpener()
            const opened = opener === null ? false : opener({ docId: id, title })
            if (opened === true) setOverlay(false)
            else toast('侧栏没接上，无法打开画布')
          },
        })
        : null

      // 放大预览挂到 body：既躲开带 transform 的祖先，也不会被卡片的 overflow: hidden 裁掉。
      const mountedOverlay = overlayNode === null
        ? null
        : (reactDom === null ? overlayNode : reactDom.createPortal(overlayNode, document.body))

      return h('div', { className: 'tst-card', style: { position: 'relative' }, 'data-table-studio': id },
        head,
        body,
        footBits.length > 0 ? h('div', { className: 'tst-foot' }, h('span', null, footBits.join(' · '))) : null,
        h('div', { className: 'tst-flash', 'data-show': flash === '' ? '0' : '1' }, flash),
        notice === null
          ? null
          : h('div', { className: 'tst-toast', role: 'status' },
            h('span', { className: 'tst-toast-check' }, '✓'),
            h('div', { className: 'tst-toast-body' },
              h('span', { className: 'tst-toast-text' }, '下载完成'),
              notice.path !== ''
                ? h('span', { className: 'tst-toast-path', title: notice.path }, notice.path)
                : null,
            ),
            h('button', {
              className: 'tst-toast-action',
              type: 'button',
              onClick: () => {
                setNotice(null)
                const opener = resolveOpener()
                const opened = opener === null ? false : opener({ docId: id, title })
                report('open-tab', { note: opened ? 'from-toast' : 'toast-no-sidebar' })
                // 「查看」= 直接在右侧表格编辑器里看这张表，不再绕预览弹层。
                if (opened !== true) toast('侧栏没接上，无法打开表格编辑器')
              },
            }, '立即查看'),
            h('button', { className: 'tst-toast-close', type: 'button', 'aria-label': '关闭提示', onClick: () => setNotice(null) }, '×'),
          ),
        mountedOverlay,
      )
    }

    /**
     * 编辑器页地址：doc 与 session 都是可选参数，缺哪个就不拼哪个。
     * @param {string} id - 表 id。
     * @param {string} sessionId - 会话 id。
     * @returns {string} URL。
     */
    function overlaySrc(id, sessionId) {
      const params = []
      if (id !== '') params.push(`doc=${encodeURIComponent(id)}`)
      if (sessionId !== '') params.push(`session=${encodeURIComponent(sessionId)}`)
      return `${PREFIX}/editor${params.length > 0 ? `?${params.join('&')}` : ''}`
    }

    /**
     * 大图预览：只读的一张表，样式与卡片同一套（表头加粗、竖线分隔、跟随主题）。
     *
     * 「放大」与「下载」都落到这里——官人的语义是「表出来我看大图」，
     * 编辑留给底栏那个显式入口。
     * @param {{ title?: string, note?: string, id?: string, data?: any, onClose: Function, onDownload: Function, onEdit: Function }} props - 预览参数。
     * @returns {any} React 节点。
     */
    function PreviewOverlay(props) {
      const title = typeof props?.title === 'string' && props.title !== '' ? props.title : '表格'
      const note = typeof props?.note === 'string' ? props.note : ''
      const data = props?.data ?? null
      useEffect(() => {
        const onKey = (event) => {
          if (event.key === 'Escape') props.onClose()
        }
        window.addEventListener('keydown', onKey)
        return () => window.removeEventListener('keydown', onKey)
      }, [props])
      const head = h('div', { className: 'tst-preview-head' },
        h('div', { className: 'tst-preview-heading' },
          h('span', { className: 'tst-preview-title' }, title),
          data === null ? null : h('span', { className: 'tst-preview-shape' }, `${data.columns.length} 列 × ${data.rows.length} 行`),
        ),
        h('button', { className: 'tst-close', type: 'button', onClick: props.onClose }, '关闭'),
      )
      const body = data === null
        ? h('div', { className: 'tst-empty', style: { padding: '24px' } }, '读不到这张表')
        : h('div', { className: 'tst-preview-body' },
          h('table', { className: 'tst-table tst-table-lg' },
            h('thead', null,
              h('tr', null, data.columns.map((name, index) => h('th', { key: `h${index}`, title: name }, name || `列${index + 1}`))),
            ),
            h('tbody', null,
              data.rows.map((row, rowIndex) => h('tr', { key: `r${rowIndex}` },
                data.columns.map((_, columnIndex) => {
                  const value = row[columnIndex] ?? ''
                  return h('td', { key: `c${columnIndex}`, title: value }, value)
                }),
              )),
            ),
          ),
        )
      // 主按钮的前景/背景按主题实算：深色主题下品牌色是近白，白字会糊成一块白板。
      const palette = readPalette()
      const foot = h('div', { className: 'tst-preview-foot' },
        note !== '' ? h('span', { className: 'tst-preview-note' }, note) : h('span', { className: 'tst-preview-note' }, ''),
        h('button', { className: 'tst-pbtn', type: 'button', onClick: props.onDownload, disabled: data === null }, '下载 CSV'),
        h('button', {
          className: 'tst-pbtn tst-pbtn-primary',
          type: 'button',
          onClick: props.onEdit,
          style: { background: palette.accent, color: palette.onAccent },
        }, '在画布里编辑'),
      )
      return h('div', {
        className: 'tst-overlay',
        role: 'dialog',
        'aria-modal': 'true',
        onClick: (event) => {
          if (event.target === event.currentTarget) props.onClose()
        },
      },
      h('div', { className: 'tst-preview' }, head, body, foot),
      )
    }

    /**
     * 工具卡：挂在 `table_*` 这次调用下面。
     *
     * 若同一张表已在轮末画过，这里只留一行——否则一段回复里会并排出现两张一模一样的表。
     * @param {any} props - 槽 props。
     * @returns {any} React 节点。
     */
    function TableCard(props) {
      const block = props?.block
      const info = useMemo(() => cardData(block), [block])
      const rendered = useTailRendered(props?.callId)
      const running = props?.phase === 'preparing' || props?.phase === 'start' || info.running

      if (running && info.data === null) {
        return h('div', { className: 'tst-card', 'data-table-studio': 'pending' },
          h('div', { className: 'tst-head' }, h('div', { className: 'tst-head-left' }, h('span', { className: 'tst-label' }, '表格'))),
          h('div', { className: 'tst-skeleton' },
            h('div', { className: 'tst-skeleton-row', style: { width: '58%' } }),
            h('div', { className: 'tst-skeleton-row', style: { width: '82%' } }),
            h('div', { className: 'tst-skeleton-row', style: { width: '72%' } }),
          ),
        )
      }

      if (rendered) {
        return h('div', { className: 'tst-compact', 'data-table-studio': info.id || 'tail' },
          h('span', { className: 'tst-compact-text' }, `表格「${info.title}」已渲染在下方`),
        )
      }

      return h(TableCardView, {
        id: info.id,
        title: info.title,
        note: info.note,
        data: info.data,
        sessionId: typeof props?.sessionId === 'string' ? props.sessionId : '',
        openEditor: props?.openEditor,
        autoOpen: props?.autoOpen,
      })
    }

    /**
     * 轮末投影：把本轮 `table_render` / `table_open` 的参数攒成卡片。
     *
     * 为什么不靠工具结果：`tool/call` 事件带 `arguments`，回放与冷启动都能重画；
     * 结果事件里只有一行给人看的文字。
     */
    const tablesDefinition = {
      kind: TABLES_KIND,
      /**
       * @param {any} event - 一条 session 事件。
       * @returns {{id: string, role: string} | null} 投影匹配。
       */
      match(event) {
        if (event === null || typeof event !== 'object') return null
        if (event.type === 'turn/start') return { id: String(event.data?.turn), role: 'start' }
        if (event.type === 'tool/call' && (event.data?.name === 'table_render' || event.data?.name === 'table_open')) {
          return { id: String(event.data?.turn), role: 'update' }
        }
        return null
      },
      /**
       * @param {any} _context - 投影上下文。
       * @param {any} matched - 命中的 turn/start。
       * @returns {{turn: any, cards: any[]}} 初始状态。
       */
      start(_context, matched) {
        return { turn: matched?.event?.data?.turn, cards: [] }
      },
      /**
       * @param {any} context - 投影上下文。
       * @param {any} matched - 命中的事件。
       * @returns {any} 新状态。
       */
      update(context, matched) {
        const event = matched?.event
        if (event === null || typeof event !== 'object' || event.type !== 'tool/call') return context.state
        const callId = String(event.data?.callId ?? '')
        if (callId === '') return context.state
        let args = null
        try {
          args = JSON.parse(String(event.data?.arguments ?? ''))
        } catch {
          return context.state
        }
        if (args === null || typeof args !== 'object') return context.state
        const info = cardData({ args })
        if (info.data === null && info.id === '') return context.state
        const cards = Array.isArray(context.state?.cards) ? context.state.cards : []
        if (cards.some((existing) => existing.callId === callId)) return context.state
        return {
          ...context.state,
          cards: [...cards, { callId, id: info.id, title: info.title, note: info.note, data: info.data }],
        }
      },
      /**
       * 把投影状态挂到 turn 上——`props.turn.data.get('table-studio')` 靠这一步。
       * @param {any} context - 投影上下文。
       * @param {string} scope - 目标作用域。
       * @param {any} previous - 上一次挂上去的值。
       * @returns {any} 位置数据，或 null 表示本轮没有表。
       */
      buildLocationData(context, scope, previous) {
        if (scope !== 'turn' || context?.state === undefined) return null
        const cards = Array.isArray(context.state?.cards) ? context.state.cards : []
        if (cards.length === 0) return null
        if (previous?.kind === 'turn' && previous.key === TABLES_KIND && previous.value?.cards === cards) return previous
        return { kind: 'turn', turn: context.state.turn, key: TABLES_KIND, value: { cards } }
      },
    }

    /**
     * 轮末那张表：正文之后、动作行之前。
     * @param {any} props - turnTail 的 owner（含 turn/seq）。
     * @returns {any} React 节点。
     */
    function TablesTail(props) {
      const state = props?.turn?.data?.get?.(TABLES_KIND)
      const cards = Array.isArray(state?.cards) ? state.cards : []
      const key = cards.map((card) => (typeof card?.callId === 'string' ? card.callId : '')).join('\u0000')
      useEffect(() => {
        if (key === '') return
        markTailRendered(cards.map((card) => card.callId))
        report('tail', { callIds: cards.map((card) => card.callId), count: cards.length })
      }, [key])
      if (cards.length === 0) return null
      const sessionId = typeof props?.sessionId === 'string' ? props.sessionId : ''
      return h('div', { className: 'tst-tail' },
        cards.map((card) => h('div', { key: card.callId, className: 'tst-tail-item' },
          h(TableCardView, {
            id: card.id,
            title: card.title,
            note: card.note,
            data: card.data,
            sessionId,
            autoOpen: false,
            openEditor: (params) => makeOpener(hostCtx, sessionId)(params),
          }),
        )),
      )
    }

    // ── 右侧画布 ────────────────────────────────────────────────────────────

    /**
     * 取 tab 参数（不同版本 props 形状不同，挨个试）。
     * @param {any} props - 面板 props。
     * @returns {any} 参数字典。
     */
    function tabParams(props) {
      const direct = props?.params
      if (direct && typeof direct === 'object') return direct
      return paramsFromTabInfo(props)
    }

    /**
     * 从 slot 的 `useTabInfo` 里取导航参数。
     *
     * 这个函数**只是取值**，hook 的调用点在 `EditorPanel` 顶层（`useTabInfoResult`），
     * 免得在被 memo/回调包起来的地方调 hook。
     * @param {any} props - 槽 props（含 hook 结果）。
     * @returns {any} 参数字典。
     */
    function paramsFromTabInfo(props) {
      try {
        const info = props?.useTabInfoResult ?? null
        const params = info?.tab?.navigation?.params
        if (params && typeof params === 'object') return params
      } catch {
        /* 老版本没有这个 hook */
      }
      return {}
    }

    /**
     * 面板 body：一个 iframe，里面是本地绑定的编辑器。
     * @param {any} props - 槽 props。
     * @returns {any} React 节点。
     */
    function EditorPanel(props) {
      const sessionId = typeof props?.sessionId === 'string' ? props.sessionId : ''
      // 顶层无条件调用：拿不到（老版本）就当 null，不影响后面的 hooks 数量。
      const tabInfo = typeof props?.useTabInfo === 'function' ? props.useTabInfo() : null
      props = { ...props, useTabInfoResult: tabInfo }
      // useTabInfo 是 hook（slot 的 hookContext），必须在组件顶层直接调，
      // 塞进 useMemo 里会被 React 当成「条件调用 hook」，轻则顺序错乱、重则整块不渲染。
      const params = tabParams(props)
      // 参数对象每帧都是新的（slot 的 hook 返回值不稳定），所以只把里面那个
      // 字符串提出来当依赖——否则 effect 每帧重跑，setPhase 又把帧数推上去，成环。
      //
      // 表 id 有三条来路，按可信度排：导航参数（刚打开）、tab 的资源地址（刷新后
      // 参数丢了、contentId 还在）、会话当前表（guide 入口那种没指名表的情况）。
      const tabContentId = typeof tabInfo?.tab?.contentId === 'string' ? tabInfo.tab.contentId : ''
      const paramDocId = typeof params?.docId === 'string' && params.docId !== ''
        ? params.docId
        : docIdOfAddress(tabContentId)
      const [docId, setDocId] = useState(paramDocId)
      const [phase, setPhase] = useState('loading')
      const [error, setError] = useState('')
      const frameRef = useRef(null)

      useEffect(() => {
        if (paramDocId !== '') {
          setDocId(paramDocId)
          setPhase('ready')
          return undefined
        }
        if (sessionId === '') {
          setPhase('empty')
          return undefined
        }
        let alive = true
        setPhase('loading')
        api(`/session?sessionId=${encodeURIComponent(sessionId)}`)
          .then((result) => {
            if (!alive) return
            const id = typeof result?.id === 'string' ? result.id : ''
            if (id !== '') {
              setDocId(id)
              setPhase('ready')
              setError('')
            } else {
              setPhase('empty')
            }
          })
          .catch((failure) => {
            if (!alive) return
            const message = String(failure?.message ?? failure)
            setError(message)
            setPhase('empty')
            report('panel-error', { note: `session:${message}`.slice(0, 160) })
          })
        return () => {
          alive = false
        }
      }, [paramDocId, sessionId])

      useEffect(() => {
        if (phase !== 'ready') return undefined
        const frame = frameRef.current
        if (!frame) return undefined
        pushTheme(frame)
        const observer = typeof MutationObserver === 'function'
          ? new MutationObserver(() => pushTheme(frameRef.current))
          : null
        try {
          observer?.observe(document.documentElement, { attributes: true, attributeFilter: ['class', 'style', 'data-theme', 'data-ds-dark-theme'] })
          if (document.body) observer?.observe(document.body, { attributes: true, attributeFilter: ['class', 'style', 'data-ds-dark-theme'] })
        } catch {
          /* 观察失败不影响渲染 */
        }
        return () => observer?.disconnect()
      }, [phase, docId])

      const createEmpty = useCallback(async () => {
        try {
          const result = await api('/create', { method: 'POST', body: { sessionId } })
          const id = typeof result?.doc?.id === 'string' ? result.doc.id : ''
          if (id !== '') {
            setDocId(id)
            setPhase('ready')
          } else {
            setError(result?.message ?? '新建失败')
          }
        } catch (failure) {
          setError(String(failure?.message ?? failure))
        }
      }, [sessionId])

      /**
       * 画布里的「下载」：iframe 自己触发下载会走 Chromium 的「另存为」，
       * 所以它把 CSV 文本 postMessage 过来，由这里用 fileActions 静默落盘。
       * @param {HTMLIFrameElement} frame - 编辑器 iframe。
       * @param {{ id?: string, name?: string, text?: string }} request - 请求。
       * @returns {Promise<void>} 无。
       */
      const saveCsvFromFrame = useCallback(async (frame, request) => {
        const name = typeof request?.name === 'string' && request.name !== '' ? request.name : '表格.csv'
        const text = typeof request?.text === 'string' ? request.text : ''
        const reply = (payload) => {
          try {
            frame?.contentWindow?.postMessage({ __ts: 'save-result', ...payload }, '*')
          } catch {
            /* iframe 已经卸载了 */
          }
        }
        try {
          const blob = new Blob([text], { type: 'text/csv;charset=utf-8' })
          const result = await saveFileSilently(hostCtx, blob, name, 'text/csv')
          report('file-download', {
            id: typeof request?.id === 'string' ? request.id : '',
            note: result.ok ? (savedHint(result) || name) : `failed:${result.code ?? result.status ?? 'unknown'}`,
          })
          if (result.ok) reply({ ok: true, path: result.path ?? '', name })
          else reply({ ok: false, message: result.code ?? (result.canceled === true ? '已取消' : '保存失败') })
        } catch (failure) {
          reply({ ok: false, message: String(failure?.message ?? failure) })
        }
      }, [])

      useEffect(() => {
        const onMessage = (event) => {
          const data = event?.data
          if (!data || typeof data !== 'object' || data.__ts !== 'save-csv') return
          const frame = frameRef.current
          if (frame === null || event.source !== frame.contentWindow) return
          void saveCsvFromFrame(frame, data)
        }
        window.addEventListener('message', onMessage)
        return () => window.removeEventListener('message', onMessage)
      }, [saveCsvFromFrame])

      useEffect(() => {
        report('panel-mount', { note: `phase:${phase}${docId === '' ? '' : `:${docId}`}` })
      }, [phase, docId])

      // 下面几个 must 放在所有 return 之前：hooks 的数量必须每帧一致。
      const src = docId === ''
        ? ''
        : `${PREFIX}/editor?doc=${encodeURIComponent(docId)}${sessionId !== '' ? `&session=${encodeURIComponent(sessionId)}` : ''}`
      useEffect(() => {
        if (src === '') return
        report('panel-iframe', { note: src })
      }, [src])

      if (phase === 'loading') {
        return h('div', { className: 'tst-pane' }, h('div', { className: 'tst-pane-empty' }, '正在载入表格…'))
      }
      if (phase === 'empty' || docId === '') {
        return h('div', { className: 'tst-pane' },
          h('div', { className: 'tst-pane-empty' },
            h('span', null, error !== '' ? `还没有可编辑的表（${error}）` : '本会话还没有表：先让模型 table_render 一张，或在这里新建。'),
            h('button', { className: 'tst-pane-btn', type: 'button', onClick: createEmpty }, '新建空表'),
          ),
        )
      }
      return h('div', { className: 'tst-pane' },
        h('iframe', {
          ref: frameRef,
          className: 'tst-frame',
          title: '表格编辑器',
          src,
          onLoad: (event) => pushTheme(event?.currentTarget ?? null),
        }),
      )
    }

    /** 右栏 tab 上的标题。 */
    function TabTitle(props) {
      // 标题槽与 body 槽一样拿得到 useTabInfo：从 tab 的 contentId 认出是哪张表，
      // 表名先从内存缓存取（卡片打开时记过），取不到再问 host 一次。
      const tabInfo = typeof props?.useTabInfo === 'function' ? props.useTabInfo() : null
      const contentId = typeof tabInfo?.tab?.contentId === 'string' ? tabInfo.tab.contentId : ''
      const docId = docIdOfAddress(contentId)
      const [name, setName] = useState(() => docTitles.get(docId) ?? '')
      useEffect(() => {
        if (docId === '') return undefined
        if (docTitles.has(docId)) {
          setName(docTitles.get(docId))
          return undefined
        }
        let alive = true
        api(`/doc/${encodeURIComponent(docId)}`)
          .then((result) => {
            if (!alive) return
            const title = typeof result?.title === 'string' ? result.title : ''
            if (title === '') return
            rememberDocTitle(docId, title)
            setName(title)
          })
          .catch(() => {
            /* 读不到表名就显示「表格」，不至于把 tab 变成空白 */
          })
        return () => {
          alive = false
        }
      }, [docId])
      const label = typeof name === 'string' && name !== '' ? name : '表格'
      return h('span', { className: 'tst-tab-title', title: label }, label)
    }

    /**
     * 打开右栏 tab，返回是否成功。
     *
     * 顺序照抄内置画布类插件：先 `expand()`（折叠的侧栏收下 openTab 却什么都不显示，
     * 看起来就像插件坏了），再看当前挂载的会话是不是本会话——是就开在当下，
     * 不是就用 `…In(sessionId, …)` 指到本会话，免得把 tab 开到别的会话上去。
     *
     * 带 docId 时走资源地址（{@link TAB_SCHEME}）：一张表一个 tab，多张表并排看得见，
     * 重复点同一张只是把它激活。老侧栏没有 `openResource` 才退回页面 tab。
     * @param {any} ctx - client ctx。
     * @param {string} [sessionId] - 本会话 id。
     * @returns {(params?: Record<string, unknown>) => boolean} opener。
     */
    function makeOpener(ctx, sessionId) {
      const mine = typeof sessionId === 'string' ? sessionId : ''
      return (params) => {
        const controller = ctx?.get?.('sidebarRight')
        if (!controller) {
          report('open-tab', { note: 'no-sidebarRight' })
          return false
        }
        const docId = typeof params?.docId === 'string' ? params.docId : ''
        rememberDocTitle(docId, typeof params?.title === 'string' ? params.title : '')
        const options = params ? { params } : {}
        try {
          if (typeof controller.expand === 'function') controller.expand()
          else if (typeof controller.open === 'function') controller.open()
        } catch {
          /* 折叠态展开失败也让下面继续试 */
        }
        const mounted = typeof controller.mounted?.getSnapshot === 'function' ? controller.mounted.getSnapshot() : undefined
        // ① 资源地址：一表一 tab
        if (docId !== '' && typeof controller.openResource === 'function') {
          const address = addressOfDoc(docId)
          const resourceOptions = { params: { docId } }
          try {
            if (mine !== '' && mounted !== undefined && mounted !== mine && typeof controller.openResourceIn === 'function') {
              controller.openResourceIn(mine, address, resourceOptions)
              report('open-tab', { note: `openResourceIn:${address}`, id: docId, count: tabCountOf(controller, mine) })
              return true
            }
            controller.openResource(address, resourceOptions)
            report('open-tab', { note: `openResource:${address}`, id: docId, count: tabCountOf(controller, mine) })
            return true
          } catch (error) {
            // 类型没认领这个地址（老侧栏 / 注册失败）时退回页面 tab，别把入口弄死。
            report('open-tab', { note: `resource-threw:${String(error?.message ?? error).slice(0, 100)}` })
          }
        }
        // ② 页面 tab：老侧栏，或没有 docId（guide 入口 / 会话当前表）
        try {
          if (mine !== '' && mounted !== undefined && mounted === mine && typeof controller.openTab === 'function') {
            controller.openTab(TAB_KIND, options)
            report('open-tab', { note: 'openTab-mine' })
            return true
          }
          if (mine !== '' && typeof controller.openTabIn === 'function') {
            controller.openTabIn(mine, TAB_KIND, options)
            report('open-tab', { note: `openTabIn:${mounted === undefined ? 'no-mount-snapshot' : mounted === mine ? 'same' : 'other'}` })
            return true
          }
          if (typeof controller.openTab === 'function') {
            controller.openTab(TAB_KIND, options)
            report('open-tab', { note: 'openTab-fallback' })
            return true
          }
          if (typeof controller.openTabIn === 'function') {
            controller.openTabIn(mine === '' ? undefined : mine, TAB_KIND, options)
            report('open-tab', { note: 'openTabIn-fallback' })
            return true
          }
          report('open-tab', { note: `no-method:${Object.keys(controller).slice(0, 8).join('|')}` })
        } catch (error) {
          report('open-tab', { note: `threw:${String(error?.message ?? error).slice(0, 120)}` })
          return false
        }
        return false
      }
    }

    // ── 注册 ────────────────────────────────────────────────────────────────

    /**
     * 把每处注册单独隔离：一处失败不该带走其余界面。
     * @param {any} ctx - client ctx。
     * @returns {void}
     */
    function register(ctx) {
      // ① 样式表
      ctx.effect(() => {
        const element = document.createElement('style')
        element.setAttribute('data-dsh-plugin', 'dsh-table-studio')
        element.textContent = CSS
        document.head.appendChild(element)
        return () => element.remove()
      }, 'table-studio: stylesheet')

      // ② tab 类型
      //
      // `patterns` 把本类型挂到资源地址上（一表一地址、一表一 tab）；`title` 是同步
      // 接口，表名从卡片打开时记下的缓存里取，认不出就退「表格」，标题槽再异步补全。
      ctx.effect(() => ctx.sidebarRightTabs.register({
        id: TAB_ID,
        kind: TAB_KIND,
        priority: 'extension',
        patterns: [`${TAB_SCHEME}/**`],
        title: (address) => tabTitleOf(address),
        guide: [{
          id: 'table-studio',
          order: 64,
          title: () => '表格',
          description: () => '在本地表格编辑器里改单元格、增删行列，导出 CSV',
        }],
      }), 'table-studio: tab type')

      // ③ 面板 body + 标题
      ctx.slots.inject('sidebar.right.pane.tab', () => ctx.slots.register(
        { name: 'sidebar.right.pane.tab', key: TAB_ID },
        withBoundary(EditorPanel),
      ))
      ctx.slots.inject('sidebar.right.pane.tab.title', () => ctx.slots.register(
        { name: 'sidebar.right.pane.tab.title', key: TAB_ID },
        TabTitle,
      ))

      // ④ 工具卡：table_render 出卡片，其余工具也把「打开编辑器」的入口带上
      for (const key of ['table_render', 'table_open', 'table_update']) {
        ctx.slots.inject('tool.call.toolview', () => ctx.slots.register({
          name: 'tool.call.toolview',
          key,
          inject: (sessionId) => ({
            openEditor: makeOpener(ctx, sessionId),
            // table_open 的语义就是「把画布打开」，只有它自动开。
            ...(key === 'table_open' ? { autoOpen: true } : {}),
          }),
        }, withBoundary(TableCard)))
      }

      // ④¼ 自报家门：host 侧据此判断「页面跑的是哪一版」。
      report('apply')

      // ④½ 未捕获异常留痕：只在栈里出现本插件时上报，别替别的插件背锅。
      ctx.effect(() => {
        const mine = (text) => typeof text === 'string' && text.includes('dsh-table-studio')
        const onError = (event) => {
          const stack = String(event?.error?.stack ?? '')
          const file = String(event?.filename ?? '')
          if (!mine(file) && !mine(stack)) return
          beacon('window-error', event?.error ?? String(event?.message ?? ''), stack)
        }
        const onRejection = (event) => {
          const reason = event?.reason
          const stack = String(reason?.stack ?? '')
          if (!mine(stack)) return
          beacon('unhandled-rejection', reason ?? '', stack)
        }
        if (typeof window === 'undefined' || typeof window.addEventListener !== 'function') return undefined
        window.addEventListener('error', onError)
        window.addEventListener('unhandledrejection', onRejection)
        return () => {
          window.removeEventListener('error', onError)
          window.removeEventListener('unhandledrejection', onRejection)
        }
      }, 'table-studio: failure beacon')

      // ⑤ 轮末直显：工具卡是「调用」的位置，用户要的是「回复里那张表」。
      //    uiConversation 可能晚到（或老版本没有），所以软注入 + 每步 try。
      const mountTail = (scope) => {
        try {
          const uiConversation = scope?.uiConversation ?? scope?.get?.('uiConversation')
          if (uiConversation === undefined || uiConversation === null
            || typeof uiConversation?.events?.register !== 'function') {
            return
          }
          uiConversation.events.register(tablesDefinition)
          ctx.slots.inject('conversation.chat.turnTail', () => ctx.slots.register(
            { name: 'conversation.chat.turnTail', id: 'dsh-table-studio' },
            withBoundary(TablesTail),
          ))
        } catch (error) {
          try {
            console.error('[dsh-table-studio] turnTail 注册失败', error)
          } catch {
            /* ignore */
          }
        }
      }
      if (typeof ctx.inject === 'function') ctx.inject(['uiConversation'], (scope) => mountTail(scope ?? ctx))
      else mountTail(ctx)
    }

    return {
      inject: ['slots', 'sidebarRightTabs', 'sidebarRight'],
      apply(ctx) {
        hostCtx = ctx
        try {
          register(ctx)
        } catch (error) {
          try {
            console.error(`[dsh-table-studio ${CLIENT_VERSION}] client apply failed`, error)
          } catch {
            /* ignore */
          }
        }
      },
      /** 仅供单测盘点内部实现，运行时不读。 */
      __internals: {
        TableCard,
        TableCardView,
        PreviewOverlay,
        TablesTail,
        tablesDefinition,
        markTailRendered,
        tailRendered,
        overlaySrc,
        autoOpenOnce,
        onColor,
        parseColor,
        TABLES_KIND,
        beacon,
        report,
        CardBoundary,
        withBoundary,
        EditorPanel,
        TabTitle,
        CSS,
        cardData,
        tableOfArgs,
        parseCsvLoose,
        toCsvText,
        toTsvText,
        escapeCsv,
        safeName,
        fileActionsOf,
        saveFileSilently,
        savedHint,
        makeOpener,
        addressOfDoc,
        docIdOfAddress,
        tabTitleOf,
        rememberDocTitle,
        tabCountOf,
        docTitles,
        readPalette,
        CLIENT_VERSION,
        TAB_ID,
        TAB_KIND,
      },
    }
  },
})




