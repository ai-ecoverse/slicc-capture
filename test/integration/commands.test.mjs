import assert from 'node:assert/strict';
import { after, before, beforeEach, describe, it } from 'node:test';
import { boot, bootWithoutEmbedder } from './kernel.mjs';

const names = ['screencapture', 'sccapture'];
const usage = (name) =>
  `usage: ${name} [-acdimorvwxCW] [-t format] [-T seconds] [-R x,y,w,h] [-D display] [-J style] [file]\n`;
const image = Uint8Array.from({ length: 300000 }, (_, i) => (i * 7 + (i >> 8)) % 256);
const page = { calls: [], screen: undefined, clipboard: undefined };

function refusal(name, message) {
  return Object.assign(new Error(message), { name });
}

const quiet = { kinds: {}, handle: () => undefined };
let os;

async function children(pid) {
  const found = await os.sh(
    `for s in /proc/[0-9]*/stat; do read -r l <"$s"; case $l in *") S ${pid} "*) echo "\${l%% *}";; esac; done`
  );
  return found.stdout.split('\n').filter(Boolean);
}

const requests = {
  kinds: { 'capture.screen': {}, 'clipboard.write': {} },
  async handle({ kind, options, body, stamp, signal, progress }) {
    const bytes = new Uint8Array(await new Response(body).arrayBuffer());
    const call = { kind, options, body: bytes, stamp };
    page.calls.push(call);
    const act = kind === 'capture.screen' ? page.screen : page.clipboard;
    if (act) return act({ call, signal, progress });
    return kind === 'capture.screen' ? image : undefined;
  },
};

before(async () => {
  os = await boot({ requests });
});

after(() => {
  os?.close();
});

beforeEach(() => {
  page.calls = [];
  page.screen = undefined;
  page.clipboard = undefined;
});

async function sh(script) {
  return os.sh(script);
}

async function read(path) {
  return new Uint8Array(await os.kernel.readFile(path));
}

