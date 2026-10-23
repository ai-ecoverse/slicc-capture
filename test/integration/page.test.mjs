import assert from 'node:assert/strict';
import { after, before, beforeEach, describe, it } from 'node:test';
import page, { create, handle, kinds } from '@ai-ecoverse/slicc-capture/page';
import { boot } from './kernel.mjs';

const picker = 'screencapture: waiting for the picker…\n';
const width = 640;
const height = 480;
let os;
let fake;

class Track extends EventTarget {
  constructor(kind) {
    super();
    this.kind = kind;
    this.readyState = 'live';
    this.stops = 0;
  }

  stop() {
    this.stops += 1;
    this.readyState = 'ended';
  }
}

function media(...tracks) {
  return {
    tracks,
    getTracks: () => tracks,
    getVideoTracks: () => tracks.filter((track) => track.kind === 'video'),
  };
}

function setup(overrides = {}) {
  const state = { constraints: [], streams: [], canvases: [], frames: [], times: {} };
  state.display = async (constraints) => {
    state.constraints.push(constraints);
    state.times.picked = Date.now();
    const stream = media(new Track('video'), new Track('audio'));
    state.streams.push(stream);
    return stream;
  };
  class ImageCapture {
    constructor(track) {
      this.track = track;
    }

    async grabFrame() {
      state.times.grabbed = Date.now();
      const frame = { width, height, closed: 0, close: () => (frame.closed += 1) };
      state.frames.push(frame);
      return frame;
    }
  }
  class OffscreenCanvas {
    constructor(w, h) {
      this.size = [w, h];
      state.canvases.push(this);
    }

    getContext() {
      return {
        drawImage: (source, ...args) => {
          this.source = source;
          this.args = args;
        },
      };
    }

    async convertToBlob(options) {
      const text = JSON.stringify({ size: this.size, args: this.args, options });
      return new Blob([text], { type: state.encodes ?? options.type });
    }
  }
  const env = { ImageCapture, OffscreenCanvas, document: undefined, ...overrides };
  state.env = env;
  state.page = create(env);
  fake = state;
  return state;
}

const requests = {
  kinds,
  handle: (request) => fake.page.handle({ ...request, display: fake.display }),
};

before(async () => {
  os = await boot({ requests });
});

after(() => {
  os?.close();
});

beforeEach(() => {
  setup();
});

const sh = (script) => os.sh(script);

async function shot(path = '/tmp/f.png') {
  return JSON.parse(new TextDecoder().decode(await os.kernel.readFile(path)));
}

function stopped(state) {
  return state.streams.flatMap((stream) => stream.tracks.map((track) => track.stops));
}

function refusal(name, message) {
  return new DOMException(message, name);
}

