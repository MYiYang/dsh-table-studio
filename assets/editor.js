/**
 * dsh-table-studio — 编辑器页（跑在右侧画布的 iframe 里）。
 *
 * 契约：
 *   - 进来只认 URL 上的 `doc`（表 id）；没有就问 `/api/session`，再没有就新建；
 *   - 网格的第一行就是表头（和导出的 CSV 首行同一行），不另设表头区；
 *   - 界面跟 Excel 一套：工具条 + 公式栏 + 行列表头 + 底部工作表标签，
 *     格式、公式、多张工作表都交给 fortune-sheet 自己管，本页只负责存取；
 *   - 改动走 1.2s 去抖自动保存，Ctrl+S 立刻保存；
 *   - 复制给制表符分隔（粘进 Excel 就是多列）；下载不再走浏览器下载
 *     （Desktop 会弹「另存为」），而是交给父页面用 DSH 的 fileActions
 *     静默存进默认下载目录；
 *   - 主题由父页面 postMessage 过来，本页只借它染顶栏与状态栏；
 *     表格纸面固定白纸——Excel 长什么样，这里就长什么样。
 *
 * @module dsh-table-studio/assets/editor
 */
;(function () {
  'use strict'

  var API = '/dsh-table-studio/api'
  /** 数据面限额（与宿主侧 normalizeTable 一致）：超出的行列不进 columns/rows。 */
  var MAX_MATRIX_ROWS = 5000
  var MAX_MATRIX_COLS = 64

  var state = {
    id: '',
    sessionId: '',
    updatedAt: '',
    title: '表格',
    columns: ['列1', '列2', '列3'],
    rows: [],
    /** 服务端保存的工作表原始数据（格式 / 多表）；只在 fortune 模式下有意义。 */
    sheets: null,
    /**
     * 用户在画布上显式插到表格尾部的空白行 / 列数。
     * 数据面对尾部空白默认裁剪（那是网格组件补的备用区），但用户右键
     * 「向下插入行 / 向右插入列」明确要的空行空列得留在文档里。
     */
    extraRows: 0,
    extraCols: 0,
    ws: null,
    fsRoot: null,
    fsRef: null,
    fsSheets: null,
    fsStable: false,
    grid: '',
    preferGrid: '',
    dark: false,
    dirty: false,
    saving: false,
    timer: 0,
    lastSaved: '',
    booted: false,
    /**
     * 网格坏掉之后的抢救状态。
     *
     * fortune 是 React 树，渲染里抛一次错 React 就把整棵树卸掉——用户看到的是
     * 一块白板。白板不能就这么交给用户：这里是「重建网格」的次数与节流标记，
     * 由 error boundary 与看门狗共用。
     */
    healAttempts: 0,
    healing: false,
    /** 看门狗连续几次看到网格不见了（一次算抖动，两次才动手）。 */
    blankTicks: 0,
    /** 已经报过几次崩溃（防止一处坏数据把日志刷爆）。 */
    crashes: 0,
    /** 最近一次崩溃的摘要，`__tsEditor.crashLog()` 与诊断报告都读它。 */
    crashLog: [],
    /** 最近 30 步用户动作：崩溃报告里能看出「白屏前一下干了什么」。 */
    breadcrumbs: [],
  }

  var els = {}

  /** @param {string} id - 元素 id。 @returns {HTMLElement | null} 元素。 */
  function $(id) {
    return document.getElementById(id)
  }

  /** @param {string} text - 状态文案。 @param {string} [tone] - ok | error。 */
  function status(text, tone) {
    if (!els.status) return
    els.status.textContent = text
    if (tone === 'ok' || tone === 'error') els.status.setAttribute('data-tone', tone)
    else els.status.removeAttribute('data-tone')
  }

  /** 给父页面报一声（不影响独立打开）。 */
  function ping(kind) {
    try {
      if (window.parent && window.parent !== window) {
        window.parent.postMessage({ __ts: kind, id: state.id }, '*')
      }
    } catch (error) {
      /* 父页面不在也没关系 */
    }
  }

  /**
   * 向 host 报一声状态：编辑器页真的加载了、真的画出了网格。
   *
   * 这一步在 iframe 里执行，所以它同时也是「同源凭据在 iframe 里能不能用」的探针：
   * 报得上去，说明 `/api/*` 在画布里是通的。
   * @param {string} kind - editor / grid / editor-error。
   * @param {Record<string, unknown>} [extra] - 附加字段。
   * @returns {void}
   */
  function report(kind, extra) {
    try {
      fetch(API + '/boot', {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'content-type': 'application/json' },
        // 不带 version：这个字段归客户端 bundle 的版本所有，编辑器页别去覆盖它。
        body: JSON.stringify({ kind: kind, ...(extra || {}) }),
      }).catch(function () {})
    } catch (error) {
      /* 报不上去也不算失败 */
    }
  }

  /**
   * 崩溃信标：编辑器页里发生的事故写进 `$DSH_HOME/table-studio/note-*.json`。
   *
   * 画布里没有控制台可看，白屏时用户也描述不出堆栈；把「哪一步、什么错、当时
   * 网格长什么样」落成文件，是这一页唯一靠谱的取证方式（同 `/api/boot` 的
   * 事件流一起看：后者记「发生了」，前者记「为什么」）。
   * @param {string} kind - 事故类别，如 grid-render / window-error / grid-blank。
   * @param {unknown} reason - Error、字符串或任意抛出物。
   * @param {Record<string, unknown>} [extra] - 附加现场信息。
   * @returns {void}
   */
  function reportCrash(kind, reason, extra) {
    var error = reason && typeof reason === 'object' ? reason : null
    var message = error !== null && typeof error.message === 'string'
      ? error.message
      : String(reason === undefined || reason === null ? '' : reason)
    var stack = error !== null && typeof error.stack === 'string' ? error.stack.slice(0, 4000) : ''
    var entry = {
      kind: kind,
      at: new Date().toISOString(),
      message: message.slice(0, 600),
      stack: stack,
      doc: state.id,
      grid: state.grid,
      rows: state.fsSheets !== null && Array.isArray(state.fsSheets) ? state.fsSheets.length : 0,
      extra: extra || {},
      breadcrumbs: state.breadcrumbs.slice(-30),
    }
    state.crashes += 1
    if (state.crashLog.length < 12) state.crashLog.push(entry)
    // 事件流里留一条（`client.json` 的 last / events 能直接看到），摘要压到 160 字。
    try {
      report('editor-crash', { id: state.id, note: kind + ': ' + message.slice(0, 120) })
    } catch (ignored) { /* 报不上去也不影响抢救 */ }
    if (state.crashes > 6) return
    try {
      request('/note', {
        method: 'POST',
        body: Object.assign({ kind: 'editor-crash', phase: kind, ua: navigator.userAgent }, entry, extra || {}),
      }).catch(function () {})
    } catch (ignored) { /* 同上 */ }
  }

  /**
   * 记一步用户动作（只留最近 30 步）。
   *
   * 崩溃报告只有堆栈还不够：白屏前那一下是复制、粘贴还是插入，往往才是线索。
   * 这些步骤随崩溃一起写进 note 文件，事后不用再问用户「你按了什么」。
   * @param {string} kind - 动作名，如 copy / paste / insert / save / heal。
   * @param {Record<string, unknown>} [extra] - 附加字段。
   * @returns {void}
   */
  function breadcrumb(kind, extra) {
    try {
      state.breadcrumbs.push(Object.assign({ at: new Date().toISOString(), kind: kind }, extra || {}))
      if (state.breadcrumbs.length > 30) state.breadcrumbs.shift()
    } catch (error) {
      /* 记不上算了，别为日志再抛错 */
    }
  }

  /**
   * 同源请求。
   * @param {string} path - 相对 API 的路径。
   * @param {RequestInit} [init] - fetch 选项。
   * @returns {Promise<any>} JSON。
   */
  function request(path, init) {
    var options = Object.assign({ credentials: 'same-origin' }, init || {})
    if (options.body !== undefined && typeof options.body !== 'string') {
      options.headers = Object.assign({ 'content-type': 'application/json' }, options.headers || {})
      options.body = JSON.stringify(options.body)
    }
    return fetch(API + path, options).then(function (response) {
      return response.json().catch(function () {
        return { ok: false, code: 'bad-json', message: '服务端返回的不是 JSON（HTTP ' + response.status + '）' }
      })
    })
  }

  /** 单元格转文本。 */
  function cell(value) {
    if (value === null || value === undefined) return ''
    return String(value)
  }

  /** 取列名：A、B … Z、AA。 */
  function columnName(index) {
    var name = ''
    var n = index
    while (n >= 0) {
      name = String.fromCharCode(65 + (n % 26)) + name
      n = Math.floor(n / 26) - 1
    }
    return name
  }

  /**
   * fortune-sheet 的 sheets → 二维字符串矩阵（只认第一张）。
   *
   * 它的单元格是 `{r, c, v: {v, m}}`（稀疏），也可能给 `data` 的二维数组；
   * 两种都认，认不出就返回 null，让上层退回自己手里的 columns/rows。
   * @param {any} sheets - onChange / getAllSheets 给的工作表数组。
   * @returns {string[][] | null} 矩阵。
   */
  function sheetsToMatrix(sheets) {
    if (!Array.isArray(sheets) || sheets.length === 0) return null
    var sheet = sheets[0] || {}
    if (Array.isArray(sheet.celldata) && sheet.celldata.length > 0) {
      var maxRow = -1
      var maxCol = -1
      for (var i = 0; i < sheet.celldata.length; i += 1) {
        var at = sheet.celldata[i]
        if (!at) continue
        maxRow = Math.max(maxRow, Number(at.r) || 0)
        maxCol = Math.max(maxCol, Number(at.c) || 0)
      }
      if (maxRow < 0 || maxCol < 0) return null
      // 数据面限额跟宿主一致：一次粘贴 / 一格脏数据把 r 写成 999999 时，
      // 原样铺开会分配上百万个字符串（每次算形状都要重铺），轻则卡死、重则白屏。
      maxRow = Math.min(maxRow, MAX_MATRIX_ROWS - 1)
      maxCol = Math.min(maxCol, MAX_MATRIX_COLS - 1)
      var grid = []
      for (var r = 0; r <= maxRow; r += 1) {
        var row = []
        for (var c = 0; c <= maxCol; c += 1) row.push('')
        grid.push(row)
      }
      for (var k = 0; k < sheet.celldata.length; k += 1) {
        var item = sheet.celldata[k]
        if (!item) continue
        if ((Number(item.r) || 0) > maxRow || (Number(item.c) || 0) > maxCol) continue
        var value = item.v
        var text = value !== null && typeof value === 'object'
          ? (value.m !== undefined && value.m !== null ? value.m : value.v)
          : value
        grid[Number(item.r) || 0][Number(item.c) || 0] = text === null || text === undefined ? '' : String(text)
      }
      return grid
    }
    if (Array.isArray(sheet.data)) {
      return sheet.data.map(function (line) {
        return (Array.isArray(line) ? line : []).map(function (item) {
          if (item === null || item === undefined) return ''
          if (typeof item === 'object') {
            if (item.m !== undefined && item.m !== null) return String(item.m)
            if (item.v !== undefined && item.v !== null) return String(item.v)
            return ''
          }
          return String(item)
        })
      })
    }
    return null
  }

  /**
   * 二维矩阵 → fortune-sheet 的稀疏 celldata（空字符串不落格，省体量）。
   * @param {string[][]} grid - 矩阵。
   * @returns {Array<{r: number, c: number, v: {v: string, m: string, ct: {fa: string, t: string}}}>} celldata。
   */
  function matrixToCelldata(grid) {
    var cells = []
    for (var r = 0; r < grid.length; r += 1) {
      var row = grid[r] || []
      for (var c = 0; c < row.length; c += 1) {
        var text = row[c] === null || row[c] === undefined ? '' : String(row[c])
        if (text === '') continue
        cells.push({ r: r, c: c, v: { v: text, m: text, ct: { fa: 'General', t: 's' } } })
      }
    }
    return cells
  }

  /** 文档里的 columns/rows 拼成矩阵（含表头行）。 */
  function baseMatrix() {
    return [state.columns.slice()].concat(state.rows.map(function (row) { return row.slice() }))
  }

  /**
   * 二维单元格数组 → fortune-sheet 的稀疏 celldata。
   *
   * 和 `matrixToCelldata` 的区别：这里**保留整份单元格对象**（`ct` 格式、
   * `bl` 加粗、`fc` 字色、`mc` 合并……），不是只留文本。编辑器保存时用它
   * 把 fortune 内部的 `data` 压回可落盘的 `celldata`，格式才不会丢。
   * @param {any[][]} rows - 单元格对象或原始值的二维数组。
   * @returns {Array<{r: number, c: number, v: any}>} celldata。
   */
  function dataToCelldata(rows) {
    var cells = []
    if (!Array.isArray(rows)) return cells
    for (var r = 0; r < rows.length; r += 1) {
      var row = rows[r]
      if (!Array.isArray(row)) continue
      for (var c = 0; c < row.length; c += 1) {
        var value = row[c]
        if (value === null || value === undefined || value === '') continue
        if (typeof value === 'object') {
          if (Array.isArray(value) || Object.keys(value).length === 0) continue
          cells.push({ r: r, c: c, v: value })
          continue
        }
        var text = String(value)
        if (text === '') continue
        cells.push({ r: r, c: c, v: { v: text, m: text, ct: { fa: 'General', t: 's' } } })
      }
    }
    return cells
  }

  /**
   * 一张工作表压成可落盘的形状：只留「重开时能还原」的字段。
   *
   * fortune 交回来的工作表带着一大票运行时状态（选区、公式缓存、撤销信息…），
   * 原样存会让一张 20 格的小表写到几十 KB，行数一多就撞上 8MB 上限。
   * @param {any} sheet - fortune 的工作表对象。
   * @returns {any | null} 压缩后的工作表；认不出来给 null。
   */
  function compactSheet(sheet) {
    if (!sheet || typeof sheet !== 'object' || Array.isArray(sheet)) return null
    var cells = null
    if (Array.isArray(sheet.celldata)) cells = sheet.celldata
    else if (Array.isArray(sheet.data)) cells = dataToCelldata(sheet.data)
    if (cells === null) return null
    var out = {
      name: typeof sheet.name === 'string' && sheet.name.trim() !== '' ? sheet.name : 'Sheet',
      order: typeof sheet.order === 'number' ? sheet.order : 0,
      status: sheet.status === 1 ? 1 : 0,
      row: typeof sheet.row === 'number' && sheet.row > 0 ? sheet.row : 30,
      column: typeof sheet.column === 'number' && sheet.column > 0 ? sheet.column : 12,
      defaultColWidth: typeof sheet.defaultColWidth === 'number' ? sheet.defaultColWidth : 110,
      defaultRowHeight: typeof sheet.defaultRowHeight === 'number' ? sheet.defaultRowHeight : 26,
      config: sheet.config && typeof sheet.config === 'object' ? sheet.config : {},
      celldata: cells,
    }
    var extra = [
      'frozen', 'images', 'showGridLines', 'zoomRatio', 'hide', 'addRows',
      'luckysheet_conditionformat_save', 'luckysheet_filter_save',
      'luckysheet_alternateformat_save', 'dataVerification', 'hyperlink',
      'filter_select', 'filter',
    ]
    for (var i = 0; i < extra.length; i += 1) {
      var key = extra[i]
      if (sheet[key] !== undefined) out[key] = sheet[key]
    }
    return out
  }

  /**
   * 当前所有工作表 → 可落盘数组。优先问组件要（它手里是最新 `data`），
   * 拿不到再用最后一次 onChange 的副本。
   * @returns {any[]} 工作表数组。
   */
  function compactSheets() {
    /** @type {any} */
    var live = null
    var ref = state.fsRef
    if (ref !== null && ref !== undefined && ref.current && typeof ref.current.getAllSheets === 'function') {
      try {
        live = ref.current.getAllSheets()
      } catch (error) {
        live = null
      }
    }
    if (!Array.isArray(live) || live.length === 0) live = state.fsSheets
    if (!Array.isArray(live) || live.length === 0) return []
    var out = []
    for (var i = 0; i < live.length; i += 1) {
      var sheet = compactSheet(live[i])
      if (sheet !== null) out.push(sheet)
    }
    // 用户显式插出来的尾部空白行/列：记在首张表上，重开时照数补回。
    // （数据面本身对尾部空白是裁剪的，光靠 columns/rows 分不清「组件备用区」
    //   和「用户右键插出来的空行」。）
    if (out.length > 0) out[0].tsExtra = { rows: state.extraRows, cols: state.extraCols }
    return out
  }

  /** 当前网格的矩阵（含表头行），并补齐矩形。 */
  function matrix() {
    if (state.grid === 'fortune') {
      var fromFortune = sheetsToMatrix(state.fsSheets)
      if (fromFortune !== null) return fromFortune
      return baseMatrix()
    }
    if (state.ws === null || typeof state.ws.getData !== 'function') {
      return baseMatrix()
    }
    var data = state.ws.getData().map(function (row) {
      return (Array.isArray(row) ? row : []).map(cell)
    })
    var width = 3
    for (var r = 0; r < data.length; r += 1) width = Math.max(width, data[r].length)
    for (var i = 0; i < data.length; i += 1) {
      while (data[i].length < width) data[i].push('')
    }
    return data
  }

  /** 第一张工作表的矩阵：fortune 数据优先，其次文档值。 */
  function firstSheetMatrix() {
    var fromSaved = sheetsToMatrix(state.sheets)
    if (fromSaved !== null) return fromSaved
    return baseMatrix()
  }

  /**
   * 矩阵 → `{columns, rows}`。这是「哪一行是表头」的唯一裁决处。
   *
   * 表头 = **第一条有内容的行**：支持在表头上方插了空行（Excel 右键「向上插入
   * 行」）后仍把原表头认出来；否则列名会全变成「列1、列2…」，原表头跌进数据。
   * 同理，整列全空的左侧列（在 A 列左边插列）不参与列名与数据。
   *
   * 尾部的整行/整列空白仍然裁掉——那是网格组件补的备用区，不是用户数据；
   * 但夹在数据中间的空白行列保留（用户可能就是插了空行做间隔）。
   * @param {string[][]} data - 含表头行在内的矩阵。
   * @returns {{ columns: string[], rows: string[][] }} 表。
   */
  function shapeFromMatrix(data) {
    var source = Array.isArray(data) && data.length > 0 ? data : [['列1', '列2', '列3']]
    // 表头索引：第一条有内容的行。
    var headIndex = 0
    for (var r = 0; r < source.length; r += 1) {
      var row = Array.isArray(source[r]) ? source[r] : []
      if (row.some(function (value) { return cell(value).trim() !== '' })) {
        headIndex = r
        break
      }
    }
    var body = source.slice(headIndex)
    var head = body[0] || []
    // 左侧整列空白：在 A 列左边插列后，这些列没有名字也没有数据，不算真列。
    var begin = 0
    while (begin < head.length - 1) {
      var leftBlank = body.every(function (line) {
        return cell((Array.isArray(line) ? line : [])[begin]).trim() === ''
      })
      if (leftBlank !== true) break
      begin += 1
    }
    // 尾部整列空白：网格的 minDimensions 会补出备用列，不能把它当成真列存回去。
    var width = head.length
    while (width > begin + 1) {
      var index = width - 1
      var blank = cell(head[index]).trim() === '' && body.every(function (line) {
        return cell((Array.isArray(line) ? line : [])[index]).trim() === ''
      })
      if (blank !== true) break
      width -= 1
    }
    var columns = head.slice(begin, width).map(function (name, position) {
      var text = cell(name).trim()
      return text === '' ? '列' + (position + 1) : text
    })
    var end = body.length
    while (end > 1 && body[end - 1].every(function (value) { return cell(value).trim() === '' })) end -= 1
    var rows = body.slice(1, end).map(function (line) {
      var row = Array.isArray(line) ? line : []
      return row.slice(begin, width)
    })
    return { columns: columns, rows: rows }
  }

  /**
   * 给表格补上用户「显式插入」的多余空白行/列。
   *
   * shapeFromMatrix 会裁掉尾部空白——网格组件补的备用区确实不该进文档；
   * 但用户右键「向下插入行 / 向右插入列」明确要的空行空列必须留下，否则
   * 插到表格末尾会「看起来没生效」。两者靠 state.extraRows/extraCols 区分，
   * 计数由 trackTrailingExtension 从画布尺寸变化里认出来。
   * @param {{ columns: string[], rows: string[][] }} base - 裁掉尾部空白后的表格。
   * @param {number} extraRows - 要补在尾部的空白行数。
   * @param {number} extraCols - 要补在尾部的空白列数。
   * @returns {{ columns: string[], rows: string[][] }} 补过空白的表格。
   */
  function padShape(base, extraRows, extraCols) {
    var columns = Array.isArray(base.columns) ? base.columns.slice() : []
    var rows = Array.isArray(base.rows)
      ? base.rows.map(function (row) { return Array.isArray(row) ? row.slice() : [] })
      : []
    var padCols = Math.max(0, Math.floor(Number(extraCols) || 0))
    var padRows = Math.max(0, Math.floor(Number(extraRows) || 0))
    for (var c = 0; c < padCols; c += 1) columns.push('列' + (columns.length + 1))
    for (var r = 0; r < rows.length; r += 1) {
      while (rows[r].length < columns.length) rows[r].push('')
    }
    for (var i = 0; i < padRows; i += 1) {
      var blank = []
      for (var j = 0; j < columns.length; j += 1) blank.push('')
      rows.push(blank)
    }
    return { columns: columns, rows: rows }
  }

  /** 数矩阵尾部有多少整行空白。 @param {string[][]} rows - 行矩阵。 @returns {number} 尾部空行数。 */
  function countTrailingBlankRows(rows) {
    if (!Array.isArray(rows)) return 0
    var count = 0
    for (var r = rows.length - 1; r >= 0; r -= 1) {
      var line = Array.isArray(rows[r]) ? rows[r] : []
      if (line.some(function (value) { return cell(value).trim() !== '' })) break
      count += 1
    }
    return count
  }

  /**
   * 数表格尾部有多少整列空白（表头与整列数据都空）。
   * @param {string[]} columns - 列名。
   * @param {string[][]} rows - 行数据。
   * @returns {number} 尾部空列数。
   */
  function countTrailingBlankColumns(columns, rows) {
    if (!Array.isArray(columns) || columns.length === 0) return 0
    var body = Array.isArray(rows) ? rows : []
    var count = 0
    for (var c = columns.length - 1; c >= 0; c -= 1) {
      var blank = cell(columns[c]).trim() === '' && body.every(function (row) {
        return cell((Array.isArray(row) ? row : [])[c]).trim() === ''
      })
      if (blank !== true) break
      count += 1
    }
    return count
  }

  /**
   * 一张工作表的内容指纹：只看「有内容的格子」在哪些坐标、是什么值。
   *
   * 插入行/列只动画布尺寸、不挪内容（插在表格末尾时），指纹不变；
   * 插在中间会把内容整体挪位，指纹就变了。
   * @param {any} sheet - fortune 的一张工作表。
   * @returns {{ signature: string, rowCount: number, colCount: number, cells: Record<string, string> }} 指纹。
   */
  function sheetContentInfo(sheet) {
    var info = { signature: '', rowCount: 0, colCount: 0, cells: {} }
    var grid = sheetsToMatrix([sheet])
    if (grid === null) return info
    var parts = []
    for (var r = 0; r < grid.length; r += 1) {
      var line = Array.isArray(grid[r]) ? grid[r] : []
      for (var c = 0; c < line.length; c += 1) {
        var text = cell(line[c]).trim()
        if (text === '') continue
        var key = r + ':' + c
        info.cells[key] = text
        parts.push(key + '=' + text)
        if (r + 1 > info.rowCount) info.rowCount = r + 1
        if (c + 1 > info.colCount) info.colCount = c + 1
      }
    }
    parts.sort()
    info.signature = parts.join('|')
    return info
  }

  /**
   * 从 onChange 前后两张表的差异里，认出用户「显式插到末尾的空白行/列」。
   *
   * 判据：内容指纹一模一样、只是画布 row/column 变大 → 插的是表格尾部空白，
   * 记进 extraRows/extraCols（保存时补回数据面）；插在中间会挪动内容，不算。
   * 反过来，用户往这些空行里打字后内容区变大，就把计数减掉，避免重复补。
   * @param {any[] | null} before - 改动前的工作表数组。
   * @param {any[] | null} after - 改动后的工作表数组。
   * @returns {void}
   */
  function trackTrailingExtension(before, after) {
    if (!Array.isArray(before) || !Array.isArray(after) || before.length === 0 || after.length === 0) return
    var oldSheet = before[0]
    var newSheet = after[0]
    if (!oldSheet || !newSheet || typeof oldSheet !== 'object' || typeof newSheet !== 'object') return
    var oldInfo = sheetContentInfo(oldSheet)
    var newInfo = sheetContentInfo(newSheet)
    if (oldInfo.signature === newInfo.signature) {
      var dr = Number(newSheet.row) - Number(oldSheet.row)
      if (Number.isFinite(dr) && dr !== 0) state.extraRows = Math.max(0, state.extraRows + dr)
      var dc = Number(newSheet.column) - Number(oldSheet.column)
      if (Number.isFinite(dc) && dc !== 0) state.extraCols = Math.max(0, state.extraCols + dc)
      return
    }
    // 内容变了：若是「原有格子都在、只是尾部多了内容」（用户往补出来的空行里打字），
    // 就把对应的补白计数减掉；中间插入会把原格子挪走，不满足这个条件，不动计数。
    var pureGrow = true
    var oldKeys = Object.keys(oldInfo.cells)
    for (var i = 0; i < oldKeys.length; i += 1) {
      var key = oldKeys[i]
      if (newInfo.cells[key] !== oldInfo.cells[key]) { pureGrow = false; break }
    }
    if (pureGrow !== true) return
    var grewRows = newInfo.rowCount - oldInfo.rowCount
    if (grewRows > 0) state.extraRows = Math.max(0, state.extraRows - grewRows)
    var grewCols = newInfo.colCount - oldInfo.colCount
    if (grewCols > 0) state.extraCols = Math.max(0, state.extraCols - grewCols)
  }
  /** 从当前网格拆出 columns + rows（裁掉表头上方/左侧与尾部空白，再补回用户显式插入的空白）。 */
  function shape() {
    return padShape(shapeFromMatrix(matrix()), state.extraRows, state.extraCols)
  }

  /** 表角标。 */
  function renderShape() {
    var current = shape()
    if (els.shape === null || els.shape === undefined) return
    var note = ''
    if (state.extraRows > 0 || state.extraCols > 0) {
      var bits = []
      if (state.extraRows > 0) bits.push(state.extraRows + ' 行空白')
      if (state.extraCols > 0) bits.push(state.extraCols + ' 列空白')
      // 尾部空白是用户右键插出来的、会随文档保存，明说出来免得以为没生效。
      note = '（尾部 ' + bits.join(' · ') + '）'
    }
    els.shape.textContent = current.columns.length + ' 列 × ' + current.rows.length + ' 行' + note
  }

  /** 表角标去抖：5000 行的表每敲一个字都重铺一遍矩阵，手感会变得很糟。 */
  var shapeTimer = 0
  function scheduleShape() {
    if (shapeTimer) clearTimeout(shapeTimer)
    shapeTimer = setTimeout(function () {
      shapeTimer = 0
      renderShape()
    }, 180)
  }

  /** 标脏 + 排一次去抖保存。 */
  function touch() {
    state.dirty = true
    status('未保存的改动…')
    scheduleShape()
    ping('dirty')
    if (state.timer) clearTimeout(state.timer)
    state.timer = setTimeout(function () {
      state.timer = 0
      save()
    }, 1200)
  }

  /**
   * 要交给服务端的工作表数据。
   *
   * 三态跟 doc API 对齐：数组=替换、null=清掉、undefined=没这东西不动。
   * 只有 fortune 画出来时才有原样数据；jspreadsheet 退路只存纯值。
   * @returns {any[] | null | undefined} 工作表数组。
   */
  function sheetsPayload() {
    if (state.grid !== 'fortune') return undefined
    var sheets = compactSheets()
    if (sheets.length === 0) return undefined
    try {
      var text = JSON.stringify(sheets)
      // 超过 4MB 的表已经不适合当「格式附件」：宁可只留值，也不让每次保存都拖几十兆。
      if (text.length > 4 * 1024 * 1024) return null
    } catch (error) {
      return null
    }
    return sheets
  }

  /** 保存到服务端。 */
  function save() {
    if (state.id === '' || state.saving) return Promise.resolve(false)
    var current = shape()
    var title = els.title && els.title.value.trim() !== '' ? els.title.value.trim() : '表格'
    var sheets = sheetsPayload()
    var serialized = JSON.stringify({
      title: title,
      columns: current.columns,
      rows: current.rows,
      sheets: sheets === undefined ? null : sheets,
    })
    if (serialized === state.lastSaved && state.dirty === false) {
      status('没有改动', 'ok')
      return Promise.resolve(true)
    }
    var body = { title: title, columns: current.columns, rows: current.rows, sessionId: state.sessionId }
    if (sheets !== undefined) body.sheets = sheets
    state.saving = true
    breadcrumb('save', { rows: current.rows.length, columns: current.columns.length, sheets: Array.isArray(sheets) })
    if (els.save) els.save.disabled = true
    status('保存中…')
    return request('/doc/' + encodeURIComponent(state.id), {
      method: 'POST',
      body: body,
    }).then(function (result) {
      state.saving = false
      if (els.save) els.save.disabled = false
      if (!result || result.ok !== true) {
        status('保存失败：' + ((result && (result.message || result.code)) || '未知错误'), 'error')
        report('editor-error', { id: state.id, note: String((result && (result.message || result.code)) || 'save-failed') })
        return false
      }
      state.dirty = false
      state.lastSaved = serialized
      state.title = title
      if (Array.isArray(sheets)) state.sheets = sheets
      else if (sheets === null) state.sheets = null
      // 服务端盖的新时间戳要收下：否则 followRemote 会把「自己刚存的」当成
      // 「模型侧又改了」，4 秒后重载一遍，把用户的选择和撤销栈冲掉。
      if (typeof result.updatedAt === 'string' && result.updatedAt !== '') state.updatedAt = result.updatedAt
      status('已保存 · ' + new Date().toLocaleTimeString('zh-CN', { hour12: false }), 'ok')
      ping('saved')
      return true
    }).catch(function (error) {
      state.saving = false
      if (els.save) els.save.disabled = false
      status('保存失败：' + (error && error.message ? error.message : String(error)), 'error')
      return false
    })
  }

  /**
   * 找出矩阵里第一条有内容的行、第一个有内容的列。
   *
   * 用来把「在表头上方插了空行 / 在 A 列左边插了空列」的表格拉回 A1：
   * 数据面已经把表头之前的空白裁掉了，画布也得跟着对齐，否则重开后表头上方
   * 会多出一行空行，看着像插入失败。
   * @param {string[][]} matrix - 矩阵。
   * @returns {{ row: number, col: number }} 偏移量（没有内容时为 0）。
   */
  function firstContentOffset(matrix) {
    if (!Array.isArray(matrix) || matrix.length === 0) return { row: 0, col: 0 }
    var test = function (value) { return value !== null && value !== undefined && String(value).trim() !== '' }
    var row = -1
    var col = -1
    for (var r = 0; r < matrix.length; r += 1) {
      var line = Array.isArray(matrix[r]) ? matrix[r] : []
      for (var c = 0; c < line.length; c += 1) {
        if (test(line[c]) !== true) continue
        if (row < 0 || r < row) row = r
        if (col < 0 || c < col) col = c
      }
    }
    return { row: row < 0 ? 0 : row, col: col < 0 ? 0 : col }
  }

  /**
   * 把索引表的键整体左移/上移（列宽、行高用的是 0 基索引）。
   * @param {Record<string, any>} source - 原索引表。
   * @param {number} offset - 要减掉的偏移量。
   * @returns {Record<string, any>} 新索引表。
   */
  function shiftKeyed(source, offset) {
    var out = {}
    if (offset === 0 || !source || typeof source !== 'object') return Object.assign(out, source ?? {})
    for (var key of Object.keys(source)) {
      var index = Number(key)
      if (!Number.isFinite(index) || index < offset) continue
      out[index - offset] = source[key]
    }
    return out
  }

  /**
   * 把一张工作表整体上移/左移，让表头回到 A1。
   *
   * 单元格对象原样搬走（加粗、字色这些都还在）；列宽/行高/合并格跟着改键。
   * 边框、条件格式、筛选这些带绝对坐标的配置在平移后无法可靠还原，直接去掉：
   * 宁可少一层装饰，也不能让它画到错位的格子上。
   * @param {any} sheet - sheetsForRender 组装好的工作表。
   * @param {{ row: number, col: number }} offset - 偏移量。
   * @returns {any} 同一张工作表（就地修改后返回）。
   */
  function shiftSheetBy(sheet, offset) {
    if (offset.row === 0 && offset.col === 0) return sheet
    var cells = []
    var source = Array.isArray(sheet.celldata) ? sheet.celldata : []
    for (var i = 0; i < source.length; i += 1) {
      var at = source[i]
      if (!at) continue
      var r = Number(at.r) - offset.row
      var c = Number(at.c) - offset.col
      if (r < 0 || c < 0) continue
      cells.push({ r: r, c: c, v: at.v })
    }
    sheet.celldata = cells
    var config = sheet.config && typeof sheet.config === 'object' ? Object.assign({}, sheet.config) : {}
    config.columnlen = shiftKeyed(config.columnlen, offset.col)
    config.rowlen = shiftKeyed(config.rowlen, offset.row)
    if (config.merge && typeof config.merge === 'object') {
      var merge = {}
      for (var key of Object.keys(config.merge)) {
        var parts = String(key).split('_')
        var mr = Number(parts[0]) - offset.row
        var mc = Number(parts[1]) - offset.col
        if (!Number.isFinite(mr) || !Number.isFinite(mc) || mr < 0 || mc < 0) continue
        merge[`${mr}_${mc}`] = config.merge[key]
      }
      config.merge = merge
    }
    delete config.borderInfo
    sheet.config = config
    delete sheet.frozen
    delete sheet.luckysheet_conditionformat_save
    delete sheet.luckysheet_filter_save
    delete sheet.luckysheet_alternateformat_save
    delete sheet.filter_select
    delete sheet.filter
    return sheet
  }

  /**
   * 把服务端存的工作表数据收成 fortune 能吃的形状。
   *
   * 老文档没有这个字段，就按 columns/rows 现造一张；只要有一张认不出来，
   * 就整份退回纯值——半套格式比没有格式更容易让人以为数据丢了。
   * @param {any[] | null} raw - doc.sheets。
   * @returns {any[]} 工作表数组。
   */
  function sheetsForRender(raw) {
    if (!Array.isArray(raw) || raw.length === 0) return [freshSheet()]
    var out = []
    var active = -1
    for (var i = 0; i < raw.length; i += 1) {
      var item = raw[i]
      if (!item || typeof item !== 'object' || Array.isArray(item)) return [freshSheet()]
      var matrix = sheetsToMatrix([item])
      var cells = null
      if (Array.isArray(item.celldata)) cells = item.celldata
      else if (Array.isArray(item.data)) cells = dataToCelldata(item.data)
      if (cells === null) return [freshSheet()]
      var sheet = {
        name: typeof item.name === 'string' && item.name.trim() !== '' ? item.name : 'Sheet' + (i + 1),
        order: typeof item.order === 'number' ? item.order : i,
        status: item.status === 1 ? 1 : 0,
        row: typeof item.row === 'number' && item.row > 0 ? item.row : Math.max(30, matrix === null ? 30 : matrix.length + 12),
        column: typeof item.column === 'number' && item.column > 0
          ? item.column
          : Math.max(8, matrix === null ? 8 : matrix[0].length + 4),
        defaultColWidth: typeof item.defaultColWidth === 'number' ? item.defaultColWidth : 110,
        defaultRowHeight: typeof item.defaultRowHeight === 'number' ? item.defaultRowHeight : 26,
        config: item.config && typeof item.config === 'object' ? item.config : {},
        celldata: cells,
      }
      // 冻结、图片、筛选、条件格式这些「附件」原样带回；漏一个，用户重开就白设了。
      var extras = [
        'frozen', 'images', 'showGridLines', 'zoomRatio', 'hide', 'addRows',
        'luckysheet_conditionformat_save', 'luckysheet_filter_save',
        'luckysheet_alternateformat_save', 'dataVerification', 'hyperlink',
        'filter_select', 'filter', 'tsExtra',
      ]
      for (var k = 0; k < extras.length; k += 1) {
        if (item[extras[k]] !== undefined) sheet[extras[k]] = item[extras[k]]
      }
      if (active < 0 && sheet.status === 1) active = out.length
      out.push(sheet)
    }
    if (active !== 0) {
      for (var j = 0; j < out.length; j += 1) out[j].status = j === 0 ? 1 : 0
    }
    // 表头必须在 A1：首表若被「向上插入行 / 向左插入列」顶到了第二行/第二列，
    // 数据面（columns/rows）已经裁掉前导空白，画布也拉回 A1——否则重开之后
    // 表头上方多一行空行，看着就像插入没生效。
    if (out.length > 0) {
      var firstMatrix = sheetsToMatrix([out[0]])
      if (firstMatrix !== null) shiftSheetBy(out[0], firstContentOffset(firstMatrix))
    }
    return out
  }

  /** 按文档值现造一张工作表。 */
  function freshSheet() {
    var data = baseMatrix()
    var widths = columnWidths(data, Math.max(1, state.columns.length))
    var columnlen = {}
    for (var i = 0; i < widths.length; i += 1) columnlen[i] = widths[i].width
    return {
      name: '表格',
      celldata: matrixToCelldata(data),
      config: { columnlen: columnlen, rowlen: { 0: 30 } },
      order: 0,
      status: 1,
      row: Math.max(30, data.length + 12),
      column: Math.max(8, state.columns.length + 4),
      defaultColWidth: 110,
      defaultRowHeight: 26,
    }
  }

  // ── 网格抢救：白屏不交给用户 ──────────────────────────────────────────────

  /** error boundary 的类只建一次（每次新建类会让 React 当成另一种组件、整棵重挂）。 */
  var boundaryClass = null

  /**
   * 造（或复用）fortune 的 error boundary。
   *
   * fortune 是 React 树：渲染里抛一次错，React 18 会把整棵树卸掉，页面只剩一块白。
   * 有了 boundary，抛错只换成一个「重建网格」面板，并且前两次自动重挂——多数崩溃是
   * 「某次粘贴 / 插入把工作表塞成畸形」，重挂能顺手把用户救回来。
   * @param {any} FS - window.__FS（含 React）。
   * @returns {any} React 组件类。
   */
  function gridBoundary(FS) {
    if (boundaryClass !== null) return boundaryClass
    var React = FS.React
    boundaryClass = class GridBoundary extends React.Component {
      constructor(props) {
        super(props)
        this.state = { failed: false }
      }

      static getDerivedStateFromError() {
        return { failed: true }
      }

      componentDidCatch(error, info) {
        var componentStack = info && typeof info.componentStack === 'string' ? info.componentStack.slice(0, 1500) : ''
        reportCrash('grid-render', error, { componentStack: componentStack })
        if (state.healAttempts < 2) setTimeout(function () { healGrid('render-error') }, 400)
      }

      render() {
        if (this.state.failed !== true) return this.props.children
        return React.createElement('div', { className: 'ts-fallback' },
          React.createElement('div', { className: 'ts-fallback-title' }, '表格渲染出错了'),
          React.createElement('div', { className: 'ts-fallback-text' },
            '错误已记录，数据还在。点「重建网格」重新画一遍；还不行就点「只保留纯值」（丢掉格式与多表，只留单元格内容）。'),
          React.createElement('div', { className: 'ts-fallback-actions' },
            React.createElement('button', { type: 'button', className: 'ts-btn ts-btn-primary', onClick: function () { healGrid('manual') } }, '重建网格'),
            React.createElement('button', { type: 'button', className: 'ts-btn', onClick: function () { dropFormats() } }, '只保留纯值'),
          ),
        )
      }
    }
    return boundaryClass
  }

  /** 丢掉格式附件，只按单元格值重建网格（最后的退路）。 */
  function dropFormats() {
    reportCrash('drop-formats', 'user-dropped-sheets')
    state.sheets = null
    state.fsSheets = null
    healGrid('drop-formats')
  }

  /**
   * 重建网格：从「上一份可用的工作表 / 文档值」重新画一遍。
   * @param {string} reason - 触发原因（写进日志）。
   * @returns {boolean} 是否重建成功。
   */
  function healGrid(reason) {
    if (state.healing === true) return false
    state.healing = true
    state.healAttempts += 1
    breadcrumb('heal', { reason: reason, attempts: state.healAttempts })
    try {
      if (state.fsRoot !== null && typeof state.fsRoot.unmount === 'function') state.fsRoot.unmount()
    } catch (error) {
      /* 卸不掉也继续 */
    }
    state.fsRoot = null
    state.fsRef = null
    try {
      // fortune 的「复制」会往 React 容器里塞一个 #fortune-copy-content；
      // 重挂之前清掉，免得新旧两棵树为它打架。
      var stale = document.getElementById('fortune-copy-content')
      if (stale !== null && stale.parentNode !== null) stale.parentNode.removeChild(stale)
    } catch (error) {
      /* 清不掉也不影响重挂 */
    }
    try {
      state.grid = ''
      renderGrid()
      status('网格已重建（' + reason + '）', 'ok')
      return true
    } catch (error) {
      reportCrash('heal-failed', error, { reason: reason })
      status('网格重建失败：' + (error && error.message ? error.message : String(error)), 'error')
      return false
    } finally {
      setTimeout(function () {
        state.healing = false
        state.blankTicks = 0
      }, 1500)
    }
  }

  /**
   * 看门狗：网格整个不见了（白板）就重建。
   *
   * 白板可能来自 React 卸树、也可能来自组件自己画不出来；用户没法自救，
   * 所以这里一秒看一眼，连续两次都空才动手（一次可能只是重的中间态）。
   * @returns {void}
   */
  function watchGrid() {
    if (state.grid !== 'fortune' || state.healing === true || !els.sheet) return
    var alive = els.sheet.querySelector('.fortune-container') !== null && els.sheet.querySelector('canvas') !== null
    if (alive) {
      state.blankTicks = 0
      return
    }
    state.blankTicks += 1
    if (state.blankTicks < 2 || state.healAttempts >= 3) return
    reportCrash('grid-blank', 'grid disappeared', { healAttempts: state.healAttempts })
    healGrid('blank')
  }

  /**
   * 当前选区（第一段）；拿不到就给 null。
   *
   * 三路都试：`getSelection()`（组件实时选区，最准）→ `getSelectionCoordinates()`
   * → `getSheet().luckysheet_select_save`（快照里常常没有实时选区）。
   * 只读 getSheet 会一直拿到 null，插入位置就会永远落在第 0 行——右键第 10 行
   * 「向下插入」却插到表头上面，正是这个坑。
   * @returns {any | null} 选区（`{row:[a,b],column:[a,b]}` 或 `{startRow,...}`）。
   */
  function currentSelection() {
    var ref = state.fsRef
    if (ref === null || ref === undefined || ref.current === null) return null
    var current = ref.current
    if (typeof current.getSelection === 'function') {
      try {
        var live = current.getSelection()
        if (Array.isArray(live) && live.length > 0) return live[0]
        if (live && typeof live === 'object' && !Array.isArray(live)) return live
      } catch (error) { /* 换下一条路 */ }
    }
    if (typeof current.getSelectionCoordinates === 'function') {
      try {
        var coords = current.getSelectionCoordinates()
        if (Array.isArray(coords) && coords.length > 0) return coords[0]
        if (coords && typeof coords === 'object') return coords
      } catch (error) { /* 换下一条路 */ }
    }
    if (typeof current.getSheet === 'function') {
      try {
        var sheet = current.getSheet()
        var save = sheet && Array.isArray(sheet.luckysheet_select_save) ? sheet.luckysheet_select_save : null
        if (save !== null && save.length > 0) return save[0]
      } catch (error) { /* 放弃 */ }
    }
    return null
  }

  /**
   * 从选区里取插行 / 插列的基准下标（取选区起点）。
   * @param {any} range - 选区。
   * @param {'row' | 'column'} type - 行还是列。
   * @returns {number} 下标。
   */
  function rangeStart(range, type) {
    if (range === null || typeof range !== 'object') return 0
    var pair = type === 'row' ? range.row : range.column
    if (Array.isArray(pair) && pair.length > 0) return Math.max(0, Number(pair[0]) || 0)
    var flat = type === 'row' ? range.startRow : range.startColumn
    if (typeof flat === 'number' && Number.isFinite(flat)) return Math.max(0, flat)
    return 0
  }

  /**
   * 修补空选区。
   *
   * fortune 的粘贴处理里直接读 `luckysheet_select_save[0].row[0]`：选区一旦是空的
   * （首次进入、切表、撤销到无选区），Ctrl+V 就抛 TypeError，运气不好连带把 React
   * 树卸掉——用户看到的就是白屏。粘贴**之前**先把选区补回 A1。
   * @returns {boolean} 是否做过修补。
   */
  function repairSelection() {
    if (state.grid !== 'fortune') return false
    var ref = state.fsRef
    if (ref === null || ref === undefined || ref.current === null) return false
    if (currentSelection() !== null) return false
    try {
      if (typeof ref.current.setSelection === 'function') {
        ref.current.setSelection([{ row: [0, 0], column: [0, 0], row_focus: 0, column_focus: 0 }])
        reportCrash('selection-repair', 'empty selection before paste')
        return true
      }
    } catch (error) {
      reportCrash('selection-repair-failed', error)
    }
    return false
  }

  /**
   * 从菜单项文字里认出「插什么、往哪插」。
   * @param {string} text - 菜单项文字，如「向下插入 行」「向左插入 列」。
   * @returns {{ type: 'row' | 'column', direction: 'lefttop' | 'rightbottom', before: boolean } | null} 解析结果；不是插入项给 null。
   */
  function parseInsertMenuItem(text) {
    var label = String(text === null || text === undefined ? '' : text).replace(/\s+/g, '')
    if (label.indexOf('插入') < 0) return null
    var row = label.indexOf('行') >= 0
    var column = label.indexOf('列') >= 0
    if (row === column) return null
    var before = label.indexOf('向上') >= 0 || label.indexOf('向左') >= 0
    return { type: row ? 'row' : 'column', direction: before ? 'lefttop' : 'rightbottom', before: before }
  }

  /**
   * 自己动手插行 / 插列（不依赖 fortune 菜单项的 onClick）。
   *
   * 菜单项的 onClick 要组件内部传进来的 DOM ref，数量输入框又会把点击吞掉；
   * 它一旦不灵，用户就只看到「点了没反应」。这里直接走 Workbook 暴露的
   * `insertRowOrColumn`，插入位置取当前选区。
   * @param {'row' | 'column'} type - 插行还是插列。
   * @param {number} count - 插几个（至少 1，最多 500）。
   * @param {'lefttop' | 'rightbottom'} [direction] - 插在选区上方/左侧还是下方/右侧。
   * @returns {boolean} 是否插成功。
   */
  function insertRowOrColumnAt(type, index, count, direction) {
    var ref = state.fsRef
    if (ref === null || ref === undefined || ref.current === null) return false
    if (typeof ref.current.insertRowOrColumn !== 'function') return false
    var amount = Math.max(1, Math.min(500, Math.floor(Number(count) || 1)))
    var at = Math.max(0, Math.floor(Number(index) || 0))
    breadcrumb('insert-by-api', { type: type, count: amount, index: at, direction: direction || 'rightbottom' })
    try {
      ref.current.insertRowOrColumn(type, at, amount, direction || 'rightbottom')
    } catch (error) {
      reportCrash('insert-failed', error, { type: type, count: amount, index: at })
      return false
    }
    touch()
    announceInsert({ type: type }, amount)
    return true
  }

  /**
   * 按当前选区插行 / 插列。
   *
   * fortune 的 `insertRowOrColumn(type, index, count, direction)` 里 index 是 **1 基**
   * 行列号（实测：选区在第 4 行 → 传 4、direction=rightbottom，空行落在第 4 行下面）。
   * 选区拿到的 row[0]/column[0] 是 0 基，所以这里 +1 再交给组件——不 +1 的话
   * 「向下插入」会插到选中行上面，跟 Excel 正好差一行。
   * @param {'row' | 'column'} type - 插行还是插列。
   * @param {number} count - 插几个（至少 1，最多 500）。
   * @param {'lefttop' | 'rightbottom'} [direction] - 插在选区上方/左侧还是下方/右侧。
   * @returns {boolean} 是否插成功。
   */
  function insertRowOrColumn(type, count, direction) {
    return insertRowOrColumnAt(type, rangeStart(currentSelection(), type) + 1, count, direction)
  }

  /**
   * 工作表指纹：用来判断一次菜单点击到底有没有真插进去。
   * @returns {string} `row:column:dataLen:cellLen`。
   */
  function sheetFingerprint() {
    var sheet = null
    try {
      var ref = state.fsRef
      if (ref !== null && ref !== undefined && ref.current !== null && typeof ref.current.getSheet === 'function') sheet = ref.current.getSheet()
    } catch (error) {
      sheet = null
    }
    if (sheet === null) return ''
    var data = Array.isArray(sheet.data) ? sheet.data.length : -1
    var cells = Array.isArray(sheet.celldata) ? sheet.celldata.length : -1
    return [sheet.row, sheet.column, data, cells].join(':')
  }

  /**
   * 菜单里点「插入行 / 插入列」时的兜底。
   *
   * 先让 fortune 自己处理（它正常时一步到位）；两拍之后画布尺寸没动，说明它的
   * onClick 没跑到（数量框吞点击、DOM ref 丢了…），我们按输入框里的数字自己插。
   * 这样「点菜单行中间」「点文字」「点数量框」结果一致，也不会插两次。
   * @param {HTMLElement} item - `.luckysheet-cols-menuitem`。
   * @returns {void}
   */
  function handleInsertMenuItem(item, event) {
    var parsed = parseInsertMenuItem(item.textContent)
    if (parsed === null) return
    var input = item.querySelector('input')
    var count = Math.max(1, Math.floor(Number(input !== null ? input.value : 1) || 1))
    var ref = state.fsRef
    var canTakeOver = ref !== null && ref !== undefined && ref.current !== null
      && typeof ref.current.insertRowOrColumn === 'function'
    if (canTakeOver === true) {
      // 接管：fortune 自己的插入把 0 基选区当 1 基下标用，「向上插入」会插到选中行
      // 的上一行、「向下插入」会插到选中行本身——跟 Excel 差一行。这里按 1 基算好
      // 自己插（见 insertRowOrColumn），然后替它把右键菜单关掉。
      if (event !== null && event !== undefined) {
        event.preventDefault()
        event.stopPropagation()
      }
      if (insertRowOrColumn(parsed.type, count, parsed.direction) === true) {
        closeContextMenu()
        return
      }
    }
    // 兜底：让组件自己走一遍，两拍后核对指纹；没插进去就自己再插一次。
    var before = sheetFingerprint()
    setTimeout(function () {
      if (sheetFingerprint() !== before) {
        announceInsert(parsed, count)
        return
      }
      if (insertRowOrColumn(parsed.type, count, parsed.direction) === true) {
        closeContextMenu()
        return
      }
      status('插入' + (parsed.type === 'row' ? '行' : '列') + '没生效：网格可能正在重建，稍后重试或按 Ctrl+S 保存后重开', 'error')
    }, 120)
  }

  /**
   * 关掉 fortune 的右键菜单。
   *
   * 接管插入时我们自己 stopPropagation，组件收不到那次点击，菜单会一直挂着；
   * 它自己的 keydown 处理里 `Escape` 就是 `contextMenu = {}`，补一发即可。
   * @returns {void}
   */
  function closeContextMenu() {
    // fortune 开菜单时会盖一层 .fortune-popover-backdrop，它的 onMouseDown 就把
    // 菜单收掉——跟用户点一下空白处是一回事，也不会动网格选区。合成 Escape 不管用
    // （React 合成分发层收不到），所以优先走 backdrop，再退键盘。
    try {
      var backdrop = document.querySelector('.fortune-popover-backdrop')
      if (backdrop !== null) {
        backdrop.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true, view: window }))
        return
      }
      var host = document.querySelector('.fortune-container')
      if (host !== null) {
        host.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', code: 'Escape', bubbles: true, cancelable: true }))
      }
    } catch (error) {
      /* 关不掉也不影响插入结果 */
    }
  }

  /**
   * 插入之后的回执：告诉用户「插到哪、现在几行几列」。
   * @param {{ type: 'row' | 'column' }} parsed - 插入类型。
   * @param {number} count - 期望插入数量。
   * @returns {void}
   */
  function announceInsert(parsed, count) {
    var current = shape()
    var unit = parsed.type === 'row' ? ' 行' : ' 列'
    status('已插入 ' + Math.max(1, count) + unit + ' · 现在 ' + current.columns.length + ' 列 × ' + current.rows.length + ' 行', 'ok')
  }

  /** 建网格：有 fortune-sheet 就用它，没有（或加载失败）就退回 jspreadsheet。 */
  function renderGrid() {
    var FS = window.__FS
    var wantFortune = state.preferGrid === 'fortune'
    // Workbook 是 forwardRef 包装出来的对象，不是函数——判 null 而不是判 typeof。
    if (wantFortune && FS !== null && typeof FS === 'object' && FS.Workbook !== undefined && FS.Workbook !== null
      && typeof FS.createRoot === 'function') {
      renderFortune(FS)
      return
    }
    renderJspreadsheet()
  }

  /**
   * 读「用哪个组件」的偏好：默认 fortune（Excel 风），画不出来会自动退回
   * jspreadsheet。URL 上带 `?grid=jspreadsheet` 可强制走退路，方便排错。
   * @returns {string} 'jspreadsheet' | 'fortune'。
   */
  function preferredGrid() {
    if (state.preferGrid !== '') return state.preferGrid
    try {
      var fromUrl = new URLSearchParams(location.search).get('grid')
      if (fromUrl === 'fortune' || fromUrl === 'jspreadsheet') {
        state.preferGrid = fromUrl
        return fromUrl
      }
    } catch (error) {
      /* 老浏览器没有 URLSearchParams 就用默认 */
    }
    state.preferGrid = 'fortune'
    return state.preferGrid
  }

  /**
   * fortune-sheet：白底 Excel 风 —— 工具条、公式栏、行列表头、底部工作表标签全开。
   *
   * 这些 chrome 是组件自带的（与 Excel/WPS 同一套布局），本插件不再自己造
   * 小按钮：格式、公式、合并、冻结、筛选、多张工作表都在工具条与右键菜单里。
   * 改动经 `onChange` 收进 `state.fsSheets`，保存时原样交给服务端。
   * @param {any} FS - window.__FS（含 React/createRoot/Workbook）。
   * @returns {void}
   */
  function renderFortune(FS) {
    try {
      if (state.fsRoot !== null && typeof state.fsRoot.unmount === 'function') state.fsRoot.unmount()
    } catch (error) {
      /* 卸不掉就让旧树自己回收 */
    }
    state.fsRoot = null
    state.fsRef = null
    state.ws = null
    state.grid = 'fortune'
    breadcrumb('render-fortune', { sheets: Array.isArray(state.sheets) ? state.sheets.length : 0 })
    els.sheet.innerHTML = ''
    var host = document.createElement('div')
    host.className = 'ts-fortune'
    // fortune 在挂载时量父容器：这一步之前若还没布局，它量到 0 就画一片空白。
    host.style.height = (els.sheet.clientHeight || 480) + 'px'
    els.sheet.appendChild(host)

    var sheets = sheetsForRender(state.sheets)
    state.fsSheets = sheets
    state.fsStable = false
    setTimeout(function () {
      state.fsStable = true
    }, 700)
    var ref = FS.React.createRef()
    state.fsRef = ref
    state.fsRoot = FS.createRoot(host)
    var Boundary = gridBoundary(FS)
    keepUnscrolled(host)
    state.fsRoot.render(FS.React.createElement(Boundary, null,
      FS.React.createElement(FS.Workbook, {
        ref: ref,
        data: sheets,
        lang: 'zh',
        allowEdit: true,
        showToolbar: true,
        showFormulaBar: true,
        showSheetTabs: true,
        onChange: function (next) {
          // 这个回调是 fortune 在它自己的 effect 里调的：这里抛一次错，
          // React 会把它当成渲染错误、把整棵树卸掉 → 白屏。所以整段兜住，
          // 出错只记日志，绝不让异常穿回组件。
          try {
            var previous = state.fsSheets
            state.fsSheets = next
            // 挂载时它自己会先发一次 onChange：那不是用户的改动，别记成「未保存」。
            if (state.fsStable !== true) return
            trackTrailingExtension(previous, next)
            touch()
          } catch (error) {
            reportCrash('onchange-failed', error)
          }
        },
      }),
    ))
    renderShape()
    report('grid', { note: 'fortune' })
    // 只把宿主钉成「容器的实际高度」，绝不再往上加尺寸。
    //
    // 早先这里会拿画布高度去补 `容器高 - 画布高`，本意是别在底部留白；可画布本来就该比
    // 容器矮（上面还有工具条 / 公式栏 / 底部工作表标签），于是每挂一次就多长出上百像素，
    // 宿主比容器高 → 顶部那一截（工具条、列头）被容器裁掉，看着就像「头被挡住了」。
    var remeasure = function () {
      try {
        var exact = Math.max(120, els.sheet.clientHeight || host.clientHeight || 480)
        host.style.height = exact + 'px'
        window.dispatchEvent(new Event('resize'))
      } catch (error) {
        /* 量不到就算了 */
      }
    }
    setTimeout(remeasure, 80)
    setTimeout(remeasure, 500)
    // 面板拖大拖小、侧栏收起后都重新钉一次，别把上一次的旧高度留在 DOM 上。
    setTimeout(remeasure, 1200)
    setTimeout(function () {
      // 这一拍只负责「第一次挂载就量不到尺寸」：真·白板交给看门狗与 boundary，
      // 免得用户刚好在粘贴 / 插入时被这里的降级抢走画布。
      if (state.grid !== 'fortune' || state.fsRoot === null) return
      var canvas = host.querySelector('canvas')
      var blank = canvas === null || canvas.width === 0 || canvas.height === 0
      if (blank !== true) return
      if (els.sheet.querySelector('.fortune-container') !== host) return
      if (state.healAttempts > 0) return
      reportCrash('fortune-blank', 'first mount has no canvas')
      healGrid('first-blank')
    }, 1800)
  }

  /**
   * 把「只负责裁切」的容器钉在原地。
   *
   * `#ts-sheet` / `.ts-fortune` / `.fortune-container` 都是 overflow: hidden 的裁切层；
   * 一旦哪个环节把它们滚走一点，工具条和列头就会钻到顶栏底下去（「头部被挡住」）。
   * 真正的滚动交给 fortune 自己的画布区，这里把 scrollTop/scrollLeft 按住。
   * @param {HTMLElement} host - fortune 宿主。
   * @returns {void}
   */
  function keepUnscrolled(host) {
    var targets = [els.sheet, host, host.querySelector('.fortune-container')]
    for (var i = 0; i < targets.length; i += 1) {
      var element = targets[i]
      if (!element || typeof element.addEventListener !== 'function') continue
      if (element.dataset && element.dataset.tsScrollGuard === '1') continue
      if (element.dataset) element.dataset.tsScrollGuard = '1'
      element.addEventListener('scroll', function (event) {
        var target = event.currentTarget
        if (!target) return
        if (target.scrollTop !== 0) target.scrollTop = 0
        if (target.scrollLeft !== 0) target.scrollLeft = 0
      }, { passive: true })
    }
  }

  /** jspreadsheet：fortune 画不出来时的退路（纯值网格，无格式与多表）。 */
  function renderJspreadsheet() {
    state.grid = 'jspreadsheet'
    report('grid', { note: 'jspreadsheet' })
    if (typeof window.jspreadsheet !== 'function') {
      status('表格组件未加载：jspreadsheet 资源 404（请检查插件 assets 是否随包）', 'error')
      return
    }
    var data = firstSheetMatrix()
    var width = Math.max(1, data[0] ? data[0].length : state.columns.length)
    var height = rowsToFill(data.length)
    var columns = columnWidths(data, width)
    els.sheet.innerHTML = ''
    var created = window.jspreadsheet(els.sheet, {
      worksheets: [{
        data: data,
        columns: columns,
        minDimensions: [width, height],
        tableOverflow: true,
        tableHeight: '100%',
        wordWrap: false,
        columnDrag: false,
        columnSort: false,
        allowInsertRow: true,
        allowDeleteRow: true,
        allowInsertColumn: true,
        allowDeleteColumn: true,
        allowRenameColumn: true,
        onchange: function () {
          touch()
        },
        oninsertrow: function () {
          touch()
        },
        oninsertcolumn: function () {
          touch()
        },
        ondeleterow: function () {
          touch()
        },
        ondeletecolumn: function () {
          touch()
        },
      }],
    })
    state.ws = Array.isArray(created) ? created[0] : created
    renderShape()
  }

  /**
   * 布局稳定后补足空行——首次渲染时容器高度还没算出来，`rowsToFill` 会偏小。
   *
   * 只在「没有未保存改动」时重画，免得把用户正在编的内容冲掉；重画前先销毁旧实例，
   * 否则 jspreadsheet 的事件监听会一层层叠上去。
   * @returns {void}
   */
  function ensureFilled() {
    // fortune 自己会把空行铺满画布，不用这边补。
    if (state.grid === 'fortune') return
    if (!state.ws || state.dirty === true) return
    var current = matrix().length
    if (rowsToFill(current) <= current) return
    try {
      if (window.jspreadsheet && typeof window.jspreadsheet.destroy === 'function') {
        window.jspreadsheet.destroy(els.sheet)
      }
    } catch (error) {
      /* 销毁失败就让它自己回收 */
    }
    renderGrid()
  }

  /**
   * 装载一份文档。
   * @param {any} doc - 服务端文档载荷。
   */
  function adopt(doc) {
    breadcrumb('adopt', { id: typeof doc.id === 'string' ? doc.id : '' })
    state.id = typeof doc.id === 'string' ? doc.id : ''
    state.updatedAt = typeof doc.updatedAt === 'string' ? doc.updatedAt : ''
    state.title = typeof doc.title === 'string' && doc.title !== '' ? doc.title : '表格'
    var data = doc.data && Array.isArray(doc.data.columns) ? doc.data : null
    state.columns = data !== null ? data.columns.map(cell) : ['列1', '列2', '列3']
    state.rows = data !== null && Array.isArray(data.rows) ? data.rows.map(function (row) { return (Array.isArray(row) ? row : []).map(cell) }) : []
    state.sheets = Array.isArray(doc.sheets) && doc.sheets.length > 0 ? doc.sheets : null
    // 用户显式插出来的尾部空白行/列：优先读 sheets 附件里记的 tsExtra；
    // 老文档没有这个字段，就按数据面尾部空白兜底。
    var firstSheet = state.sheets !== null && Array.isArray(state.sheets) ? state.sheets[0] : null
    var savedExtra = firstSheet !== null && firstSheet.tsExtra && typeof firstSheet.tsExtra === 'object' ? firstSheet.tsExtra : null
    if (savedExtra !== null) {
      state.extraRows = Math.max(0, Math.floor(Number(savedExtra.rows) || 0))
      state.extraCols = Math.max(0, Math.floor(Number(savedExtra.cols) || 0))
    } else {
      state.extraRows = countTrailingBlankRows(state.rows)
      state.extraCols = countTrailingBlankColumns(state.columns, state.rows)
    }
    if (els.title) els.title.value = state.title
    renderGrid()
    state.dirty = false
    state.lastSaved = JSON.stringify({
      title: state.title,
      columns: state.columns,
      rows: state.rows,
      sheets: state.grid === 'fortune' && Array.isArray(state.fsSheets) ? state.fsSheets : null,
    })
    status('已载入 · ' + state.columns.length + ' 列 × ' + state.rows.length + ' 行 · 改动自动保存')
    report('editor', {
      id: state.id,
      count: state.rows.length,
      note: state.columns.length + ' 列' + (state.sheets === null ? '' : ' · ' + state.sheets.length + ' 张表'),
    })
    ping('ready')
    setTimeout(ensureFilled, 120)
    setTimeout(ensureFilled, 600)
  }

  /** 启动：按 doc → session → 新建 的顺序找一张表。 */
  function boot() {
    // 先把「这一页真的跑起来了」报上去：它和后面的 editor/editor-error 一起，
    // 能把「iframe 没加载」「加载了但取不到数据」「取到了但画不出来」三态分开。
    report('editor-page', { note: typeof location !== 'undefined' ? String(location.search || '').slice(0, 120) : '' })
    var params = new URLSearchParams(location.search)
    state.sessionId = params.get('session') || ''
    var docId = params.get('doc') || ''
    status('正在载入…')
    var load = docId !== ''
      ? request('/doc/' + encodeURIComponent(docId))
      : (state.sessionId !== ''
        ? request('/session?sessionId=' + encodeURIComponent(state.sessionId)).then(function (result) {
          if (result && result.ok === true && result.doc) return result.doc
          return request('/create', { method: 'POST', body: { sessionId: state.sessionId } })
            .then(function (created) { return created && created.doc ? created.doc : null })
        })
        : Promise.resolve(null))
    load.then(function (doc) {
      if (doc === null || doc === undefined) {
        status('没有可显示的表：请在会话里让模型 table_render 一张（或刷新重试）', 'error')
        report('editor-error', { note: 'no-doc' })
        return
      }
      if (doc.ok === false) {
        status('载入失败：' + (doc.message || doc.code || '未知错误'), 'error')
        report('editor-error', { id: String(doc.id || ''), note: String(doc.message || doc.code || 'load-failed') })
        return
      }
      adopt(doc.data ? doc : (doc.doc || doc))
      state.booted = true
    }).catch(function (error) {
      status('载入失败：' + (error && error.message ? error.message : String(error)), 'error')
      report('editor-error', { note: String((error && error.message) || error || 'fetch-failed') })
    })
  }

  /** CSV 单元格转义（与服务端 lib/csv.js 同一套规则）。 */
  function escapeCsv(value) {
    var text = cell(value)
    if (/[",\r\n]/.test(text) || text !== text.trim()) return '"' + text.replace(/"/g, '""') + '"'
    return text
  }

  /** 整表 CSV 文本（带 BOM，Excel/WPS 打开中文不乱码）。 */
  function csvText() {
    var current = shape()
    var lines = [current.columns].concat(current.rows).map(function (row) {
      return row.map(escapeCsv).join(',')
    })
    return '\uFEFF' + lines.join('\r\n') + '\r\n'
  }

  /** 文件名：标题 → 平台安全的名字。 */
  function safeName() {
    var name = ((els.title && els.title.value.trim()) || state.title || '表格').replace(/[\\/:*?"<>|]+/g, '_')
    return name === '' ? '表格' : name
  }

  /** 兜底下载：没有父页面（独立打开）时退回 a[download]。 */
  function downloadBlob(text, name) {
    var blob = new Blob([text], { type: 'text/csv;charset=utf-8' })
    var url = URL.createObjectURL(blob)
    var anchor = document.createElement('a')
    anchor.href = url
    anchor.download = name
    document.body.appendChild(anchor)
    anchor.click()
    anchor.remove()
    setTimeout(function () { URL.revokeObjectURL(url) }, 60000)
  }

  /**
   * 下载 CSV。
   *
   * 在 DSH 画布里时交给父页面：它用 DSH 的 fileActions 存进默认下载目录
   * （Desktop 下不弹系统「另存为」），存完再把路径回传到这里显示。
   * 独立打开（没有父页面）才退回浏览器下载。
   * @returns {void}
   */
  function download() {
    var name = safeName() + '.csv'
    var text = csvText()
    var parent = null
    try {
      if (window.parent && window.parent !== window) parent = window.parent
    } catch (error) {
      parent = null
    }
    if (parent === null) {
      downloadBlob(text, name)
      status('已下载 ' + name, 'ok')
      return
    }
    status('正在保存 ' + name + '…')
    parent.postMessage({ __ts: 'save-csv', id: state.id, name: name, text: text }, '*')
  }

  /** 复制成制表符分隔文本。 */
  function copy() {
    var current = shape()
    var text = [current.columns].concat(current.rows).map(function (row) {
      return row.map(function (value) { return cell(value).replace(/\t/g, ' ') }).join('\t')
    }).join('\n')
    var done = function (ok) {
      breadcrumb('copy-toolbar', { ok: ok, rows: current.rows.length })
      status(ok ? '已复制 ' + current.columns.length + ' 列 × ' + current.rows.length + ' 行' : '复制失败：浏览器拒绝了剪贴板权限', ok ? 'ok' : 'error')
    }
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(function () { done(true) }).catch(function () { done(fallbackCopy(text)) })
      return
    }
    done(fallbackCopy(text))
  }

  /**
   * 老浏览器兜底：隐藏 textarea + execCommand。
   * @param {string} text - 文本。
   * @returns {boolean} 成功与否。
   */
  function fallbackCopy(text) {
    try {
      var area = document.createElement('textarea')
      area.value = text
      area.setAttribute('readonly', '')
      area.style.position = 'fixed'
      area.style.opacity = '0'
      document.body.appendChild(area)
      area.select()
      var ok = document.execCommand('copy')
      area.remove()
      return ok
    } catch (error) {
      return false
    }
  }

  /**
   * 要铺多少行才不留死白——表格只画到第 4 行、底下空一大片，最像半成品。
   *
   * 按 26px 行高换算可视高度，最少给到「数据 + 2」行；多出来的空行不会被保存
   * （`shape()` 会裁掉尾部整行空白）。
   * @param {number} needed - 现有行数（含表头行）。
   * @returns {number} 目标行数。
   */
  function rowsToFill(needed) {
    var available = els.sheet ? els.sheet.clientHeight : 0
    if (!available || available < 80) return Math.max(5, needed + 2)
    var fit = Math.floor((available - 46) / 26)
    return Math.min(400, Math.max(needed + 2, fit))
  }

  /**
   * 按内容量列宽：jspreadsheet 默认给的宽度会把中文长句截成「右侧 jspreadshee」这种。
   *
   * 汉字按两个字符宽度算，最小 96px、最大 320px——够看全一行，又不至于一列霸满屏幕。
   * @param {string[][]} data - 含表头行的矩阵。
   * @param {number} width - 列数。
   * @returns {Array<{ width: number }>} 每列配置。
   */
  function columnWidths(data, width) {
    var natural = []
    for (var c = 0; c < width; c += 1) {
      var longest = 4
      for (var r = 0; r < data.length; r += 1) {
        var text = cell((data[r] || [])[c])
        var units = 0
        for (var i = 0; i < text.length; i += 1) {
          var code = text.charCodeAt(i)
          units += code > 0x2e80 ? 2 : 1
        }
        if (units > longest) longest = units
      }
      natural.push(Math.min(320, Math.max(96, longest * 7 + 24)))
    }
    // 剩余宽度均分：否则 table 被拉伸时，最长那列会独吞整个面板。
    // 留 14px 给纵向滚动条，否则列宽刚好顶满时会在底部挤出一条横向滚动条。
    var available = (els.sheet ? els.sheet.clientWidth : 0) - 50 - 14
    var sum = natural.reduce(function (total, value) { return total + value }, 0)
    if (available > 0 && sum > 0) {
      if (sum > available) {
        // 列太多就别硬塞：压到 72px 一列虽然「不出滚动条」，可内容是读不了的。
        // 保持 110px 起、让画布横向滚动，才是表格编辑器的正常手感。
        natural = natural.map(function (value) { return Math.max(110, value) })
      } else {
        var extra = Math.floor((available - sum) / width)
        if (extra > 0) natural = natural.map(function (value) { return Math.min(420, value + extra) })
      }
    }
    return natural.map(function (value) { return { width: value } })
  }

  /** 父页面主题：把算好的令牌打到本页 CSS 变量上。 */
  function applyTheme(palette) {
    if (!palette || typeof palette !== 'object') return
    var root = document.documentElement
    var map = {
      bg: '--ts-bg',
      surface: '--ts-surface',
      fg: '--ts-fg',
      muted: '--ts-muted',
      line: '--ts-line',
      accent: '--ts-accent',
      onAccent: '--ts-on-accent',
      header: '--ts-header',
    }
    Object.keys(map).forEach(function (key) {
      if (typeof palette[key] === 'string' && palette[key] !== '') root.style.setProperty(map[key], palette[key])
    })
    if (typeof palette.font === 'string' && palette.font !== '') root.style.setProperty('--ts-font', palette.font)
    state.dark = palette.dark === true
    root.setAttribute('data-ts-theme', state.dark ? 'dark' : 'light')
    applySkin()
  }

  /**
   * 表格纸面：固定白纸。
   *
   * Excel/WPS 的表格就是白纸黑字；深色主题只染顶栏与状态栏，不把纸面反相——
   * 反相出来的「深色表格」正是此前被官人判「没眼看」的那版。
   * @returns {void}
   */
  function applySkin() {
    document.documentElement.setAttribute('data-ts-skin', 'paper')
  }

  /** 绑事件。 */
  function bind() {
    els.title = $('ts-title')
    els.shape = $('ts-shape')
    els.status = $('ts-status')
    els.sheet = $('ts-sheet')
    els.save = $('ts-save')
    if (els.title) {
      els.title.addEventListener('input', function () { touch() })
      els.title.addEventListener('change', function () { touch() })
    }
    var bindClick = function (id, handler) {
      var element = $(id)
      if (element) element.addEventListener('click', handler)
    }
    bindClick('ts-save', function () { save() })
    // fortune 的「插入行 / 插入列」菜单项中间夹着一个数量输入框，输入框自己的
    // onClick 会 stopPropagation，正好占着菜单行正中间；用户往中间一按，就像
    // 「点了没反应」。以前这里替组件补发一次 click，但那会和它自己的 onClick
    // 打架（有时插两次、有时还是不插）。现在改成「先让它自己走，两拍后核对」：
    // 画布尺寸没变就说明它的 onClick 没跑到，我们按输入框里的数字自己插一次。
    document.addEventListener('click', function (event) {
      var target = event.target
      if (!target || typeof target.closest !== 'function') return
      var item = target.closest('.luckysheet-cols-menuitem')
      if (item === null) return
      handleInsertMenuItem(item, event)
    }, true)
    // 粘贴前把空选区补好：fortune 的粘贴处理直接读 luckysheet_select_save[0]，
    // 空选区会抛 TypeError（严重时把 React 树整个卸掉 → 白屏）。
    document.addEventListener('paste', function (event) {
      breadcrumb('paste', {
        hasData: !!(event && event.clipboardData),
        types: event && event.clipboardData ? Array.from(event.clipboardData.types || []) : [],
      })
      repairSelection()
    }, true)
    // 兜底取证：页面里没有控制台可看，任何未捕获异常 / 未处理的 rejection
    // 都落一份到 note 文件，同时让看门狗有机会把白板救回来。
    window.addEventListener('error', function (event) {
      if (event && event.error) reportCrash('window-error', event.error, { source: String(event.filename || ''), line: event.lineno || 0 })
    })
    window.addEventListener('unhandledrejection', function (event) {
      reportCrash('unhandled-rejection', event && event.reason)
    })
    bindClick('ts-download', download)
    bindClick('ts-copy', copy)
    document.addEventListener('keydown', function (event) {
      if ((event.ctrlKey || event.metaKey) && String(event.key).toLowerCase() === 's') {
        event.preventDefault()
        save()
      }
    })
    window.addEventListener('message', function (event) {
      var data = event && event.data
      if (!data || typeof data !== 'object') return
      if (data.__ts === 'theme') applyTheme(data.palette)
      else if (data.__ts === 'save') save()
      else if (data.__ts === 'reload') boot()
      else if (data.__ts === 'save-result') {
        if (data.ok === true) {
          var where = typeof data.path === 'string' && data.path !== '' ? data.path : (data.name || 'CSV')
          status('已保存 · ' + where, 'ok')
          ping('file-saved')
        } else {
          status('保存失败：' + (data.message || '父页面没有保存能力'), 'error')
        }
      }
    })
    var resizeTimer = 0
    window.addEventListener('resize', function () {
      if (resizeTimer) clearTimeout(resizeTimer)
      resizeTimer = setTimeout(ensureFilled, 200)
    })
    window.addEventListener('beforeunload', function (event) {
      if (state.dirty !== true) return
      save()
      event.preventDefault()
      event.returnValue = ''
    })
  }

  /**
   * 外部改动跟随：模型在会话里 table_update 之后，画布不能停在旧数据上。
   * 只在「没有未保存改动、也不在保存中」时才重载，免得把用户正打的字冲掉。
   * @returns {void}
   */
  function followRemote() {
    if (state.id === '' || state.dirty === true || state.saving === true) return
    request('/doc/' + encodeURIComponent(state.id)).then(function (result) {
      if (!result || result.ok !== true) return
      var stamp = typeof result.updatedAt === 'string' ? result.updatedAt : ''
      if (stamp === '' || stamp === state.updatedAt) return
      adopt(result)
      status('已同步模型侧的改动', 'ok')
    }).catch(function () {
      /* 网络抖动就等下一拍 */
    })
  }

  /**
   * 供真机/单测驱动：不经过 DOM 也能取到当前矩阵。
   * @returns {{ id: string, columns: string[], rows: string[][], grid: string, sheets: number, skin: string }} 快照。
   */
  function snapshot() {
    var current = shape()
    return {
      id: state.id,
      columns: current.columns,
      rows: current.rows,
      grid: state.grid,
      sheets: Array.isArray(state.fsSheets) ? state.fsSheets.length : 1,
      skin: document.documentElement.getAttribute('data-ts-skin') || '',
    }
  }

  function start() {
    bind()
    preferredGrid()
    applySkin()
    boot()
    setInterval(followRemote, 4000)
    // 白板看门狗：一秒看一眼网格还在不在（见 watchGrid）。
    setInterval(watchGrid, 1000)
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start)
  else start()

  window.__tsEditor = {
    snapshot: snapshot,
    save: save,
    shape: shape,
    shapeFromMatrix: shapeFromMatrix,
    padShape: padShape,
    countTrailingBlankRows: countTrailingBlankRows,
    countTrailingBlankColumns: countTrailingBlankColumns,
    trackTrailingExtension: trackTrailingExtension,
    trailingExtra: function () { return { rows: state.extraRows, cols: state.extraCols } },
    trailingExtraReset: function () { state.extraRows = 0; state.extraCols = 0 },
    // —— 抢救与自诊断（测试与真机排查都用这几个口） ——
    /** @param {string} text - 菜单项文字。 @returns {any} 解析结果。 */
    parseInsertMenuItem: parseInsertMenuItem,
    /** @param {'row'|'column'} type - 行/列。 @param {number} count - 数量。 @param {string} [direction] - 方向。 @returns {boolean} 是否插成功。 */
    insertRowOrColumn: insertRowOrColumn,
    /** @param {'row'|'column'} type - 行/列。 @param {number} index - 1 基下标。 @param {number} count - 数量。 @param {string} [direction] - 方向。 @returns {boolean} 是否插成功。 */
    insertRowOrColumnAt: insertRowOrColumnAt,
    /** @param {string} [reason] - 触发原因。 @returns {boolean} 是否重建成功。 */
    healGrid: healGrid,
    /** @returns {any[]} 最近 12 条崩溃摘要。 */
    crashLog: function () { return state.crashLog.slice() },
    /** @returns {any | null} 当前选区（测试用）。 */
    selection: currentSelection,
    /** @returns {{ attempts: number, blankTicks: number, healing: boolean }} 抢救状态。 */
    healState: function () {
      return { attempts: state.healAttempts, blankTicks: state.blankTicks, healing: state.healing }
    },
    /** @param {string} kind - 事故类别。 @param {unknown} reason - 错误。 @returns {void} */
    reportCrash: reportCrash,
    csvText: csvText,
    adopt: adopt,
    followRemote: followRemote,
    sheetsToMatrix: sheetsToMatrix,
    matrixToCelldata: matrixToCelldata,
    dataToCelldata: dataToCelldata,
    compactSheet: compactSheet,
    compactSheets: compactSheets,
    sheetsPayload: sheetsPayload,
    applySkin: applySkin,
    preferredGrid: preferredGrid,
    renderSheets: sheetsForRender,
    firstContentOffset: firstContentOffset,
    shiftSheetBy: shiftSheetBy,
    /** 只读诊断：返回组件里当前工作表（含格式），拿不到就 null。 */
    sheetData: function () {
      try {
        var ref = state.fsRef
        if (ref !== null && ref !== undefined && ref.current && typeof ref.current.getSheet === 'function') return ref.current.getSheet()
      } catch (error) {
        /* 组件还没挂上 */
      }
      return null
    },
    sheetCount: function () {
      return Array.isArray(state.fsSheets) ? state.fsSheets.length : 1
    },
  }
})()
