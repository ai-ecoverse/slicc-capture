import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { copyFileSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(import.meta.dirname, '..');

export function releaseAssets(version, out = join(root, 'dist')) {
  const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
  if (!version || version !== pkg.version) {
    throw new Error(`version ${version ?? '(none)'} is not package.json's ${pkg.version}`);
  }
  rmSync(out, { recursive: true, force: true });
  mkdirSync(out, { recursive: true });
  const packed = JSON.parse(
    execFileSync('npm', ['pack', '--json', '--ignore-scripts', '--pack-destination', out], {
      cwd: root,
      encoding: 'utf8',
    })
  )[0].filename;
  const tarball = `slicc-capture-${version}.tgz`;
  renameSync(join(out, packed), join(out, tarball));
  for (const name of ['install.sh', 'install.ps1']) copyFileSync(join(root, name), join(out, name));
  const names = [tarball, 'install.sh', 'install.ps1'];
  const hash = (name) =>
    createHash('sha256')
      .update(readFileSync(join(out, name)))
      .digest('hex');
  writeFileSync(join(out, 'SHA256SUMS'), names.map((name) => `${hash(name)}  ${name}\n`).join(''));
  return names;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    releaseAssets(...process.argv.slice(2));
  } catch (error) {
    process.stderr.write(`release-assets: ${error.message}\n`);
    process.exit(1);
  }
}
