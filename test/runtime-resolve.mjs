let runtimeParent
export function initialize(data) { runtimeParent = data.parentURL }
export async function resolve(specifier, context, nextResolve) {
  if (specifier.startsWith('@deepseek-ai/')) {
    return nextResolve(specifier, { ...context, parentURL: runtimeParent })
  }
  return nextResolve(specifier, context)
}
