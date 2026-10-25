import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { EventEmitter } from 'node:events';
import {
  chmodSync,
  closeSync,
  existsSync,
  mkdtempSync,
  openSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { delimiter, dirname, join, resolve, sep } from 'node:path';
import { after, before, describe, it } from 'node:test';
import { run } from '../../host/capture.mjs';
import { fakeExe } from './fake-windows.mjs';

const root = resolve(import.meta.dirname, '../..');
const scratch = realpathSync(mkdtempSync(join(tmpdir(), 'slicc-capture-host-')));
const usages = {
  darwin:
    'usage: sccapture [-abcdgikmoprsuvwxACMPSUW] [-t format] [-T seconds] [-R x,y,w,h] [-D display] [-J style] [-l windowid] [-B bundleid] [-V seconds] [-G id] [file ... | -]\n',
  linux:
    'usage: sccapture [-acdgiorsvwxACPW] [-t format] [-T seconds] [-R x,y,w,h] [-J style] [-l windowid] [-V seconds] [-G id] [file | -]\n',
  win32:
    'usage: sccapture [-acdmorvxCP] [-t format] [-T seconds] [-R x,y,w,h] [-D display] [-V seconds] [-G id] [file | -]\n',
};
const usage = usages.linux;
const version = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).version;
const onWindows = process.platform === 'win32';
const posix = { skip: onWindows && 'needs POSIX fakes' };

after(() => rmSync(scratch, { recursive: true, force: true, maxRetries: 20 }));

const shooters = [
  'screencapture',
  'grim',
  'gnome-screenshot',
  'import',
  'scrot',
  'wf-recorder',
  'ffmpeg',
  'ffmpeg.exe',
];

function fake(name) {
  return `#!${process.execPath}
const fs = require('node:fs');
const path = require('node:path');
const name = ${JSON.stringify(name)};
const argv = process.argv.slice(2);
const call = { name, argv };
if (/copy|xclip/.test(name)) call.stdin = fs.readFileSync(0, 'utf8');
if (/\\.exe$/.test(name) && !name.startsWith('curl')) {
  call.env = Object.fromEntries(Object.entries(process.env).filter(([key]) => key.startsWith('SCCAPTURE_')));
}
for (const arg of argv) {
  try {
    if (arg.endsWith('install.ps1')) call.file = fs.readFileSync(arg, 'utf8');
  } catch {}
}
if (argv.includes('-File')) call.modules = process.env.PSModulePath ?? null;
fs.appendFileSync(path.join(process.env.FAKE_LOG, 'calls'), JSON.stringify(call) + '\\n');
const fail = (process.env.FAKE_FAIL ?? '').split('|').find((rule) => rule.startsWith(name + ':'));
if (fail !== undefined) {
  const message = fail.slice(name.length + 1);
  if (message) process.stderr.write(message + '\\n');
  process.exit(3);
}
if (name === 'slurp') process.stdout.write('10,20 30x40\\n');
if (!process.env.FAKE_EMPTY && ${JSON.stringify(shooters)}.includes(name) && argv.length && path.isAbsolute(argv.at(-1).replace(/^[a-z]+:/, ''))) {
  fs.writeFileSync(argv.at(-1).replace(/^[a-z]+:/, ''), 'image by ' + name);
}
if (process.env.SCCAPTURE_FILE) fs.writeFileSync(process.env.SCCAPTURE_FILE, 'image by ' + name);
if (process.env.FAKE_INSTALLED && argv.includes('-File')) process.stdout.write('sccapture ' + process.env.FAKE_INSTALLED + ' installed to x\\n');
if (process.env.FAKE_HOLD === name) {
  const done = (how) => {
    fs.appendFileSync(path.join(process.env.FAKE_LOG, 'calls'), JSON.stringify({ name, stopped: how }) + '\\n');
    process.exit(Number(process.env.FAKE_STOPPED ?? 0));
  };
  if (argv.includes('-hide_banner')) done(fs.readFileSync(0, 'utf8'));
  process.on('SIGINT', () => done('SIGINT'));
  fs.writeFileSync(path.join(process.env.FAKE_LOG, 'ready'), '');
  setInterval(() => {}, 1000);
}
`;
}

function bin(names) {
  const dir = mkdtempSync(join(scratch, 'bin-'));
  for (const name of names) {
    if (onWindows) {
      fakeExe(dir, name, fake(name));
      continue;
    }
    writeFileSync(join(dir, name), fake(name));
    chmodSync(join(dir, name), 0o755);
  }
  return dir;
}

function base(path) {
  const env = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (
      !['PATH', 'WAYLAND_DISPLAY', 'SCCAPTURE_INSTALL_DIR', 'SLICC_INSTALL_BASE_URL'].includes(
        key.toUpperCase()
      )
    ) {
      env[key] = value;
    }
  }
  env.PATH = path;
  return env;
}

async function capture({
  platform,
  names = [],
  argv,
  extra = {},
  entry,
  timeout,
  path = (dir) => dir,
  signals = new EventEmitter(),
  tty,
  pause = 0,
  during,
}) {
  const dir = bin(names);
  const log = mkdtempSync(join(scratch, 'log-'));
  const out = join(log, 'out');
  const err = join(log, 'err');
  writeFileSync(join(log, 'in'), '');
  const fds = [openSync(join(log, 'in'), 'r'), openSync(out, 'w'), openSync(err, 'w')];
  const env = { ...base(path(dir)), FAKE_LOG: log, ...extra };
  if (env.PATH === undefined) env.PATH = path(dir);
  if (platform === 'win32') {
    delete env.PATH;
    env.Path = `${join(scratch, 'missing')};${dir}`;
  }
  const waited = [];
  const wait = async (seconds) => {
    waited.push(seconds);
    writeFileSync(join(log, 'calls'), '', { flag: 'a' });
    if (pause) await new Promise((resolve) => setTimeout(resolve, pause));
  };
  const files = (name) => join(log, name);
  const args = argv.map((arg) => arg.replace(/^@/, `${log}${sep}`));
  let code;
  try {
    const running = run({ argv: args, env, platform, fds, wait, entry, timeout, signals, tty });
    if (during) await during({ log, signals });
    code = await running;
  } finally {
    for (const fd of fds) closeSync(fd);
  }
  const text = (file) => (existsSync(file) ? readFileSync(file, 'utf8') : undefined);
  const calls = (text(files('calls')) ?? '').split('\n').filter(Boolean).map(JSON.parse);
  return {
    code,
    stdout: text(out),
    stderr: text(err),
    calls,
    waited,
    log,
    read: (n) => text(files(n)),
  };
}

function decoded(argv) {
  return Buffer.from(argv.at(-1), 'base64').toString('utf16le');
}

