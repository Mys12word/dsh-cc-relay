const path = require('node:path');
const { spawnSync } = require('node:child_process');
const root = path.resolve(__dirname, '..');
const executable = process.env.DSH_NODE_EXECUTABLE || process.execPath;
const result = spawnSync(executable, [
  '--require', path.join(__dirname, 'runtime-register.cjs'),
  path.join(__dirname, 'compatibility.test.mjs'),
], {
  cwd: root,
  env: { ...process.env, ...(process.env.DSH_NODE_EXECUTABLE ? { ELECTRON_RUN_AS_NODE: '1' } : {}) },
  stdio: 'inherit',
});
if (result.error) { console.error(result.error.message); process.exitCode = 1; }
else process.exitCode = result.status ?? 1;
