import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { describe, it } from 'node:test';

const root = resolve(import.meta.dirname, '../..');
const read = (path) => readFileSync(join(root, path), 'utf8');
const pkg = JSON.parse(read('package.json'));

describe('the repository', () => {
  it('has ci.yml as its only workflow, on the pipeline at the devDependency version', () => {
    assert.deepEqual(readdirSync(join(root, '.github/workflows')), ['ci.yml']);
    const ci = read('.github/workflows/ci.yml');
    const uses = [...ci.matchAll(/^\s*uses:\s*(\S+)\s*$/gm)].map((match) => match[1]);
    assert.deepEqual(uses, [
      `ai-ecoverse/slicc-shared-web/.github/workflows/pipeline.yml@v${pkg.devDependencies['@ai-ecoverse/slicc-shared-web']}`,
    ]);
    assert.match(ci, /^\s*secrets: inherit$/m);
    assert.doesNotMatch(ci, /runs-on|workflow_dispatch|schedule|#/);
    for (const scope of [
      'contents',
      'issues',
      'pull-requests',
      'statuses',
      'id-token',
      'attestations',
    ]) {
      assert.match(ci, new RegExp(`^  ${scope}: write$`, 'm'), scope);
    }
    assert.match(ci, /^ {2}actions: read$/m);
    assert.match(ci, /cancel-in-progress: \$\{\{ github\.event_name == 'pull_request' \}\}/);
    assert.match(ci, /^\s*review-prompt: \|\n\s+SLICC-CAPTURE$/m);
    const glob = /^\s*test-glob:\s*(\S+)$/m.exec(ci)?.[1];
    assert.ok(glob && pkg.scripts.test.endsWith(` ${glob}`), pkg.scripts.test);
  });

  it('pins every devDependency exactly', () => {
    for (const [name, version] of Object.entries(pkg.devDependencies)) {
      assert.match(version, /^\d+\.\d+\.\d+$/, name);
    }
    assert.equal(pkg.engines.node, '>=24');
  });

  it('publishes to npm from ci.yml through semantic-release, with provenance', () => {
    assert.equal(pkg.name, '@ai-ecoverse/slicc-capture');
    assert.equal(pkg.fledgling.workflow, 'ci.yml');
    assert.equal(pkg.fledgling.repo, 'ai-ecoverse/slicc-capture');
    assert.equal(pkg.publishConfig.access, 'public');
    assert.equal(pkg.publishConfig.provenance, true);
    const release = JSON.parse(read('.releaserc.json'));
    assert.deepEqual(release.branches, ['main']);
    assert.ok(release.plugins.includes('@semantic-release/npm'));
    assert.doesNotMatch(JSON.stringify(release), /npmPublish/);
  });

  it('attaches install.sh, install.ps1, the tarball and SHA256SUMS to each release', () => {
    const release = JSON.parse(read('.releaserc.json'));
    const names = release.plugins.map((plugin) => (Array.isArray(plugin) ? plugin[0] : plugin));
    const config = (name) => release.plugins.find((plugin) => plugin[0] === name)?.[1];
    assert.ok(names.indexOf('@semantic-release/npm') < names.indexOf('@semantic-release/exec'));
    assert.ok(names.indexOf('@semantic-release/exec') < names.indexOf('@semantic-release/github'));
    assert.deepEqual(config('@semantic-release/exec'), {
      prepareCmd: 'node scripts/release-assets.mjs ${nextRelease.version}',
    });
    assert.deepEqual(config('@semantic-release/github').assets, [
      'dist/install.sh',
      'dist/install.ps1',
      'dist/slicc-capture-*.tgz',
      'dist/SHA256SUMS',
    ]);
    assert.match(read('.gitignore'), /^dist\/$/m);
    const out = mkdtempSync(join(tmpdir(), 'slicc-capture-assets-'));
    try {
      const wrong = spawnSync(process.execPath, ['scripts/release-assets.mjs', '9.9.9', out], {
        cwd: root,
        encoding: 'utf8',
      });
      assert.equal(wrong.status, 1);
      const run = spawnSync(process.execPath, ['scripts/release-assets.mjs', pkg.version, out], {
        cwd: root,
        encoding: 'utf8',
      });
      assert.equal(run.status, 0, run.stderr);
      const tarball = `slicc-capture-${pkg.version}.tgz`;
      assert.deepEqual(readdirSync(out).sort(), [
        'SHA256SUMS',
        'install.ps1',
        'install.sh',
        tarball,
      ]);
      const lines = readFileSync(join(out, 'SHA256SUMS'), 'utf8').trimEnd().split('\n');
      assert.deepEqual(
        lines.map((line) => line.slice(66)),
        [tarball, 'install.sh', 'install.ps1']
      );
      for (const line of lines) {
        const file = readFileSync(join(out, line.slice(66)));
        assert.equal(line.slice(0, 66), `${createHash('sha256').update(file).digest('hex')}  `);
      }
      assert.equal(readFileSync(join(out, 'install.sh'), 'utf8'), read('install.sh'));
      assert.equal(readFileSync(join(out, 'install.ps1'), 'utf8'), read('install.ps1'));
      const list = spawnSync('tar', ['-tzf', join(out, tarball)], { encoding: 'utf8' });
      assert.equal(list.status, 0, list.stderr);
      assert.ok(list.stdout.split('\n').includes('package/package.json'), list.stdout);
    } finally {
      rmSync(out, { recursive: true, force: true });
    }
  });

  it('keeps unit tests out of git', () => {
    assert.match(read('.gitignore'), /^test\/unit\/$/m);
    const tracked = spawnSync('git', ['ls-files', 'test/unit', '*CLAUDE.md'], {
      cwd: root,
      encoding: 'utf8',
    });
    assert.equal(tracked.status, 0, tracked.stderr);
    assert.equal(tracked.stdout, '');
  });

  it('has a row in the README for every option of macOS screencapture', () => {
    const rows = new Set(
      [...read('README.md').matchAll(/^\| `(-\w)(?: <[^>]+>)?` \|/gm)].map((match) => match[1])
    );
    const options = 'abBcCdDgGiJklmMoprPRsStTuUvVwWx'.split('').map((letter) => `-${letter}`);
    assert.deepEqual(
      options.filter((option) => !rows.has(option)),
      []
    );
  });

  it('packs every file that bin and slicc.commands name, and no tests', () => {
    const pack = spawnSync('npm', ['pack', '--dry-run', '--json', '--ignore-scripts'], {
      cwd: root,
      encoding: 'utf8',
    });
    assert.equal(pack.status, 0, pack.stderr);
    const files = JSON.parse(pack.stdout)[0]
      .files.map((file) => file.path)
      .sort();
    const shipped = (pkg.files ?? []).flatMap((dir) =>
      readdirSync(join(root, dir)).map((name) => `${dir}/${name}`)
    );
    assert.deepEqual(files, ['LICENSE', 'README.md', 'package.json', ...shipped].sort());
    for (const [name, command] of Object.entries(pkg.slicc?.commands ?? {})) {
      assert.ok(files.includes(command.script), name);
    }
    for (const [name, path] of Object.entries(pkg.bin ?? {})) assert.ok(files.includes(path), name);
  });
});