describe('on the kernel', () => {
  it('lists screencapture and sccapture in /usr/bin, beside /dev/embedder', async () => {
    const result = await sh('command -v screencapture sccapture && test -c /dev/embedder');
    assert.deepEqual(result, {
      status: 0,
      stdout: '/usr/bin/screencapture\n/usr/bin/sccapture\n',
      stderr: '',
    });
  });

  it('writes the bytes of the reply unchanged, and asks for a PNG by default', async () => {
    for (const name of names) {
      page.calls = [];
      const result = await sh(`rm -f shot.png; ${name} shot.png`);
      assert.deepEqual(result, { status: 0, stdout: 'captured 293 KB to shot.png\n', stderr: '' });
      assert.deepEqual(await read('/tmp/shot.png'), image);
      assert.deepEqual(
        page.calls.map(({ kind, options, body }) => [kind, options, body.length]),
        [['capture.screen', { type: 'image/png', cursor: 'never' }, 0]]
      );
      assert.equal(page.calls[0].stamp.uid, 0);
    }
  });

  it('maps every option to the header', async () => {
    const cases = [
      ['-C', { cursor: 'always' }],
      ['-m', { surface: 'monitor' }],
      ['-D 2', { surface: 'monitor' }],
      ['-D2', { surface: 'monitor' }],
      ['-w', { surface: 'window' }],
      ['-W', { surface: 'window' }],
      ['-J window', { surface: 'window' }],
      ['-m -w', { surface: 'window' }],
      ['-w -m', { surface: 'monitor' }],
      ['-T 3', { delay: 3 }],
      ['-T3', { delay: 3 }],
      ['-T 0.5', { delay: 0.5 }],
      ['-T 007.250', { delay: 7.25 }],
      ['-T 0', { delay: 0 }],
      ['-T 1 -T 2', { delay: 2 }],
      ['-R 0,0,800,600', { rect: { x: 0, y: 0, width: 800, height: 600 } }],
      ['-R10,020,3,4', { rect: { x: 10, y: 20, width: 3, height: 4 } }],
      ['-a -d -i -o -r -x', {}],
      ['-adiorx', {}],
      ['-xCm', { cursor: 'always', surface: 'monitor' }],
      ['-CT2', { cursor: 'always', delay: 2 }],
    ];
    for (const [args, extra] of cases) {
      page.calls = [];
      const result = await sh(`screencapture ${args} f.png`);
      assert.deepEqual(
        result,
        { status: 0, stdout: 'captured 293 KB to f.png\n', stderr: '' },
        args
      );
      assert.deepEqual(
        page.calls.map((call) => call.options),
        [{ type: 'image/png', cursor: 'never', ...extra }],
        args
      );
    }
  });

  it('takes the format from -t, else from the extension, else PNG', async () => {
    const jpeg = { type: 'image/jpeg', quality: 0.92 };
    const webp = { type: 'image/webp', quality: 0.92 };
    const png = { type: 'image/png' };
    const cases = [
      ['f.png', png],
      ['f.jpg', jpeg],
      ['f.JPEG', jpeg],
      ['f.webp', webp],
      ['f.gif', png],
      ['f', png],
      ['-t jpg f.png', jpeg],
      ['-t jpeg f', jpeg],
      ['-tJPG f', jpeg],
      ['-t webp f.png', webp],
      ['-t png f.jpg', png],
    ];
    for (const [args, type] of cases) {
      page.calls = [];
      const result = await sh(`screencapture ${args}`);
      assert.equal(result.status, 0, args);
      assert.deepEqual(
        page.calls.map((call) => call.options),
        [{ ...type, cursor: 'never' }],
        args
      );
    }
  });

  it('refuses every option SLICC does not support, before asking the page', async () => {
    const cases = [
      ['-b', '-b'],
      ['-B com.apple.Preview', '-B'],
      ['-g', '-g'],
      ['-G 1', '-G'],
      ['-k', '-k'],
      ['-l 42', '-l'],
      ['-M', '-M'],
      ['-p', '-p'],
      ['-P', '-P'],
      ['-s', '-s'],
      ['-S', '-S'],
      ['-u', '-u'],
      ['-U', '-U'],
      ['-V 5', '-V'],
      ['-xs', '-s'],
      ['-P -b', '-P'],
      ['-J selection', '-J selection'],
      ['-J video', '-J video'],
      ['-t gif', '-t gif'],
      ['-t pdf', '-t pdf'],
      ['-T 1 -T 2 -t tiff', '-t tiff'],
    ];
    for (const name of names) {
      for (const [args, label] of cases) {
        const result = await sh(`${name} ${args} f.png`);
        assert.deepEqual(
          result,
          { status: 2, stdout: '', stderr: `${name}: ${label}: not supported in SLICC\n` },
          args
        );
      }
    }
    const more = await sh('screencapture a.png b.png');
    assert.deepEqual(more, {
      status: 2,
      stdout: '',
      stderr: 'screencapture: more than one file: not supported in SLICC\n',
    });
    assert.deepEqual(page.calls, []);
  });

  it('checks the values of -T, -R, -D and -J', async () => {
    const cases = [
      ['-T x', '-T: invalid delay: x'],
      ['-T -1', '-T: invalid delay: -1'],
      ['-T 1.', '-T: invalid delay: 1.'],
      ['-T .5', '-T: invalid delay: .5'],
      ['-T 1.2.3', '-T: invalid delay: 1.2.3'],
      ['-R 1,2,3', '-R: invalid rectangle: 1,2,3'],
      ['-R 1,2,3,4,5', '-R: invalid rectangle: 1,2,3,4,5'],
      ['-R 1,2,0,4', '-R: invalid rectangle: 1,2,0,4'],
      ['-R 1,2,3,0', '-R: invalid rectangle: 1,2,3,0'],
      ['-R a,2,3,4', '-R: invalid rectangle: a,2,3,4'],
      ['-R 1,,3,4', '-R: invalid rectangle: 1,,3,4'],
      ['-D 0', '-D: invalid display: 0'],
      ['-D 1x', '-D: invalid display: 1x'],
      ['-D main', '-D: invalid display: main'],
      ['-J tab', '-J: invalid style: tab'],
      ['-T x -R 1', '-T: invalid delay: x'],
    ];
    for (const [args, message] of cases) {
      const result = await sh(`screencapture ${args} f.png`);
      assert.deepEqual(
        result,
        { status: 2, stdout: '', stderr: `screencapture: ${message}\n` },
        args
      );
    }
    const order = await sh('sccapture -T x -s f.png');
    assert.equal(order.stderr, 'sccapture: -s: not supported in SLICC\n');
    assert.deepEqual(page.calls, []);
  });

  it('prints the usage, and refuses unknown options, missing values and a missing file', async () => {
    for (const name of names) {
      for (const args of ['-h', '--help', 'f.png -h', '-xh', '-Z -h', '--version --help']) {
        assert.deepEqual(
          await sh(`${name} ${args}`),
          { status: 0, stdout: usage(name), stderr: '' },
          args
        );
      }
      const cases = [
        ['-Z f.png', 'unknown option: -Z'],
        ['-xZ f.png', 'unknown option: -Z'],
        ['--nope f.png', 'unknown option: --nope'],
        ['-T', '-T: option requires a value'],
        ['f.png -R', '-R: option requires a value'],
        ['-b -Z', 'unknown option: -Z'],
        ['', 'output file required (or use -c for clipboard)'],
        ['-C -T 1', 'output file required (or use -c for clipboard)'],
        ['--version f.png', '--version: takes no other arguments'],
        ['--upgrade -c', '--upgrade: takes no other arguments'],
      ];
      for (const [args, message] of cases) {
        assert.deepEqual(
          await sh(`${name} ${args}`),
          { status: 2, stdout: '', stderr: `${name}: ${message}\n${usage(name)}` },
          args
        );
      }
    }
    assert.deepEqual(page.calls, []);
  });

  it('takes files that look like options after --', async () => {
    const result = await sh('screencapture -- -x.jpg && test -s ./-x.jpg');
    assert.deepEqual(result, { status: 0, stdout: 'captured 293 KB to -x.jpg\n', stderr: '' });
    assert.equal(page.calls[0].options.type, 'image/jpeg');
  });

  it('prints its version and the pnpm line for --upgrade', async () => {
    for (const name of names) {
      assert.deepEqual(await sh(`${name} --version`), {
        status: 0,
        stdout: '0.0.0\n',
        stderr: '',
      });
      assert.deepEqual(await sh(`${name} --upgrade`), {
        status: 0,
        stdout: 'pnpm add -g @ai-ecoverse/slicc-capture@latest\n',
        stderr: '',
      });
    }
  });

  it('maps the errnos of /dev/embedder to its messages', async () => {
    const cases = [
      [
        refusal('NotAllowedError', 'Permission denied by user'),
        'user cancelled, permission denied, or the surface is protected',
      ],
      [
        refusal('AbortError', 'the prompt was dismissed'),
        'user cancelled, permission denied, or the surface is protected',
      ],
      [
        refusal('NotSupportedError', 'screen capture is not supported in this browser'),
        'screen capture is not supported in this browser',
      ],
      [refusal('NotSupportedError', ''), 'screen capture is not supported in this browser'],
      [
        refusal('TimeoutError', 'timed out waiting for the picker'),
        'timed out waiting for the picker',
      ],
      [new RangeError('-R: rectangle outside the capture'), '-R: rectangle outside the capture'],
      [new Error('first line\nsecond line'), 'first line'],
      [new Error(''), 'I/O error'],
      [refusal('NotFoundError', ''), 'No such file or directory'],
    ];
    for (const name of names) {
      for (const [error, message] of cases) {
        page.screen = () => {
          throw error;
        };
        const result = await sh(`rm -f f.png; ${name} f.png; test -e f.png || echo none`);
        assert.deepEqual(
          result,
          { status: 0, stdout: 'none\n', stderr: `${name}: ${message}\n` },
          `${error.name} ${error.message}`
        );
      }
    }
  });

  it('says so when the page sends nothing', async () => {
    page.screen = () => undefined;
    const result = await sh('screencapture f.png');
    assert.deepEqual(result, {
      status: 1,
      stdout: '',
      stderr: 'screencapture: the page sent no image\n',
    });
  });

  it('passes the page progress to stderr', async () => {
    page.screen = async ({ progress }) => {
      progress('waiting for the picker');
      await new Promise((resolve) => setTimeout(resolve, 300));
      progress('captured a frame');
      return image;
    };
    const result = await sh('sccapture f.png');
    assert.deepEqual(result, {
      status: 0,
      stdout: 'captured 293 KB to f.png\n',
      stderr: 'sccapture: waiting for the picker\nsccapture: captured a frame\n',
    });
  });

  it('stops on a signal, as EINTR, and aborts the request', async () => {
    let reason;
    page.screen = ({ call, signal }) =>
      new Promise((resolve) => {
        signal.addEventListener('abort', () => {
          reason = String(signal.reason?.message ?? signal.reason);
          resolve(image);
        });
        setTimeout(async () => {
          for (const pid of await children(call.stamp.pid)) await os.sh(`kill -INT ${pid}`);
        }, 200);
      });
    const result = await sh(
      'rm -f f.png; screencapture f.png; echo "$?"; test -e f.png || echo none'
    );
    assert.deepEqual(result, {
      status: 0,
      stdout: '130\nnone\n',
      stderr: 'screencapture: interrupted\n',
    });
    assert.equal(reason, 'interrupted');
  });

  it('fails when the file cannot be written', async () => {
    const result = await sh('screencapture /missing/f.png');
    assert.deepEqual(result, {
      status: 1,
      stdout: '',
      stderr: 'screencapture: failed to write file: /missing/f.png: No such file or directory\n',
    });
  });

  it('keeps an existing file when the capture fails', async () => {
    page.screen = () => {
      throw refusal('NotAllowedError', 'no');
    };
    const result = await sh('printf old > keep.png; screencapture keep.png; cat keep.png');
    assert.equal(result.stdout, 'old');
    const left = await sh('ls -d "${TMPDIR:-/tmp}"/tmp.* 2>/dev/null; true');
    assert.equal(left.stdout, '');
  });

  it('copies a PNG to the clipboard with -c, as clipboard.write', async () => {
    for (const args of ['-c', '--clipboard', '-c -t jpg f.jpg', '-xc a.png b.png']) {
      page.calls = [];
      const result = await sh(`rm -f f.jpg a.png; screencapture ${args}; ls f.jpg a.png`);
      assert.deepEqual(
        { status: result.status, stdout: result.stdout },
        { status: 2, stdout: 'captured 293 KB to clipboard\n' },
        args
      );
      assert.deepEqual(
        page.calls.map(({ kind, options }) => [kind, options]),
        [
          ['capture.screen', { type: 'image/png', cursor: 'never' }],
          ['clipboard.write', { type: 'image/png' }],
        ],
        args
      );
      assert.deepEqual(page.calls[1].body, image, args);
    }
  });

  it('copies more than the 1 MiB body window', async () => {
    const big = Uint8Array.from({ length: 3 * 1024 * 1024 + 5 }, (_, i) => i % 251);
    page.screen = () => big;
    const result = await sh('sccapture -c');
    assert.deepEqual(result, {
      status: 0,
      stdout: 'captured 3072 KB to clipboard\n',
      stderr: '',
    });
    assert.deepEqual(page.calls[1].body, big);
  });

  it('says so when the clipboard refuses the image', async () => {
    page.clipboard = () => {
      throw refusal('NotAllowedError', 'Document is not focused.');
    };
    const denied = await sh('screencapture -c');
    assert.deepEqual(denied, {
      status: 1,
      stdout: '',
      stderr: 'screencapture: failed to copy to clipboard: Document is not focused.\n',
    });
    page.clipboard = () => {
      throw new Error('');
    };
    const failed = await sh('screencapture -c');
    assert.equal(failed.stderr, 'screencapture: failed to copy to clipboard: I/O error\n');
  });

  it('shows the capture inline with -v, as an <img:path> marker', async () => {
    const file = await sh('mkdir -p /tmp/v && cd /tmp/v && screencapture -v shot.jpg');
    assert.deepEqual(file, { status: 0, stdout: '<img:/tmp/v/shot.jpg>\n', stderr: '' });
    assert.deepEqual(await read('/tmp/v/shot.jpg'), image);
    assert.equal(page.calls[0].options.type, 'image/jpeg');
    const absolute = await sh('screencapture --view /tmp/v/a.png');
    assert.equal(absolute.stdout, '<img:/tmp/v/a.png>\n');
    const dot = await sh('cd /tmp/v && screencapture -v ./b.png');
    assert.equal(dot.stdout, '<img:/tmp/v/b.png>\n');
    const bare = await sh('screencapture -v');
    const path = /^<img:(\/tmp\/screencapture-\w+\.png)>\n$/.exec(bare.stdout)?.[1];
    assert.ok(path, bare.stdout);
    assert.deepEqual(await read(path), image);
    page.calls = [];
    const both = await sh('sccapture -cv -t webp f.webp');
    const lines = both.stdout.split('\n');
    assert.equal(lines[0], 'captured 293 KB to clipboard');
    assert.match(lines[1], /^<img:\/tmp\/screencapture-\w+\.png>$/);
    assert.deepEqual(await read(lines[1].slice(5, -1)), image);
    assert.deepEqual(
      page.calls.map((call) => call.kind),
      ['capture.screen', 'clipboard.write']
    );
  });

  it('runs the sh sccapture where the kernel also takes npm bins', async () => {
    const modules = '/opt/tool/node_modules';
    const tool = await boot({ requests, commands: { append: [modules] } }, undefined, modules);
    try {
      assert.equal(
        (await tool.sh('command -v sccapture screencapture')).stdout,
        '/usr/bin/sccapture\n/usr/bin/screencapture\n'
      );
      assert.deepEqual(await tool.sh('sccapture f.png'), {
        status: 0,
        stdout: 'captured 293 KB to f.png\n',
        stderr: '',
      });
    } finally {
      tool.close();
    }
  });
});

