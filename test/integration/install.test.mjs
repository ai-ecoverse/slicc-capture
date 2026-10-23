import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  chmodSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { delimiter, join, resolve } from 'node:path';
import { after, before, describe, it } from 'node:test';
import { pathToFileURL } from 'node:url';

const root = resolve(import.meta.dirname, '../..');
const script = join(root, 'install.sh');
const ps1 = join(root, 'install.ps1');
const nodeVersion = '24.11.0';
const realNode = process.execPath;
const sha = (file) => createHash('sha256').update(readFileSync(file)).digest('hex');

const find = (name, path = process.env.PATH) =>
  path
    .split(delimiter)
    .map((dir) => join(dir, name))
    .find((file) => existsSync(file));

const tools = [
  'sh',
  'uname',
  'mkdir',
  'rm',
  'mv',
  'ln',
  'chmod',
  'cat',
  'cp',
  'grep',
  'sed',
  'cut',
  'head',
  'tar',
  'gzip',
  'mktemp',
  'dirname',
  'basename',
  'tr',
  'sha256sum',
  'shasum',
];

const write = (file, text, mode = 0o644) => {
  mkdirSync(resolve(file, '..'), { recursive: true });
  writeFileSync(file, text);
  chmodSync(file, mode);
};

const fakeNode = (file, version) =>
  write(
    file,
    `#!/bin/sh\nif [ "$1" = --version ]; then echo v${version}; exit 0; fi\nexec '${realNode}' "$@"\n`,
    0o755
  );

const tar = (dir, file) => {
  const run = spawnSync('tar', ['-czf', file, '-C', dir, 'package'], { encoding: 'utf8' });
  assert.equal(run.status, 0, run.stderr);
};

let fixture;
const runs = [];

const release = (version) => {
  const pkg = join(fixture, 'src', version);
  write(
    join(pkg, 'package', 'host', 'sccapture.mjs'),
    `if (process.argv[2] === '--version') console.log('${version}');\nelse console.log(JSON.stringify(process.argv.slice(2)));\n`
  );
  write(join(pkg, 'package', 'package.json'), `{"version":"${version}"}\n`);
  const dir = join(fixture, 'releases', 'download', `v${version}`);
  mkdirSync(dir, { recursive: true });
  const tarball = `slicc-capture-${version}.tgz`;
  tar(pkg, join(dir, tarball));
  for (const name of ['install.sh', 'install.ps1']) cpSync(join(root, name), join(dir, name));
  write(
    join(dir, 'SHA256SUMS'),
    [tarball, 'install.sh', 'install.ps1']
      .map((name) => `${sha(join(dir, name))}  ${name}\n`)
      .join('')
  );
  return dir;
};

const nodeDist = (os, arch) => {
  const base = `node-v${nodeVersion}-${os}-${arch}`;
  const dist = join(fixture, 'node', `v${nodeVersion}`);
  const src = join(fixture, 'src', base);
  fakeNode(join(src, base, 'bin', 'node'), nodeVersion);
  mkdirSync(dist, { recursive: true });
  const run = spawnSync('tar', ['-czf', join(dist, `${base}.tar.gz`), '-C', src, base]);
  assert.equal(run.status, 0);
  return { base, dist };
};

before(() => {
  fixture = realpathSync(mkdtempSync(join(tmpdir(), 'slicc-capture-install-')));
  release('1.0.0');
  const latest = release('1.1.0');
  cpSync(latest, join(fixture, 'releases', 'latest', 'download'), { recursive: true });
  write(
    join(fixture, 'node', 'index.json'),
    `[\n{"version":"v25.1.0","files":["linux-x64"],"lts":false},\n{"version":"v${nodeVersion}","files":["linux-x64"],"lts":"Krypton"},\n{"version":"v22.20.0","files":["linux-x64"],"lts":"Jod"}\n]\n`
  );
  const sums = [
    ['linux', 'x64'],
    ['darwin', 'arm64'],
  ].map(([os, arch]) => {
    const { base, dist } = nodeDist(os, arch);
    return `${sha(join(dist, `${base}.tar.gz`))}  ${base}.tar.gz\n`;
  });
  write(join(fixture, 'node', `v${nodeVersion}`, 'SHASUMS256.txt'), sums.join(''));
});