describe('the options', () => {
  for (const platform of ['darwin', 'linux', 'win32']) {
    it(`prints the help for -h or --help anywhere on ${platform}`, async () => {
      const first = await capture({ platform, argv: ['-h'] });
      for (const argv of [['-h'], ['--help'], ['-xh'], ['-Z', 'f', '-h'], ['--version', '-h']]) {
        const result = await capture({ platform, argv });
        assert.deepEqual(
          [result.code, result.stdout, result.stderr],
          [0, first.stdout, ''],
          argv.join(' ')
        );
        assert.deepEqual(result.calls, []);
      }
      assert.ok(first.stdout.startsWith(`${usages[platform]}\nCaptures the screen with `));
      for (const row of ['--version', '--upgrade', '-h, --help', '-c, --clipboard']) {
        assert.match(first.stdout, new RegExp(`^  ${row} +\\S`, 'm'), row);
      }
    });

    it(`lists in the usage and the help exactly the options it takes on ${platform}`, async () => {
      const { stdout } = await capture({ platform, argv: ['--help'] });
      const line = usages[platform];
      const all = 'aAbBcCdDgGiJklmMoprPRsStTuUvVwWx';
      const values = {
        B: 'x',
        D: '1',
        G: '1',
        J: 'window',
        l: '1',
        R: '0,0,1,1',
        t: 'png',
        T: '0',
        V: '1',
      };
      for (const letter of all) {
        const argv = values[letter] ? [`-${letter}`, values[letter], '-c'] : [`-${letter}`, '-c'];
        const result = await capture({ platform, names: [], argv });
        const refused = result.stderr.includes(`-${letter}: not supported on`);
        const listed = values[letter]
          ? line.includes(`[-${letter} `)
          : new RegExp(`\\[-[a-zA-Z]*${letter}[a-zA-Z]*\\]`).test(line);
        const described =
          new RegExp(`^  -${letter}[ ,]`, 'm').test(stdout) ||
          stdout.includes(`-${letter}, `) ||
          stdout.includes(`-${letter}: accepted`);
        assert.equal(listed, !refused, `-${letter} in the usage`);
        assert.equal(described, !refused, `-${letter} in the help`);
      }
    });
  }

  it('refuses unknown options and missing values with the usage', async () => {
    for (const [argv, message] of [
      [['-Z', '@f'], 'unknown option: -Z'],
      [['-xZ', '@f'], 'unknown option: -Z'],
      [['--frobnicate', '@f'], 'unknown option: --frobnicate'],
      [['-e', '@f'], 'unknown option: -e'],
      [['-t'], '-t: option requires a value'],
      [['@f', '-xT'], '-T: option requires a value'],
    ]) {
      const result = await capture({ platform: 'linux', names: ['scrot'], argv });
      assert.deepEqual(
        [result.code, result.stdout, result.stderr],
        [2, '', `sccapture: ${message}\n${usage}`],
        argv.join(' ')
      );
      assert.deepEqual(result.calls, []);
    }
  });

  it('refuses invalid values', async () => {
    for (const [argv, message] of [
      [['-T', 'soon'], '-T: invalid delay: soon'],
      [['-T-1'], '-T: invalid delay: -1'],
      [['-R', '1,2,3'], '-R: invalid rectangle: 1,2,3'],
      [['-R0,0,0,5'], '-R: invalid rectangle: 0,0,0,5'],
      [['-R', '0,0,5,5;x'], '-R: invalid rectangle: 0,0,5,5;x'],
      [['-J', 'region'], '-J: invalid style: region'],
      [['-l', 'abc'], '-l: invalid window: abc'],
    ]) {
      const result = await capture({ platform: 'linux', names: ['import'], argv: [...argv, '@f'] });
      assert.deepEqual(
        [result.code, result.stderr],
        [2, `sccapture: ${message}\n`],
        argv.join(' ')
      );
      assert.deepEqual(result.calls, []);
    }
    for (const value of ['0', 'x', '-1']) {
      const result = await capture({
        platform: 'win32',
        names: ['powershell.exe'],
        argv: ['-D', value, '@f'],
      });
      assert.deepEqual(
        [result.code, result.stderr],
        [2, `sccapture: -D: invalid display: ${value}\n`]
      );
    }
  });

  it('requires a file, unless -c', async () => {
    for (const platform of ['darwin', 'linux', 'win32']) {
      const result = await capture({
        platform,
        names: ['screencapture', 'scrot', 'pwsh.exe'],
        argv: ['-x'],
      });
      assert.deepEqual(
        [result.code, result.stderr],
        [2, `sccapture: output file required (or use -c for clipboard)\n${usages[platform]}`]
      );
      assert.deepEqual(result.calls, []);
    }
  });

  it('takes --version and --upgrade only alone', async () => {
    for (const argv of [
      ['--version', 'f'],
      ['-x', '--upgrade'],
      ['--version', '--upgrade'],
    ]) {
      const result = await capture({ platform: 'linux', argv });
      assert.deepEqual(
        [result.code, result.stderr],
        [
          2,
          `sccapture: ${argv.find((a) => a.startsWith('--'))}: takes no other arguments\n${usage}`,
        ]
      );
    }
  });

  it('prints the version', async () => {
    for (const platform of ['darwin', 'linux', 'win32']) {
      const result = await capture({ platform, argv: ['--version'] });
      assert.deepEqual([result.code, result.stdout, result.stderr], [0, `${version}\n`, '']);
    }
  });
});

describe('macOS', posix, () => {
  const mac = (argv, extra) =>
    capture({ platform: 'darwin', names: ['screencapture'], argv, extra });

  it('passes the options to screencapture unchanged', async () => {
    const result = await mac([
      '-xc',
      '-T3',
      '-R',
      '0,0,10,10',
      '-l',
      '42',
      '-J',
      'video',
      '-B',
      'com.x',
      '-b',
      '-t',
      'heic',
      '@a',
      '@b',
    ]);
    assert.deepEqual([result.code, result.stdout, result.stderr], [0, '', '']);
    assert.deepEqual(result.calls, [
      {
        name: 'screencapture',
        argv: [
          '-xc',
          '-T3',
          '-R',
          '0,0,10,10',
          '-l',
          '42',
          '-J',
          'video',
          '-B',
          'com.x',
          '-b',
          '-t',
          'heic',
          `${result.log}/a`,
          `${result.log}/b`,
        ],
      },
    ]);
    assert.equal(result.read('b'), 'image by screencapture');
  });

  it('passes every option of the table that macOS takes', async () => {
    for (const letter of 'aBbcCdDiJlmMopPrRsStTuUwWx') {
      const value = { B: 'com.x', D: '2', J: 'window', l: '7', R: '1,2,3,4', t: 'png', T: '1' }[
        letter
      ];
      const argv = value ? [`-${letter}`, value, '@f.png'] : [`-${letter}`, '@f.png'];
      const result = await mac(argv);
      assert.equal(result.code, 0, letter);
      assert.deepEqual(
        result.calls[0].argv,
        argv.map((arg) => arg.replace('@', `${result.log}/`))
      );
    }
  });

  it('maps --clipboard to -c and keeps -- before a file starting with -', async () => {
    const result = await mac(['--clipboard', '--', '-dash']);
    assert.deepEqual(result.calls[0].argv, ['-c', '--', '-dash']);
  });

  it('adds -t for the extensions screencapture would not guess', async () => {
    for (const [ext, type] of [
      ['jpg', 'jpg'],
      ['JPEG', 'jpg'],
      ['pdf', 'pdf'],
      ['tiff', 'tiff'],
      ['gif', 'gif'],
      ['bmp', 'bmp'],
    ]) {
      const result = await mac([`@f.${ext}`]);
      assert.deepEqual(result.calls[0].argv, ['-t', type, `${result.log}/f.${ext}`]);
    }
    for (const argv of [['@f.png'], ['@f'], ['-t', 'png', '@f.jpg']]) {
      const result = await mac(argv);
      assert.deepEqual(
        result.calls[0].argv,
        argv.map((arg) => arg.replace('@', `${result.log}/`))
      );
    }
  });

  it('runs without a file for -p, -u, -P, -M and -B', async () => {
    for (const argv of [['-p'], ['-u'], ['-P'], ['-M'], ['-B', 'com.apple.Preview'], ['-c']]) {
      const result = await mac(argv);
      assert.deepEqual([result.code, result.calls[0].argv], [0, argv]);
    }
  });

  it('passes the video options, adding -v for -V', async () => {
    for (const [argv, expected] of [
      [
        ['-v', '@f.mov'],
        ['-v', '@f.mov'],
      ],
      [
        ['-V', '5', '@f.mov'],
        ['-v', '-V', '5', '@f.mov'],
      ],
      [
        ['-v', '-V5', '@f.mov'],
        ['-v', '-V5', '@f.mov'],
      ],
      [
        ['-vgkA', '-G', '1', '@f.mov'],
        ['-vgkA', '-G', '1', '@f.mov'],
      ],
      [
        ['-J', 'video', '@f.mov'],
        ['-J', 'video', '@f.mov'],
      ],
      [
        ['-v', '-t', 'jpg', '@f.jpg'],
        ['-v', '-t', 'jpg', '@f.jpg'],
      ],
      [
        ['--view', '@f.png'],
        ['-P', '@f.png'],
      ],
    ]) {
      const result = await mac(argv);
      assert.equal(result.code, 0, `${argv.join(' ')}: ${result.stderr}`);
      assert.deepEqual(
        result.calls[0].argv,
        expected.map((arg) => arg.replace('@', `${result.log}/`)),
        argv.join(' ')
      );
    }
  });

  it('stops screencapture -v on a signal, and keeps the movie', async () => {
    for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
      const result = await capture({
        platform: 'darwin',
        names: ['screencapture'],
        argv: ['-v', '@f.mov'],
        extra: { FAKE_HOLD: 'screencapture', FAKE_STOPPED: '1' },
        during: async ({ log, signals }) => {
          while (!existsSync(join(log, 'ready'))) await new Promise((r) => setTimeout(r, 20));
          signals.emit(signal);
        },
      });
      assert.deepEqual([result.code, result.stderr], [0, ''], signal);
      assert.deepEqual(result.calls[1], { name: 'screencapture', stopped: 'SIGINT' }, signal);
      assert.equal(result.read('f.mov'), 'image by screencapture');
    }
  });

  it('fails when screencapture -v fails, or stops without a movie', async () => {
    const failed = await mac(['-v', '@f.mov'], { FAKE_FAIL: 'screencapture:no permission' });
    assert.deepEqual([failed.code, failed.stderr], [1, 'no permission\n']);
    const quiet = await mac(['-v', '@f.mov'], { FAKE_FAIL: 'screencapture:' });
    assert.deepEqual([quiet.code, quiet.stderr], [1, 'sccapture: screencapture failed\n']);
    const empty = await capture({
      platform: 'darwin',
      names: ['screencapture'],
      argv: ['-v', '@f.mov'],
      extra: { FAKE_HOLD: 'screencapture', FAKE_STOPPED: '1', FAKE_EMPTY: '1' },
      during: async ({ log, signals }) => {
        while (!existsSync(join(log, 'ready'))) await new Promise((r) => setTimeout(r, 20));
        signals.emit('SIGINT');
      },
    });
    assert.deepEqual([empty.code, empty.stderr], [1, 'sccapture: screencapture failed\n']);
  });

  it('passes on screencapture failing, and says when it is missing', async () => {
    const failed = await mac(['-i', '@f'], {
      FAKE_FAIL: 'screencapture:could not create image from display',
    });
    assert.deepEqual([failed.code, failed.stderr], [1, 'could not create image from display\n']);
    const quiet = await mac(['@f'], { FAKE_FAIL: 'screencapture:' });
    assert.deepEqual([quiet.code, quiet.stderr], [1, 'sccapture: screencapture failed\n']);
    const missing = await capture({ platform: 'darwin', names: ['grim'], argv: ['@f'] });
    assert.deepEqual(
      [missing.code, missing.stderr],
      [1, 'sccapture: no screenshot tool found (tried screencapture)\n']
    );
  });
});

