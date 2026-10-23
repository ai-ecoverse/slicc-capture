import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
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
      assert.match(version, /^(npm:@ai-ecoverse\/slicc-kernel@)?\d+\.\d+\.\d+(-\d+)?$/, name);
    }
    assert.equal(pkg.engines.node, '>=24');
    assert.equal(pkg.engines['slicc-kernel'], '>=1.153.0');
    const kernel = pkg.devDependencies['@ai-ecoverse/slicc-kernel'];
    assert.match(kernel, /^\d+\.\d+\.\d+$/);
    const parts = (version) => version.split('.').map(Number);
    const order = (a, b) => a.reduce((sign, part, i) => sign || Math.sign(part - b[i]), 0);
    assert.ok(order(parts(kernel), parts(pkg.engines['slicc-kernel'].slice(2))) >= 0, kernel);
    assert.equal(
      pkg.devDependencies['slicc-kernel-without-embedder'],
      'npm:@ai-ecoverse/slicc-kernel@1.152.2'
    );
  });

  it('keeps renovate off the old-kernel alias', () => {
    assert.deepEqual(JSON.parse(read('renovate.json')).packageRules, [
      { matchDepNames: ['slicc-kernel-without-embedder'], enabled: false },
    ]);
  });

  it('publishes to npm from ci.yml through semantic-release, with provenance', () => {
    assert.equal(pkg.name, '@ai-ecoverse/slicc-capture');
    assert.equal(pkg.fledgling.workflow, 'ci.yml');
    assert.equal(pkg.fledgling.repo, 'ai-ecoverse/slicc-capture');
    assert.equal(pkg.publishConfig.access, 'public');
    assert.equal(pkg.publishConfig.provenance, true);
    const release = JSON.parse(read('.releaserc.json'));
    assert.deepEqual(release.branches, ['main']);
    assert.ok(release.plugins.some((entry) => [entry].flat()[0] === '@semantic-release/npm'));
    assert.doesNotMatch(JSON.stringify(release), /npmPublish/);
  });

  it('attaches the tarball, SHA256SUMS, install.sh and install.ps1 to the GitHub release', () => {
    const release = JSON.parse(read('.releaserc.json'));
    const plugin = (name) => release.plugins.find((entry) => [entry].flat()[0] === name);
    assert.deepEqual(plugin('@semantic-release/npm'), [
      '@semantic-release/npm',
      { tarballDir: 'release' },
    ]);
    assert.deepEqual(plugin('@semantic-release/exec')[1], {
      prepareCmd: 'node scripts/assets.mjs release ${nextRelease.version}',
    });
    const names = release.plugins.map((entry) => [entry].flat()[0]);
    assert.ok(names.indexOf('@semantic-release/npm') < names.indexOf('@semantic-release/exec'));
    assert.ok(names.indexOf('@semantic-release/exec') < names.indexOf('@semantic-release/github'));
    assert.deepEqual(
      plugin('@semantic-release/github')[1].assets.map((asset) => asset.path),
      ['release/slicc-capture-*.tgz', 'release/SHA256SUMS', 'install.sh', 'install.ps1']
    );
    assert.ok(existsSync(join(root, 'install.sh')));
    assert.ok(existsSync(join(root, 'install.ps1')));
    assert.match(read('.gitignore'), /^release\/$/m);
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
