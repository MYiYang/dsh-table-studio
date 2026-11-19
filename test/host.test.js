/**
 * Host 半侧单测：假 ctx 起插件，跑工具与路由。
 *
 * 不碰网络、不碰真 DSH：`webServer`/`tools`/`connection` 都是替身，
 * 断言的是「注册了什么、工具返回什么、路由怎么答」。
 */
import assert from 'node:assert/strict'
import { mkdtempSync, existsSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { apply } from '../index.js'

let passed = 0
/** @param {string} name - 用例名。 @param {() => void | Promise<void>} fn - 用例。 */
async function test(name, fn) {
  try {
    await fn()
    passed += 1
    console.log(`  ok  ${name}`)
  } catch (error) {
    console.error(`  FAIL ${name}`)
    throw error
  }
}

const root = mkdtempSync(join(tmpdir(), 'table-studio-host-'))

/** 造一个够用的假 ctx。 */
function makeCtx() {
  /** @type {Map<string, any>} */
  const tools = new Map()
  /** @type {any[]} */
  const routes = []
  /** @type {any[]} */
  const skills = []
  /** @type {any[]} */
  const sections = []
  /** @type {any[]} */
  const effects = []
  const ctx = {
    logger: { debug() {}, info() {}, warn() {}, error() {} },
    tools: {
      register(definition) {
        tools.set(definition.name, definition)
        return () => tools.delete(definition.name)
      },
    },
    webServer: {
      register(route) {
        routes.push(route)
        return () => {
          const index = routes.indexOf(route)
          if (index >= 0) routes.splice(index, 1)
        }
      },
    },
    connection: { requestRejection: () => undefined },
    inject(names, callback) {
      if (names.includes('systemPrompt')) {
        callback({
          systemPrompt: {
            section(definition) {
              sections.push(definition)
              return () => {}
            },
          },
          effect(fn) {
            return fn()
          },
        })
        return
      }
      if (names.includes('skills')) {
        callback({
          skills: {
            register(definition) {
              skills.push(definition)
              return () => {}
            },
          },
          effect(fn) {
            const dispose = fn()
            return dispose
          },
        })
        return
      }
      callback(ctx)
    },
    effect(fn) {
      const dispose = fn()
      effects.push(dispose)
      return dispose
    },
    get() {
      return undefined
    },
  }
  return { ctx, tools, routes, skills, sections, effects }
}

const { ctx, tools, routes, skills, sections, effects } = makeCtx()
apply(ctx, { storageDir: root })

/** 假响应：收集状态码、头、正文。 */
function makeRes() {
  const state = { status: 0, headers: {}, body: '' }
  const res = {
    writeHead(status, headers) {
      state.status = status
      Object.assign(state.headers, headers ?? {})
    },
    end(body) {
      if (body === undefined) state.body = ''
      else if (Buffer.isBuffer(body)) state.body = body.toString('utf8')
      else state.body = String(body)
    },
  }
  return { res, state }
}

/** 找一条路由。 */
function routeOf(kind, path) {
  const found = routes.find((route) => route.kind === kind && route.path === path)
  assert.ok(found, `没找到路由 ${kind} ${path}`)
  return found
}

/** 假执行上下文。 */
const exec = { agent: { session: { id: 'session-test', cwd: root } } }
/** 跑工具。 */
async function run(name, args) {
  const tool = tools.get(name)
  assert.ok(tool, `没注册工具 ${name}`)
  return tool.execute(args, exec)
}

console.log('host.test.js')

await test('注册了五个工具', () => {
  assert.deepEqual([...tools.keys()].sort(), ['table_export', 'table_open', 'table_read', 'table_render', 'table_update'])
})

await test('注册了自带 skill', () => {
  assert.equal(skills.length, 1)
  assert.equal(skills[0].name, 'table-studio')
  assert.ok(String(skills[0].description).length > 10)
  assert.match(String(skills[0].content), /table_render/)
  assert.match(String(skills[0].description), /唯一通道|所有表格展示|禁止 Markdown/)
})

await test('注入「所有表格展示走本插件」的全局约束', () => {
  assert.equal(sections.length, 1, '应只注册一个约束段')
  assert.equal(sections[0].name, 'dsh-table-studio:table-policy')
  assert.equal(typeof sections[0].order, 'number')
  assert.match(sections[0].text, /table_render/)
  assert.match(sections[0].text, /Markdown 表格/)
  assert.match(sections[0].text, /例外|真的/)
})

await test('表格约束状态落成 policy.json', () => {
  const file = join(root, 'policy.json')
  assert.ok(existsSync(file), '应写出 policy.json 作为约束生效的证据')
  const state = JSON.parse(readFileSync(file, 'utf8'))
  assert.equal(state.ok, true)
  assert.equal(state.section, 'dsh-table-studio:table-policy')
  assert.equal(state.order, 3200)
  assert.ok(typeof state.at === 'string' && state.at.includes('T'))
})

await test('工具参数是 JSON Schema', () => {
  const parameters = tools.get('table_render').parameters
  assert.equal(parameters.type, 'object')
  assert.ok(parameters.properties.columns)
  assert.equal(parameters.additionalProperties, false)
})

await test('table_render 建表并给回收据', async () => {
  const value = await run('table_render', {
    title: '穴位对照',
    columns: ['位置', '中医名称', '对应西医常见'],
    rows: [['合谷', '虎口', '头痛'], ['足三里', '下陵', '胃痛']],
    note: '演示',
  })
  assert.equal(value.ok, true)
  assert.match(value.id, /^tbl_/)
  assert.equal(value.shape, '3 列 × 2 行')
  assert.deepEqual(value.data.columns, ['位置', '中医名称', '对应西医常见'])
  assert.ok(existsSync(join(root, 'docs', `${value.id}.json`)))
})

await test('table_render 空内容给可读错误', async () => {
  const value = await run('table_render', {})
  assert.equal(value.ok, false)
  assert.equal(value.code, 'empty-table')
  const blocks = tools.get('table_render').output.render({}, value)
  assert.equal(blocks[0].type, 'text')
  assert.match(blocks[0].text, /empty-table/)
})

await test('table_render 接受 csv 文本', async () => {
  const value = await run('table_render', { csv: 'a,b\n1,2\n3,4\n' })
  assert.equal(value.ok, true)
  assert.equal(value.shape, '2 列 × 2 行')
  assert.deepEqual(value.data.rows, [['1', '2'], ['3', '4']])
})

await test('table_read 给回 CSV 且带表头', async () => {
  const created = await run('table_render', { title: '读回', columns: ['甲', '乙'], rows: [['1', '2']] })
  const value = await run('table_read', { id: created.id })
  assert.equal(value.ok, true)
  assert.equal(value.format, 'csv')
  assert.match(value.text, /甲,乙/)
  assert.match(value.text, /\n1,2$/)
  const blocks = tools.get('table_read').output.render({}, value)
  const joined = blocks.map((block) => block.text).join('\n')
  assert.match(joined, /```csv/)
})

await test('table_read 支持 markdown 与 json', async () => {
  const created = await run('table_render', { columns: ['甲', '乙'], rows: [['1', '2']] })
  const markdown = await run('table_read', { id: created.id, format: 'markdown' })
  assert.match(markdown.text, /\| 甲 \| 乙 \|/)
  const json = await run('table_read', { id: created.id, format: 'json' })
  assert.deepEqual(JSON.parse(json.text).rows, [['1', '2']])
})

await test('table_update 整表覆盖', async () => {
  const created = await run('table_render', { columns: ['甲', '乙'], rows: [['1', '2'], ['3', '4']] })
  const value = await run('table_update', { id: created.id, columns: ['甲', '乙'], rows: [['9', '8']], title: '改过' })
  assert.equal(value.ok, true)
  assert.equal(value.title, '改过')
  assert.equal(value.shape, '2 列 × 1 行')
})

await test('会话当前表：省略 id 时命中上一张', async () => {
  const created = await run('table_render', { columns: ['甲'], rows: [['1']] })
  const value = await run('table_read', {})
  assert.equal(value.id, created.id)
})

await test('table_export 写文件并带 BOM', async () => {
  const created = await run('table_render', { title: '导出', columns: ['位置'], rows: [['合谷']] })
  const value = await run('table_export', { id: created.id })
  assert.equal(value.ok, true)
  assert.ok(existsSync(value.file), `文件应存在：${value.file}`)
  const text = readFileSync(value.file, 'utf8')
  assert.equal(text.codePointAt(0), 0xfeff)
  assert.match(text, /位置\r\n合谷/)
})

await test('table_export 支持显式路径', async () => {
  const created = await run('table_render', { columns: ['a'], rows: [['1']] })
  const value = await run('table_export', { id: created.id, path: 'sub/dir/t.csv' })
  assert.equal(value.file, join(root, 'sub', 'dir', 't.csv'))
  assert.ok(existsSync(value.file))
})

await test('table_open 从工作区 CSV 开表', async () => {
  const file = join(root, 'open-me.csv')
  const { writeFileSync } = await import('node:fs')
  writeFileSync(file, '位置,名称\n合谷,虎口\n', 'utf8')
  const value = await run('table_open', { path: file })
  assert.equal(value.ok, true)
  assert.equal(value.opened, true)
  assert.deepEqual(value.data.columns, ['位置', '名称'])
})

await test('table_open 文件不存在给 file-not-found', async () => {
  const value = await run('table_open', { path: join(root, 'nope.csv') })
  assert.equal(value.ok, false)
  assert.equal(value.code, 'file-not-found')
})

await test('table_open 找不到 id 给 not-found', async () => {
  const value = await run('table_open', { id: 'tbl_19700101_000000' })
  assert.equal(value.ok, false)
  assert.equal(value.code, 'not-found')
})

await test('静态资源路由发出 jspreadsheet.js', async () => {
  const route = routeOf('exact', '/dsh-table-studio/assets/jspreadsheet.js')
  const response = await route.resource({ method: 'GET' })
  assert.equal(response.status, 200)
  assert.match(response.headers.get('content-type'), /javascript/)
  const text = await response.text()
  assert.ok(text.length > 100000, '应发出完整库文件')
})

await test('编辑器自己的脚本不缓存，第三方库长缓存', async () => {
  const own = await routeOf('exact', '/dsh-table-studio/assets/editor.js').resource({ method: 'GET' })
  const vendored = await routeOf('exact', '/dsh-table-studio/assets/jspreadsheet.js').resource({ method: 'GET' })
  assert.equal(own.headers.get('cache-control'), 'no-store')
  assert.match(vendored.headers.get('cache-control'), /immutable/)
})

await test('未打包的资源 404', async () => {
  const route = routeOf('exact', '/dsh-table-studio/assets/jspreadsheet.js')
  const response = await route.resource({ method: 'POST' })
  assert.equal(response.status, 405)
})

await test('编辑器页是静态外壳，不吃凭据门', async () => {
  const route = routeOf('exact', '/dsh-table-studio/editor')
  const original = ctx.connection.requestRejection
  ctx.connection.requestRejection = () => 403
  const { res, state } = makeRes()
  try {
    route.handler({ method: 'GET', url: '/dsh-table-studio/editor' }, res)
  } finally {
    ctx.connection.requestRejection = original
  }
  assert.equal(state.status, 200)
  assert.match(state.headers['content-type'], /text\/html/)
})

await test('编辑器页带 CSP', async () => {
  const route = routeOf('exact', '/dsh-table-studio/editor')
  const { res, state } = makeRes()
  route.handler({ method: 'GET', url: '/dsh-table-studio/editor' }, res)
  assert.equal(state.status, 200)
  assert.match(state.headers['content-type'], /text\/html/)
  assert.match(state.headers['content-security-policy'], /script-src 'self'/)
  assert.match(state.body, /jspreadsheet\.js/)
  assert.match(state.body, /editor\.js/)
})

await test('API /health 正常', async () => {
  const route = routeOf('prefix', '/dsh-table-studio/api')
  const { res, state } = makeRes()
  await route.handler({ method: 'GET', url: '/dsh-table-studio/api/health' }, res)
  assert.equal(state.status, 200)
  const body = JSON.parse(state.body)
  assert.equal(body.ok, true)
  assert.equal(body.root, root)
})

await test('API 403 当连接不认这道请求', async () => {
  const route = routeOf('prefix', '/dsh-table-studio/api')
  const strict = { ...ctx, connection: { requestRejection: () => 403 } }
  const { res, state } = makeRes()
  // 这条路由的闭包绑的是原 ctx，所以直接改原 ctx 的 connection 再还原。
  const original = ctx.connection.requestRejection
  ctx.connection.requestRejection = strict.connection.requestRejection
  try {
    await route.handler({ method: 'GET', url: '/dsh-table-studio/api/health' }, res)
  } finally {
    ctx.connection.requestRejection = original
  }
  assert.equal(state.status, 403)
  assert.equal(JSON.parse(state.body).code, 'forbidden')
})

await test('API 未知路径 404', async () => {
  const route = routeOf('prefix', '/dsh-table-studio/api')
  const { res, state } = makeRes()
  await route.handler({ method: 'GET', url: '/dsh-table-studio/api/nope' }, res)
  assert.equal(state.status, 404)
})

await test('API doc 读取与保存', async () => {
  const route = routeOf('prefix', '/dsh-table-studio/api')
  const created = await run('table_render', { columns: ['a', 'b'], rows: [['1', '2']] })

  const first = makeRes()
  await route.handler({ method: 'GET', url: `/dsh-table-studio/api/doc/${created.id}` }, first.res)
  assert.equal(first.state.status, 200)
  assert.deepEqual(JSON.parse(first.state.body).data.rows, [['1', '2']])

  const body = JSON.stringify({ columns: ['a', 'b'], rows: [['3', '4']], title: '画布改的', sessionId: 'session-test' })
  const second = makeRes()
  await route.handler({
    method: 'POST',
    url: `/dsh-table-studio/api/doc/${created.id}`,
    on() {},
    destroy() {},
    ...fakeBody(req => body),
  }, second.res)
  assert.equal(second.state.status, 200)
  const saved = JSON.parse(second.state.body)
  assert.equal(saved.shape, '2 列 × 1 行')
  assert.equal(saved.title, '画布改的')
})

await test('API doc 保存工作表格式数据（sheets）并能取回', async () => {
  const route = routeOf('prefix', '/dsh-table-studio/api')
  const created = await run('table_render', { columns: ['a', 'b'], rows: [['1', '2']] })
  const sheets = [{
    name: '表格',
    celldata: [{ r: 0, c: 0, v: { v: 'a', m: 'a', bl: 1 } }],
    config: { columnlen: { 0: 120 } },
    order: 0,
    status: 1,
  }]
  const saving = makeRes()
  await route.handler({
    method: 'POST',
    url: `/dsh-table-studio/api/doc/${created.id}`,
    on() {},
    destroy() {},
    ...fakeBody(() => JSON.stringify({ columns: ['a', 'b'], rows: [['1', '2']], sheets })),
  }, saving.res)
  assert.equal(saving.state.status, 200)

  const reading = makeRes()
  await route.handler({ method: 'GET', url: `/dsh-table-studio/api/doc/${created.id}` }, reading.res)
  const payload = JSON.parse(reading.state.body)
  assert.equal(payload.sheets.length, 1)
  assert.equal(payload.sheets[0].celldata[0].v.bl, 1)
  assert.equal(payload.sheets[0].config.columnlen[0], 120)

  const clearing = makeRes()
  await route.handler({
    method: 'POST',
    url: `/dsh-table-studio/api/doc/${created.id}`,
    on() {},
    destroy() {},
    ...fakeBody(() => JSON.stringify({ columns: ['a', 'b'], rows: [['9', '9']], sheets: null })),
  }, clearing.res)
  const after = JSON.parse(clearing.state.body)
  assert.equal(after.sheets, undefined, 'sheets:null 应清掉格式附件')
})

await test('table_update 会清掉旧的工作表格式数据', async () => {
  const route = routeOf('prefix', '/dsh-table-studio/api')
  const created = await run('table_render', { columns: ['a'], rows: [['1']] })
  const saving = makeRes()
  await route.handler({
    method: 'POST',
    url: `/dsh-table-studio/api/doc/${created.id}`,
    on() {},
    destroy() {},
    ...fakeBody(() => JSON.stringify({
      columns: ['a'], rows: [['1']],
      sheets: [{ name: '表格', celldata: [], config: {} }],
    })),
  }, saving.res)
  const updated = await run('table_update', { id: created.id, columns: ['a'], rows: [['2']] })
  assert.equal(updated.ok, true)
  const reading = makeRes()
  await route.handler({ method: 'GET', url: `/dsh-table-studio/api/doc/${created.id}` }, reading.res)
  assert.equal(JSON.parse(reading.state.body).sheets, undefined, '模型改过值后格式附件不该继续挂着')
})

await test('API csv 下载带 content-disposition', async () => {
  const route = routeOf('prefix', '/dsh-table-studio/api')
  const created = await run('table_render', { title: '带 空格', columns: ['a'], rows: [['1']] })
  const { res, state } = makeRes()
  await route.handler({ method: 'GET', url: `/dsh-table-studio/api/doc/${created.id}/csv` }, res)
  assert.equal(state.status, 200)
  assert.match(state.headers['content-type'], /text\/csv/)
  assert.match(state.headers['content-disposition'], /attachment/)
  assert.ok(state.body.startsWith('\uFEFF'))
})

await test('API boot 记下客户端版本', async () => {
  const route = routeOf('prefix', '/dsh-table-studio/api')
  const body = JSON.stringify({ version: '0.1.4', ua: 'jsdom' })
  const { res, state } = makeRes()
  await route.handler({
    method: 'POST',
    url: '/dsh-table-studio/api/boot',
    on() {},
    destroy() {},
    ...fakeBody(() => body),
  }, res)
  assert.equal(state.status, 200)
  assert.equal(JSON.parse(state.body).ok, true)
  const saved = JSON.parse(readFileSync(join(root, 'client.json'), 'utf8'))
  assert.equal(saved.version, '0.1.4')
  assert.ok(typeof saved.at === 'string' && saved.at.includes('T'))
})

await test('API boot 合并渲染证据（card / tail）', async () => {
  const route = routeOf('prefix', '/dsh-table-studio/api')
  const post = async (payload) => {
    const { res, state } = makeRes()
    await route.handler({
      method: 'POST',
      url: '/dsh-table-studio/api/boot',
      on() {},
      destroy() {},
      ...fakeBody(() => JSON.stringify(payload)),
    }, res)
    assert.equal(state.status, 200)
    return JSON.parse(readFileSync(join(root, 'client.json'), 'utf8'))
  }
  const afterCard = await post({ version: '0.1.5', kind: 'card', id: 'tbl_1', count: 2, note: '3 列', ua: 'jsdom' })
  assert.equal(afterCard.version, '0.1.5')
  assert.equal(afterCard.last.card.id, 'tbl_1')
  assert.equal(afterCard.last.card.count, 2)
  const afterTail = await post({ version: '0.1.5', kind: 'tail', callIds: ['c1', 'c2'], count: 2 })
  assert.equal(afterTail.last.tail.count, 2)
  assert.deepEqual(afterTail.last.tail.callIds, ['c1', 'c2'])
  assert.equal(afterTail.last.card.id, 'tbl_1', '先前的 card 证据不该被覆盖')
})

await test('API note 落盘客户端故障', async () => {
  const route = routeOf('prefix', '/dsh-table-studio/api')
  const body = JSON.stringify({ clientFailure: 'render', message: 'boom', stack: 'at x', version: '0.1.3' })
  const { res, state } = makeRes()
  await route.handler({
    method: 'POST',
    url: '/dsh-table-studio/api/note',
    on() {},
    destroy() {},
    ...fakeBody(() => body),
  }, res)
  assert.equal(state.status, 200)
  const parsed = JSON.parse(state.body)
  assert.equal(parsed.ok, true)
  assert.ok(existsSync(parsed.file), `note 文件应存在：${parsed.file}`)
  const saved = JSON.parse(readFileSync(parsed.file, 'utf8'))
  assert.equal(saved.message, 'boom')
  rmSync(parsed.file, { force: true })
})

await test('API session 给出当前表', async () => {
  const route = routeOf('prefix', '/dsh-table-studio/api')
  const created = await run('table_render', { columns: ['x'], rows: [['1']] })
  const { res, state } = makeRes()
  await route.handler({ method: 'GET', url: '/dsh-table-studio/api/session?sessionId=session-test' }, res)
  const body = JSON.parse(state.body)
  assert.equal(body.id, created.id)
  assert.deepEqual(body.doc.data.columns, ['x'])
})

await test('卸载时撤掉路由', () => {
  assert.ok(routes.length > 0)
  for (const dispose of [...effects].reverse()) {
    if (typeof dispose === 'function') dispose()
  }
  assert.equal(routes.length, 0, 'effect 卸载后路由应清空')
})

rmSync(root, { recursive: true, force: true })
console.log(`host.test.js: ${passed} passed`)

/**
 * 造一个能吐 JSON 的假请求体读取器：`readJsonBody` 只用到 on/data/end/error。
 * @param {(req: any) => string} produce - 生成正文。
 * @returns {Record<string, Function>} 事件方法。
 */
function fakeBody(produce) {
  const handlers = {}
  const self = {
    on(event, callback) {
      handlers[event] = callback
      return self
    },
  }
  setTimeout(() => {
    const text = produce(self)
    handlers.data?.(Buffer.from(text, 'utf8'))
    handlers.end?.()
  }, 0)
  return self
}