after(() => {
  for (const dir of [fixture, ...runs]) rmSync(dir, { recursive: true, force: true });
});

const setup = ({
  node = '24.1.0',
  curl = true,
  wget = false,
  uname = ['Linux', 'x86_64'],
  ldd,
} = {}) => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'slicc-capture-run-')));
  runs.push(dir);
  const bin = join(dir, 'bin');
  const sys = join(dir, 'sys');
  mkdirSync(bin, { recursive: true });
  mkdirSync(sys, { recursive: true });
  for (const tool of tools) {
    const real = find(
      tool,
      `${process.env.PATH}${delimiter}/usr/bin${delimiter}/bin${delimiter}/sbin`
    );
    if (real) symlinkSync(real, join(sys, tool));
  }
  const log = join(dir, 'fetch.log');
  if (curl) {
    write(
      join(bin, 'curl'),
      `#!/bin/sh\nout=\nurl=\nwhile [ $# -gt 0 ]; do case "$1" in -o) out="$2"; shift 2 ;; -*) shift ;; *) url="$1"; shift ;; esac; done\nprintf 'curl %s\\n' "$url" >>'${log}'\nfile="\${url#file://}"\n[ -f "$file" ] || exit 22\ncp "$file" "$out"\n`,
      0o755
    );
  }
  if (wget) {
    write(
      join(bin, 'wget'),
      `#!/bin/sh\nout=\nurl=\nwhile [ $# -gt 0 ]; do case "$1" in -O) out="$2"; shift 2 ;; -*) shift ;; *) url="$1"; shift ;; esac; done\nprintf 'wget %s\\n' "$url" >>'${log}'\nfile="\${url#file://}"\n[ -f "$file" ] || exit 8\ncp "$file" "$out"\n`,
      0o755
    );
  }
  if (uname) {
    write(
      join(bin, 'uname'),
      `#!/bin/sh\ncase "$1" in -s) echo ${uname[0]} ;; -m) echo ${uname[1]} ;; *) echo ${uname[0]} ;; esac\n`,
      0o755
    );
  }
  if (ldd) write(join(bin, 'ldd'), `#!/bin/sh\necho '${ldd}' >&2\n`, 0o755);
  if (node) fakeNode(join(bin, 'node'), node);
  const home = join(dir, 'home');
  mkdirSync(home, { recursive: true });
  const env = {
    PATH: `${bin}${delimiter}${sys}`,
    HOME: home,
    SLICC_INSTALL_BASE_URL: pathToFileURL(join(fixture, 'releases')).href,
    SLICC_NODE_DIST_BASE: pathToFileURL(join(fixture, 'node')).href,
  };
  const run = (args = [], extra = {}) =>
    spawnSync(join(sys, 'sh'), [script, ...args], { env: { ...env, ...extra }, encoding: 'utf8' });
  const fetched = () => (existsSync(log) ? readFileSync(log, 'utf8') : '');
  const data = join(home, '.local', 'share', 'slicc-capture');
  return {
    dir,
    bin,
    home,
    data,
    env,
    run,
    fetched,
    launcher: join(home, '.local', 'bin', 'sccapture'),
  };
};

const spawnAsync = (command, args, options) =>
  new Promise((ok, fail) => {
    const child = spawn(command, args, options);
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8').on('data', (chunk) => {
      stdout += chunk;
    });
    child.stderr.setEncoding('utf8').on('data', (chunk) => {
      stderr += chunk;
    });
    child.on('error', fail);
    child.on('close', (status) => ok({ status, stdout, stderr }));
  });

const launch = (launcher, args) => spawnSync(launcher, args, { encoding: 'utf8' });

