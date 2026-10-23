import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  chmodSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { after, before, describe, it } from 'node:test';
import { pathToFileURL } from 'node:url';

const root = resolve(import.meta.dirname, '../..');
const version = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).version;
const scratch = realpathSync(mkdtempSync(join(tmpdir(), 'slicc-capture-install-')));
const installSh = join(root, 'install.sh');
const installPs1 = join(root, 'install.ps1');

after(() => rmSync(scratch, { recursive: true, force: true }));

function which(name) {
  const found = spawnSync('sh', ['-c', `command -v ${name}`], { encoding: 'utf8' });
  return found.status === 0 ? found.stdout.trim() : undefined;
}

function release(at, as = version, patch = () => {}, status = 0) {
  const dir = mkdtempSync(join(scratch, `release-${as}-`));
  const source = mkdtempSync(join(scratch, 'source-'));
  for (const name of ['LICENSE', 'README.md', 'package.json', 'host']) {
    cpSync(join(root, name), join(source, name), { recursive: true });
  }
  patch(source);
  const pkg = JSON.parse(readFileSync(join(source, 'package.json'), 'utf8'));
  pkg.version = as;
  delete pkg.scripts;
  writeFileSync(join(source, 'package.json'), `${JSON.stringify(pkg, null, 2)}\n`);
  const pack = spawnSync('npm', ['pack', '--ignore-scripts', '--pack-destination', dir], {
    cwd: source,
    encoding: 'utf8',
  });
  assert.equal(pack.status, 0, pack.stderr);
  const assets = spawnSync(process.execPath, [join(root, 'scripts/assets.mjs'), dir, as], {
    encoding: 'utf8',
  });
  assert.equal(assets.status, status, assets.stderr);
  if (status !== 0) return assets;
  if (at) cpSync(dir, at, { recursive: true });
  return dir;
}