const x11 = ['gnome-screenshot', 'import', 'scrot'];
const wayland = { WAYLAND_DISPLAY: 'wayland-1' };

describe('Linux', posix, () => {
  const linux = (names, argv, extra) => capture({ platform: 'linux', names, argv, extra });
  const argvOf = async (name, argv, extra) => {
    const result = await linux([name, 'slurp', 'xdg-open'], argv, extra);
    assert.equal(result.code, 0, `${name} ${argv.join(' ')}: ${result.stderr}`);
    return result.calls
      .find((call) => call.name === name)
      .argv.map((arg) => arg.replace(result.log, '@'));
  };

  it('runs each tool as the table says', async () => {
    const rows = [
      ['grim', [], ['@/f.png']],
      ['grim', ['-R', '1,2,30,40'], ['-g', '1,2 30x40', '@/f.png']],
      ['grim', ['-C'], ['-c', '@/f.png']],
      ['grim', ['-t', 'png'], ['-t', 'png', '@/f.png']],
      ['grim', ['-t', 'jpg'], ['-t', 'jpeg', '@/f.png']],
      ['grim', ['-t', 'JPEG'], ['-t', 'jpeg', '@/f.png']],
      ['gnome-screenshot', [], ['-f', '@/f.png']],
      ['gnome-screenshot', ['-i'], ['-a', '-f', '@/f.png']],
      ['gnome-screenshot', ['-s', '-C'], ['-a', '-p', '-f', '@/f.png']],
      ['gnome-screenshot', ['-J', 'selection'], ['-a', '-f', '@/f.png']],
      ['gnome-screenshot', ['-t', 'png'], ['-f', '@/f.png']],
      ['import', [], ['-window', 'root', '@/f.png']],
      ['import', ['-i'], ['@/f.png']],
      ['import', ['-s'], ['@/f.png']],
      ['import', ['-w'], ['@/f.png']],
      ['import', ['-W'], ['@/f.png']],
      ['import', ['-J', 'window'], ['@/f.png']],
      [
        'import',
        ['-R', '1,2,30,40'],
        ['-window', 'root', '-crop', '30x40+1+2', '+repage', '@/f.png'],
      ],
      ['import', ['-l', '0x1e00007'], ['-window', '0x1e00007', '@/f.png']],
      ['import', ['-t', 'png'], ['-window', 'root', 'png:@/f.png']],
      ['import', ['-t', 'jpeg'], ['-window', 'root', 'jpg:@/f.png']],
      ['scrot', [], ['-o', '@/f.png']],
      ['scrot', ['-i'], ['-s', '-o', '@/f.png']],
      ['scrot', ['-w'], ['-s', '-o', '@/f.png']],
      ['scrot', ['-W'], ['-s', '-o', '@/f.png']],
      ['scrot', ['-R', '1,2,30,40'], ['-a', '1,2,30,40', '-o', '@/f.png']],
      ['scrot', ['-C'], ['-p', '-o', '@/f.png']],
      ['scrot', ['-t', 'png'], ['-o', '@/f.png']],
    ];
    for (const [name, options, expected] of rows) {
      const extra = name === 'grim' ? wayland : {};
      assert.deepEqual(
        await argvOf(name, [...options, '@f.png'], extra),
        expected,
        `${name} ${options.join(' ')}`
      );
    }
    assert.deepEqual(await argvOf('scrot', ['-t', 'jpg', '@f.JPG']), ['-o', '@/f.JPG']);
    for (const file of ['f.jpg', 'f.JPEG']) {
      assert.deepEqual(await argvOf('grim', [`@${file}`], wayland), ['-t', 'jpeg', `@/${file}`]);
    }
    assert.deepEqual(await argvOf('grim', ['-t', 'png', '@f.jpg'], wayland), [
      '-t',
      'png',
      '@/f.jpg',
    ]);
    assert.deepEqual(await argvOf('grim', ['@f.webp'], wayland), ['@/f.webp']);
    assert.deepEqual(await argvOf('import', ['@shot']), ['-window', 'root', 'png:@/shot']);
    assert.deepEqual(await argvOf('import', ['@f.webp']), ['-window', 'root', '@/f.webp']);
    const clip = await capture({
      platform: 'linux',
      names: ['grim', 'wl-copy'],
      argv: ['-c', '@f.jpg'],
      extra: wayland,
    });
    assert.deepEqual(clip.calls[0].argv.length, 1);
  });

  it('selects a region with slurp for grim', async () => {
    for (const option of [['-s'], ['-i'], ['-J', 'selection']]) {
      const result = await linux(['grim', 'slurp'], [...option, '-C', '@f.png'], wayland);
      assert.equal(result.code, 0);
      assert.deepEqual(result.calls, [
        { name: 'slurp', argv: [] },
        { name: 'grim', argv: ['-g', '10,20 30x40', '-c', `${result.log}/f.png`] },
      ]);
    }
    const rect = await linux(['grim', 'slurp'], ['-s', '-R', '1,2,3,4', '@f'], wayland);
    assert.deepEqual(
      rect.calls.map((call) => call.name),
      ['grim']
    );
    const cancelled = await linux(['grim', 'slurp'], ['-s', '@f'], {
      ...wayland,
      FAKE_FAIL: 'slurp:selection cancelled',
    });
    assert.deepEqual([cancelled.code, cancelled.stderr], [1, 'selection cancelled\n']);
    assert.deepEqual(
      cancelled.calls.map((call) => call.name),
      ['slurp']
    );
    const missing = await linux(['grim', 'gnome-screenshot'], ['-s', '@f'], wayland);
    assert.deepEqual(
      [missing.code, missing.stderr],
      [1, 'sccapture: no region selector found (tried slurp)\n']
    );
    assert.deepEqual(missing.calls, []);
  });

  it('tries grim then gnome-screenshot under Wayland, and never import or scrot', async () => {
    const both = await linux(['grim', ...x11], ['@f'], wayland);
    assert.deepEqual(
      both.calls.map((call) => call.name),
      ['grim']
    );
    const gnome = await linux(x11, ['@f'], wayland);
    assert.deepEqual(
      gnome.calls.map((call) => call.name),
      ['gnome-screenshot']
    );
    const none = await linux(['import', 'scrot'], ['@f'], wayland);
    assert.deepEqual(
      [none.code, none.stderr, none.calls],
      [1, 'sccapture: no screenshot tool found (tried grim, gnome-screenshot)\n', []]
    );
  });

  it('tries gnome-screenshot, import, then scrot under X11, and never grim', async () => {
    for (const [names, used] of [
      [['grim', ...x11], 'gnome-screenshot'],
      [['import', 'scrot'], 'import'],
      [['scrot'], 'scrot'],
    ]) {
      const result = await linux(names, ['@f'], {});
      assert.deepEqual(
        result.calls.map((call) => call.name),
        [used]
      );
      assert.equal(result.read('f'), `image by ${used}`);
    }
    for (const platform of ['linux', 'freebsd']) {
      const none = await capture({ platform, names: ['grim'], argv: ['@f'] });
      assert.deepEqual(
        [none.code, none.stderr],
        [1, 'sccapture: no screenshot tool found (tried gnome-screenshot, import, scrot)\n']
      );
    }
  });

  it('picks the first tool that supports every option given', async () => {
    for (const [options, used] of [
      [['-l', '42'], 'import'],
      [['-w'], 'import'],
      [['-R', '0,0,5,5'], 'import'],
      [['-C'], 'gnome-screenshot'],
      [['-C', '-R', '0,0,5,5'], 'scrot'],
      [['-t', 'jpg'], 'import'],
      [['-t', 'jpg', '-C'], 'scrot'],
    ]) {
      const file = options.includes('jpg') ? '@f.jpg' : '@f.png';
      const result = await linux(x11, [...options, file]);
      assert.deepEqual(
        [result.code, result.calls.map((call) => call.name)],
        [0, [used]],
        options.join(' ')
      );
    }
    const grim = await linux(['grim', 'gnome-screenshot'], ['-C', '@f'], wayland);
    assert.deepEqual(
      grim.calls.map((call) => call.name),
      ['grim']
    );
  });

  it('names the first tool tried when none supports the options', async () => {
    for (const [names, options, message, extra] of [
      [['grim', 'gnome-screenshot'], ['-w'], '-w: not supported with grim', wayland],
      [['grim', 'gnome-screenshot'], ['-W'], '-W: not supported with grim', wayland],
      [
        ['grim', 'gnome-screenshot'],
        ['-J', 'window'],
        '-J window: not supported with grim',
        wayland,
      ],
      [['grim'], ['-l', '1'], '-l: not supported with grim', wayland],
      [['gnome-screenshot'], ['-w'], '-w: not supported with gnome-screenshot', wayland],
      [['gnome-screenshot'], ['-R', '0,0,1,1'], '-R: not supported with gnome-screenshot', {}],
      [['gnome-screenshot'], ['-l', '1'], '-l: not supported with gnome-screenshot', {}],
      [['gnome-screenshot'], ['-t', 'jpg'], '-t jpg: not supported with gnome-screenshot', {}],
      [['import'], ['-C'], '-C: not supported with import', {}],
      [['scrot'], ['-l', '1'], '-l: not supported with scrot', {}],
      [['scrot'], ['-t', 'jpg'], '-t jpg: not supported with scrot', {}],
      [['import', 'scrot'], ['-C', '-l', '1'], '-C: not supported with import', {}],
    ]) {
      const result = await linux(names, [...options, '@f.png'], extra);
      assert.deepEqual(
        [result.code, result.stderr],
        [2, `sccapture: ${message}\n`],
        options.join(' ')
      );
      assert.deepEqual(result.calls, []);
    }
  });

  it('accepts the no-op options and refuses the unsupported ones', async () => {
    const noop = await linux(['scrot'], ['-adorx', '@f']);
    assert.deepEqual([noop.code, noop.calls[0].argv], [0, ['-o', `${noop.log}/f`]]);
    for (const [argv, label] of [
      [['-b'], '-b'],
      [['-B', 'x'], '-B'],
      [['-D', '1'], '-D'],
      [['-k'], '-k'],
      [['-m'], '-m'],
      [['-M'], '-M'],
      [['-p'], '-p'],
      [['-S'], '-S'],
      [['-u'], '-u'],
      [['-U'], '-U'],
      [['-t', 'webp'], '-t webp'],
      [['-v', '-t', 'png'], '-t png'],
      [['-v', '-t', 'gif'], '-t gif'],
      [['-t', 'gif'], '-t gif'],
    ]) {
      const result = await linux(['scrot'], [...argv, '@f']);
      assert.deepEqual(
        [result.code, result.stderr],
        [2, `sccapture: ${label}: not supported on Linux\n`]
      );
      assert.deepEqual(result.calls, []);
    }
    const many = await linux(['scrot'], ['@f', '@g']);
    assert.deepEqual(
      [many.code, many.stderr],
      [2, 'sccapture: more than one file: not supported on Linux\n']
    );
  });

  it('waits for -T, then runs the tool', async () => {
    const result = await linux(['scrot'], ['-T', '2.5', '@f']);
    assert.deepEqual([result.code, result.waited], [0, [2.5]]);
    const none = await linux(['scrot'], ['@f']);
    assert.deepEqual(none.waited, [0]);
  });

  it('copies a temporary PNG to the clipboard with -c, ignoring the file and -t', async () => {
    for (const [names, extra, clip] of [
      [['grim', 'wl-copy', 'xclip'], wayland, { name: 'wl-copy', argv: ['--type', 'image/png'] }],
      [
        ['grim', 'xclip'],
        wayland,
        { name: 'xclip', argv: ['-selection', 'clipboard', '-t', 'image/png'] },
      ],
      [
        ['scrot', 'wl-copy', 'xclip'],
        {},
        { name: 'xclip', argv: ['-selection', 'clipboard', '-t', 'image/png'] },
      ],
    ]) {
      const result = await linux(names, ['-c', '-t', 'webp', '@f', '@g'], extra);
      assert.deepEqual([result.code, result.stdout, result.stderr], [0, '', '']);
      const [shot, copy] = result.calls;
      const temp = shot.argv.at(-1);
      assert.match(temp, /capture\.png$/);
      assert.doesNotMatch(temp, new RegExp(result.log));
      assert.equal(existsSync(temp), false);
      assert.deepEqual(copy, { ...clip, stdin: `image by ${names[0]}` });
      assert.equal(result.read('f'), undefined);
    }
    const none = await linux(['grim'], ['-c'], wayland);
    assert.deepEqual(
      [none.code, none.stderr, none.calls],
      [1, 'sccapture: no clipboard tool found (tried wl-copy, xclip)\n', []]
    );
    const x = await linux(['scrot', 'wl-copy'], ['-c']);
    assert.deepEqual([x.code, x.stderr], [1, 'sccapture: no clipboard tool found (tried xclip)\n']);
    const failed = await linux(['scrot', 'xclip'], ['-c'], {
      FAKE_FAIL: "xclip:Error: Can't open display",
    });
    assert.deepEqual([failed.code, failed.stderr], [1, "Error: Can't open display\n"]);
  });

  it('opens the file with xdg-open for -P, after writing it', async () => {
    const opened = await linux(['scrot', 'xdg-open'], ['-P', '@f']);
    assert.equal(opened.code, 0);
    assert.deepEqual(
      opened.calls.map((call) => [call.name, call.argv.at(-1)]),
      [
        ['scrot', `${opened.log}/f`],
        ['xdg-open', `${opened.log}/f`],
      ]
    );
    const missing = await linux(['scrot'], ['-P', '@f']);
    assert.deepEqual(
      [missing.code, missing.stderr],
      [1, 'sccapture: no viewer found (tried xdg-open)\n']
    );
    assert.equal(missing.read('f'), 'image by scrot');
    const clip = await linux(['scrot', 'xclip', 'xdg-open'], ['-P', '-c']);
    assert.deepEqual(
      clip.calls.map((call) => call.name),
      ['scrot', 'xclip']
    );
    const failed = await linux(['scrot', 'xdg-open'], ['-P', '@f'], {
      FAKE_FAIL: 'xdg-open:no handler',
    });
    assert.deepEqual([failed.code, failed.stderr], [1, 'no handler\n']);
  });

  it('passes on the stderr of a tool that fails', async () => {
    const result = await linux(['grim'], ['@f'], {
      ...wayland,
      FAKE_FAIL: 'grim:compositor does not support wlr-screencopy',
    });
    assert.deepEqual(
      [result.code, result.stderr],
      [1, 'compositor does not support wlr-screencopy\n']
    );
  });

  it('resolves a relative file and one that starts with a dash', async () => {
    const result = await linux(['scrot'], ['--', '-dash.png']);
    assert.deepEqual(result.calls[0].argv, ['-o', resolve('-dash.png')]);
    rmSync(resolve('-dash.png'), { force: true });
  });
});

