import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  chmodSync,
  closeSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { after, describe, it } from 'node:test';
import { run } from '../../host/capture.mjs';

const root = resolve(import.meta.dirname, '../..');
const scratch = realpathSync(mkdtempSync(join(tmpdir(), 'slicc-capture-host-')));
const usage =
  'usage: sccapture [-acdimorvwxCW] [-t format] [-T seconds] [-R x,y,w,h] [-D display] [-J style] [file]\n';
const version = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).version;

after(() => rmSync(scratch, { recursive: true, force: true }));

const shooters = ['screencapture', 'grim', 'gnome-screenshot', 'import', 'scrot'];

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
if (name === 'sh' || argv.includes('-File')) call.version = process.env.VERSION ?? 'unset';
fs.appendFileSync(path.join(process.env.FAKE_LOG, 'calls'), JSON.stringify(call) + '\\n');
const fail = (process.env.FAKE_FAIL ?? '').split('|').find((rule) => rule.startsWith(name + ':'));
if (fail !== undefined) {
  const message = fail.slice(name.length + 1);
  if (message) process.stderr.write(message + '\\n');
  process.exit(3);
}
if (name === 'slurp') process.stdout.write('10,20 30x40\\n');
if (${JSON.stringify(shooters)}.includes(name) && argv.length && path.isAbsolute(argv.at(-1).replace(/^[a-z]+:/, ''))) {
  fs.writeFileSync(argv.at(-1).replace(/^[a-z]+:/, ''), 'image by ' + name);
}
if (process.env.SCCAPTURE_FILE) fs.writeFileSync(process.env.SCCAPTURE_FILE, 'image by ' + name);
if (name.startsWith('curl') || name === 'wget') {
  const out = argv[argv.indexOf(name === 'wget' ? '-O' : '-o') + 1];
  fs.copyFileSync(process.env.FAKE_INSTALLER, out);
}
if (argv.includes('-File')) {
  const next = process.env.FAKE_NEXT;
  fs.mkdirSync(path.join(process.env.FAKE_DATA, next), { recursive: true });
  fs.writeFileSync(path.join(process.env.FAKE_DATA, next, 'package.json'), JSON.stringify({ version: next }));
  fs.rmSync(path.join(process.env.FAKE_DATA, 'current'), { force: true });
  fs.symlinkSync(next, path.join(process.env.FAKE_DATA, 'current'));
}
`;
}

function bin(names) {
  const dir = mkdtempSync(join(scratch, 'bin-'));
  for (const name of names) {
    writeFileSync(join(dir, name), fake(name));
    chmodSync(join(dir, name), 0o755);
  }
  return dir;
}

function base(path) {
  const env = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (!['PATH', 'WAYLAND_DISPLAY', 'VERSION', 'INSTALL_DIR'].includes(key.toUpperCase())) {
      env[key] = value;
    }
  }
  env.PATH = path;
  return env;
}

async function capture({ platform, names = [], argv, extra = {}, entry, path = (dir) => dir }) {
  const dir = bin(names);
  const log = mkdtempSync(join(scratch, 'log-'));
  const out = join(log, 'out');
  const err = join(log, 'err');
  const fds = [openSync('/dev/null', 'r'), openSync(out, 'w'), openSync(err, 'w')];
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
  };
  const files = (name) => join(log, name);
  const args = argv.map((arg) => arg.replace(/^@/, `${log}/`));
  let code;
  try {
    code = await run({ argv: args, env, platform, fds, wait, entry });
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
    it(`prints the usage for -h or --help anywhere on ${platform}`, async () => {
      for (const argv of [['-h'], ['--help'], ['-xh'], ['-Z', 'f', '-h'], ['--version', '-h']]) {
        const result = await capture({ platform, argv });
        assert.deepEqual(
          [result.code, result.stdout, result.stderr],
          [0, usage, ''],
          argv.join(' ')
        );
        assert.deepEqual(result.calls, []);
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
        [2, `sccapture: output file required (or use -c for clipboard)\n${usage}`]
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

describe('macOS', () => {
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

  it('refuses the video options', async () => {
    for (const [argv, label] of [
      [['-v'], '-v'],
      [['--view'], '--view'],
      [['-V', '5'], '-V'],
      [['-g'], '-g'],
      [['-G', '1'], '-G'],
      [['-k'], '-k'],
    ]) {
      const result = await mac([...argv, '@f']);
      assert.deepEqual(
        [result.code, result.stderr],
        [2, `sccapture: ${label}: not supported on macOS\n`]
      );
      assert.deepEqual(result.calls, []);
    }
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

describe('Linux', () => {
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
      [['-g'], '-g'],
      [['-G', '1'], '-G'],
      [['-k'], '-k'],
      [['-m'], '-m'],
      [['-M'], '-M'],
      [['-p'], '-p'],
      [['-S'], '-S'],
      [['-u'], '-u'],
      [['-U'], '-U'],
      [['-v'], '-v'],
      [['--view'], '--view'],
      [['-V', '1'], '-V'],
      [['-J', 'video'], '-J video'],
      [['-t', 'webp'], '-t webp'],
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
        SCCAPTURE_FILE: `${result.log}/f.png`,
        SCCAPTURE_FORMAT: 'png',
        SCCAPTURE_SCREEN: 'all',
      });
      assert.equal(result.read('f.png'), `image by ${names[0]}`);
    }
  });

  it('keeps the file name and values out of the script', async () => {
    const result = await win(
      ['powershell.exe'],
      ['-C', '-R', '1,2,3,4', "@x'; Remove-Item C:\\ $(evil).png"],
      {
        SCCAPTURE_RECT: 'stale',
      }
    );
    const script = decoded(result.calls[0].argv);
    assert.doesNotMatch(script, /evil|Remove-Item|1,2,3,4/);
    assert.match(script, /SetProcessDPIAware/);
    assert.match(script, /CopyFromScreen/);
    assert.match(script, /DrawCursor/);
    assert.match(script, /\[System\.Windows\.Forms\.Clipboard\]::SetImage\(\$bitmap\)/);
    assert.match(script, /Invoke-Item -LiteralPath \$env:SCCAPTURE_FILE/);
    assert.match(script, /'sccapture: -D \{0\}: no such display' -f \$index/);
    assert.equal(result.calls[0].env.SCCAPTURE_RECT, '1,2,3,4');
    assert.equal(
      result.calls[0].env.SCCAPTURE_FILE,
      `${result.log}/x'; Remove-Item C:\\ $(evil).png`
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
      [['-b'], '-b'],
      [['-B', 'x'], '-B'],
      [['-g'], '-g'],
      [['-G', '1'], '-G'],
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
      [['-v'], '-v'],
      [['-V', '1'], '-V'],
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

