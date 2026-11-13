import z from '@deepseek-ai/schemastery'
import { normalizeStream } from './lib/normalize.js'

export const name = 'response-compat'
export const inject = ['llm']
export const Config = z.object({
  allowJsonToolCalls: z.boolean().default(false).volatile().description('允许把纯文本中的完整模型协议 JSON 工具请求转成交给 DSH 审批的调用。默认仅显示；只应在确认上游将 JSON 当作真实工具协议时启用。Claude Code/Codex 运行记录始终不重放。'),
  maxStructuredChars: z.number().step(1).min(1024).max(16777216).default(2097152).volatile().description('自动识别 JSON 响应时的缓冲字符上限；超出后原样显示，不限制普通回复或工具次数。'),
})

export function apply(ctx, config) {
  // Config snapshots are per request. Active calls finish under the wrapper they
  // entered; unload only withdraws it from subsequent requests. The original
  // provider remains the sole owner of network cancellation and authentication.
  ctx.on('llm/stream', (options, next) => {
    const setting = config.maxStructuredChars
    const maxStructuredChars = typeof setting?.get === 'function' ? setting.get() : setting
    const flag = config.allowJsonToolCalls
    const allowJsonToolCalls = typeof flag?.get === 'function' ? flag.get() : flag
    return normalizeStream(next(), options, { maxStructuredChars, allowJsonToolCalls })
  })
}