describe('Windows', () => {
  const win = (names, argv, extra) => capture({ platform: 'win32', names, argv, extra });

  it('runs powershell.exe, else pwsh.exe, with a fixed script and the values as data', async () => {
    for (const names of [['powershell.exe', 'pwsh.exe'], ['pwsh.exe']]) {
      const result = await win(names, ['@f.png']);
      assert.deepEqual([result.code, result.stdout, result.stderr], [0, '', '']);
      const [call] = result.calls;
      assert.equal(call.name, names[0]);
      assert.deepEqual(call.argv.slice(0, 4), [
        '-NoProfile',
        '-NonInteractive',
        '-STA',
        '-EncodedCommand',
      ]);
      assert.equal(call.argv.length, 5);
      assert.deepEqual(call.env, {
        SCCAPTURE_FILE: join(result.log, 'f.png'),
        SCCAPTURE_FORMAT: 'png',
        SCCAPTURE_SCREEN: 'all',
      });
      assert.equal(result.read('f.png'), `image by ${names[0]}`);
    }
  });

  it('keeps the file name and values out of the script', async () => {
    const result = await win(
      ['powershell.exe'],
      ['-C', '-R', '1,2,3,4', "@x'; Remove-Item $(evil) & ^ %PATH%.png"],
      {
        SCCAPTURE_RECT: 'stale',
      }
    );
    const script = decoded(result.calls[0].argv);
    assert.doesNotMatch(script, /evil|Remove-Item|1,2,3,4/);
    assert.match(script, /\[SccaptureNative\]::Aware\(\)/);
    assert.match(script, /SetProcessDpiAwarenessContext\(new IntPtr\(-4\)\)/);
    assert.match(script, /SetProcessDPIAware\(\);/);
    assert.match(script, /CopyFromScreen/);
    assert.match(script, /DrawCursor/);
    assert.match(script, /\[System\.Windows\.Forms\.Clipboard\]::SetImage\(\$bitmap\)/);
    assert.match(script, /Invoke-Item -LiteralPath \$env:SCCAPTURE_FILE/);
    assert.match(script, /'sccapture: -D \{0\}: no such display' -f \$index/);
    assert.equal(result.calls[0].env.SCCAPTURE_RECT, '1,2,3,4');
    assert.equal(
      result.calls[0].env.SCCAPTURE_FILE,
      join(result.log, "x'; Remove-Item $(evil) & ^ %PATH%.png")
    );
  });

  it('turns each option into data for the script', async () => {
    for (const [argv, env] of [
      [
        ['-c', '-t', 'gif', '@f.bmp'],
        { SCCAPTURE_FORMAT: 'png', SCCAPTURE_CLIPBOARD: '1', SCCAPTURE_SCREEN: 'all' },
      ],
      [['-C', '@f'], { SCCAPTURE_CURSOR: '1' }],
      [['-m', '@f'], { SCCAPTURE_SCREEN: 'primary' }],
      [['-m', '-D', '2', '@f'], { SCCAPTURE_SCREEN: '2' }],
      [['-R', '5,6,70,80', '@f'], { SCCAPTURE_RECT: '5,6,70,80' }],
      [['-P', '@f'], { SCCAPTURE_OPEN: '1' }],
      [['-t', 'jpeg', '@f.png'], { SCCAPTURE_FORMAT: 'jpg' }],
      [['-t', 'TIFF', '@f'], { SCCAPTURE_FORMAT: 'tiff' }],
      [['@f.JPEG'], { SCCAPTURE_FORMAT: 'jpg' }],
      [['@f.bmp'], { SCCAPTURE_FORMAT: 'bmp' }],
      [['@f.gif'], { SCCAPTURE_FORMAT: 'gif' }],
      [['@f.tif'], { SCCAPTURE_FORMAT: 'tiff' }],
      [['@f.webp'], { SCCAPTURE_FORMAT: 'png' }],
      [['-adorx', '@f'], { SCCAPTURE_FORMAT: 'png' }],
    ]) {
      const result = await win(['powershell.exe'], argv);
      assert.equal(result.code, 0, argv.join(' '));
      const got = result.calls[0].env;
      for (const [key, value] of Object.entries(env))
        assert.equal(got[key], value, `${argv.join(' ')} ${key}`);
      if (argv.includes('-c')) assert.equal(got.SCCAPTURE_FILE, undefined);
      if (argv.includes('-c') || !argv.includes('-P')) assert.equal(got.SCCAPTURE_OPEN, undefined);
    }
    const clip = await win(['powershell.exe'], ['-c', '-P']);
    assert.equal(clip.calls[0].env.SCCAPTURE_OPEN, undefined);
  });

  it('waits for -T, then captures', async () => {
    const result = await win(['powershell.exe'], ['-T', '1', '@f']);
    assert.deepEqual(result.waited, [1]);
  });

  it('refuses the unsupported options', async () => {
    for (const [argv, label] of [
      [['-A'], '-A'],
      [['-b'], '-b'],
      [['-B', 'x'], '-B'],
      [['-g'], '-g'],
      [['-i'], '-i'],
      [['-J', 'window'], '-J'],
      [['-k'], '-k'],
      [['-l', '1'], '-l'],
      [['-M'], '-M'],
      [['-p'], '-p'],
      [['-s'], '-s'],
      [['-S'], '-S'],
      [['-u'], '-u'],
      [['-U'], '-U'],
      [['-w'], '-w'],
      [['-W'], '-W'],
      [['-t', 'webp'], '-t webp'],
      [['-t', 'pdf'], '-t pdf'],
    ]) {
      const result = await win(['powershell.exe'], [...argv, '@f']);
      assert.deepEqual(
        [result.code, result.stderr],
        [2, `sccapture: ${label}: not supported on Windows\n`]
      );
      assert.deepEqual(result.calls, []);
    }
    const many = await win(['powershell.exe'], ['@f', '@g']);
    assert.deepEqual(
      [many.code, many.stderr],
      [2, 'sccapture: more than one file: not supported on Windows\n']
    );
  });

  it('passes on the script failing, and says when PowerShell is missing', async () => {
    const failed = await win(['powershell.exe'], ['-D', '3', '@f'], {
      FAKE_FAIL: 'powershell.exe:sccapture: -D 3: no such display',
    });
    assert.deepEqual([failed.code, failed.stderr], [1, 'sccapture: -D 3: no such display\n']);
    const none = await win([], ['@f']);
    assert.deepEqual(
      [none.code, none.stderr],
      [1, 'sccapture: no screenshot tool found (tried powershell.exe, pwsh.exe)\n']
    );
  });
});

