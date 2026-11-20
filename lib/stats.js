export const STATS_ROUTE = '/api/dsh-cc-relay/reasoning-conversions'

export function createReasoningStats() {
  const bySource = { tags: 0, claudeCode: 0, codex: 0, anthropic: 0, openaiChat: 0, openaiResponses: 0 }
  let total = 0
  return {
    record(source) {
      if (!Object.hasOwn(bySource, source)) return
      bySource[source]++
      total++
    },
    snapshot() { return { total, bySource: { ...bySource } } },
  }
}
