/**
 * dsh-table-studio — 全局约束：所有表格展示都走本插件。
 *
 * 为什么要有这一层：自带 skill 是「模型想起来了才加载」的说明书，靠它兜不住
 * 「顺手画个 markdown 表格」。这里把约束注册进 `ctx.systemPrompt`，每一步都在
 * 系统提示里，并且随插件注册/卸载——不写进用户记忆，也不改全局配置。
 *
 * 注册失败只记日志：约束挂不上不该拖垮会话或工具。
 *
 * @module dsh-table-studio/lib/policy
 */

/** 约束正文：表格展示的唯一通道是本插件。 */
export const TABLE_POLICY = [
  '表格展示一律走 dsh-table-studio 插件：凡是给用户看的结构化表格——查询结果、数据对比、清单、参数表、证据表、进度表等，只要有两列及以上、两行及以上，就必须用 table_render 出表格卡（需要编辑时再用 table_open 开右侧画布），不要用 Markdown 表格（| … |）代替。',
  '表格卡可复制、下载 CSV、放大、二次编辑，Markdown 表格这些都没有；同一份数据既画卡片又写 Markdown 表属于重复展示，不要这么做。',
  '仅两种例外：用户明确要求纯文字/不要卡片；或本轮 table_* 工具不可用。此时退化为文字或列表说明，并在回复里说明原因。',
].join('')

/** 段名：宿主里唯一，重复注册会被替换而不是叠加。 */
export const POLICY_SECTION = 'dsh-table-studio:table-policy'

/** 段顺序：紧跟在工具说明簇之后（computer-use 3100 / MCP 3100 之后）。 */
export const POLICY_ORDER = 3200

/**
 * 把「所有表格展示走本插件」注册成全局系统提示段。
 *
 * 宿主没有 `systemPrompt` 服务时静默降级（老版本 DSH / headless 组合）。
 * @param {any} ctx - cordis 上下文。
 * @param {{ log?: (level: string, message: string) => void, onResult?: (result: { ok: boolean, section: string, order: number, reason?: string, message?: string }) => void }} [options] - 选项。
 * @returns {{ registered: boolean, section: string, reason?: string }} 注册结果。
 */
export function registerTablePolicy(ctx, options = {}) {
  const log = options.log ?? (() => {})
  const onResult = options.onResult ?? (() => {})

  /**
   * 把「挂上了 / 没挂上」报给调用方（host 会落成 policy.json，供无屏幕排查）。
   * @param {{ ok: boolean, reason?: string, message?: string }} state - 结果。
   * @returns {void}
   */
  const report = (state) => {
    try {
      onResult({ ...state, section: POLICY_SECTION, order: POLICY_ORDER })
    } catch (error) {
      log('warn', `table-studio: 表格约束结果回报失败：${error instanceof Error ? error.message : String(error)}`)
    }
  }

  /**
   * 拿到注册表就挂段；拿不到就记一行，不影响别处。
   * @param {any} scope - 注入后的上下文。
   * @returns {void}
   */
  const mount = (scope) => {
    try {
      const registry = scope?.systemPrompt ?? ctx?.get?.('systemPrompt')
      if (registry === undefined || registry === null || typeof registry.section !== 'function') {
        log('warn', 'table-studio: 宿主没有 systemPrompt.section()，表格约束未注入')
        report({ ok: false, reason: 'no-system-prompt' })
        return
      }
      registry.section({ name: POLICY_SECTION, order: POLICY_ORDER, text: TABLE_POLICY })
      log('info', `table-studio: 已注入全局约束「所有表格展示走本插件」（${POLICY_SECTION}@${POLICY_ORDER}）`)
      report({ ok: true })
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      log('warn', `table-studio: 表格约束注册失败：${message}`)
      report({ ok: false, reason: 'section-failed', message })
    }
  }

  if (typeof ctx?.inject === 'function') {
    try {
      // 软注入：systemPrompt 晚到也能挂上；永远拿不到就只是没有这条约束。
      ctx.inject(['systemPrompt'], mount)
      return { registered: true, section: POLICY_SECTION }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      log('warn', `table-studio: systemPrompt 注入失败：${message}`)
      report({ ok: false, reason: 'inject-failed', message })
      return { registered: false, section: POLICY_SECTION, reason: 'inject-failed' }
    }
  }
  mount(ctx)
  return { registered: true, section: POLICY_SECTION }
}