const ready = async ({ log, signals }, signal = 'SIGINT') => {
  while (!existsSync(join(log, 'ready'))) await new Promise((r) => setTimeout(r, 20));
  signals.emit(signal);
};

const head = ['-hide_banner', '-loglevel', 'error', '-nostats', '-y'];
const tail = ['-vf', 'scale=trunc(iw/2)*2:trunc(ih/2)*2', '-pix_fmt', 'yuv420p'];

describe('videos on Linux', posix, () => {
  const film = (names, argv, extra, more) =>
    capture({ platform: 'linux', names, argv, extra: { DISPLAY: '', ...extra }, ...more });

  it('records with ffmpeg under X11, as the table says', async () => {
    const x = (...args) => ['-f', 'x11grab', ...args];
    for (const [argv, expected, extra] of [
      [
        ['-v', '@f.mp4'],
        [...x('-draw_mouse', '0', '-i', ':0'), ...tail],
      ],
      [['-v', '@f.mp4'], [...x('-draw_mouse', '0', '-i', ':1.0'), ...tail], { DISPLAY: ':1.0' }],
      [
        ['-V', '2.5', '-C', '@f.mkv'],
        [...x('-draw_mouse', '1', '-i', ':0'), '-t', '2.5', ...tail],
      ],
      [
        ['-v', '-R', '10,20,300,200', '@f.webm'],
        [...x('-draw_mouse', '0', '-video_size', '300x200', '-i', ':0+10,20'), ...tail],
      ],
      [
        ['-v', '-s', '@f.mp4'],
        [...x('-draw_mouse', '0', '-select_region', '1', '-i', ':0'), ...tail],
      ],
      [
        ['-J', 'video', '-i', '@f.mp4'],
        [...x('-draw_mouse', '0', '-select_region', '1', '-i', ':0'), ...tail],
      ],
      [
        ['-v', '-l', '0x2a', '@f.mp4'],
        [...x('-draw_mouse', '0', '-window_id', '0x2a', '-i', ':0'), ...tail],
      ],
      [
        ['-v', '-g', '@f.mp4'],
        [...x('-draw_mouse', '0', '-i', ':0'), '-f', 'pulse', '-i', 'default', ...tail],
      ],
      [
        ['-v', '-G', 'alsa_input.usb', '@f.mp4'],
        [...x('-draw_mouse', '0', '-i', ':0'), '-f', 'pulse', '-i', 'alsa_input.usb', ...tail],
      ],
      [
        ['-v', '-A', '-g', '@f.mp4'],
        [
          ...x('-draw_mouse', '0', '-i', ':0'),
          '-f',
          'pulse',
          '-i',
          'default',
          '-f',
          'pulse',
          '-i',
          '@DEFAULT_MONITOR@',
          '-filter_complex',
          '[1:a][2:a]amix=inputs=2[a]',
          '-map',
          '0:v',
          '-map',
          '[a]',
          ...tail,
        ],
      ],
      [
        ['-v', '-t', 'mkv', '@f.mp4'],
        [...x('-draw_mouse', '0', '-i', ':0'), ...tail, '-f', 'matroska'],
      ],
      [
        ['-v', '@f'],
        [...x('-draw_mouse', '0', '-i', ':0'), ...tail, '-f', 'mp4'],
      ],
      [
        ['-v', '@f.avi'],
        [...x('-draw_mouse', '0', '-i', ':0'), ...tail],
      ],
    ]) {
      const result = await film(['ffmpeg', 'wf-recorder'], argv, extra);
      assert.equal(result.code, 0, `${argv.join(' ')}: ${result.stderr}`);
      const file = argv.at(-1).replace('@', `${result.log}/`);
      assert.deepEqual(
        result.calls[0],
        { name: 'ffmpeg', argv: [...head, ...expected, file] },
        argv.join(' ')
      );
    }
  });

  it('records with wf-recorder under Wayland, as the table says', async () => {
    for (const [argv, expected] of [
      [['-v', '@f.mp4'], ['-y']],
      [
        ['-v', '-R', '1,2,3,4', '@f.mp4'],
        ['-y', '-g', '1,2 3x4'],
      ],
      [
        ['-v', '-g', '@f.mp4'],
        ['-y', '-a'],
      ],
      [
        ['-v', '-G', 'mic', '@f.mp4'],
        ['-y', '--audio=mic'],
      ],
      [
        ['-v', '-A', '@f.mp4'],
        ['-y', '--audio=@DEFAULT_MONITOR@'],
      ],
      [
        ['-v', '@f.webm'],
        ['-y', '-c', 'libvpx-vp9'],
      ],
      [
        ['-v', '-t', 'webm', '@f'],
        ['-y', '-m', 'webm', '-c', 'libvpx-vp9'],
      ],
      [
        ['-v', '@f'],
        ['-y', '-m', 'mp4'],
      ],
    ]) {
      const result = await film(['wf-recorder', 'ffmpeg'], argv, wayland);
      assert.equal(result.code, 0, `${argv.join(' ')}: ${result.stderr}`);
      const file = argv.at(-1).replace('@', `${result.log}/`);
      assert.deepEqual(
        result.calls[0],
        { name: 'wf-recorder', argv: [...expected, '-f', file] },
        argv.join(' ')
      );
    }
  });

  it('selects a region with slurp for wf-recorder', async () => {
    const result = await film(['wf-recorder', 'slurp'], ['-v', '-s', '@f.mp4'], wayland);
    assert.equal(result.code, 0, result.stderr);
    assert.deepEqual(
      result.calls.map((call) => call.name),
      ['slurp', 'wf-recorder']
    );
    assert.deepEqual(result.calls[1].argv, [
      '-g',
      '10,20 30x40',
      '-y',
      '-f',
      `${result.log}/f.mp4`,
    ]);
  });

  it('stops ffmpeg with q and wf-recorder with SIGINT, on a signal or after -V', async () => {
    const ff = await film(
      ['ffmpeg'],
      ['-v', '@f.mp4'],
      { FAKE_HOLD: 'ffmpeg' },
      {
        during: async ({ log, signals }) => {
          while (!existsSync(join(log, 'calls'))) await new Promise((r) => setTimeout(r, 20));
          await new Promise((r) => setTimeout(r, 200));
          signals.emit('SIGTERM');
          signals.emit('SIGINT');
        },
      }
    );
    assert.deepEqual([ff.code, ff.stderr], [0, '']);
    assert.deepEqual(ff.calls[1], { name: 'ffmpeg', stopped: 'q' });
    const wf = await film(
      ['wf-recorder'],
      ['-v', '@f.mp4'],
      { ...wayland, FAKE_HOLD: 'wf-recorder' },
      {
        during: (context) => ready(context, 'SIGHUP'),
      }
    );
    assert.deepEqual([wf.code, wf.stderr], [0, '']);
    assert.deepEqual(wf.calls[1], { name: 'wf-recorder', stopped: 'SIGINT' });
    const timed = await film(
      ['wf-recorder'],
      ['-V', '3', '@f.mp4'],
      { ...wayland, FAKE_HOLD: 'wf-recorder', FAKE_STOPPED: '130' },
      { pause: 500 }
    );
    assert.deepEqual([timed.code, timed.stderr, timed.waited], [0, '', [0, 3]]);
    assert.deepEqual(timed.calls.at(-1), { name: 'wf-recorder', stopped: 'SIGINT' });
  });

  it('refuses what the recorders cannot do, and says when none is there', async () => {
    for (const [names, argv, extra, message] of [
      [['ffmpeg'], ['-v', '-w', '@f'], {}, '-w: not supported with ffmpeg'],
      [['ffmpeg'], ['-J', 'window', '-v', '@f'], {}, '-J window: not supported with ffmpeg'],
      [['wf-recorder'], ['-v', '-W', '@f'], wayland, '-W: not supported with wf-recorder'],
      [['wf-recorder'], ['-v', '-l', '1', '@f'], wayland, '-l: not supported with wf-recorder'],
      [['wf-recorder'], ['-v', '-C', '@f'], wayland, '-C: not supported with wf-recorder'],
      [['wf-recorder'], ['-v', '-A', '-g', '@f'], wayland, '-A: not supported with wf-recorder'],
    ]) {
      const result = await film(names, argv, extra);
      assert.deepEqual([result.code, result.stderr], [2, `sccapture: ${message}\n`], message);
      assert.deepEqual(result.calls, []);
    }
    const none = await film(['ffmpeg'], ['-v', '@f'], wayland);
    assert.deepEqual(
      [none.code, none.stderr],
      [1, 'sccapture: no screen recorder found (tried wf-recorder)\n']
    );
    const x = await film([], ['-v', '@f']);
    assert.deepEqual(
      [x.code, x.stderr],
      [1, 'sccapture: no screen recorder found (tried ffmpeg)\n']
    );
    const failed = await film(['ffmpeg'], ['-V', '1', '@f'], {
      FAKE_FAIL: 'ffmpeg:Cannot open display',
    });
    assert.deepEqual([failed.code, failed.stderr], [1, 'Cannot open display\n']);
  });

  it('needs -v for the audio options, and refuses -c with it', async () => {
    for (const [argv, message] of [
      [['-g', '@f'], '-g: needs -v'],
      [['-G', 'x', '@f'], '-G: needs -v'],
      [['-A', '@f'], '-A: needs -v'],
      [['-v', '-c'], '-c: not with -v'],
      [['-v', '--clipboard'], '--clipboard: not with -v'],
      [['-V', '0', '@f'], '-V: invalid duration: 0'],
      [['-V', 'x', '@f'], '-V: invalid duration: x'],
      [['-v', '-G', ' ', '@f'], '-G: invalid audio input:  '],
    ]) {
      const result = await film(['ffmpeg'], argv);
      assert.deepEqual([result.code, result.stderr], [2, `sccapture: ${message}\n`], message);
    }
  });

  it('opens the movie with xdg-open for -P', async () => {
    const result = await film(['ffmpeg', 'xdg-open'], ['-V', '1', '-P', '@f.mp4']);
    assert.equal(result.code, 0, result.stderr);
    assert.deepEqual(
      result.calls.map((call) => call.name),
      ['ffmpeg', 'xdg-open']
    );
  });
});

