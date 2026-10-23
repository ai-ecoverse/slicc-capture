import { createHash } from 'node:crypto';
import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

const [dir, version] = process.argv.slice(2);
if (!dir || !/^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/.test(version ?? '')) {
  console.error('usage: node scripts/assets.mjs DIR VERSION');
  process.exit(2);
}
const packed = join(resolve(dir), `ai-ecoverse-slicc-capture-${version}.tgz`);
const name = `slicc-capture-${version}.tgz`;
const tarball = join(resolve(dir), name);
if (existsSync(packed)) renameSync(packed, tarball);
if (!existsSync(tarball)) {
  console.error(`scripts/assets.mjs: no ${packed}`);
  process.exit(1);
}
const root = resolve(import.meta.dirname, '..');
const files = [
  [name, tarball],
  ['install.sh', join(root, 'install.sh')],
  ['install.ps1', join(root, 'install.ps1')],
];
const sums = files
  .map(
    ([file, path]) => `${createHash('sha256').update(readFileSync(path)).digest('hex')}  ${file}\n`
  )
  .join('');
writeFileSync(join(resolve(dir), 'SHA256SUMS'), sums);
process.stdout.write(sums);
