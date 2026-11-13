// Resolve only tools advertised for this exact request. This module never executes tools.
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value)
const aliases = new Map([
  ['Bash', 'bash'], ['exec_command', 'bash'], ['shell_command', 'bash'],
  ['Read', 'read'], ['read_file', 'read'], ['Write', 'write'], ['write_file', 'write'],
  ['Edit', 'edit'], ['edit_file', 'edit'], ['Glob', 'glob'], ['Grep', 'grep'],
])
const shortName = name => name.startsWith('functions.') ? name.slice(10) : name

function matches(value, schema, depth = 0) {
  if (schema === false || depth > 24) return false
  if (!object(schema)) return true
  if (schema.enum && !schema.enum.some(item => JSON.stringify(item) === JSON.stringify(value))) return false
  if (Object.hasOwn(schema, 'const') && JSON.stringify(schema.const) !== JSON.stringify(value)) return false
  if (schema.anyOf && !schema.anyOf.some(item => matches(value, item, depth + 1))) return false
  if (schema.oneOf && schema.oneOf.filter(item => matches(value, item, depth + 1)).length !== 1) return false
  if (schema.allOf && !schema.allOf.every(item => matches(value, item, depth + 1))) return false
  const types = Array.isArray(schema.type) ? schema.type : schema.type ? [schema.type] : []
  if (types.length && !types.some(type => type === 'object' ? object(value) : type === 'array' ? Array.isArray(value) : type === 'null' ? value === null : type === 'integer' ? Number.isSafeInteger(value) : type === 'number' ? typeof value === 'number' && Number.isFinite(value) : typeof value === type)) return false
  if (typeof value === 'string' && (schema.minLength !== undefined && value.length < schema.minLength || schema.maxLength !== undefined && value.length > schema.maxLength)) return false
  if (typeof value === 'number' && (schema.minimum !== undefined && value < schema.minimum || schema.maximum !== undefined && value > schema.maximum)) return false
  if (Array.isArray(value) && schema.items && !value.every(item => matches(item, schema.items, depth + 1))) return false
  if (object(value)) {
    if (schema.required?.some(key => !Object.hasOwn(value, key))) return false
    for (const [key, item] of Object.entries(value)) {
      if (Object.hasOwn(schema.properties ?? {}, key)) {
        if (!matches(item, schema.properties[key], depth + 1)) return false
      } else if (schema.additionalProperties === false) return false
      else if (object(schema.additionalProperties) && !matches(item, schema.additionalProperties, depth + 1)) return false
    }
  }
  return true
}

export function resolveTool(call, tools = []) {
  if (!object(call) || typeof call.name !== 'string' || typeof call.id !== 'string' || !call.id.trim()) return undefined
  let input = call.arguments
  if (typeof input === 'string') { try { input = JSON.parse(input) } catch { return undefined } }
  if (!object(input)) return undefined
  const requested = shortName(call.name)
  const exact = tools.find(tool => tool.name === call.name) ?? tools.find(tool => shortName(tool.name) === requested)
  const targets = tools.filter(tool => shortName(tool.name) === aliases.get(requested))
  const target = exact ?? (targets.length === 1 ? targets[0] : undefined)
  if (!target) return undefined
  if (object(target.parameters?.properties) && Object.keys(input).some(key => ['dangerouslyDisableSandbox', 'additional_permissions', 'environment_id', 'subagent_type', 'isolation', 'shell', 'login', 'tty', 'yield_time_ms', 'max_output_tokens'].includes(key) && !Object.hasOwn(target.parameters.properties, key))) return undefined
  const args = { ...input }
  const canonical = shortName(target.name)
  const props = target.parameters?.properties ?? {}
  const move = (from, to) => {
    if (Object.hasOwn(args, from) && !Object.hasOwn(props, from) && Object.hasOwn(props, to)) {
      if (!Object.hasOwn(args, to)) args[to] = args[from]
      delete args[from]
    }
  }
  if (!exact || call.name !== target.name) {
    if (canonical === 'bash') { move('cmd', 'command'); move('timeout', 'timeoutMs') }
    if (['read', 'write', 'edit'].includes(canonical)) move('path', 'file_path')
    if (canonical === 'read') move('start_line', 'offset')
    if (canonical === 'grep') { move('glob', 'include'); move('regex', 'pattern') }
    // An alias must never discard foreign flags: unsupported arguments remain invalid.
    if (canonical === 'bash' && target.parameters?.required?.includes('description') && !Object.hasOwn(args, 'description')) args.description = '执行模型请求的命令'
  }
  if (!matches(args, target.parameters)) return undefined
  return { type: 'tool-call', id: call.id, name: target.name, arguments: JSON.stringify(args) }
}