describe('videos on Windows', () => {
  const film = (names, argv, extra) => capture({ platform: 'win32', names, argv, extra });
  const grab = (...args) => ['-f', 'gdigrab', ...args];

  it('records with ffmpeg.exe and gdigrab, as the table says', async () => {
    for (const [argv, expected] of [
      [
        ['-v', '@f.mp4'],
        [...grab('-draw_mouse', '0', '-i', 'desktop'), ...tail],
      ],
      [
        ['-V', '4', '-C', '@f.mp4'],
        [...grab('-draw_mouse', '1', '-i', 'desktop'), '-t', '4', ...tail],
      ],
      [
        ['-v', '-R', '5,6,70,80', '@f.mkv'],
        [
          ...grab(
            '-draw_mouse',
            '0',
            '-offset_x',
            '5',
            '-offset_y',
            '6',
            '-video_size',
            '70x80',
            '-i',
            'desktop'
          ),
          ...tail,
        ],
      ],
      [
        ['-v', '-G', 'Microphone (USB)', '@f.mp4'],
        [
          ...grab('-draw_mouse', '0', '-i', 'desktop'),
          '-f',
          'dshow',
          '-i',
          'audio=Microphone (USB)',
          ...tail,
        ],
      ],
      [
        ['-v', '-t', 'mov', '@f'],
        [...grab('-draw_mouse', '0', '-i', 'desktop'), ...tail, '-f', 'mov'],
      ],
    ]) {
      const result = await film(['ffmpeg.exe'], argv);
      assert.equal(result.code, 0, `${argv.join(' ')}: ${result.stderr}`);
      const file = resolve(argv.at(-1).replace('@', `${result.log}${sep}`));
      assert.deepEqual(result.calls[0].name, 'ffmpeg.exe');
      assert.deepEqual(result.calls[0].argv, [...head, ...expected, file], argv.join(' '));
    }
  });

  it('refuses -m and -D with -v, and says when ffmpeg.exe is missing', async () => {
    for (const [argv, message] of [
      [['-v', '-m', '@f'], '-m: not supported with ffmpeg.exe'],
      [['-v', '-D', '2', '@f'], '-D: not supported with ffmpeg.exe'],
    ]) {
      const result = await film(['ffmpeg.exe'], argv);
      assert.deepEqual([result.code, result.stderr], [2, `sccapture: ${message}\n`]);
      assert.deepEqual(result.calls, []);
    }
    const none = await film(['powershell.exe'], ['-v', '@f']);
    assert.deepEqual(
      [none.code, none.stderr],
      [1, 'sccapture: no screen recorder found (tried ffmpeg.exe)\n']
    );
  });

  it('opens the movie with Invoke-Item for -P, with the file as data', async () => {
    const result = await film(['ffmpeg.exe', 'pwsh.exe'], ['-V', '1', '-P', '@f.mp4']);
    assert.equal(result.code, 0, result.stderr);
    assert.deepEqual(
      result.calls.map((call) => call.name),
      ['ffmpeg.exe', 'pwsh.exe']
    );
    assert.equal(decoded(result.calls[1].argv), 'Invoke-Item -LiteralPath $env:SCCAPTURE_FILE');
    assert.equal(result.calls[1].env.SCCAPTURE_FILE, resolve(`${result.log}${sep}f.mp4`));
    const none = await film(['ffmpeg.exe'], ['-V', '1', '-P', '@f.mp4']);
    assert.deepEqual(
      [none.code, none.stderr],
      [1, 'sccapture: no viewer found (tried powershell.exe, pwsh.exe)\n']
    );
  });
});

