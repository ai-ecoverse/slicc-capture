import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  copyFileSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { dirname, join, resolve, sep } from 'node:path';
import { after, before, describe, it } from 'node:test';
import { fakeExe } from './fake-windows.mjs';

const root = resolve(import.meta.dirname, '../..');
const version = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).version;
const installPs1 = join(root, 'install.ps1');
const onWindows = process.platform === 'win32';
const system = join(process.env.SystemRoot ?? 'C:\\Windows', 'System32');
const powershell = join(system, 'WindowsPowerShell', 'v1.0', 'powershell.exe');
const cmd = join(system, 'cmd.exe');
const magic = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

function withPath(env, value) {
  const out = {};
  for (const [key, entry] of Object.entries(env)) {
    if (key.toUpperCase() !== 'PATH') out[key] = entry;
  }
  out.PATH = value;
  return out;
}

function pathOf(env) {
  return Object.entries(env).find(([key]) => key.toUpperCase() === 'PATH')?.[1] ?? '';
}

function clean(extra = {}) {
  const out = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (
      !['SCCAPTURE_INSTALL_DIR', 'NODE_USE_ENV_PROXY', 'NODE_OPTIONS', 'PSMODULEPATH'].includes(
        key.toUpperCase()
      )
    ) {
      out[key] = value;
    }
  }
  return { ...out, ...extra };
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
    child.on('error', (error) => done({ status: -1, stdout, stderr: `${stderr}${error.message}` }));
    child.on('close', (status) => done({ status, stdout, stderr }));
  });
}

function lines(text) {
  return text.split(/\r?\n/).filter(Boolean);
}

function ps(shell, script, env) {
  return run(
    shell,
    ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script],
    { env }
  );
}

function batch(line, env) {
  return run(cmd, ['/d', '/s', '/c', `"${line}"`], { env, windowsVerbatimArguments: true });
}

