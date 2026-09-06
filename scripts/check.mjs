import { readdir } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
const root = fileURLToPath(new URL('..', import.meta.url));
async function walk(dir) {
  const result = [];
  for (const item of await readdir(dir, { withFileTypes: true })) {
    if (item.isDirectory()) result.push(...await walk(path.join(dir, item.name)));
    else if (item.name.endsWith('.mjs')) result.push(path.join(dir, item.name));
  }
  return result;
}
let count = 0;
for (const dir of ['worker', 'public', 'scripts', 'tests']) {
  for (const file of await walk(path.join(root, dir)).catch(e => e.code === 'ENOENT' ? [] : Promise.reject(e))) {
    const result = spawnSync(process.execPath, ['--check', file], { stdio: 'inherit' });
    if (result.status !== 0) process.exit(result.status || 1); count++;
  }
}
console.log(`Syntax checked: ${count} JavaScript modules.`);