describe('standard output on a host', posix, () => {
  it('writes the capture to standard output for -, and leaves no file', async () => {
    for (const [platform, names, argv, extra, made] of [
      ['linux', ['scrot'], ['-'], {}, 'capture.png'],
      ['linux', ['scrot'], ['-t', 'jpg', '--', '-'], {}, 'capture.jpg'],
      ['linux', ['ffmpeg'], ['-V', '1', '-'], {}, 'capture.mp4'],
      ['linux', ['ffmpeg'], ['-V', '1', '-t', 'webm', '-'], {}, 'capture.webm'],
      ['darwin', ['screencapture'], ['-x', '-'], {}, 'capture.png'],
      ['darwin', ['screencapture'], ['-V', '1', '-'], {}, 'capture.mov'],
    ]) {
      const result = await capture({ platform, names, argv, extra });
      const how = `${platform} ${argv.join(' ')}`;
      assert.deepEqual([result.code, result.stderr], [0, ''], how);
      assert.equal(result.stdout, `image by ${names[0]}`, how);
      const file = result.calls[0].argv.at(-1).replace(/^[a-z]+:/, '');
      assert.equal(file.split(/[\\/]/).at(-1), made, how);
      assert.equal(existsSync(file), false, how);
    }
  });

  it('refuses a terminal, -P and another file with -', async () => {
    for (const [argv, tty, message] of [
      [
        ['-'],
        () => true,
        'refusing to write to a terminal: redirect standard output or name a file',
      ],
      [['-P', '-'], undefined, '-P: not with -'],
      [['-', '@f'], undefined, '-: standard output takes no other file'],
    ]) {
      const result = await capture({ platform: 'darwin', names: ['screencapture'], argv, tty });
      assert.deepEqual(
        [result.code, result.stdout, result.stderr],
        [2, '', `sccapture: ${message}\n`]
      );
      assert.deepEqual(result.calls, []);
    }
  });

  it('fails when the tool fails or writes nothing', async () => {
    const failed = await capture({
      platform: 'linux',
      names: ['scrot'],
      argv: ['-'],
      extra: { FAKE_FAIL: 'scrot:no display' },
    });
    assert.deepEqual([failed.code, failed.stdout, failed.stderr], [1, '', 'no display\n']);
    const empty = await capture({
      platform: 'linux',
      names: ['scrot'],
      argv: ['-'],
      extra: { FAKE_EMPTY: '1' },
    });
    assert.deepEqual(
      [empty.code, empty.stdout, empty.stderr],
      [1, '', 'sccapture: nothing was captured\n']
    );
  });
});

