const tags = ['thinking', 'think', 'analysis', 'reasoning']
const openers = tags.map(tag => `<${tag}>`)

// A small incremental lexer. Code spans/fences are copied literally. Only a leading
// model wrapper is treated as reasoning; prose that discusses a tag is unchanged.
export class TaggedText {
  constructor(emit) {
    this.emit = emit
    this.pending = ''
    this.reasoning = null
    this.leading = true
    this.code = 0
    this.converted = false
  }
  output(type, text) { if (text) this.emit(type, text) }
  push(text, final = false) {
    this.pending += text
    while (this.pending) {
      const kind = this.reasoning ? 'reasoning' : 'text'
      // Resolve runs of backticks across arbitrary delta boundaries.
      if (!this.reasoning && this.pending[0] === '`') {
        const match = /^`+/.exec(this.pending)[0]
        if (match.length === this.pending.length && !final) return
        this.output('text', match)
        if (!this.code) this.code = match.length
        else if (match.length === this.code) this.code = 0
        this.leading = false
        this.pending = this.pending.slice(match.length)
        continue
      }
      const allowed = this.reasoning ? [`</${this.reasoning}>`] : this.leading && !this.code ? openers : []
      const lower = this.pending.toLowerCase()
      const token = allowed.find(tag => lower.startsWith(tag))
      if (token) {
        this.pending = this.pending.slice(token.length)
        this.converted = true
        if (this.reasoning) { this.reasoning = null; this.leading = true }
        else { this.reasoning = token.slice(1, -1); this.leading = false }
        continue
      }
      if (!final && allowed.some(tag => tag.startsWith(lower))) return
      // Emit up to the next possible delimiter without a per-character callback.
      let end = 1
      while (end < this.pending.length && this.pending[end] !== '<' && (this.reasoning || this.pending[end] !== '`')) end++
      const part = this.pending.slice(0, end)
      this.output(kind, part)
      if (!this.reasoning && part.trim()) this.leading = false
      this.pending = this.pending.slice(end)
    }
  }
  finish() { this.push('', true) }
}
