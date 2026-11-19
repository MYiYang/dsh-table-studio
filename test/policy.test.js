/**
 * 全局约束单测：「所有表格展示走本插件」进系统提示段。
 */
import assert from 'node:assert/strict'
import { POLICY_ORDER, POLICY_SECTION, TABLE_POLICY, registerTablePolicy } from '../lib/policy.js'

let passed = 0
/** @param {string} name - 用例名。 @param {() => void} fn - 用例。 */
function test(name, fn) {
  try {
    fn()
    passed += 1
    console.log(`  ok  ${name}`)
  } catch (error) {
    console.error(`  FAIL ${name}`)
    throw error
  }
}

console.log('policy.test.js')

test('约束正文是硬的：点名 table_render、禁 Markdown、留例外', () => {
  assert.match(TABLE_POLICY, /table_render/)
  assert.match(TABLE_POLICY, /Markdown 表格/)
  assert.match(TABLE_POLICY, /不要用/)
  assert.match(TABLE_POLICY, /仅两种例外/)
})

test('通过 ctx.inject 注入 systemPrompt 段', () => {
  const sections = []
  const injected = []
  const ctx = {
    inject(names, callback) {
      injected.push(names)
      callback({ systemPrompt: { section(section) { sections.push(section); return () => {} } } })
    },
    get() { return undefined },
  }
  const result = registerTablePolicy(ctx, { log() {} })
  assert.equal(result.registered, true)
  assert.deepEqual(injected, [['systemPrompt']])
  assert.equal(sections.length, 1)
  assert.equal(sections[0].name, POLICY_SECTION)
  assert.equal(sections[0].order, POLICY_ORDER)
  assert.equal(sections[0].text, TABLE_POLICY)
})

test('宿主没有 systemPrompt 服务时只记日志、不抛错', () => {
  const logs = []
  const ctx = { inject(names, callback) { callback({}) }, get() { return undefined } }
  const result = registerTablePolicy(ctx, { log: (level, message) => logs.push(`${level}:${message}`) })
  assert.equal(result.registered, true)
  assert.ok(logs.some((line) => line.includes('systemPrompt.section')))
})

test('没有 inject 的老宿主直接挂', () => {
  const sections = []
  const ctx = { get: (name) => (name === 'systemPrompt' ? { section(section) { sections.push(section) } } : undefined) }
  const result = registerTablePolicy(ctx, { log() {} })
  assert.equal(result.registered, true)
  assert.equal(sections.length, 1)
  assert.equal(sections[0].name, POLICY_SECTION)
})

console.log(`policy.test.js: ${passed} passed`)
