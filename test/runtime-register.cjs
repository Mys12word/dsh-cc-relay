// Run with the installation's ASAR-aware Electron runtime in Desktop builds.
const fs = require('node:fs');
const path = require('node:path');
const { registerHooks, createRequire } = require('node:module');
const { pathToFileURL, fileURLToPath } = require('node:url');
const anchor = process.env.DSH_INSTALL_DIR;
if (!anchor) throw new Error('Set DSH_INSTALL_DIR to the running Harness CLI package');
const anchorRequire = createRequire(path.join(anchor, 'package.json'));
const pluginRoot = path.resolve(__dirname, '..');
let resolving = false;
function moduleFormat(filename) {
  if (filename.endsWith('.json')) return 'json';
  if (filename.endsWith('.mjs')) return 'module';
  if (filename.endsWith('.cjs')) return 'commonjs';
  for (let dir = path.dirname(filename); path.dirname(dir) !== dir; dir = path.dirname(dir)) {
    const manifest = path.join(dir, 'package.json');
    if (fs.existsSync(manifest)) return JSON.parse(fs.readFileSync(manifest, 'utf8')).type === 'module' ? 'module' : 'commonjs';
  }
  return 'commonjs';
}
registerHooks({
  resolve(specifier, context, nextResolve) {
    if (resolving || specifier.startsWith('node:')) return nextResolve(specifier, context);
    if (specifier === '@deepseek-ai/schemastery' && context.parentURL?.startsWith(pathToFileURL(pluginRoot).href)) {
      const manifest = process.env.CC_TEST_SCHEMA_ROOT
        ? path.join(process.env.CC_TEST_SCHEMA_ROOT, 'package.json')
        : anchorRequire.resolve('@deepseek-ai/schemastery/package.json');
      return { url: pathToFileURL(path.join(path.dirname(manifest), 'lib/index.mjs')).href, shortCircuit: true };
    }
    try { return nextResolve(specifier, context); } catch (original) {
      if (specifier.startsWith('.') || specifier.startsWith('file:')) {
        const url = new URL(specifier, context.parentURL);
        if (url.protocol === 'file:' && fs.existsSync(fileURLToPath(url))) return { url: url.href, shortCircuit: true };
      }
      if (!specifier.startsWith('.') && !specifier.startsWith('file:')) {
        resolving = true;
        try {
          const parent = context.parentURL?.startsWith('file:') ? fileURLToPath(context.parentURL) : path.join(anchor, 'package.json');
          const local = createRequire(parent);
          let filename;
          try { filename = local.resolve(specifier); } catch { filename = anchorRequire.resolve(specifier); }
          return { url: filename.startsWith('node:') ? filename : pathToFileURL(filename).href, shortCircuit: true };
        } finally { resolving = false; }
      }
      throw original;
    }
  },
  load(url, context, nextLoad) {
    if (url.startsWith('file:') && fileURLToPath(url).includes('.asar' + path.sep)) {
      const filename = fileURLToPath(url);
      return { format: moduleFormat(filename), source: fs.readFileSync(filename, 'utf8'), shortCircuit: true };
    }
    return nextLoad(url, context);
  },
});