describe('install.sh', () => {
  it('is POSIX sh that shellcheck and dash accept, and lint checks it', () => {
    const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
    assert.match(pkg.scripts.lint, /shellcheck -s sh install\.sh/);
    assert.match(pkg.scripts.lint, /dash -n install\.sh/);
    assert.match(readFileSync(script, 'utf8'), /^#!\/bin\/sh\n/);
  });

  it('installs the latest release with the node on PATH', () => {
    const t = setup();
    const run = t.run();
    assert.equal(run.status, 0, run.stderr);
    assert.equal(run.stderr, '');
    const dir = join(t.home, '.local', 'bin');
    assert.equal(
      run.stdout,
      `sccapture 1.1.0 installed to ${t.launcher}\n${dir} is not on PATH; add it with: export PATH="${dir}:$PATH"\n`
    );
    assert.equal(readlinkSync(join(t.data, 'current')), '1.1.0');
    const text = readFileSync(t.launcher, 'utf8');
    assert.equal(
      text,
      `#!/bin/sh\nexec '${join(t.bin, 'node')}' '${join(t.data, '1.1.0', 'host', 'sccapture.mjs')}' "$@"\n`
    );
    assert.equal(launch(t.launcher, ['--version']).stdout, '1.1.0\n');
    assert.equal(launch(t.launcher, ['-c', 'a b']).stdout, '["-c","a b"]\n');
    assert.match(
      t.fetched(),
      /latest\/download\/SHA256SUMS\n.*latest\/download\/slicc-capture-1\.1\.0\.tgz\n$/
    );
    assert.doesNotMatch(t.fetched(), /index\.json/);
  });

  it('installs --version, with or without a v, and VERSION', () => {
    for (const [args, extra] of [
      [['--version', '1.0.0'], {}],
      [['--version', 'v1.0.0'], {}],
      [[], { VERSION: '1.0.0' }],
    ]) {
      const t = setup();
      const run = t.run(args, extra);
      assert.equal(run.status, 0, run.stderr);
      assert.match(run.stdout, /^sccapture 1\.0\.0 installed to /);
      assert.match(t.fetched(), /download\/v1\.0\.0\/SHA256SUMS/);
      assert.equal(readlinkSync(join(t.data, 'current')), '1.0.0');
    }
  });

  it('fails on a version that does not exist or is not a version', () => {
    const t = setup();
    let run = t.run(['--version', '9.9.9']);
    assert.equal(run.status, 1);
    assert.match(
      run.stderr,
      /^slicc-capture: download failed: file:.*\/download\/v9\.9\.9\/SHA256SUMS\n$/
    );
    run = t.run(['--version', '1.0;rm']);
    assert.equal(run.status, 1);
    assert.equal(run.stderr, 'slicc-capture: invalid version: 1.0;rm\n');
  });

  it('puts the launcher in --dir or INSTALL_DIR, and says nothing about PATH when it is on it', () => {
    const t = setup();
    const dir = join(t.dir, 'tools');
    let run = t.run(['--dir', dir]);
    assert.equal(run.status, 0, run.stderr);
    assert.match(run.stdout, /is not on PATH; add it with: export PATH=/);
    assert.ok(existsSync(join(dir, 'sccapture')));
    const other = join(t.dir, 'other dir');
    run = t.run([], { INSTALL_DIR: other, PATH: `${other}${delimiter}${t.env.PATH}` });
    assert.equal(run.status, 0, run.stderr);
    assert.equal(run.stdout, `sccapture 1.1.0 installed to ${join(other, 'sccapture')}\n`);
    assert.equal(launch(join(other, 'sccapture'), ['--version']).stdout, '1.1.0\n');
  });

  it('uses XDG_DATA_HOME, and quotes paths in the launcher', () => {
    const t = setup();
    const xdg = join(t.dir, "it's $data");
    const run = t.run([], { XDG_DATA_HOME: xdg });
    assert.equal(run.status, 0, run.stderr);
    assert.equal(readlinkSync(join(xdg, 'slicc-capture', 'current')), '1.1.0');
    assert.equal(launch(t.launcher, ['--version']).stdout, '1.1.0\n');
  });

  it('prints the usage for --help, and rejects unknown options and missing values', () => {
    const t = setup();
    let run = t.run(['--help']);
    assert.equal(run.status, 0);
    assert.match(
      run.stdout,
      /^usage: install\.sh \[--version <version>\] \[--dir <dir>\] \[--help\]\n/
    );
    assert.equal(run.stderr, '');
    assert.equal(t.fetched(), '');
    run = t.run(['--bogus']);
    assert.equal(run.status, 1);
    assert.equal(run.stderr, 'slicc-capture: unknown option: --bogus\n');
    for (const args of [['--dir'], ['--version'], ['--dir', '']]) {
      run = t.run(args);
      assert.equal(run.status, 1);
      assert.equal(run.stderr, `slicc-capture: ${args[0]} needs a value\n`);
    }
    assert.equal(t.run([], { INSTALL_DIR: '' }).status, 0);
  });

  it('refuses a tarball that does not match SHA256SUMS', () => {
    const t = setup();
    const bad = join(t.dir, 'releases');
    cpSync(join(fixture, 'releases'), bad, { recursive: true });
    writeFileSync(join(bad, 'latest', 'download', 'slicc-capture-1.1.0.tgz'), 'tampered');
    const run = t.run([], { SLICC_INSTALL_BASE_URL: pathToFileURL(bad).href });
    assert.equal(run.status, 1);
    assert.equal(run.stderr, 'slicc-capture: checksum mismatch for slicc-capture-1.1.0.tgz\n');
    assert.equal(run.stdout, '');
    assert.ok(!existsSync(t.launcher));
    assert.ok(!existsSync(join(t.data, '1.1.0')));
  });

  it('refuses a SHA256SUMS without the tarball', () => {
    const t = setup();
    const bad = join(t.dir, 'releases');
    cpSync(join(fixture, 'releases'), bad, { recursive: true });
    writeFileSync(join(bad, 'latest', 'download', 'SHA256SUMS'), `${'0'.repeat(64)}  install.sh\n`);
    let run = t.run([], { SLICC_INSTALL_BASE_URL: pathToFileURL(bad).href });
    assert.equal(run.status, 1);
    assert.match(run.stderr, /^slicc-capture: no slicc-capture tarball in .*SHA256SUMS\n$/);
    writeFileSync(join(bad, 'download', 'v1.0.0', 'SHA256SUMS'), `${'0'.repeat(64)}  install.sh\n`);
    run = t.run(['--version', '1.0.0'], { SLICC_INSTALL_BASE_URL: pathToFileURL(bad).href });
    assert.equal(run.status, 1);
    assert.match(
      run.stderr,
      /^slicc-capture: no checksum for slicc-capture-1\.0\.0\.tgz in .*SHA256SUMS\n$/
    );
  });

  it('refuses a tarball without host/sccapture.mjs', () => {
    const t = setup();
    const bad = join(t.dir, 'releases');
    const dir = join(bad, 'latest', 'download');
    mkdirSync(dir, { recursive: true });
    write(join(t.dir, 'pkg', 'package', 'package.json'), '{}\n');
    tar(join(t.dir, 'pkg'), join(dir, 'slicc-capture-1.1.0.tgz'));
    write(
      join(dir, 'SHA256SUMS'),
      `${sha(join(dir, 'slicc-capture-1.1.0.tgz'))}  slicc-capture-1.1.0.tgz\n`
    );
    const run = t.run([], { SLICC_INSTALL_BASE_URL: pathToFileURL(bad).href });
    assert.equal(run.status, 1);
    assert.equal(run.stderr, 'slicc-capture: no host/sccapture.mjs in slicc-capture-1.1.0.tgz\n');
  });

  it('downloads Node when there is none, checks it, and reuses it next time', () => {
    const t = setup({ node: null });
    let run = t.run();
    assert.equal(run.status, 0, run.stderr);
    assert.equal(run.stderr, `slicc-capture: downloading Node ${nodeVersion}\n`);
    assert.match(run.stdout, /^sccapture 1\.1\.0 installed to /);
    assert.match(
      t.fetched(),
      new RegExp(
        `index\\.json\\n.*v${nodeVersion}/SHASUMS256\\.txt\\n.*v${nodeVersion}/node-v${nodeVersion}-linux-x64\\.tar\\.gz\\n`
      )
    );
    assert.match(
      readFileSync(t.launcher, 'utf8'),
      new RegExp(`exec '${join(t.data, 'node', 'bin', 'node')}'`)
    );
    assert.equal(launch(t.launcher, ['--version']).stdout, '1.1.0\n');
    rmSync(join(t.dir, 'fetch.log'));
    run = t.run();
    assert.equal(run.status, 0, run.stderr);
    assert.equal(run.stderr, '');
    assert.doesNotMatch(t.fetched(), /index\.json/);
  });

  it('downloads Node when the one on PATH is older than 24', () => {
    for (const old of ['22.20.0', 'garbage']) {
      const t = setup({ node: old, uname: ['Darwin', 'arm64'] });
      const run = t.run();
      assert.equal(run.status, 0, run.stderr);
      assert.match(t.fetched(), /node-v24\.11\.0-darwin-arm64\.tar\.gz/);
      assert.match(readFileSync(t.launcher, 'utf8'), /\/node\/bin\/node' /);
    }
  });

  it('refuses a Node download that does not match SHASUMS256.txt', () => {
    const t = setup({ node: null });
    const bad = join(t.dir, 'node');
    cpSync(join(fixture, 'node'), bad, { recursive: true });
    writeFileSync(
      join(bad, `v${nodeVersion}`, `node-v${nodeVersion}-linux-x64.tar.gz`),
      'tampered'
    );
    let run = t.run([], { SLICC_NODE_DIST_BASE: pathToFileURL(bad).href });
    assert.equal(run.status, 1);
    assert.match(
      run.stderr,
      new RegExp(
        `slicc-capture: checksum mismatch for node-v${nodeVersion}-linux-x64\\.tar\\.gz\\n$`
      )
    );
    assert.ok(!existsSync(join(t.data, 'node')));
    writeFileSync(join(bad, `v${nodeVersion}`, 'SHASUMS256.txt'), '');
    run = t.run([], { SLICC_NODE_DIST_BASE: pathToFileURL(bad).href });
    assert.equal(run.status, 1);
    assert.match(
      run.stderr,
      new RegExp(`slicc-capture: no checksum for node-v${nodeVersion}-linux-x64\\.tar\\.gz\\n$`)
    );
    writeFileSync(join(bad, 'index.json'), '[\n{"version":"v25.1.0","lts":false}\n]\n');
    run = t.run([], { SLICC_NODE_DIST_BASE: pathToFileURL(bad).href });
    assert.equal(run.status, 1);
    assert.match(run.stderr, /^slicc-capture: no Node LTS release 24 or later in .*index\.json\n$/);
  });

  it('says to install Node with the package manager on musl Linux', () => {
    const t = setup({ node: null, ldd: 'musl libc (x86_64)' });
    const run = t.run();
    assert.equal(run.status, 1);
    assert.match(
      run.stderr,
      /^slicc-capture: nodejs\.org has no Node for musl Linux; install Node 24 or later with the package manager .*\n$/
    );
    assert.equal(t.fetched(), '');
  });

  it('names npm on an unsupported OS or architecture without Node', () => {
    let t = setup({ node: null, uname: ['FreeBSD', 'amd64'] });
    let run = t.run();
    assert.equal(run.status, 1);
    assert.match(
      run.stderr,
      /^slicc-capture: unsupported OS: FreeBSD; .*npm install -g @ai-ecoverse\/slicc-capture\n$/
    );
    t = setup({ node: null, uname: ['Linux', 'riscv64'] });
    run = t.run();
    assert.equal(run.status, 1);
    assert.match(
      run.stderr,
      /^slicc-capture: unsupported architecture: riscv64; .*npm install -g @ai-ecoverse\/slicc-capture\n$/
    );
    t = setup({ uname: ['FreeBSD', 'amd64'] });
    assert.equal(t.run().status, 0);
  });

  it('fails in one line without curl or wget, and uses wget without curl', () => {
    let t = setup({ curl: false });
    let run = t.run();
    assert.equal(run.status, 1);
    assert.equal(run.stderr, 'slicc-capture: curl or wget is required\n');
    t = setup({ curl: false, wget: true });
    run = t.run();
    assert.equal(run.status, 0, run.stderr);
    assert.match(t.fetched(), /^wget .*SHA256SUMS\n/);
  });

  it('replaces an older install in place', () => {
    const t = setup();
    const dir = join(t.dir, 'bin2');
    let run = t.run(['--version', '1.0.0', '--dir', dir]);
    assert.equal(run.status, 0, run.stderr);
    assert.equal(launch(join(dir, 'sccapture'), ['--version']).stdout, '1.0.0\n');
    run = t.run(['--dir', dir]);
    assert.equal(run.status, 0, run.stderr);
    assert.match(run.stdout, /^sccapture 1\.1\.0 installed to /);
    assert.equal(launch(join(dir, 'sccapture'), ['--version']).stdout, '1.1.0\n');
    assert.equal(readlinkSync(join(t.data, 'current')), '1.1.0');
    run = t.run(['--dir', dir]);
    assert.equal(run.status, 0, run.stderr);
    assert.equal(launch(join(dir, 'sccapture'), ['--version']).stdout, '1.1.0\n');
  });
});

describe('the release assets', () => {
  it('install with install.sh, and the launcher runs the packed host/sccapture.mjs', () => {
    const dir = realpathSync(mkdtempSync(join(tmpdir(), 'slicc-capture-assets-')));
    runs.push(dir);
    const out = join(dir, 'releases', 'latest', 'download');
    const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
    const built = spawnSync(
      realNode,
      [join(root, 'scripts/release-assets.mjs'), pkg.version, out],
      {
        cwd: root,
        encoding: 'utf8',
      }
    );
    assert.equal(built.status, 0, built.stderr);
    const t = setup({ node: pkg.engines.node.replace('>=', '') + '.0.0' });
    const run = t.run([], { SLICC_INSTALL_BASE_URL: pathToFileURL(join(dir, 'releases')).href });
    assert.equal(run.status, 0, run.stderr);
    assert.match(
      run.stdout,
      new RegExp(`^sccapture ${pkg.version.replace(/\./g, '\\.')} installed to `)
    );
    assert.equal(launch(t.launcher, ['--version']).stdout, `${pkg.version}\n`);
    assert.equal(readlinkSync(join(t.data, 'current')), pkg.version);
  });
});

const pwsh = find('pwsh');

describe('install.ps1', { skip: pwsh ? false : 'pwsh is not installed' }, () => {
  let server;
  let base;

  before(async () => {
    for (;;) {
      server = createServer((req, res) => {
        const file = join(fixture, decodeURIComponent(new URL(req.url, 'http://x').pathname));
        if (!file.startsWith(fixture) || !existsSync(file)) {
          res.writeHead(404).end();
          return;
        }
        res.writeHead(200).end(readFileSync(file));
      });
      await new Promise((ok) => server.listen(0, '127.0.0.1', ok));
      const { port } = server.address();
      if (port < 9222 || port > 9229) break;
      await new Promise((ok) => server.close(ok));
    }
    base = `http://127.0.0.1:${server.address().port}`;
  });

  after(() => new Promise((ok) => server.close(ok)));

  const run = (t, args = [], extra = {}) =>
    spawnAsync(pwsh, ['-NoProfile', '-NonInteractive', '-File', ps1, ...args], {
      env: {
        PATH: `${t.bin}${delimiter}${join(t.dir, 'sys')}`,
        HOME: t.home,
        LOCALAPPDATA: join(t.dir, 'local'),
        SLICC_INSTALL_BASE_URL: `${base}/releases`,
        SLICC_NODE_DIST_BASE: `${base}/node`,
        ...extra,
      },
      encoding: 'utf8',
    });

  it('installs the latest release with the node on PATH', async () => {
    const t = setup();
    const r = await run(t);
    assert.equal(r.status, 0, r.stderr);
    const data = join(t.dir, 'local', 'slicc-capture');
    const launcher = join(data, 'bin', 'sccapture.cmd');
    assert.match(
      r.stdout,
      new RegExp(`^sccapture 1\\.1\\.0 installed to ${launcher.replace(/[.\\]/g, '\\$&')}\\n`)
    );
    assert.match(
      r.stdout,
      /is not on PATH; add it with: \[Environment\]::SetEnvironmentVariable\('Path', '.*'/
    );
    assert.equal(
      readFileSync(launcher, 'utf8'),
      `@"${join(t.bin, 'node')}" "${join(data, '1.1.0', 'host', 'sccapture.mjs')}" %*\r\n`
    );
    assert.equal(readlinkSync(join(data, 'current')), join(data, '1.1.0'));
  });

  it('installs --version into --dir, and replaces an older install', async () => {
    const t = setup();
    const dir = join(t.dir, 'tools');
    let r = await run(t, ['--version', '1.0.0', '--dir', dir]);
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /^sccapture 1\.0\.0 installed to .*sccapture\.cmd\n/);
    assert.match(readFileSync(join(dir, 'sccapture.cmd'), 'utf8'), /1\.0\.0/);
    r = await run(t, [], {
      INSTALL_DIR: dir,
      PATH: `${dir}${delimiter}${t.bin}${delimiter}${join(t.dir, 'sys')}`,
    });
    assert.equal(r.status, 0, r.stderr);
    assert.equal(r.stdout, `sccapture 1.1.0 installed to ${join(dir, 'sccapture.cmd')}\n`);
    r = await run(t, [], { VERSION: 'v1.0.0' });
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /^sccapture 1\.0\.0 /);
    r = await run(t, [], { VERSION: 'v1.0.0' });
    assert.equal(r.status, 0, r.stderr);
    const data = join(t.dir, 'local', 'slicc-capture');
    assert.equal(readlinkSync(join(data, 'current')), join(data, '1.0.0'));
  });

  it('prints the usage for --help, and rejects unknown options', async () => {
    const t = setup();
    let r = await run(t, ['--help']);
    assert.equal(r.status, 0, r.stderr);
    assert.match(
      r.stdout,
      /^usage: install\.ps1 \[--version <version>\] \[--dir <dir>\] \[--help\]\n/
    );
    r = await run(t, ['--bogus']);
    assert.equal(r.status, 1);
    assert.equal(r.stderr, 'slicc-capture: unknown option: --bogus\n');
    r = await run(t, ['--dir']);
    assert.equal(r.status, 1);
    assert.equal(r.stderr, 'slicc-capture: --dir needs a value\n');
    r = await run(t, ['--version', 'x']);
    assert.equal(r.status, 1);
    assert.equal(r.stderr, 'slicc-capture: invalid version: x\n');
    r = await spawnAsync(
      pwsh,
      [
        '-NoProfile',
        '-NonInteractive',
        '-Command',
        `& ([scriptblock]::Create((Get-Content -Raw '${ps1}'))) --help`,
      ],
      { encoding: 'utf8' }
    );
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /^usage: install\.ps1 /);
  });

  it('refuses a tarball that does not match SHA256SUMS', async () => {
    const t = setup();
    const bad = join(fixture, 'bad-ps1');
    cpSync(join(fixture, 'releases'), bad, { recursive: true });
    writeFileSync(join(bad, 'latest', 'download', 'slicc-capture-1.1.0.tgz'), 'tampered');
    let r = await run(t, [], { SLICC_INSTALL_BASE_URL: `${base}/bad-ps1` });
    assert.equal(r.status, 1);
    assert.equal(r.stderr, 'slicc-capture: checksum mismatch for slicc-capture-1.1.0.tgz\n');
    assert.equal(r.stdout, '');
    r = await run(t, ['--version', '9.9.9']);
    assert.equal(r.status, 1);
    assert.match(r.stderr, /^slicc-capture: download failed: .*v9\.9\.9\/SHA256SUMS\n$/);
  });

  it('says to use install.sh when it would download Node off Windows', {
    skip: process.platform === 'win32' && 'Windows downloads Node',
  }, async () => {
    const t = setup({ node: '22.0.0' });
    const r = await run(t);
    assert.equal(r.status, 1);
    assert.match(
      r.stderr,
      /^slicc-capture: unsupported OS: install\.ps1 is for Windows; use install\.sh or npm install -g @ai-ecoverse\/slicc-capture\n$/
    );
  });
});