function sha256(path) {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

function png(path) {
  const data = readFileSync(path);
  assert.deepEqual([...data.subarray(0, 8)], magic, path);
  return { width: data.readUInt32BE(16), height: data.readUInt32BE(20), size: data.length };
}

describe('on real Windows', { skip: !onWindows && 'not Windows' }, () => {
  let scratch;
  let server;
  let url;
  let served;
  let userPath;
  let pwsh;

  function npm(args, cwd) {
    const cli = /\.c?js$/.test(process.env.npm_execpath ?? '')
      ? process.env.npm_execpath
      : join(dirname(process.execPath), 'node_modules', 'npm', 'bin', 'npm-cli.js');
    return spawnSync(process.execPath, [cli, ...args], { cwd, encoding: 'utf8' });
  }

  function release(name, as) {
    const dir = join(served, name);
    mkdirSync(dir, { recursive: true });
    const source = mkdtempSync(join(scratch, 'source-'));
    for (const file of ['LICENSE', 'README.md', 'package.json', 'bin', 'host', 'page']) {
      cpSync(join(root, file), join(source, file), { recursive: true });
    }
    const pkg = JSON.parse(readFileSync(join(source, 'package.json'), 'utf8'));
    pkg.version = as;
    delete pkg.scripts;
    writeFileSync(join(source, 'package.json'), `${JSON.stringify(pkg, null, 2)}\n`);
    const pack = npm(['pack', '--ignore-scripts', '--pack-destination', dir], source);
    assert.equal(pack.status, 0, `${pack.stdout}${pack.stderr}${pack.error?.message ?? ''}`);
    const assets = spawnSync(process.execPath, [join(root, 'scripts', 'assets.mjs'), dir, as], {
      encoding: 'utf8',
    });
    assert.equal(assets.status, 0, assets.stderr);
    return `${url}/${name}`;
  }

  function install(shell, dir, local, base, extra = {}) {
    return run(
      shell,
      [
        '-NoProfile',
        '-NonInteractive',
        '-ExecutionPolicy',
        'Bypass',
        '-File',
        installPs1,
        '-Dir',
        dir,
      ],
      { env: clean({ LOCALAPPDATA: local, SLICC_INSTALL_BASE_URL: base, ...extra }) }
    );
  }

  function fakes() {
    const dir = mkdtempSync(join(scratch, 'fakes-'));
    const log = join(dir, 'calls.log');
    fakeExe(
      dir,
      'powershell.exe',
      [
        "const fs = require('node:fs');",
        "const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => key.toUpperCase().startsWith('SCCAPTURE_')));",
        'fs.appendFileSync(process.env.FAKE_LOG, JSON.stringify({ argv: process.argv.slice(2), env }) + "\\n");',
        "if (process.env.SCCAPTURE_FILE) fs.writeFileSync(process.env.SCCAPTURE_FILE, 'image');",
        '',
      ].join('\n')
    );
    const calls = () =>
      existsSync(log) ? lines(readFileSync(log, 'utf8')).map((line) => JSON.parse(line)) : [];
    return { dir, log, calls };
  }

  function probe() {
    const dir = mkdtempSync(join(scratch, 'probe-'));
    const log = join(dir, 'argv.log');
    const script = join(dir, 'argv.cjs');
    writeFileSync(
      script,
      "require('node:fs').appendFileSync(process.env.PROBE_LOG, JSON.stringify(process.argv.slice(2)) + '\\n');\nprocess.exit(0);\n"
    );
    const env = clean({ PROBE_LOG: log, NODE_OPTIONS: `--require "${script}"` });
    const seen = () =>
      existsSync(log) ? lines(readFileSync(log, 'utf8')).map((line) => JSON.parse(line)) : [];
    return { env, seen };
  }

  before(async () => {
    scratch = realpathSync.native(mkdtempSync(join(tmpdir(), 'slicc-capture-windows-')));
    served = join(scratch, 'served');
    mkdirSync(served);
    server = createServer((request, response) => {
      const path = resolve(served, `.${decodeURIComponent(request.url.split('?')[0])}`);
      if (!path.startsWith(served + sep) || !existsSync(path)) {
        response.writeHead(404);
        response.end();
        return;
      }
      response.writeHead(200);
      response.end(readFileSync(path));
    });
    await new Promise((done) => server.listen(0, '127.0.0.1', done));
    url = `http://127.0.0.1:${server.address().port}`;
    const saved = spawnSync(
      powershell,
      [
        '-NoProfile',
        '-NonInteractive',
        '-Command',
        "[Environment]::GetEnvironmentVariable('Path', 'User')",
      ],
      { encoding: 'utf8' }
    );
    userPath = saved.stdout.replace(/\r?\n$/, '');
    pwsh =
      spawnSync('pwsh', ['-NoProfile', '-Command', 'exit 0']).status === 0 ? 'pwsh' : undefined;
  });

  after(() => {
    server?.close();
    spawnSync(
      powershell,
      [
        '-NoProfile',
        '-NonInteractive',
        '-Command',
        "[Environment]::SetEnvironmentVariable('Path', $(if ($env:SLICC_USER_PATH) { $env:SLICC_USER_PATH } else { $null }), 'User')",
      ],
      { env: { ...process.env, SLICC_USER_PATH: userPath } }
    );
    if (scratch) rmSync(scratch, { recursive: true, force: true, maxRetries: 20 });
  });

  for (const shell of ['powershell.exe', 'pwsh']) {
    it(`installs with ${shell}, and both launchers run, keep their arguments and leak nothing`, async (t) => {
      const exe = shell === 'pwsh' ? pwsh : powershell;
      if (!exe) {
        t.skip('pwsh is not installed');
        return;
      }
      const base = release(`r-${shell}`, version);
      const local = mkdtempSync(join(scratch, 'local-'));
      const bin = join(local, "my 'bin' (x86) & 100%");
      const result = await install(exe, bin, local, base);
      assert.equal(result.status, 0, result.stderr);
      const out = lines(result.stdout);
      assert.equal(out[0], `sccapture ${version} installed to ${join(bin, 'sccapture.ps1')}`);
      assert.ok(existsSync(join(local, 'slicc-capture', version, 'host', 'sccapture.mjs')));
      const ps1 = join(bin, 'sccapture.ps1');
      const launcher = join(bin, 'sccapture.cmd');
      assert.deepEqual([...readFileSync(ps1).subarray(0, 3)], [0xef, 0xbb, 0xbf]);

      const env = clean();
      for (const argv of [['--version'], ['--help']]) {
        const viaCmd = await batch(`"${launcher}" ${argv.join(' ')}`, env);
        const viaPs = await ps(exe, `& $env:T_LAUNCHER ${argv.join(' ')}; exit $LASTEXITCODE`, {
          ...env,
          T_LAUNCHER: ps1,
        });
        for (const [how, got] of [
          ['cmd', viaCmd],
          ['ps1', viaPs],
        ]) {
          assert.equal(got.status, 0, `${how} ${argv}: ${got.stderr}`);
          if (argv[0] === '--version') assert.equal(got.stdout.trim(), version, how);
          else assert.match(got.stdout, /^usage: sccapture /, how);
        }
      }
      assert.equal((await batch(`"${launcher}" --nope`, env)).status, 2);
      assert.equal(
        (
          await ps(exe, '& $env:T_LAUNCHER --nope 2>$null; exit $LASTEXITCODE', {
            ...env,
            T_LAUNCHER: ps1,
          })
        ).status,
        2
      );

      const pages = await batch(`chcp & "${launcher}" --version & chcp`, env);
      const [before, , after] = lines(pages.stdout);
      assert.equal(before, after, pages.stdout);

      const leak = await batch(
        `"${launcher}" --version & set SCCAPTURE_INSTALL_DIR & set NODE_USE_ENV_PROXY`,
        env
      );
      assert.equal(leak.stdout.trim(), version, leak.stdout);
      const show = (name) =>
        `'${name}=' + $(if ($null -eq $env:${name}) { 'unset' } else { $env:${name} })`;
      for (const [setup, dir, proxy] of [
        ["$env:SCCAPTURE_INSTALL_DIR = 'before'; $env:NODE_USE_ENV_PROXY = '0'", 'before', '0'],
        ['', 'unset', 'unset'],
      ]) {
        const session = await ps(
          exe,
          `${setup}; & $env:T_LAUNCHER --version | Out-Null; 'code=' + $LASTEXITCODE; ${show('SCCAPTURE_INSTALL_DIR')}; ${show('NODE_USE_ENV_PROXY')}`,
          { ...env, T_LAUNCHER: ps1 }
        );
        assert.deepEqual(
          lines(session.stdout),
          ['code=0', `SCCAPTURE_INSTALL_DIR=${dir}`, `NODE_USE_ENV_PROXY=${proxy}`],
          session.stderr
        );
      }

      const argv = probe();
      const tricky = [
        'a )&%^ b "q" c',
        'x"y\\',
        'sp ace\\',
        'tail\\',
        '',
        '%SCCAPTURE_NOPE%',
        "it's",
      ];
      const typed = ['a )&%^ b "q" c', 'x"y" z', 'tail\\', '%SCCAPTURE_NOPE%'];
      const modes = shell === 'pwsh' ? ['', "$PSNativeCommandArgumentPassing = 'Legacy'; "] : [''];
      for (const mode of modes) {
        const viaPs = await ps(
          exe,
          `${mode}$a = ConvertFrom-Json $env:T_ARGS; & $env:T_LAUNCHER @a; exit $LASTEXITCODE`,
          { ...argv.env, T_LAUNCHER: ps1, T_ARGS: JSON.stringify(tricky) }
        );
        assert.equal(viaPs.status, 0, `${mode}${viaPs.stderr}`);
      }
      const viaCmd = await batch(
        `"${launcher}" "a )&%^ b \\"q\\" c" "x\\"y\\" z" tail\\ %SCCAPTURE_NOPE%`,
        argv.env
      );
      assert.equal(viaCmd.status, 0, viaCmd.stderr);
      assert.deepEqual(argv.seen(), [...modes.map(() => tricky), typed]);

      const fake = fakes();
      const work = mkdtempSync(join(scratch, 'work-'));
      const file = join(work, "a ) & ^ 'f' b.png");
      const faked = withPath(clean({ FAKE_LOG: fake.log }), `${fake.dir};${pathOf(process.env)}`);
      const shotPs = await ps(
        exe,
        "& $env:T_LAUNCHER -R '1,2,30,40' $env:T_FILE; exit $LASTEXITCODE",
        { ...faked, T_LAUNCHER: ps1, T_FILE: file, SCCAPTURE_SCREEN: 'stale' }
      );
      assert.equal(shotPs.status, 0, shotPs.stderr);
      const shotCmd = await batch(`"${launcher}" -C "${file}"`, faked);
      assert.equal(shotCmd.status, 0, shotCmd.stderr);
      assert.deepEqual(
        fake.calls().map((call) => call.env),
        [
          {
            SCCAPTURE_FILE: file,
            SCCAPTURE_FORMAT: 'png',
            SCCAPTURE_SCREEN: 'all',
            SCCAPTURE_RECT: '1,2,30,40',
          },
          {
            SCCAPTURE_FILE: file,
            SCCAPTURE_FORMAT: 'png',
            SCCAPTURE_SCREEN: 'all',
            SCCAPTURE_CURSOR: '1',
          },
        ]
      );
      for (const call of fake.calls()) {
        assert.deepEqual(call.argv.slice(0, 4), [
          '-NoProfile',
          '-NonInteractive',
          '-STA',
          '-EncodedCommand',
        ]);
      }
      assert.equal(readFileSync(file, 'utf8'), 'image');

      const added = out.find((line) => line.startsWith('Added '));
      const undo = out.find((line) => line.startsWith('To undo: '));
      if (shell === 'powershell.exe') {
        assert.equal(added, `Added ${bin} to your user PATH; open a new terminal to use sccapture`);
        const listed = await ps(
          powershell,
          "[Environment]::GetEnvironmentVariable('Path', 'User')",
          clean()
        );
        assert.ok(listed.stdout.trim().split(';').includes(bin), listed.stdout);
        const undone = await ps(
          powershell,
          `${undo.slice('To undo: '.length)}; [Environment]::GetEnvironmentVariable('Path', 'User')`,
          clean()
        );
        assert.equal(undone.status, 0, undone.stderr);
        assert.ok(!undone.stdout.trim().split(';').includes(bin), undone.stdout);
      }
    });
  }

  it('captures the real screen to a PNG from both launchers, from Windows PowerShell and pwsh', async () => {
    const local = mkdtempSync(join(scratch, 'local-'));
    const bin = join(local, 'bin');
    const installed = await install(powershell, bin, local, release('shot', version));
    assert.equal(installed.status, 0, installed.stderr);
    const work = mkdtempSync(join(scratch, 'shots-'));
    const runs = [
      ['cmd', (file, args) => batch(`"${join(bin, 'sccapture.cmd')}" ${args} "${file}"`, clean())],
      [
        'powershell.exe',
        (file, args) =>
          ps(powershell, `& $env:T_LAUNCHER ${args} $env:T_FILE; exit $LASTEXITCODE`, {
            ...clean(),
            T_LAUNCHER: join(bin, 'sccapture.ps1'),
            T_FILE: file,
          }),
      ],
    ];
    if (pwsh) {
      runs.push([
        'pwsh',
        (file, args) =>
          ps(pwsh, `& $env:T_LAUNCHER ${args} $env:T_FILE; exit $LASTEXITCODE`, {
            ...clean(),
            T_LAUNCHER: join(bin, 'sccapture.ps1'),
            T_FILE: file,
          }),
      ]);
    }
    for (const [how, shoot] of runs) {
      const whole = join(work, `${how} whole.png`);
      const full = await shoot(whole, '-x');
      assert.equal(full.status, 0, `${how}: ${full.stderr}`);
      const shot = png(whole);
      assert.ok(shot.width > 0 && shot.height > 0, `${how}: ${JSON.stringify(shot)}`);
      assert.ok(shot.size > 100, `${how}: ${JSON.stringify(shot)}`);
      assert.equal(statSync(whole).size, shot.size);
      const part = join(work, `${how} part.png`);
      const cut = await shoot(part, how === 'cmd' ? '-C -R 0,0,64,32' : "-C -R '0,0,64,32'");
      assert.equal(cut.status, 0, `${how}: ${cut.stderr}`);
      const piece = png(part);
      assert.deepEqual([piece.width, piece.height], [64, 32], how);
      console.log(`${how}: ${shot.width}x${shot.height}, ${shot.size} bytes`);
    }
  });

  it('upgrades in place from the installed sccapture.cmd and sccapture.ps1', async () => {
    const local = mkdtempSync(join(scratch, 'local-'));
    const bin = join(local, 'bin');
    const first = await install(powershell, bin, local, release('old', version));
    assert.equal(first.status, 0, first.stderr);
    const newer = release('new', '99.0.0');
    const modules = pwsh
      ? spawnSync(pwsh, ['-NoProfile', '-Command', '$env:PSModulePath'], {
          encoding: 'utf8',
        }).stdout.trim()
      : join(process.env.ProgramFiles, 'PowerShell', '7', 'Modules');
    const env = clean({
      LOCALAPPDATA: local,
      SLICC_INSTALL_BASE_URL: newer,
      PSModulePath: modules,
    });
    const upgraded = await batch(`"${join(bin, 'sccapture.cmd')}" --upgrade`, env);
    assert.equal(upgraded.status, 0, upgraded.stderr);
    assert.equal(upgraded.stdout, `sccapture: ${version} → 99.0.0\n`);
    const reported = await batch(`"${join(bin, 'sccapture.cmd')}" --version`, clean());
    assert.equal(reported.stdout.trim(), '99.0.0');
    assert.ok(existsSync(join(local, 'slicc-capture', '99.0.0', 'host', 'sccapture.mjs')));
    const again = await ps(powershell, '& $env:T_LAUNCHER --upgrade; exit $LASTEXITCODE', {
      ...env,
      T_LAUNCHER: join(bin, 'sccapture.ps1'),
    });
    assert.equal(again.status, 0, again.stderr);
    assert.equal(again.stdout.trim(), 'sccapture: already up to date (99.0.0)');
    if (pwsh) {
      const fromPwsh = await ps(pwsh, '& $env:T_LAUNCHER --upgrade; exit $LASTEXITCODE', {
        ...clean({ LOCALAPPDATA: local, SLICC_INSTALL_BASE_URL: newer }),
        T_LAUNCHER: join(bin, 'sccapture.ps1'),
      });
      assert.equal(fromPwsh.status, 0, fromPwsh.stderr);
      assert.equal(fromPwsh.stdout.trim(), 'sccapture: already up to date (99.0.0)');
    }
  });

  it('downloads Node as a .zip when PATH has none, and the launchers use it', async () => {
    const arch = { AMD64: 'x64', ARM64: 'arm64' }[process.env.PROCESSOR_ARCHITECTURE];
    const dist = join(served, 'dist');
    const name = `node-v24.99.0-win-${arch}`;
    const build = join(scratch, 'build');
    mkdirSync(join(build, name), { recursive: true });
    copyFileSync(process.execPath, join(build, name, 'node.exe'));
    mkdirSync(join(dist, 'v24.99.0'), { recursive: true });
    const archive = join(dist, 'v24.99.0', `${name}.zip`);
    const zipped = spawnSync(
      join(system, 'tar.exe'),
      ['-a', '-c', '--options', 'zip:compression=store', '-f', `${name}.zip`, '-C', build, name],
      { cwd: dirname(archive), encoding: 'utf8' }
    );
    assert.equal(zipped.status, 0, zipped.stderr);
    writeFileSync(
      join(dist, 'v24.99.0', 'SHASUMS256.txt'),
      `${'0'.repeat(64)}  ${name}.7z\n${sha256(archive)}  ${name}.zip\n`
    );
    writeFileSync(
      join(dist, 'index.json'),
      JSON.stringify([
        { version: 'v25.0.0', lts: false },
        { version: 'v24.99.0', lts: 'Krypton' },
        { version: 'v22.0.0', lts: 'Jod' },
      ])
    );
    const local = mkdtempSync(join(scratch, 'local-'));
    const bin = join(local, 'bin');
    const bare = `${system};${dirname(system)};${dirname(powershell)}`;
    const result = await run(
      powershell,
      [
        '-NoProfile',
        '-NonInteractive',
        '-ExecutionPolicy',
        'Bypass',
        '-File',
        installPs1,
        '-Dir',
        bin,
      ],
      {
        env: withPath(
          clean({
            LOCALAPPDATA: local,
            SLICC_INSTALL_BASE_URL: release('zip', version),
            SLICC_NODE_DIST_BASE: `${url}/dist`,
          }),
          bare
        ),
      }
    );
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stderr, /Node v24\.99\.0 installed to /);
    const managed = join(local, 'slicc-capture', 'node', 'node.exe');
    assert.ok(existsSync(managed));
    assert.ok(readFileSync(join(bin, 'sccapture.ps1'), 'utf8').includes(`'${managed}'`));
    assert.ok(readFileSync(join(bin, 'sccapture.cmd'), 'utf8').includes(`"${managed}"`));
    const reported = await batch(
      `"${join(bin, 'sccapture.cmd')}" --version`,
      withPath(clean(), bare)
    );
    assert.equal(reported.stdout.trim(), version, reported.stderr);
  });
});
