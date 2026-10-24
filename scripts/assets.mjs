import { createHash } from 'node:crypto';
import { copyFileSync, existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { gunzipSync } from 'node:zlib';

const root = resolve(import.meta.dirname, '..');
const [dir, version] = process.argv.slice(2);
if (!dir || !/^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/.test(version ?? '')) {
  console.error('usage: node scripts/assets.mjs DIR VERSION');
  process.exit(2);
}
const out = resolve(dir);
const packed = join(out, `ai-ecoverse-slicc-capture-${version}.tgz`);
const tarball = `slicc-capture-${version}.tgz`;
const source = existsSync(packed) ? packed : join(out, tarball);
if (!existsSync(source)) {
  console.error(`scripts/assets.mjs: no ${packed}`);
  process.exit(1);
}
const entries = new Map();
const tar = gunzipSync(readFileSync(source));
for (let at = 0; at + 512 <= tar.length; ) {
  const field = (from, length) =>
    tar
      .subarray(at + from, at + from + length)
      .toString('utf8')
      .replace(/\0.*$/s, '');
  const name = field(0, 100);
  if (name === '') break;
  const prefix = field(345, 155);
  const size = Number.parseInt(field(124, 12).trim() || '0', 8);
  entries.set(prefix ? `${prefix}/${name}` : name, tar.subarray(at + 512, at + 512 + size));
  at += 512 + Math.ceil(size / 512) * 512;
}
const manifest = entries.get('package/package.json');
const bin = manifest ? (JSON.parse(manifest.toString('utf8')).bin ?? {}) : {};
const bins = typeof bin === 'string' ? { bin } : bin;
const lacking = Object.entries(bins).filter(
  ([, path]) => !entries.has(`package/${path.replace(/^\.\//, '')}`)
);
if (!manifest || Object.keys(bins).length === 0 || lacking.length > 0) {
  const what = lacking.map(([name, path]) => `${path} (bin ${name})`).join(', ');
  console.error(`scripts/assets.mjs: ${tarball} lacks ${what || 'a package.json with bin'}`);
  process.exit(1);
}
if (source === packed) renameSync(packed, join(out, tarball));
for (const name of ['install.sh', 'install.ps1']) copyFileSync(join(root, name), join(out, name));
const sums = [tarball, 'install.sh', 'install.ps1']
  .map(
    (name) =>
      `${createHash('sha256')
        .update(readFileSync(join(out, name)))
        .digest('hex')}  ${name}\n`
  )
  .join('');
writeFileSync(join(out, 'SHA256SUMS'), sums);
process.stdout.write(sums);
