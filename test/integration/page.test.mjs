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
  handle: (request) => {
    fake.signal = request.signal;
    return fake.page.handle({ ...request, display: fake.display, userMedia: fake.userMedia });
  },
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
        state.signal.addEventListener('abort', () => {
          setTimeout(async () => {
            resolve(await display(constraints));
            setTimeout(arrived, 50);
          }, 50);
        });
        setTimeout(() => os.sh('kill -INT "$(cat /tmp/main)"'), 200);
      });
    const result = await sh('sh -c \'echo $$ >/tmp/main; exec screencapture f.png\'; echo "$?"');
    assert.equal(result.stdout, '130\n');
    await late;
    assert.deepEqual(stopped(state), [1, 1]);
    assert.equal(state.frames.length, 0);
  });

  it('closes the frame that arrives after the command was interrupted in grabFrame', async () => {
    const state = setup();
    const { ImageCapture } = state.env;
    let arrived;
    const late = new Promise((resolve) => {
      arrived = resolve;
    });
    state.page = create({
      ...state.env,
      ImageCapture: class extends ImageCapture {
        grabFrame() {
          setTimeout(() => os.sh('kill -INT "$(cat /tmp/main)"'), 200);
          return new Promise((resolve) => {
            state.signal.addEventListener('abort', () => {
              setTimeout(async () => {
                resolve(await super.grabFrame());
                setTimeout(arrived, 50);
              }, 50);
            });
          });
        }
      },
    });
    const result = await sh(
      'rm -f f.png; sh -c \'echo $$ >/tmp/main; exec screencapture f.png\'; echo "$?"; test -e f.png || echo none'
    );
    assert.equal(result.stdout, '130\nnone\n');
    await late;
    assert.deepEqual(stopped(state), [1, 1]);
    assert.deepEqual(
      state.frames.map((frame) => frame.closed),
      [1]
    );
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

function studio(overrides = {}) {
  const tape = {
    recorders: [],
    mimes: ['video/webm;codecs=vp9', 'video/webm;codecs=vp9,opus', 'video/mp4'],
    asked: [],
    contexts: [],
    start: (recorder) =>
      setTimeout(() => recorder.ondataavailable({ data: new Blob(['one']) }), 10),
  };
  class MediaRecorder {
    static isTypeSupported(type) {
      return tape.mimes.includes(type);
    }

    constructor(stream, options) {
      this.stream = stream;
      this.options = options;
      this.state = 'inactive';
      tape.recorders.push(this);
    }

    start(slice) {
      this.slice = slice;
      this.state = 'recording';
      tape.start(this);
    }

    stop() {
      this.state = 'inactive';
      this.stops = (this.stops ?? 0) + 1;
      queueMicrotask(() => {
        this.ondataavailable({ data: new Blob([]) });
        this.ondataavailable({ data: new Blob(['end']) });
        this.onstop();
      });
    }
  }
  class MediaStream {
    constructor(tracks) {
      this.tracks = tracks;
    }
  }
  class AudioContext {
    constructor() {
      this.sources = [];
      this.closed = 0;
      this.mixed = new Track('audio');
      tape.contexts.push(this);
    }

    createMediaStreamDestination() {
      return { stream: { getAudioTracks: () => [this.mixed] } };
    }

    createMediaStreamSource(stream) {
      return { connect: (to) => this.sources.push([stream.tracks, to]) };
    }

    close() {
      this.closed += 1;
    }
  }
  const state = setup({ MediaRecorder, MediaStream, AudioContext, ...overrides });
  state.tape = tape;
  state.userMedia = async (constraints) => {
    tape.asked.push(constraints);
    tape.mic = media(new Track('audio'));
    return tape.mic;
  };
  return state;
}

async function bytes(path) {
  return new TextDecoder().decode(await os.kernel.readFile(path));
}

describe('the page module recording', () => {
  it('records for -V seconds, then stops every track', async () => {
    const state = studio();
    const result = await sh('rm -f v.webm; screencapture -V 0.3 v.webm');
    assert.deepEqual(result, {
      status: 0,
      stdout: 'captured 0 KB to v.webm\n',
      stderr: `${picker}screencapture: recording for 0.3 s…\n`,
    });
    assert.equal(await bytes('/tmp/v.webm'), 'oneend');
    const [recorder] = state.tape.recorders;
    assert.deepEqual(recorder.options, { mimeType: 'video/webm;codecs=vp9,opus' });
    assert.equal(recorder.slice, 250);
    assert.deepEqual(recorder.stream.tracks, state.streams[0].tracks);
    assert.deepEqual(state.constraints, [{ video: { cursor: 'never' }, audio: false }]);
    assert.deepEqual(stopped(state), [1, 1]);
  });

  it('picks an mp4 type, and one without audio for a silent capture', async () => {
    const state = studio();
    state.display = async (constraints) => {
      state.constraints.push(constraints);
      const stream = media(new Track('video'));
      state.streams.push(stream);
      return stream;
    };
    let result = await sh('screencapture -V 0.1 v.webm');
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(state.tape.recorders[0].options, { mimeType: 'video/webm;codecs=vp9' });
    result = await sh('screencapture -V 0.1 v.mp4');
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(state.tape.recorders[1].options, { mimeType: 'video/mp4' });
  });

  it('stops when the user ends the share', async () => {
    const state = studio();
    const display = state.display;
    state.display = async (constraints) => {
      const stream = await display(constraints);
      setTimeout(() => stream.tracks[0].dispatchEvent(new Event('ended')), 200);
      return stream;
    };
    const result = await sh('screencapture -v v.webm');
    assert.deepEqual(result, {
      status: 0,
      stdout: 'captured 0 KB to v.webm\n',
      stderr: `${picker}screencapture: recording…\n`,
    });
    assert.equal(await bytes('/tmp/v.webm'), 'oneend');
    assert.deepEqual(stopped(state), [1, 1]);
  });

  it('keeps what was recorded on ^C, and stops the recorder and the tracks', async () => {
    const state = studio();
    state.tape.start = (recorder) => {
      recorder.ondataavailable({ data: new Blob(['one']) });
      setTimeout(() => os.sh('kill -INT "$(cat /tmp/main)"'), 300);
    };
    const result = await sh(
      'rm -f v.webm; sh -c \'echo $$ >/tmp/main; exec screencapture -v v.webm\'; echo "$?"'
    );
    assert.deepEqual(result, {
      status: 0,
      stdout: 'captured 0 KB to v.webm\n0\n',
      stderr: `${picker}screencapture: recording…\n`,
    });
    assert.equal(await bytes('/tmp/v.webm'), 'one');
    assert.equal(state.tape.recorders[0].state, 'inactive');
    assert.deepEqual(stopped(state), [1, 1]);
  });

  it('records the microphone too, mixed with the shared audio', async () => {
    const state = studio();
    const result = await sh('screencapture -V 0.1 -A -g v.webm');
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(state.constraints, [{ video: { cursor: 'never' }, audio: true }]);
    assert.deepEqual(state.tape.asked, [{ audio: true, video: false }]);
    const [context] = state.tape.contexts;
    const [display] = state.streams;
    assert.deepEqual(state.tape.recorders[0].stream.tracks, [display.tracks[0], context.mixed]);
    assert.deepEqual(
      context.sources.map(([tracks]) => tracks),
      [[display.tracks[1]], [state.tape.mic.tracks[0]]]
    );
    assert.equal(context.closed, 1);
    assert.deepEqual(state.tape.mic.tracks[0].stops, 1);
    assert.deepEqual(stopped(state), [1, 1]);
  });

  it('asks the embedder for the microphone the header names', async () => {
    const state = studio();
    const asked = [];
    state.userMedia = async (constraints) => {
      asked.push(constraints);
      return media(new Track('audio'));
    };
    const result = await sh('screencapture -V 0.1 -G dev1 v.webm');
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(asked, [{ audio: { deviceId: { exact: 'dev1' } }, video: false }]);
    assert.deepEqual(state.tape.asked, []);
  });

  it('refuses the microphone before the picker when the embedder passes no userMedia', async () => {
    const state = studio();
    state.userMedia = undefined;
    const result = await sh('screencapture -v -g v.webm');
    assert.deepEqual(result, {
      status: 1,
      stdout: '',
      stderr: 'screencapture: this page does not record the microphone\n',
    });
    assert.deepEqual(state.constraints, []);
  });

  it('says when no audio was shared', async () => {
    const state = studio();
    state.display = async (constraints) => {
      state.constraints.push(constraints);
      const stream = media(new Track('video'));
      state.streams.push(stream);
      return stream;
    };
    const result = await sh('screencapture -V 0.1 -A v.webm');
    assert.equal(
      result.stderr,
      `${picker}screencapture: no audio was shared\nscreencapture: recording for 0.1 s…\n`
    );
  });

  it('stops the capture when the microphone is refused', async () => {
    const state = studio();
    state.userMedia = async () => {
      throw refusal('NotAllowedError', 'no microphone');
    };
    const result = await sh('screencapture -v -g v.webm');
    assert.equal(result.status, 1);
    assert.match(
      result.stderr,
      /user cancelled, permission denied, or the surface is protected\n$/
    );
    assert.deepEqual(stopped(state), [1, 1]);
    assert.equal(state.tape.recorders.length, 0);
  });

  it('stops a microphone that arrives after an interrupt', async () => {
    const state = studio();
    let late;
    const arrived = new Promise((resolve) => {
      late = resolve;
    });
    const mic = media(new Track('audio'));
    state.userMedia = () =>
      new Promise((resolve) => {
        state.signal.addEventListener('abort', () =>
          setTimeout(() => {
            resolve(mic);
            setTimeout(late, 50);
          }, 50)
        );
        setTimeout(() => os.sh('kill -INT "$(cat /tmp/main)"'), 200);
      });
    const result = await sh(
      'sh -c \'echo $$ >/tmp/main; exec screencapture -v -g v.webm\'; echo "$?"'
    );
    assert.equal(result.stdout, '130\n');
    await arrived;
    assert.equal(mic.tracks[0].stops, 1);
  });

  it('fails the recording when the recorder does', async () => {
    const state = studio();
    state.tape.start = (recorder) =>
      setTimeout(() => recorder.onerror({ error: new Error('the encoder broke') }), 50);
    let result = await sh('rm -f v.webm; screencapture -v v.webm; test -e v.webm || echo none');
    assert.equal(result.stdout, 'none\n');
    assert.match(result.stderr, /screencapture: the encoder broke\n$/);
    assert.deepEqual(stopped(state), [1, 1]);
    state.tape.start = (recorder) => setTimeout(() => recorder.onerror({}), 50);
    result = await sh('screencapture -v v.webm');
    assert.match(result.stderr, /screencapture: the recording failed\n$/);
  });

  it('refuses a type this browser cannot record, before the picker', async () => {
    let state = studio();
    state.tape.mimes = [];
    let result = await sh('screencapture -v v.mp4');
    assert.deepEqual(result, {
      status: 1,
      stdout: '',
      stderr: 'screencapture: video/mp4 is not supported by this browser\n',
    });
    assert.deepEqual(state.constraints, []);
    state = studio({ MediaRecorder: undefined });
    result = await sh('screencapture -v v.webm');
    assert.equal(result.stderr, 'screencapture: screen capture is not supported in this browser\n');
    state = studio();
    state.tape.mimes = ['video/webm;codecs=vp9'];
    result = await sh('screencapture -V 0.1 v.webm');
    assert.match(result.stderr, /screencapture: video\/webm is not supported by this browser\n$/);
    assert.deepEqual(stopped(state), [1, 1]);
  });

  it('checks the video fields of the header', async () => {
    const state = studio();
    const display = state.display;
    const cases = [
      [{ duration: 0 }, 'invalid duration: 0'],
      [{ duration: 'x' }, 'invalid duration: "x"'],
      [{ system: 'yes' }, 'invalid system: "yes"'],
      [{ microphone: '' }, 'invalid microphone: ""'],
      [{ microphone: 1 }, 'invalid microphone: 1'],
    ];
    for (const [options, message] of cases) {
      await assert.rejects(
        state.page.handle({ options: { type: 'video/webm', ...options }, display }),
        { name: 'TypeError', message },
        message
      );
    }
    await assert.rejects(
      state.page.handle({
        options: { type: 'video/webm', rect: { x: 0, y: 0, width: 1, height: 1 } },
        display,
      }),
      { name: 'NotSupportedError', message: 'rect: not with video' }
    );
    for (const type of ['toString', 'constructor', '__proto__']) {
      await assert.rejects(
        state.page.handle({ options: { type }, display }),
        { name: 'NotSupportedError', message: `unsupported type: ${type}` },
        type
      );
    }
    assert.deepEqual(state.constraints, []);
  });

  it('stops when the reader cancels the reply', async () => {
    const state = studio();
    const reply = await state.page.handle({
      options: { type: 'video/webm', system: false, microphone: false },
      display: state.display,
    });
    await reply.cancel();
    assert.equal(state.tape.recorders[0].state, 'inactive');
    assert.deepEqual(stopped(state), [1, 1]);
  });
});