describe('the page module', () => {
  it('exports kinds, handle and a default of both', () => {
    assert.deepEqual(kinds, { 'capture.screen': {} });
    assert.equal(page.kinds, kinds);
    assert.equal(page.handle, handle);
    assert.equal(typeof create, 'function');
  });

  it('maps the header to the constraints of display', async () => {
    const cases = [
      ['', { cursor: 'never' }],
      ['-C', { cursor: 'always' }],
      ['-m', { cursor: 'never', displaySurface: 'monitor' }],
      ['-D 2', { cursor: 'never', displaySurface: 'monitor' }],
      ['-C -w', { cursor: 'always', displaySurface: 'window' }],
      ['-J window', { cursor: 'never', displaySurface: 'window' }],
    ];
    for (const [args, video] of cases) {
      const state = setup();
      const result = await sh(`screencapture ${args} f.png`);
      assert.equal(result.status, 0, `${args}: ${result.stderr}`);
      assert.deepEqual(state.constraints, [{ video, audio: false }], args);
      assert.deepEqual(stopped(state), [1, 1], args);
      assert.deepEqual(
        state.frames.map((frame) => frame.closed),
        [1],
        args
      );
    }
  });

  it('writes the encoded frame, whole or cropped to -R', async () => {
    let result = await sh('rm -f f.png; screencapture f.png');
    assert.deepEqual(result, {
      status: 0,
      stdout: 'captured 0 KB to f.png\n',
      stderr: 'screencapture: waiting for the picker…\n',
    });
    assert.deepEqual(await shot(), {
      size: [width, height],
      args: [0, 0, width, height, 0, 0, width, height],
      options: { type: 'image/png' },
    });
    result = await sh('screencapture -R 10,20,300,200 f.png');
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(await shot(), {
      size: [300, 200],
      args: [10, 20, 300, 200, 0, 0, 300, 200],
      options: { type: 'image/png' },
    });
    result = await sh(`screencapture -R 0,0,${width},${height} f.png`);
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual((await shot()).size, [width, height]);
  });

  it('encodes as the type the header names, with its quality', async () => {
    const cases = [
      ['f.jpg', '/tmp/f.jpg', { type: 'image/jpeg', quality: 0.92 }],
      ['-t webp f.png', '/tmp/f.png', { type: 'image/webp', quality: 0.92 }],
      ['f.webp', '/tmp/f.webp', { type: 'image/webp', quality: 0.92 }],
      ['-t png f.jpg', '/tmp/f.jpg', { type: 'image/png' }],
    ];
    for (const [args, path, options] of cases) {
      const result = await sh(`screencapture ${args}`);
      assert.equal(result.status, 0, `${args}: ${result.stderr}`);
      assert.deepEqual((await shot(path)).options, options, args);
    }
  });

  it('rejects a rectangle outside the frame, and stops the capture', async () => {
    for (const rect of [`${width - 10},0,11,1`, `0,${height},1,1`, '0,0,1000,1']) {
      const state = setup();
      const result = await sh(
        `rm -f f.png; screencapture -R ${rect} f.png; test -e f.png || echo none`
      );
      assert.deepEqual(
        result,
        {
          status: 0,
          stdout: 'none\n',
          stderr: `${picker}screencapture: -R: rectangle outside the capture\n`,
        },
        rect
      );
      assert.deepEqual(stopped(state), [1, 1], rect);
      assert.equal(state.canvases.length, 0, rect);
    }
  });

  it('waits for -T after the picker, and says so', async () => {
    const state = setup();
    const result = await sh('screencapture -T 0.5 f.png');
    assert.deepEqual(result, {
      status: 0,
      stdout: 'captured 0 KB to f.png\n',
      stderr: 'screencapture: waiting for the picker…\nscreencapture: waiting 0.5 s…\n',
    });
    assert.ok(state.times.grabbed - state.times.picked >= 490, state.times);
  });

  it('stops every track when the command is interrupted during the delay', async () => {
    const state = setup();
    const display = state.display;
    state.display = async (constraints) => {
      const stream = await display(constraints);
      setTimeout(() => os.sh('kill -INT "$(cat /tmp/main)"'), 200);
      return stream;
    };
    const result = await sh(
      'rm -f f.png; sh -c \'echo $$ >/tmp/main; exec screencapture -T 30 f.png\'; echo "$?"; test -e f.png || echo none'
    );
    assert.equal(result.stdout, '130\nnone\n');
    assert.match(result.stderr, /screencapture: interrupted\n$/);
    assert.deepEqual(stopped(state), [1, 1]);
    assert.equal(state.frames.length, 0);
  });

  it('stops the stream that arrives after the command was interrupted in the picker', async () => {
    const state = setup();
    const display = state.display;
    let arrived;
    const late = new Promise((resolve) => {
      arrived = resolve;
    });
    state.display = (constraints) =>
      new Promise((resolve) => {
        setTimeout(() => os.sh('kill -INT "$(cat /tmp/main)"'), 200);
        setTimeout(async () => {
          resolve(await display(constraints));
          setTimeout(arrived, 50);
        }, 600);
      });
    const result = await sh('sh -c \'echo $$ >/tmp/main; exec screencapture f.png\'; echo "$?"');
    assert.equal(result.stdout, '130\n');
    await late;
    assert.deepEqual(stopped(state), [1, 1]);
    assert.equal(state.frames.length, 0);
  });

  it('stops when the user ends the share during the delay', async () => {
    const state = setup();
    const display = state.display;
    state.display = async (constraints) => {
      const stream = await display(constraints);
      setTimeout(() => {
        stream.tracks[0].stop();
        stream.tracks[0].dispatchEvent(new Event('ended'));
      }, 100);
      return stream;
    };
    const result = await sh('screencapture -T 30 f.png');
    assert.deepEqual(result, {
      status: 1,
      stdout: '',
      stderr:
        'screencapture: waiting for the picker…\nscreencapture: waiting 30 s…\nscreencapture: user cancelled, permission denied, or the surface is protected\n',
    });
    assert.deepEqual(stopped(state), [2, 1]);
  });

  it('maps its errors to the errnos and messages of the command', async () => {
    const cases = [
      [
        (state) => {
          state.display = async () => {
            throw refusal('NotAllowedError', 'Permission denied');
          };
        },
        'user cancelled, permission denied, or the surface is protected',
      ],
      [
        (state) => {
          state.display = async () => {
            throw refusal('AbortError', 'the prompt was withdrawn');
          };
        },
        'user cancelled, permission denied, or the surface is protected',
      ],
      [
        (state) => {
          state.display = undefined;
        },
        'screen capture is not supported in this browser',
      ],
      [
        (state) => {
          state.display = async () => media(new Track('audio'));
        },
        'the capture has no video track',
      ],
      [
        (state) => {
          state.encodes = 'image/png';
        },
        'image/webp is not supported by this browser',
        'f.webp',
      ],
      [
        (state) => {
          state.display = async () => {
            throw new Error('the embedder broke\nsecond line');
          };
        },
        'the embedder broke',
      ],
    ];
    for (const [arrange, message, file = 'f.png'] of cases) {
      arrange(setup());
      const result = await sh(`rm -f ${file}; screencapture ${file}; test -e ${file} || echo none`);
      assert.equal(result.stdout, 'none\n', message);
      assert.equal(result.stderr.split('\n').at(-2), `screencapture: ${message}`, message);
    }
  });

  it('gives up on the picker after its timeout, and stops the late stream', async () => {
    const state = setup();
    state.page = create({ ...state.env, timeout: 100 });
    const display = state.display;
    let arrived;
    const late = new Promise((resolve) => {
      arrived = resolve;
    });
    state.display = (constraints) =>
      new Promise((resolve) => {
        setTimeout(async () => {
          resolve(await display(constraints));
          setTimeout(arrived, 50);
        }, 400);
      });
    const result = await sh('screencapture f.png');
    assert.equal(result.status, 1);
    assert.match(result.stderr, /screencapture: timed out waiting for the picker\n$/);
    await late;
    assert.deepEqual(stopped(state), [1, 1]);
  });

  it('falls back to a video element without ImageCapture', async () => {
    const videos = [];
    const document = {
      createElement(name) {
        const video = {
          name,
          paused: 0,
          videoWidth: 320,
          videoHeight: 240,
          play: async () => {
            queueMicrotask(() => video.onloadeddata());
          },
          pause: () => {
            video.paused += 1;
          },
        };
        let source = null;
        Object.defineProperty(video, 'srcObject', {
          get: () => source,
          set: (value) => {
            source = value;
            if (value) queueMicrotask(() => video.onloadedmetadata());
          },
        });
        videos.push(video);
        return video;
      },
    };
    const state = setup({ ImageCapture: undefined, document });
    const result = await sh('screencapture -R 1,2,3,4 f.png');
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(await shot(), {
      size: [3, 4],
      args: [1, 2, 3, 4, 0, 0, 3, 4],
      options: { type: 'image/png' },
    });
    assert.equal(videos.length, 1);
    assert.equal(state.canvases[0].source, videos[0]);
    assert.equal(videos[0].muted, true);
    assert.equal(videos[0].srcObject, null);
    assert.equal(videos[0].paused, 1);
    assert.deepEqual(stopped(state), [1, 1]);
  });
});