function run(file, args, options = {}) {
  return new Promise((done) => {
    const child = spawn(file, args, { ...options, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => {
      stdout += chunk;
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk;
    });
    child.on('close', (status) => done({ status, stdout, stderr }));
  });
}

function sha256(path) {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

function dependency() {
  const source = mkdtempSync(join(scratch, 'dep-'));
  writeFileSync(
    join(source, 'package.json'),
    JSON.stringify({ name: 'sccapture-test-dep', version: '1.0.0', main: 'index.js' })
  );
  writeFileSync(join(source, 'index.js'), 'module.exports = 42;\n');
  const out = mkdtempSync(join(scratch, 'dep-out-'));
  const pack = spawnSync('npm', ['pack', '--ignore-scripts', '--pack-destination', out], {
    cwd: source,
    encoding: 'utf8',
  });
  assert.equal(pack.status, 0, pack.stderr);
  return join(out, 'sccapture-test-dep-1.0.0.tgz');
}

function depending(spec, field = 'dependencies') {
  return (source) => {
    const path = join(source, 'package.json');
    const pkg = JSON.parse(readFileSync(path, 'utf8'));
    pkg[field] = { 'sccapture-test-dep': spec };
    writeFileSync(path, JSON.stringify(pkg));
  };
}

const npmCache = () => ({
  npm_config_cache: mkdtempSync(join(scratch, 'npm-cache-')),
  npm_config_registry: 'http://127.0.0.1:1/',
  npm_config_fetch_retries: '0',
});

function home() {
  return mkdtempSync(join(scratch, 'home-'));
}

function env(extra) {
  const out = { ...process.env };
  delete out.SCCAPTURE_INSTALL_DIR;
  delete out.XDG_DATA_HOME;
  delete out.NODE_OPTIONS;
  return { ...out, ...extra };
}

const curl = which('curl');

describe('scripts/assets.mjs', () => {
  it('names the tarball slicc-capture-<version>.tgz and writes SHA256SUMS for it and both installers', () => {
    const dir = release();
    const lines = readFileSync(join(dir, 'SHA256SUMS'), 'utf8').split('\n');
    assert.deepEqual(
      lines.map((line) => line.slice(66)),
      [`slicc-capture-${version}.tgz`, 'install.sh', 'install.ps1', '']
    );
    for (const line of lines.slice(0, 3)) {
      const [sum, name] = line.split('  ');
      assert.equal(sum, sha256(join(dir, name)), name);
    }
    assert.equal(readFileSync(join(dir, 'install.sh'), 'utf8'), readFileSync(installSh, 'utf8'));
    assert.equal(readFileSync(join(dir, 'install.ps1'), 'utf8'), readFileSync(installPs1, 'utf8'));
    assert.ok(existsSync(join(dir, `slicc-capture-${version}.tgz`)));
    assert.ok(!existsSync(join(dir, `ai-ecoverse-slicc-capture-${version}.tgz`)));
    const noEntry = release(
      undefined,
      '0.6.0',
      (source) => rmSync(join(source, 'host/sccapture.mjs')),
      1
    );
    assert.equal(
      noEntry.stderr,
      'scripts/assets.mjs: slicc-capture-0.6.0.tgz lacks host/sccapture.mjs (bin sccapture)\n'
    );
    const noBin = release(
      undefined,
      '0.6.1',
      (source) => {
        const path = join(source, 'package.json');
        const pkg = JSON.parse(readFileSync(path, 'utf8'));
        delete pkg.bin;
        writeFileSync(path, JSON.stringify(pkg));
      },
      1
    );
    assert.equal(
      noBin.stderr,
      'scripts/assets.mjs: slicc-capture-0.6.1.tgz lacks a package.json with bin\n'
    );
    const bad = spawnSync(process.execPath, [join(root, 'scripts/assets.mjs'), dir, 'nope']);
    assert.equal(bad.status, 2);
    const none = spawnSync(process.execPath, [join(root, 'scripts/assets.mjs'), scratch, '1.0.0']);
    assert.equal(none.status, 1);
  });
});

describe('install.sh', { skip: !curl && 'curl is not installed' }, () => {
  let dir;
  before(() => {
    dir = release();
  });

  it('is POSIX sh', () => {
    for (const shell of ['dash', 'sh']) {
      if (!which(shell)) continue;
      assert.equal(spawnSync(shell, ['-n', installSh]).status, 0, shell);
    }
  });

  it('installs the latest tarball into a versioned directory and a launcher into --dir', async () => {
    const h = home();
    const bin = join(h, 'my bin');
    const result = await run('sh', [installSh, '--dir', bin], {
      env: env({ HOME: h, SLICC_INSTALL_BASE_URL: pathToFileURL(dir).href }),
    });
    assert.equal(result.status, 0, result.stderr);
    const launcher = join(bin, 'sccapture');
    assert.match(
      result.stdout,
      new RegExp(`^sccapture ${version.replaceAll('.', '\\.')} installed to ${launcher}\n`)
    );
    const entry = join(h, '.local/share/slicc-capture', version, 'host/sccapture.mjs');
    assert.ok(existsSync(entry));
    assert.ok(!existsSync(join(h, '.local/share/slicc-capture', version, 'node_modules')));
    const text = readFileSync(launcher, 'utf8');
    assert.ok(text.includes(`'${entry}' "$@"`), text);
    const reported = await run(launcher, ['--version'], { env: env({}) });
    assert.equal(reported.stdout, `${version}\n`);
    const printed = await run(launcher, [], { env: env({}) });
    assert.equal(printed.status, 2);
  });

  for (const field of ['dependencies', 'optionalDependencies']) {
    it(`installs ${field} with npm when package.json has some`, async () => {
      const withDep = release(undefined, '0.8.0', depending(`file:${dependency()}`, field));
      const h = home();
      const result = await run('sh', [installSh, '--version', '0.8.0', '--dir', join(h, 'bin')], {
        env: env({ HOME: h, SLICC_INSTALL_BASE_URL: pathToFileURL(withDep).href, ...npmCache() }),
      });
      assert.equal(result.status, 0, result.stderr);
      const installed = join(
        h,
        '.local/share/slicc-capture/0.8.0/node_modules/sccapture-test-dep/index.js'
      );
      assert.equal(readFileSync(installed, 'utf8'), 'module.exports = 42;\n');
      assert.equal(
        result.stdout.split('\n')[0],
        `sccapture 0.8.0 installed to ${join(h, 'bin', 'sccapture')}`
      );
    });
  }

  it('fails with exit 1 and leaves no version directory when npm install fails', async () => {
    const broken = release(undefined, '0.7.0', depending(`file:${join(scratch, 'missing.tgz')}`));
    const h = home();
    const result = await run('sh', [installSh, '--version', '0.7.0', '--dir', join(h, 'bin')], {
      env: env({ HOME: h, SLICC_INSTALL_BASE_URL: pathToFileURL(broken).href, ...npmCache() }),
    });
    assert.equal(result.status, 1);
    assert.match(
      result.stderr,
      /install\.sh: npm install failed for slicc-capture-0\.7\.0\.tgz\n$/
    );
    assert.deepEqual(readdirSync(join(h, '.local/share/slicc-capture')), []);
    assert.ok(!existsSync(join(h, 'bin', 'sccapture')));
  });

  it('takes --version, and XDG_DATA_HOME for the data', async () => {
    const h = home();
    const data = join(h, 'data');
    const result = await run(
      'sh',
      [installSh, '--version', `v${version}`, `--dir=${join(h, 'b')}`],
      {
        env: env({ HOME: h, XDG_DATA_HOME: data, SLICC_INSTALL_BASE_URL: pathToFileURL(dir).href }),
      }
    );
    assert.equal(result.status, 0, result.stderr);
    assert.ok(existsSync(join(data, 'slicc-capture', version, 'host/sccapture.mjs')));
    const missing = await run('sh', [installSh, '--version', '0.0.0-nope', '--dir', join(h, 'c')], {
      env: env({ HOME: h, SLICC_INSTALL_BASE_URL: pathToFileURL(dir).href }),
    });
    assert.equal(missing.status, 1);
    assert.match(missing.stderr, /could not download .*slicc-capture-0\.0\.0-nope\.tgz/);
  });

  it('accepts the older `sccapture <version>` from --version, and nothing else', async () => {
    for (const [said, status] of [
      [`sccapture ${version}`, 0],
      ['9.9.9', 1],
    ]) {
      const old = release(undefined, version, (source) =>
        writeFileSync(
          join(source, 'host', 'sccapture.mjs'),
          `console.log(${JSON.stringify(said)});\n`
        )
      );
      const h = home();
      const result = await run('sh', [installSh, '--dir', join(h, 'bin')], {
        env: env({ HOME: h, SLICC_INSTALL_BASE_URL: pathToFileURL(old).href }),
      });
      assert.equal(result.status, status, result.stderr);
      if (status) assert.match(result.stderr, /reports 9\.9\.9, not /);
      else
        assert.match(
          result.stdout,
          new RegExp(`^sccapture ${version.replaceAll('.', '\\.')} installed`)
        );
    }
  });

  it('writes a launcher that survives a hostile --dir', async () => {
    const h = home();
    const bin = join(h, 'it\'s $(touch PWNED) `x` "q"');
    const result = await run('sh', [installSh, '--dir', bin], {
      env: env({ HOME: h, SLICC_INSTALL_BASE_URL: pathToFileURL(dir).href }),
      cwd: h,
    });
    assert.equal(result.status, 0, result.stderr);
    const launched = await run(join(bin, 'sccapture'), ['--version'], { env: env({}), cwd: h });
    assert.equal(launched.stdout, `${version}\n`);
    const marker = readFileSync(join(bin, 'sccapture'), 'utf8').split('\n')[1];
    const parsed = spawnSync('sh', ['-c', `${marker}; printf %s "$SCCAPTURE_INSTALL_DIR"`], {
      encoding: 'utf8',
      cwd: h,
    });
    assert.equal(parsed.stdout, bin);
    assert.ok(!existsSync(join(h, 'PWNED')));
  });

  it('refuses a tarball that does not match SHA256SUMS', async () => {
    const bad = mkdtempSync(join(scratch, 'bad-'));
    cpSync(dir, bad, { recursive: true });
    writeFileSync(join(bad, `slicc-capture-${version}.tgz`), 'tampered');
    const h = home();
    const result = await run('sh', [installSh, '--dir', join(h, 'bin')], {
      env: env({ HOME: h, SLICC_INSTALL_BASE_URL: pathToFileURL(bad).href }),
    });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /^install\.sh: checksum mismatch for slicc-capture-/);
    assert.ok(!existsSync(join(h, 'bin', 'sccapture')));
  });

  it('handles its options before it needs HOME, which only the default directories need', async () => {
    const bare = env({});
    delete bare.HOME;
    const help = await run('sh', [installSh, '--help'], { env: bare });
    assert.equal(help.status, 0, help.stderr);
    assert.match(help.stdout, /^usage: install\.sh /);
    assert.equal((await run('sh', [installSh, '--nope'], { env: bare })).status, 2);
    for (const args of [[], ['--dir', join(scratch, 'nohome-bin')]]) {
      const result = await run('sh', [installSh, ...args], { env: bare });
      assert.equal(result.status, 1, args.join(' '));
      assert.equal(
        result.stderr,
        'install.sh: HOME is not set; give --dir and set XDG_DATA_HOME\n'
      );
    }
    const data = mkdtempSync(join(scratch, 'nohome-data-'));
    const bin = join(data, 'bin');
    const result = await run('sh', [installSh, '--dir', bin], {
      env: { ...bare, XDG_DATA_HOME: data, SLICC_INSTALL_BASE_URL: pathToFileURL(dir).href },
    });
    assert.equal(result.status, 0, result.stderr);
    assert.ok(existsSync(join(data, 'slicc-capture', version, 'host/sccapture.mjs')));
  });

  it('writes a launcher that sets NODE_USE_ENV_PROXY=1 only when it is unset', async () => {
    const h = home();
    const bin = join(h, 'bin');
    const result = await run('sh', [installSh, '--dir', bin], {
      env: env({ HOME: h, SLICC_INSTALL_BASE_URL: pathToFileURL(dir).href }),
    });
    assert.equal(result.status, 0, result.stderr);
    const lines = readFileSync(join(bin, 'sccapture'), 'utf8').trimEnd().split('\n');
    assert.match(lines.at(-1), /^exec /);
    const probe = [
      ...lines.slice(0, -1),
      'printf "%s|%s" "$NODE_USE_ENV_PROXY" "$SCCAPTURE_INSTALL_DIR"',
    ].join('\n');
    const unset = env({});
    delete unset.NODE_USE_ENV_PROXY;
    for (const [extra, expected] of [
      [{}, `1|${bin}`],
      [{ NODE_USE_ENV_PROXY: '0' }, `0|${bin}`],
    ]) {
      const shown = spawnSync('sh', ['-c', probe], {
        env: { ...unset, ...extra },
        encoding: 'utf8',
      });
      assert.equal(shown.stdout, expected);
    }
  });

  it('prints its usage, and rejects bad options with exit 2', async () => {
    const help = await run('sh', [installSh, '--help'], { env: env({}) });
    assert.equal(help.status, 0);
    assert.match(help.stdout, /^usage: install\.sh \[--version VERSION\] \[--dir DIR\] \[--help\]/);
    for (const args of [['--nope'], ['--dir'], ['--version']]) {
      const result = await run('sh', [installSh, ...args], { env: env({}) });
      assert.equal(result.status, 2, args.join(' '));
      assert.match(result.stderr, /^install\.sh: /);
    }
  });

  it('downloads Node 24 as .tar.gz when PATH has none or an older one', async () => {
    const os = { darwin: 'darwin', linux: 'linux' }[process.platform];
    const arch = { x64: 'x64', arm64: 'arm64' }[process.arch];
    if (!os || !arch) return;
    const dist = mkdtempSync(join(scratch, 'dist-'));
    const name = `node-v24.99.0-${os}-${arch}`;
    mkdirSync(join(dist, 'build', name, 'bin'), { recursive: true });
    writeFileSync(
      join(dist, 'build', name, 'bin', 'node'),
      `#!/bin/sh\nexec '${process.execPath}' "$@"\n`
    );
    chmodSync(join(dist, 'build', name, 'bin', 'node'), 0o755);
    mkdirSync(join(dist, 'v24.99.0'));
    const archive = join(dist, 'v24.99.0', `${name}.tar.gz`);
    const tar = spawnSync('sh', [
      '-c',
      'tar czf "$3" -C "$1" "$2"',
      'sh',
      join(dist, 'build'),
      name,
      archive,
    ]);
    assert.equal(tar.status, 0, String(tar.stderr));
    const sum = sha256(archive);
    writeFileSync(
      join(dist, 'v24.99.0', 'SHASUMS256.txt'),
      `${'0'.repeat(64)}  ${name}.tar.xz\n${sum}  ${name}.tar.gz\n`
    );
    writeFileSync(
      join(dist, 'index.json'),
      JSON.stringify([
        { version: 'v25.0.0', lts: false },
        { version: 'v24.99.0', lts: 'Krypton' },
        { version: 'v22.0.0', lts: 'Jod' },
      ])
    );
    const bin = mkdtempSync(join(scratch, 'tools-'));
    for (const tool of [
      'sh',
      'uname',
      'curl',
      'sha256sum',
      'shasum',
      'cut',
      'grep',
      'sed',
      'head',
      'tr',
      'awk',
      'mktemp',
      'mkdir',
      'rm',
      'mv',
      'chmod',
      'cat',
      'dirname',
      'basename',
      'tar',
      'gzip',
      'ldd',
      'perl',
    ]) {
      const path = which(tool);
      if (path) symlinkSync(path, join(bin, tool));
    }
    writeFileSync(join(bin, 'node'), '#!/bin/sh\necho v20.0.0\n');
    chmodSync(join(bin, 'node'), 0o755);
    const h = home();
    const result = await run(join(bin, 'sh'), [installSh, '--dir', join(h, 'bin')], {
      env: env({
        HOME: h,
        PATH: bin,
        SLICC_INSTALL_BASE_URL: pathToFileURL(dir).href,
        SLICC_NODE_DIST_BASE: pathToFileURL(dist).href,
      }),
    });
    assert.equal(result.status, 0, result.stderr);
    const managed = join(h, '.local/share/slicc-capture/node/bin/node');
    assert.match(result.stderr, /Node v24\.99\.0 installed to /);
    assert.ok(readFileSync(join(h, 'bin', 'sccapture'), 'utf8').includes(`'${managed}'`));
    writeFileSync(join(dist, 'index.json'), '[]');
    const again = await run(join(bin, 'sh'), [installSh, '--dir', join(h, 'bin')], {
      env: env({
        HOME: h,
        PATH: bin,
        SLICC_INSTALL_BASE_URL: pathToFileURL(dir).href,
        SLICC_NODE_DIST_BASE: pathToFileURL(dist).href,
      }),
    });
    assert.equal(again.status, 0, again.stderr);
    assert.doesNotMatch(again.stderr, /downloading/);
    const fresh = home();
    const none = await run(join(bin, 'sh'), [installSh, '--dir', join(fresh, 'bin')], {
      env: env({
        HOME: fresh,
        PATH: bin,
        SLICC_INSTALL_BASE_URL: pathToFileURL(dir).href,
        SLICC_NODE_DIST_BASE: pathToFileURL(dist).href,
      }),
    });
    assert.equal(none.status, 1);
    assert.match(none.stderr, /no Node 24 or later in /);
  });
});

describe('--upgrade through the installer', { skip: !curl && 'curl is not installed' }, () => {
  let server;
  let url;
  const served = mkdtempSync(join(scratch, 'served-'));
  before(async () => {
    server = createServer((request, response) => {
      const path = join(served, decodeURIComponent(request.url));
      if (!path.startsWith(served) || !existsSync(path)) {
        response.writeHead(404);
        response.end();
        return;
      }
      response.writeHead(200);
      response.end(readFileSync(path));
    });
    await new Promise((done) => server.listen(0, '127.0.0.1', done));
    url = `http://127.0.0.1:${server.address().port}`;
  });
  after(() => server.close());

  it('replaces the installed version in place, then says it is up to date', async () => {
    const h = home();
    const bin = join(h, 'bin');
    const first = await run('sh', [installSh, '--dir', bin], {
      env: env({ HOME: h, SLICC_INSTALL_BASE_URL: pathToFileURL(release()).href }),
    });
    assert.equal(first.status, 0, first.stderr);
    release(served, '99.0.0');
    const launcher = join(bin, 'sccapture');
    const upgraded = await run(launcher, ['--upgrade'], {
      env: env({ HOME: h, SLICC_INSTALL_BASE_URL: url }),
    });
    assert.equal(upgraded.status, 0, upgraded.stderr);
    assert.equal(upgraded.stdout, `sccapture: ${version} → 99.0.0\n`);
    assert.equal((await run(launcher, ['--version'], { env: env({}) })).stdout, '99.0.0\n');
    const again = await run(launcher, ['--upgrade'], {
      env: env({ HOME: h, SLICC_INSTALL_BASE_URL: url }),
    });
    assert.equal(again.stdout, 'sccapture: already up to date (99.0.0)\n');
    rmSync(join(served, 'SHA256SUMS'));
    const broken = await run(launcher, ['--upgrade'], {
      env: env({ HOME: h, SLICC_INSTALL_BASE_URL: url }),
    });
    assert.equal(broken.status, 1);
    assert.equal(broken.stdout, '');
    assert.match(broken.stderr, /install\.sh: could not download .*SHA256SUMS/);
  });
});

describe('install.ps1', () => {
  const text = readFileSync(installPs1, 'utf8');

  it('takes -Version, -Dir and -Help, checks SHA256SUMS and never runs cmd or iex', () => {
    assert.match(
      text,
      /^param\(\n {2}\[string\]\$Version = '',\n {2}\[string\]\$Dir = '',\n {2}\[switch\]\$Help\n\)/
    );
    assert.match(text, /SHA256SUMS/);
    assert.match(text, /Get-FileHash -Algorithm SHA256/);
    assert.match(text, /SHASUMS256\.txt/);
    assert.match(text, /\$env:LOCALAPPDATA/);
    assert.match(text, /SCCAPTURE_INSTALL_DIR/);
    assert.doesNotMatch(text, /Invoke-Expression|\biex\b|cmd(\.exe)? \/c|Start-Process/i);
    assert.doesNotMatch(text, /^\s*exit\b/m);
    assert.match(
      text,
      /if \(\$LASTEXITCODE -ne 0 -or \("\$Reported" -ne "\$BundleVersion" -and "\$Reported" -ne "\$BinName \$BundleVersion"\)\)/
    );
    assert.ok(text.includes(`'if not defined NODE_USE_ENV_PROXY set "NODE_USE_ENV_PROXY=1"',`));
    assert.match(text, /Write-Output "To undo: \[Environment\]::SetEnvironmentVariable\('Path', /);
    assert.match(text, /@\('Restricted', 'AllSigned', 'Undefined'\) -contains \$policy/);
    assert.doesNotMatch(text, /^\s*Set-ExecutionPolicy/m);
    for (const line of [
      "'$sccapturePrevious = $env:SCCAPTURE_INSTALL_DIR',",
      "'$sccaptureProxy = $env:NODE_USE_ENV_PROXY',",
      "'$sccaptureMode = Get-Variable -Name PSNativeCommandArgumentPassing -ValueOnly -ErrorAction SilentlyContinue',",
      "'$sccaptureLegacy = $PSVersionTable.PSVersion.Major -lt 7 -or \"$sccaptureMode\" -eq ''Legacy'' -or ($null -eq $sccaptureMode -and $PSVersionTable.PSVersion.Major -eq 7 -and $PSVersionTable.PSVersion.Minor -lt 3)',",
      "'$sccaptureArgs = @(foreach ($sccaptureArg in $args) { foreach ($sccaptureItem in @($sccaptureArg)) {',",
      "'if ($null -eq $sccaptureProxy) { $env:NODE_USE_ENV_PROXY = ''1'' }',",
      "'  if ($null -eq $sccaptureProxy) { Remove-Item -LiteralPath Env:NODE_USE_ENV_PROXY -ErrorAction SilentlyContinue }',",
      "'try {',",
      "'  $sccaptureStatus = $LASTEXITCODE',",
      "'} finally {',",
      "'  if ($null -eq $sccapturePrevious) { Remove-Item -LiteralPath Env:SCCAPTURE_INSTALL_DIR -ErrorAction SilentlyContinue } else { $env:SCCAPTURE_INSTALL_DIR = $sccapturePrevious }',",
      "'exit $sccaptureStatus',",
    ]) {
      assert.ok(text.includes(line), line);
    }
    assert.ok(text.includes('`" %* & call :done %%ERRORLEVEL%% & call exit /b %%ERRORLEVEL%%",\n'));
    assert.doesNotMatch(text, /^\s+'\(',$/m);
  });

  const pwsh = ['pwsh', 'pwsh.exe'].find(
    (name) => spawnSync(name, ['-NoProfile', '-Command', 'exit 0']).status === 0
  );
  it('parses, installs and writes sccapture.ps1 and sccapture.cmd in a real PowerShell', {
    skip: !pwsh && 'pwsh is not installed',
  }, async () => {
    const parse = spawnSync(
      pwsh,
      [
        '-NoProfile',
        '-Command',
        '$e = $null; [void][System.Management.Automation.Language.Parser]::ParseFile($env:SCCAPTURE_PS1, [ref]$null, [ref]$e); if ($e) { $e | ForEach-Object { $_.Message }; exit 1 }',
      ],
      { encoding: 'utf8', env: env({ SCCAPTURE_PS1: installPs1 }) }
    );
    assert.equal(parse.status, 0, parse.stdout);
    const served = release();
    const server = createServer((request, response) => {
      const path = join(served, decodeURIComponent(request.url));
      if (!existsSync(path)) {
        response.writeHead(404);
        response.end();
        return;
      }
      response.end(readFileSync(path));
    });
    await new Promise((done) => server.listen(0, '127.0.0.1', done));
    try {
      const url = `http://127.0.0.1:${server.address().port}`;
      const local = home();
      const bin = join(local, "my 'bin'");
      const result = await run(
        pwsh,
        ['-NoProfile', '-NonInteractive', '-File', installPs1, '-Dir', bin],
        {
          env: env({ LOCALAPPDATA: local, SLICC_INSTALL_BASE_URL: url }),
        }
      );
      assert.equal(result.status, 0, result.stderr);
      assert.equal(
        result.stdout.split(/\r?\n/)[0],
        `sccapture ${version} installed to ${join(bin, 'sccapture.ps1')}`
      );
      const entry = join(local, 'slicc-capture', version, 'host', 'sccapture.mjs');
      assert.ok(existsSync(entry));
      const cmd = readFileSync(join(bin, 'sccapture.cmd'), 'utf8');
      const lines = cmd.split('\r\n');
      const at = lines.findIndex((line) =>
        line.endsWith(` "${entry}" %* & call :done %%ERRORLEVEL%% & call exit /b %%ERRORLEVEL%%`)
      );
      assert.deepEqual(
        lines.slice(at, at + 5),
        [lines[at], ':done', 'chcp %SCCAPTURE_CP% >nul', 'exit /b %1', ''],
        cmd
      );
      const launched = await run(
        pwsh,
        ['-NoProfile', '-File', join(bin, 'sccapture.ps1'), '--version'],
        { env: env({}) }
      );
      assert.equal(launched.stdout.trim(), version);
      const launcher = join(bin, 'sccapture.ps1').replaceAll("'", "''");
      const show = (name) =>
        `'${name}=' + $(if ($null -eq $env:${name}) { 'unset' } else { $env:${name} })`;
      for (const [before, after, proxy] of [
        ["$env:SCCAPTURE_INSTALL_DIR = 'before'; $env:NODE_USE_ENV_PROXY = '0'", 'before', '0'],
        [
          'Remove-Item Env:SCCAPTURE_INSTALL_DIR, Env:NODE_USE_ENV_PROXY -ErrorAction SilentlyContinue',
          'unset',
          'unset',
        ],
      ]) {
        const session = await run(
          pwsh,
          [
            '-NoProfile',
            '-NonInteractive',
            '-Command',
            `${before}; & '${launcher}' --nope 2>$null; 'code=' + $LASTEXITCODE; ${show('SCCAPTURE_INSTALL_DIR')}; ${show('NODE_USE_ENV_PROXY')}`,
          ],
          { env: env({}) }
        );
        assert.deepEqual(session.stdout.trim().split(/\r?\n/), [
          'code=2',
          `SCCAPTURE_INSTALL_DIR=${after}`,
          `NODE_USE_ENV_PROXY=${proxy}`,
        ]);
      }
      const probe = join(local, 'probe.mjs');
      writeFileSync(
        probe,
        'process.stdout.write(`${process.env.NODE_USE_ENV_PROXY}|${process.env.SCCAPTURE_INSTALL_DIR}`);\n'
      );
      const entry2 = join(local, 'slicc-capture', version, 'host', 'sccapture.mjs');
      const probing = join(local, 'probe.ps1');
      writeFileSync(
        probing,
        readFileSync(join(bin, 'sccapture.ps1'), 'utf8').replace(`'${entry2}'`, `'${probe}'`)
      );
      const seen = await run(
        pwsh,
        [
          '-NoProfile',
          '-NonInteractive',
          '-Command',
          `Remove-Item Env:NODE_USE_ENV_PROXY -ErrorAction SilentlyContinue; & '${probing}'`,
        ],
        { env: env({}) }
      );
      assert.equal(seen.stdout.trim(), `1|${bin}`);
      const argv = join(local, 'argv.mjs');
      writeFileSync(argv, 'process.stdout.write(JSON.stringify(process.argv.slice(2)));\n');
      const passing = join(local, 'argv.ps1');
      writeFileSync(
        passing,
        readFileSync(join(bin, 'sccapture.ps1'), 'utf8').replace(`'${entry2}'`, `'${argv}'`)
      );
      const tricky = ['a )&%^ b "q" c', 'x"y\\', 'sp ace\\', 'tail\\', '', "it's"];
      for (const mode of [
        "$PSNativeCommandArgumentPassing = 'Standard'",
        "$PSNativeCommandArgumentPassing = 'Legacy'",
        'Remove-Variable PSNativeCommandArgumentPassing',
      ]) {
        const passed = await run(
          pwsh,
          [
            '-NoProfile',
            '-NonInteractive',
            '-Command',
            `${mode}; $a = ConvertFrom-Json $env:T_ARGS; & '${passing}' @a; & '${passing}' a,'b c' d`,
          ],
          { env: env({ T_ARGS: JSON.stringify(tricky) }) }
        );
        const [all, list] = passed.stdout.split(/(?<=\])(?=\[)/).map((part) => JSON.parse(part));
        assert.deepEqual(all, tricky, `${mode}: ${passed.stderr}`);
        assert.deepEqual(list, ['a', 'b c', 'd'], mode);
      }
      const restricted = await run(
        pwsh,
        [
          '-NoProfile',
          '-NonInteractive',
          '-Command',
          `function Get-ExecutionPolicy { 'Restricted' }; & '${installPs1}' -Dir '${bin.replaceAll("'", "''")}'`,
        ],
        { env: env({ LOCALAPPDATA: local, SLICC_INSTALL_BASE_URL: url }) }
      );
      assert.equal(restricted.status, 0, restricted.stderr);
      assert.match(
        restricted.stderr,
        /install\.ps1: the execution policy is Restricted, so PowerShell won't run sccapture\.ps1; run Set-ExecutionPolicy -Scope CurrentUser RemoteSigned, or use sccapture\.cmd/
      );
      assert.doesNotMatch(result.stderr, /execution policy/);
      const help = await run(pwsh, ['-NoProfile', '-File', installPs1, '-Help'], { env: env({}) });
      assert.equal(help.status, 0);
      assert.match(help.stdout, /^usage: install\.ps1 \[-Version VERSION\] \[-Dir DIR\] \[-Help\]/);
      const missing = await run(
        pwsh,
        [
          '-NoProfile',
          '-NonInteractive',
          '-File',
          installPs1,
          '-Version',
          '0.0.0-nope',
          '-Dir',
          bin,
        ],
        {
          env: env({ LOCALAPPDATA: local, SLICC_INSTALL_BASE_URL: url }),
        }
      );
      assert.equal(missing.status, 1);
      assert.match(
        missing.stderr,
        /^install\.ps1: could not download .*slicc-capture-0\.0\.0-nope\.tgz/
      );
      const block = await run(
        pwsh,
        [
          '-NoProfile',
          '-NonInteractive',
          '-Command',
          `& ([scriptblock]::Create((Get-Content -Raw '${installPs1}'))) -Version 0.0.0-nope -Dir '${bin.replaceAll("'", "''")}'; 'still here'`,
        ],
        {
          env: env({ LOCALAPPDATA: local, SLICC_INSTALL_BASE_URL: url }),
        }
      );
      assert.equal(block.stdout.trim(), 'still here');
      release(served, '0.8.0', depending(`file:${dependency()}`));
      const deps = await run(
        pwsh,
        ['-NoProfile', '-NonInteractive', '-File', installPs1, '-Version', '0.8.0', '-Dir', bin],
        { env: env({ LOCALAPPDATA: local, SLICC_INSTALL_BASE_URL: url, ...npmCache() }) }
      );
      assert.equal(deps.status, 0, deps.stderr);
      assert.ok(
        existsSync(join(local, 'slicc-capture/0.8.0/node_modules/sccapture-test-dep/index.js'))
      );
      release(served, '0.7.0', depending(`file:${join(scratch, 'missing.tgz')}`));
      const failed = await run(
        pwsh,
        ['-NoProfile', '-NonInteractive', '-File', installPs1, '-Version', '0.7.0', '-Dir', bin],
        { env: env({ LOCALAPPDATA: local, SLICC_INSTALL_BASE_URL: url, ...npmCache() }) }
      );
      assert.equal(failed.status, 1);
      assert.match(
        failed.stderr,
        /install\.ps1: npm install failed for slicc-capture-0\.7\.0\.tgz/
      );
      assert.deepEqual(
        readdirSync(join(local, 'slicc-capture')).filter(
          (name) => !/^\d/.test(name) || name === '0.7.0'
        ),
        []
      );
    } finally {
      server.close();
    }
  });
  it('lives next to install.sh at the repo root', () => {
    assert.equal(dirname(installPs1), dirname(installSh));
  });
});
