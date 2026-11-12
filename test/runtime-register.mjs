import { register } from 'node:module'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

if (!process.env.DSH_RUNTIME_ROOT) throw new Error('Set DSH_RUNTIME_ROOT to the installed runtime node_modules directory.')
register('./runtime-resolve.mjs', import.meta.url, {
  data: { parentURL: pathToFileURL(resolve(process.env.DSH_RUNTIME_ROOT, '__dsh_runtime_test__.mjs')).href },
})