describe('--upgrade', () => {
  let server;
  let url;
  const files = new Map();
  before(async () => {
    server = createServer((request, response) => {
      const body = files.get(request.url);
      response.writeHead(body === undefined ? 404 : 200);
      response.end(body ?? 'not found');
    });
    await new Promise((done) => server.listen(0, '127.0.0.1', done));
    url = `http://127.0.0.1:${server.address().port}`;
  });
  after(() => server.close());

  const installer = (body) => {
    const name = `/r${files.size}`;
    files.set(`${name}/install.sh`, `#!/bin/sh\n${body}\n`);
    return `${url}${name}`;
  };
  const shell = dirname(
    spawnSync('sh', ['-c', 'command -v sh'], { encoding: 'utf8' }).stdout.trim()
  );

  it('prints the npm command when npm installed it', async () => {
    const result = await capture({ platform: 'linux', argv: ['--upgrade'] });
    assert.deepEqual(
      [result.code, result.stdout, result.calls],
      [0, 'npm install -g @ai-ecoverse/slicc-capture@latest\n', []]
    );
  });

  it('runs the latest install.sh with --dir and prints old → new', posix, async () => {
    const log = join(mkdtempSync(join(scratch, 'up-')), 'args');
    const at = installer(
      `printf '%s\\n' "$@" "\${SCCAPTURE_INSTALL_DIR:-unset}" > '${log}'\necho progress >&2\necho 'sccapture 99.1.0 installed to /x/sccapture'`
    );
    const result = await capture({
      platform: 'linux',
      argv: ['--upgrade'],
      extra: {
        PATH: shell,
        SCCAPTURE_INSTALL_DIR: '/opt/my bin',
        SLICC_INSTALL_BASE_URL: `${at}/`,
      },
    });
    assert.equal(result.code, 0, result.stderr);
    assert.equal(result.stdout, `sccapture: ${version} → 99.1.0\n`);
    assert.equal(result.stderr, 'progress\n');
    assert.deepEqual(readFileSync(log, 'utf8').split('\n'), ['--dir', '/opt/my bin', 'unset', '']);
  });

  it('says when it is already up to date', posix, async () => {
    const at = installer(`echo 'sccapture ${version} installed to /x/sccapture'`);
    const result = await capture({
      platform: 'darwin',
      argv: ['--upgrade'],
      extra: { PATH: shell, SCCAPTURE_INSTALL_DIR: '/d', SLICC_INSTALL_BASE_URL: at },
    });
    assert.deepEqual(
      [result.code, result.stdout],
      [0, `sccapture: already up to date (${version})\n`]
    );
  });

  it('passes a failing installer stderr through and exits 1', posix, async () => {
    for (const [body, stderr] of [
      ['echo broken >&2; exit 5', 'broken\n'],
      ['echo nothing useful', 'sccapture: install.sh did not say which version it installed\n'],
    ]) {
      const at = installer(body);
      const result = await capture({
        platform: 'linux',
        argv: ['--upgrade'],
        extra: { PATH: shell, SCCAPTURE_INSTALL_DIR: '/d', SLICC_INSTALL_BASE_URL: at },
      });
      assert.deepEqual([result.code, result.stdout, result.stderr], [1, '', stderr]);
    }
  });

  it('exits 1 when the installer cannot be downloaded or run', async () => {
    const missing = await capture({
      platform: 'linux',
      argv: ['--upgrade'],
      extra: { SCCAPTURE_INSTALL_DIR: '/d', SLICC_INSTALL_BASE_URL: `${url}/gone` },
    });
    assert.equal(missing.code, 1);
    assert.equal(
      missing.stderr,
      `sccapture: could not download ${url}/gone/install.sh: HTTP 404\n`
    );
    const refused = await capture({
      platform: 'linux',
      argv: ['--upgrade'],
      extra: { SCCAPTURE_INSTALL_DIR: '/d', SLICC_INSTALL_BASE_URL: 'http://127.0.0.1:1' },
    });
    assert.equal(refused.code, 1);
    assert.match(
      refused.stderr,
      /^sccapture: could not download http:\/\/127\.0\.0\.1:1\/install\.sh: /
    );
    const at = installer('exit 0');
    const noShell = await capture({
      platform: 'linux',
      argv: ['--upgrade'],
      extra: { SCCAPTURE_INSTALL_DIR: '/d', SLICC_INSTALL_BASE_URL: at },
    });
    assert.equal(noShell.code, 1);
    assert.equal(noShell.stderr, 'sccapture: no shell found to run install.sh (tried sh)\n');
  });

  it('exits 1 when sh cannot run the installer', posix, async () => {
    const at = installer('exit 0');
    const broken = await capture({
      platform: 'linux',
      names: ['sh'],
      argv: ['--upgrade'],
      extra: { SCCAPTURE_INSTALL_DIR: '/d', SLICC_INSTALL_BASE_URL: at },
    });
    assert.equal(broken.code, 1);
  });

  it('drops the body of a failed download', async () => {
    let closed;
    const gone = new Promise((done) => {
      closed = done;
    });
    const endless = createServer((request, response) => {
      response.writeHead(500);
      response.write('still going\n');
      response.on('close', closed);
    });
    await new Promise((done) => endless.listen(0, '127.0.0.1', done));
    try {
      const at = `http://127.0.0.1:${endless.address().port}`;
      const result = await capture({
        platform: 'linux',
        argv: ['--upgrade'],
        timeout: 30000,
        extra: { SCCAPTURE_INSTALL_DIR: '/d', SLICC_INSTALL_BASE_URL: at },
      });
      assert.deepEqual(
        [result.code, result.stderr],
        [1, `sccapture: could not download ${at}/install.sh: HTTP 500\n`]
      );
      let timer;
      const late = new Promise((done) => {
        timer = setTimeout(() => done('open'), 2000);
      });
      assert.equal(await Promise.race([gone.then(() => 'closed'), late]), 'closed');
      clearTimeout(timer);
    } finally {
      endless.closeAllConnections();
      endless.close();
    }
  });

  it('still exits 1 when cancelling a failed download rejects', async () => {
    const real = globalThis.fetch;
    globalThis.fetch = async () => ({
      ok: false,
      status: 500,
      body: { cancel: () => Promise.reject(new Error('x')) },
    });
    try {
      const result = await capture({
        platform: 'linux',
        argv: ['--upgrade'],
        extra: { SCCAPTURE_INSTALL_DIR: '/d', SLICC_INSTALL_BASE_URL: 'http://127.0.0.1:1/r' },
      });
      assert.deepEqual(
        [result.code, result.stderr],
        [1, 'sccapture: could not download http://127.0.0.1:1/r/install.sh: HTTP 500\n']
      );
    } finally {
      globalThis.fetch = real;
    }
  });

  it('gives up on a download that never answers, after the timeout', async () => {
    const sockets = new Set();
    const silent = createServer(() => {});
    silent.on('connection', (socket) => sockets.add(socket));
    await new Promise((done) => silent.listen(0, '127.0.0.1', done));
    try {
      for (const [prefix, body] of [
        ['headers', false],
        ['body', true],
      ]) {
        if (body) {
          silent.removeAllListeners('request');
          silent.on('request', (request, response) => {
            response.writeHead(200);
            response.write('#!/bin/sh\n');
          });
        }
        const started = Date.now();
        const result = await capture({
          platform: 'linux',
          names: ['sh'],
          argv: ['--upgrade'],
          timeout: 300,
          extra: {
            SCCAPTURE_INSTALL_DIR: '/d',
            SLICC_INSTALL_BASE_URL: `http://127.0.0.1:${silent.address().port}/${prefix}`,
          },
        });
        assert.deepEqual(
          [result.code, result.stdout, result.stderr],
          [1, '', 'sccapture: download timed out\n']
        );
        assert.ok(Date.now() - started < 5000);
        assert.deepEqual(result.calls, []);
      }
    } finally {
      for (const socket of sockets) socket.destroy();
      silent.close();
    }
  });

  it('waits 60 seconds for the download by default', () => {
    assert.match(readFileSync(join(root, 'host/capture.mjs'), 'utf8'), /timeout = 60000,/);
  });

  it('runs install.ps1 with -Dir through PowerShell on Windows', async () => {
    files.set('/win/install.ps1', 'param($Dir)');
    const result = await capture({
      platform: 'win32',
      names: ['powershell.exe', 'pwsh.exe'],
      argv: ['--upgrade'],
      extra: {
        SCCAPTURE_INSTALL_DIR: 'C:\\Users\\me\\bin',
        SLICC_INSTALL_BASE_URL: `${url}/win`,
        FAKE_INSTALLED: '99.2.0',
        PSModulePath: 'C:\\Program Files\\PowerShell\\7\\Modules',
      },
    });
    assert.equal(result.code, 0, result.stderr);
    assert.equal(result.stdout, `sccapture: ${version} → 99.2.0\n`);
    const [call] = result.calls;
    assert.equal(call.name, 'powershell.exe');
    assert.deepEqual(call.argv.slice(0, 5), [
      '-NoProfile',
      '-NonInteractive',
      '-ExecutionPolicy',
      'Bypass',
      '-File',
    ]);
    assert.match(call.argv[5], /install\.ps1$/);
    assert.deepEqual(call.argv.slice(6), ['-Dir', 'C:\\Users\\me\\bin']);
    assert.equal(call.file, 'param($Dir)');
    assert.equal(call.env.SCCAPTURE_INSTALL_DIR, undefined);
    assert.equal(call.modules, null);
    const none = await capture({
      platform: 'win32',
      argv: ['--upgrade'],
      extra: { SCCAPTURE_INSTALL_DIR: 'C:\\d', SLICC_INSTALL_BASE_URL: `${url}/win` },
    });
    assert.equal(
      none.stderr,
      'sccapture: no shell found to run install.ps1 (tried powershell.exe, pwsh.exe)\n'
    );
  });

  it('keeps SCCAPTURE_INSTALL_DIR from the screenshot tools', async () => {
    const result = await capture({
      platform: 'win32',
      names: ['powershell.exe'],
      argv: ['@f'],
      extra: { SCCAPTURE_INSTALL_DIR: 'C:\\x' },
    });
    assert.equal(result.code, 0, result.stderr);
    assert.equal(result.calls[0].env.SCCAPTURE_INSTALL_DIR, undefined);
  });

  it('is run by the spawned bin too', () => {
    const npm = spawnSync(process.execPath, [join(root, 'host', 'sccapture.mjs'), '--upgrade'], {
      env: base(delimiter),
      encoding: 'utf8',
    });
    assert.deepEqual(
      [npm.status, npm.stdout],
      [0, 'npm install -g @ai-ecoverse/slicc-capture@latest\n']
    );
  });
});

function installed(name) {
  const found = spawnSync('sh', ['-c', `command -v ${name}`], { encoding: 'utf8' });
  return found.status === 0 ? found.stdout.trim() : undefined;
}

function live(name) {
  if (process.env.CI !== 'true') return 'touches the real screen, so it runs on CI only';
  if (process.platform !== 'linux') return 'runs on Linux only';
  if (!process.env.DISPLAY || process.env.WAYLAND_DISPLAY) return 'needs an X display';
  if (!installed(name)) return `${name} is not installed`;
  return false;
}

describe('the real screen on Linux', () => {
  for (const name of ['import', 'scrot']) {
    it(`captures a PNG with ${name}`, { skip: live(name) }, () => {
      const dir = mkdtempSync(join(scratch, 'bin-'));
      symlinkSync(installed(name), join(dir, name));
      const file = join(dir, 'shot.png');
      const result = spawnSync(
        process.execPath,
        [join(root, 'host', 'sccapture.mjs'), '-R', '0,0,64,32', file],
        {
          env: base(dir),
          encoding: 'utf8',
          timeout: 60000,
        }
      );
      assert.deepEqual([result.status, result.stderr], [0, '']);
      assert.deepEqual(
        [...readFileSync(file).subarray(0, 8)],
        [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]
      );
    });
  }
});