function layout(from = '1.0.0') {
  const home = mkdtempSync(join(scratch, 'home-'));
  const data = join(home, 'share', 'slicc-capture');
  mkdirSync(join(data, from, 'host'), { recursive: true });
  cpSync(join(root, 'host'), join(data, from, 'host'), { recursive: true });
  writeFileSync(join(data, from, 'package.json'), JSON.stringify({ version: from }));
  symlinkSync(from, join(data, 'current'));
  const launchers = join(home, 'launchers');
  mkdirSync(launchers);
  const entry = join(data, from, 'host', 'sccapture.mjs');
  writeFileSync(
    join(launchers, 'sccapture'),
    `#!/bin/sh\nexec "${process.execPath}" "${entry}" "$@"\n`
  );
  chmodSync(join(launchers, 'sccapture'), 0o755);
  writeFileSync(join(launchers, 'sccapture.cmd'), `@"node.exe" "${entry}" %*\r\n`);
  const installer = join(home, 'install');
  writeFileSync(
    installer,
    [
      'printf "%s\\n" "$*" > "$FAKE_LOG/installer"',
      'printf "%s\\n" "${VERSION-unset}" >> "$FAKE_LOG/installer"',
      '[ -n "$FAKE_INSTALL_FAIL" ] && { printf "%s\\n" "$FAKE_INSTALL_FAIL" >&2; exit 4; }',
      '/bin/mkdir -p "$FAKE_DATA/$FAKE_NEXT"',
      'printf \'{"version":"%s"}\' "$FAKE_NEXT" > "$FAKE_DATA/$FAKE_NEXT/package.json"',
      '/bin/ln -sfn "$FAKE_NEXT" "$FAKE_DATA/current"',
      'printf "sccapture %s installed to %s\\n" "$FAKE_NEXT" "$2/sccapture"',
      '',
    ].join('\n')
  );
  return {
    home,
    data,
    entry,
    launchers,
    installer,
    extra: { FAKE_DATA: data, FAKE_INSTALLER: installer },
  };
}