describe('on a kernel whose page answers nothing', () => {
  it('says the browser APIs are unavailable, and -c that images are not copied', async () => {
    const bare = await boot();
    const partial = await boot({ requests: { ...requests, kinds: { 'capture.screen': {} } } });
    const none = await boot({ requests: quiet });
    try {
      for (const kernel of [bare, none]) {
        assert.deepEqual(await kernel.sh('screencapture f.png'), {
          status: 1,
          stdout: '',
          stderr: 'screencapture: browser APIs are unavailable in this environment\n',
        });
      }
      for (const kernel of [bare, partial]) {
        page.calls = [];
        assert.deepEqual(await kernel.sh('sccapture -c'), {
          status: 1,
          stdout: '',
          stderr:
            'sccapture: failed to copy to clipboard: this page does not copy images (no clipboard.write)\n',
        });
        assert.deepEqual(page.calls, []);
      }
    } finally {
      bare.close();
      partial.close();
      none.close();
    }
  });
});

describe('on a kernel older than 1.153.0, without /dev/embedder', () => {
  it('refuses the commands with the kernel floor', async () => {
    const old = await bootWithoutEmbedder();
    try {
      assert.equal((await old.sh('test -e /dev/embedder')).status, 1);
      for (const name of names) {
        const result = await old.sh(`${name} f.png`);
        assert.deepEqual(
          result,
          {
            status: 126,
            stdout: '',
            stderr: `${name}: @ai-ecoverse/slicc-capture@0.0.0 needs slicc-kernel >=1.153.0; this kernel is 1.152.2\n`,
          },
          name
        );
      }
    } finally {
      old.close();
    }
  });
});