describe('--upgrade', () => {
  const posix = process.platform === 'win32' && 'needs /bin/sh';

  it('tells an npm install to upgrade with npm', async () => {
    const result = await capture({ platform: 'linux', names: ['curl'], argv: ['--upgrade'] });
    assert.deepEqual(
      [result.code, result.stdout, result.stderr, result.calls],
      [0, 'npm install -g @ai-ecoverse/slicc-capture@latest\n', '', []]
    );
  });

  it('runs the latest install.sh into the launcher directory and prints old → new', {
    skip: posix,
  }, async () => {
    const at = layout();
    const result = await capture({
      platform: 'linux',
      names: ['curl', 'wget'],
      argv: ['--upgrade'],
      entry: at.entry,
      extra: {
        ...at.extra,
        FAKE_NEXT: '1.1.0',
        VERSION: '0.9.0',
        INSTALL_DIR: '/nowhere',
        HOME: at.home,
      },
    });
    assert.deepEqual(
      [result.code, result.stdout, result.stderr],
      [0, 'sccapture: 1.0.0 → 1.1.0\n', '']
    );
    const [curl] = result.calls;
    assert.equal(curl.name, 'curl');
    assert.deepEqual(curl.argv.slice(0, 2), ['-fsSL', '-o']);
    assert.match(curl.argv[2], /install\.sh$/);
    assert.equal(
      curl.argv[3],
      'https://github.com/ai-ecoverse/slicc-capture/releases/latest/download/install.sh'
    );
    assert.equal(existsSync(curl.argv[2]), false);
    assert.equal(result.read('installer'), `--dir ${join(at.home, '.local', 'bin')}\nunset\n`);
  });

  it('finds the launcher on PATH, and says already up to date', { skip: posix }, async () => {
    const at = layout('1.1.0');
    const dir = bin(['wget']);
    const log = mkdtempSync(join(scratch, 'log-'));
    const out = join(log, 'out');
    const fds = [0, openSync(out, 'w'), 2];
    const env = {
      ...base(`${join(scratch, 'none')}:${at.launchers}:${dir}`),
      ...at.extra,
      FAKE_LOG: log,
      FAKE_NEXT: '1.1.0',
      HOME: at.home,
    };
    const code = await run({ argv: ['--upgrade'], env, platform: 'darwin', fds, entry: at.entry });
    closeSync(fds[1]);
    assert.deepEqual(
      [code, readFileSync(out, 'utf8')],
      [0, 'sccapture: already up to date (1.1.0)\n']
    );
    assert.equal(readFileSync(join(log, 'installer'), 'utf8'), `--dir ${at.launchers}\nunset\n`);
    const [wget] = readFileSync(join(log, 'calls'), 'utf8').trim().split('\n').map(JSON.parse);
    assert.deepEqual(wget.argv.slice(0, 2), ['-q', '-O']);
  });

  it('finds a launcher that names the data directory through a symlink', {
    skip: posix,
  }, async () => {
    const at = layout();
    const link = join(at.home, 'linked');
    symlinkSync(join(at.home, 'share'), link);
    const other = join(at.home, 'other');
    mkdirSync(other);
    writeFileSync(
      join(other, 'sccapture'),
      `exec node "${join(link, 'slicc-capture', 'current', 'host', 'sccapture.mjs')}"\n`
    );
    const result = await capture({
      platform: 'linux',
      names: ['curl'],
      argv: ['--upgrade'],
      entry: at.entry,
      extra: { ...at.extra, FAKE_NEXT: '2.0.0', XDG_DATA_HOME: link, HOME: at.home },
    });
    assert.equal(result.code, 0);
    assert.equal(result.read('installer'), `--dir ${join(at.home, '.local', 'bin')}\nunset\n`);
    const found = await capture({
      platform: 'linux',
      names: ['curl'],
      argv: ['--upgrade'],
      entry: at.entry,
      extra: {
        ...at.extra,
        FAKE_NEXT: '2.0.0',
        XDG_DATA_HOME: link,
        HOME: at.home,
        PATH: undefined,
      },
      path: (dir) => `${other}:${dir}`,
    });
    assert.equal(found.code, 0, found.stderr);
    assert.equal(found.read('installer'), `--dir ${other}\nunset\n`);
    const none = await capture({
      platform: 'linux',
      argv: ['--upgrade'],
      entry: at.entry,
      extra: at.extra,
    });
    assert.deepEqual(
      [none.code, none.stderr],
      [1, 'sccapture: no downloader found (tried curl, wget)\n']
    );
  });

  it('passes on the installer failing', { skip: posix }, async () => {
    const at = layout();
    const result = await capture({
      platform: 'linux',
      names: ['curl'],
      argv: ['--upgrade'],
      entry: at.entry,
      extra: {
        ...at.extra,
        FAKE_NEXT: '1.1.0',
        FAKE_INSTALL_FAIL: 'slicc-capture: checksum mismatch',
      },
    });
    assert.deepEqual(
      [result.code, result.stdout, result.stderr],
      [1, '', 'slicc-capture: checksum mismatch\n']
    );
    const download = await capture({
      platform: 'linux',
      names: ['curl'],
      argv: ['--upgrade'],
      entry: at.entry,
      extra: { ...at.extra, FAKE_FAIL: 'curl:curl: (22) The requested URL returned error: 404' },
    });
    assert.deepEqual(
      [download.code, download.stderr],
      [1, 'curl: (22) The requested URL returned error: 404\n']
    );
  });

  it('runs install.ps1 with PowerShell on Windows', async () => {
    const at = layout();
    const result = await capture({
      platform: 'win32',
      names: ['curl.exe', 'pwsh.exe'],
      argv: ['--upgrade'],
      entry: at.entry,
      extra: { ...at.extra, FAKE_NEXT: '1.2.0', LOCALAPPDATA: join(at.home, 'appdata') },
    });
    assert.deepEqual(
      [result.code, result.stdout, result.stderr],
      [0, 'sccapture: 1.0.0 → 1.2.0\n', '']
    );
    const [curl, pwsh] = result.calls;
    assert.equal(
      curl.argv[3],
      'https://github.com/ai-ecoverse/slicc-capture/releases/latest/download/install.ps1'
    );
    assert.equal(pwsh.name, 'pwsh.exe');
    assert.deepEqual(pwsh.argv.slice(0, 6), [
      '-NoProfile',
      '-NonInteractive',
      '-ExecutionPolicy',
      'Bypass',
      '-File',
      curl.argv[2],
    ]);
    assert.deepEqual(pwsh.argv.slice(6), [
      '--dir',
      join(at.home, 'appdata', 'slicc-capture', 'bin'),
    ]);
    const none = await capture({
      platform: 'win32',
      names: ['curl.exe'],
      argv: ['--upgrade'],
      entry: at.entry,
      extra: at.extra,
    });
    assert.deepEqual(
      [none.code, none.stderr],
      [1, 'sccapture: no PowerShell found (tried powershell.exe, pwsh.exe)\n']
    );
    const noget = await capture({
      platform: 'win32',
      names: ['pwsh.exe'],
      argv: ['--upgrade'],
      entry: at.entry,
      extra: at.extra,
    });
    assert.deepEqual(
      [noget.code, noget.stderr],
      [1, 'sccapture: no downloader found (tried curl.exe)\n']
    );
  });

  it('upgrades through the launcher the installer wrote', { skip: posix }, () => {
    const at = layout();
    const log = mkdtempSync(join(scratch, 'log-'));
    const env = {
      ...base(`${at.launchers}:${bin(['curl'])}`),
      ...at.extra,
      FAKE_LOG: log,
      FAKE_NEXT: '1.3.0',
      HOME: at.home,
    };
    const version = spawnSync(join(at.launchers, 'sccapture'), ['--version'], {
      env,
      encoding: 'utf8',
    });
    assert.deepEqual([version.status, version.stdout], [0, '1.0.0\n']);
    const result = spawnSync(join(at.launchers, 'sccapture'), ['--upgrade'], {
      env,
      encoding: 'utf8',
    });
    assert.deepEqual(
      [result.status, result.stdout, result.stderr],
      [0, 'sccapture: 1.0.0 → 1.3.0\n', '']
    );
    assert.equal(readFileSync(join(log, 'installer'), 'utf8'), `--dir ${at.launchers}\nunset\n`);
    const npm = spawnSync(process.execPath, [join(root, 'host', 'sccapture.mjs'), '--upgrade'], {
      env,
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
