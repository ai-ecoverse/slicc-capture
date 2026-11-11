import assert from 'node:assert/strict';
import { after, before, beforeEach, describe, it } from 'node:test';
import { create, kinds, MAX_UNREAD } from '@ai-ecoverse/slicc-capture/page';
import { boot } from './kernel.mjs';

const MiB = 1024 * 1024;
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

function refusal(name, message, extra = {}) {
  return Object.assign(new DOMException(message, name), extra);
}

function setup(overrides = {}) {
  const state = { asked: [], streams: [], frames: [], recorders: [], contexts: [], times: {} };
  state.userMedia = async (constraints) => {
    state.asked.push(constraints);
    state.times.opened = Date.now();
    const tracks = [new Track('video')];
    if (constraints.audio) tracks.push(new Track('audio'));
    const stream = media(...tracks);
    state.streams.push(stream);
    return stream;
  };
  state.start = (recorder) =>
    setTimeout(() => recorder.ondataavailable({ data: new Blob(['one']) }), 10);
  class ImageCapture {
    constructor(track) {
      this.track = track;
    }

    async grabFrame() {
      state.times.grabbed = Date.now();
      if (state.grab) return state.grab(this.track);
      const frame = { width: 1280, height: 720, closed: 0, close: () => (frame.closed += 1) };
      state.frames.push(frame);
      return frame;
    }
  }
  class OffscreenCanvas {
    constructor(width, height) {
      this.size = [width, height];
    }

    getContext() {
      return {
        drawImage: (source, ...args) => {
          this.args = args;
        },
      };
    }

    async convertToBlob(options) {
      return new Blob([JSON.stringify({ size: this.size, args: this.args, options })], {
        type: options.type,
      });
    }
  }
  class MediaRecorder {
    static isTypeSupported(type) {
      return ['video/webm;codecs=vp9', 'video/webm;codecs=vp9,opus', 'video/mp4'].includes(type);
    }

    constructor(stream, options) {
      this.stream = stream;
      this.options = options;
      this.state = 'inactive';
      state.recorders.push(this);
    }

    start(slice) {
      this.slice = slice;
      this.state = 'recording';
      state.start(this);
    }

    stop() {
      this.state = 'inactive';
      this.stops = (this.stops ?? 0) + 1;
      queueMicrotask(() => {
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
      state.contexts.push(this);
    }
  }
  state.env = { ImageCapture, OffscreenCanvas, MediaRecorder, MediaStream, AudioContext };
  state.page = create({ ...state.env, ...overrides });
  fake = state;
  return state;
}

const requests = {
  kinds,
  handle: (request) => {
    fake.signal = request.signal;
    return fake.page.handle({ ...request, userMedia: fake.userMedia, devices: fake.devices });
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

function ask(header, out = 'o') {
  const line = JSON.stringify({ kind: 'capture.camera', ...header });
  return os.sh(
    `rm -f ${out}; exec 3<>/dev/embedder; printf '%s\\n' '${line}' >&3; cat <&3 >${out}; echo "$?"`
  );
}

const kill = () => setTimeout(() => os.sh('kill -INT "$(cat /tmp/main)"'), 200);

async function interrupted(header) {
  const line = JSON.stringify({ kind: 'capture.camera', ...header });
  await os.kernel.writeFile('/tmp/h', `${line}\n`);
  return os.sh(
    'rm -f o; sh -c \'echo $$ >/tmp/main; exec 3<>/dev/embedder; read -r l <h; printf "%s\\n" "$l" >&3; exec cat <&3 >o\'; echo "$?"'
  );
}

async function read(path = '/tmp/o') {
  return new TextDecoder().decode(await os.kernel.readFile(path));
}

function stopped(state) {
  return state.streams.flatMap((stream) => stream.tracks.map((track) => track.stops));
}

const settle = () => new Promise((resolve) => setImmediate(resolve));

describe('capture.camera, a still', () => {
  it('waits 1.5 s by default, then encodes one frame and stops the camera', async () => {
    const state = setup();
    const result = await ask({ type: 'image/jpeg', quality: 0.8 });
    assert.deepEqual(result, { status: 0, stdout: '0\n', stderr: '' });
    assert.deepEqual(JSON.parse(await read()), {
      size: [1280, 720],
      args: [0, 0, 1280, 720, 0, 0, 1280, 720],
      options: { type: 'image/jpeg', quality: 0.8 },
    });
    assert.deepEqual(state.asked, [{ video: true, audio: false }]);
    assert.ok(state.times.grabbed - state.times.opened >= 1490, state.times);
    assert.deepEqual(stopped(state), [1]);
    assert.deepEqual(
      state.frames.map((frame) => frame.closed),
      [1]
    );
  });

  it('skips the warmup with warmup 0, and waits for a warmup it is given', async () => {
    let state = setup();
    let result = await ask({ warmup: 0 });
    assert.equal(result.stdout, '0\n', result.stderr);
    assert.ok(state.times.grabbed - state.times.opened < 400, state.times);
    assert.deepEqual(JSON.parse(await read()).options, { type: 'image/png' });
    state = setup();
    result = await ask({ type: 'image/webp', warmup: 0.4 });
    assert.equal(result.stdout, '0\n', result.stderr);
    assert.ok(state.times.grabbed - state.times.opened >= 390, state.times);
    assert.deepEqual(stopped(state), [1]);
  });

  it('maps the header to ideal constraints, exact ones with exact, and the device', async () => {
    const cases = [
      [
        { width: 1920, height: 1080, frameRate: 30 },
        { width: { ideal: 1920 }, height: { ideal: 1080 }, frameRate: { ideal: 30 } },
      ],
      [
        { width: 640, exact: true, device: 'cam-1+/=._A9' },
        { deviceId: { exact: 'cam-1+/=._A9' }, width: { exact: 640 } },
      ],
      [
        { device: 'abc', exact: false, frameRate: 7.5 },
        { deviceId: { exact: 'abc' }, frameRate: { ideal: 7.5 } },
      ],
      [{ exact: true }, true],
      [{ microphone: true }, true],
    ];
    for (const [header, video] of cases) {
      const state = setup();
      const result = await ask({ warmup: 0, ...header });
      assert.equal(result.stdout, '0\n', result.stderr);
      assert.deepEqual(state.asked, [{ video, audio: false }], JSON.stringify(header));
    }
  });

  it('names the constraint no camera meets', async () => {
    const cases = [
      ['width', 'width'],
      ['height', 'height'],
      ['frameRate', 'frameRate'],
      ['deviceId', 'device'],
      ['aspectRatio', 'constraints'],
      [undefined, 'constraints'],
      ['toString', 'constraints'],
    ];
    for (const [constraint, field] of cases) {
      const state = setup();
      state.userMedia = async () => {
        throw refusal('OverconstrainedError', 'Constraints could be not satisfied.', {
          constraint,
        });
      };
      await assert.rejects(
        state.page.handle({
          kind: 'capture.camera',
          options: { width: 4000, exact: true },
          userMedia: state.userMedia,
        }),
        { name: 'NotSupportedError', message: `no camera matches the ${field} asked for` }
      );
    }
    fake.userMedia = async () => {
      throw refusal('OverconstrainedError', '', { constraint: 'width' });
    };
    const result = await ask({ width: 4000, exact: true });
    assert.deepEqual(result, {
      status: 0,
      stdout: '1\n',
      stderr: 'cat: /dev/embedder: no camera matches the width asked for\ncat: -: Not supported\n',
    });
  });

  it('maps its errors to the errnos of /dev/embedder', async () => {
    const cases = [
      [
        async () => {
          throw refusal('NotFoundError', 'Requested device not found');
        },
        'no camera',
        'No such file or directory',
      ],
      [
        async () => {
          throw refusal('NotAllowedError', 'Permission denied');
        },
        'Permission denied',
        'Permission denied',
      ],
      [
        async () => {
          throw refusal('AbortError', 'nobody clicked within 5 min');
        },
        'nobody clicked within 5 min',
        'Permission denied',
      ],
      [
        async () => {
          throw refusal('NotReadableError', 'Could not start video source');
        },
        'Could not start video source',
        'I/O error',
      ],
      [async () => media(new Track('audio')), 'no camera', 'No such file or directory'],
      [
        async () => {
          const track = new Track('video');
          track.readyState = 'ended';
          return media(track);
        },
        'the camera was stopped',
        'Permission denied',
      ],
    ];
    for (const [userMedia, message, errno] of cases) {
      setup();
      fake.userMedia = userMedia;
      const result = await ask({ warmup: 0 });
      assert.deepEqual(
        result,
        {
          status: 0,
          stdout: '1\n',
          stderr: `cat: /dev/embedder: ${message}\ncat: -: ${errno}\n`,
        },
        message
      );
    }
    setup();
    fake.userMedia = async () => {
      throw refusal('NotFoundError', 'Requested device not found');
    };
    const result = await ask({ type: 'video/webm', microphone: 'mic-1' });
    assert.match(result.stderr, /^cat: \/dev\/embedder: no camera or microphone\n/);
  });

  it('stops the camera when the frame fails, and when the request is aborted', async () => {
    let state = setup();
    state.grab = async () => {
      throw refusal('InvalidStateError', 'the track is muted');
    };
    let result = await ask({ warmup: 0 });
    assert.equal(result.stderr, 'cat: /dev/embedder: the track is muted\ncat: -: I/O error\n');
    assert.deepEqual(stopped(state), [1]);

    state = setup();
    const controller = new AbortController();
    setTimeout(() => controller.abort('interrupted'), 100);
    await assert.rejects(
      state.page.handle({
        kind: 'capture.camera',
        options: { warmup: 30 },
        signal: controller.signal,
        userMedia: state.userMedia,
      }),
      { name: 'AbortError', message: 'interrupted' }
    );
    assert.deepEqual(stopped(state), [1]);
    assert.equal(state.frames.length, 0);

    state = setup();
    const opened = state.userMedia;
    fake.userMedia = (constraints) => {
      kill();
      return opened(constraints);
    };
    result = await interrupted({ warmup: 30 });
    assert.equal(result.stdout, '130\n', result.stderr);
    assert.equal(await read(), '');
    await settle();
    assert.equal(fake.signal.aborted, true);
    assert.deepEqual(stopped(state), [1]);
  });

  it('stops a camera that arrives after an abort', async () => {
    const state = setup();
    const controller = new AbortController();
    const stream = media(new Track('video'));
    let arrived;
    const late = new Promise((resolve) => {
      arrived = resolve;
    });
    const pending = state.page.handle({
      kind: 'capture.camera',
      options: {},
      signal: controller.signal,
      userMedia: () =>
        new Promise((resolve) => {
          setTimeout(() => controller.abort(new Error('closed')), 20);
          controller.signal.addEventListener('abort', () =>
            setTimeout(() => {
              resolve(stream);
              setTimeout(arrived, 20);
            }, 20)
          );
        }),
    });
    await assert.rejects(pending, { name: 'AbortError', message: 'closed' });
    await late;
    assert.equal(stream.tracks[0].stops, 1);
  });

  it('fails when the camera is stopped during the warmup', async () => {
    const state = setup();
    const userMedia = state.userMedia;
    fake.userMedia = async (constraints) => {
      const stream = await userMedia(constraints);
      setTimeout(() => stream.tracks[0].dispatchEvent(new Event('ended')), 100);
      return stream;
    };
    const result = await ask({ warmup: 30 });
    assert.equal(
      result.stderr,
      'cat: /dev/embedder: the camera was stopped\ncat: -: Permission denied\n'
    );
    assert.deepEqual(stopped(state), [1]);
  });
});

describe('capture.camera, a video', () => {
  it('records the camera alone for the duration, and stops it', async () => {
    const state = setup();
    const result = await ask({ type: 'video/webm', duration: 0.3, width: 640, warmup: 9 });
    assert.deepEqual(result, { status: 0, stdout: '0\n', stderr: 'sh: recording for 0.3 s…\n' });
    assert.equal(await read(), 'oneend');
    assert.deepEqual(state.asked, [{ video: { width: { ideal: 640 } }, audio: false }]);
    const [recorder] = state.recorders;
    assert.deepEqual(recorder.options, { mimeType: 'video/webm;codecs=vp9' });
    assert.equal(recorder.slice, 250);
    assert.deepEqual(recorder.stream.tracks, state.streams[0].tracks);
    assert.deepEqual(stopped(state), [1]);
  });

  it('asks for the camera and the microphone in one userMedia call', async () => {
    const cases = [
      [true, true],
      ['mic-1', { deviceId: { exact: 'mic-1' } }],
    ];
    for (const [microphone, audio] of cases) {
      const state = setup();
      const result = await ask({ type: 'video/webm', duration: 0.1, microphone });
      assert.equal(result.stdout, '0\n', result.stderr);
      assert.deepEqual(state.asked, [{ video: true, audio }]);
      const [recorder] = state.recorders;
      assert.deepEqual(recorder.options, { mimeType: 'video/webm;codecs=vp9,opus' });
      assert.deepEqual(recorder.stream.tracks, state.streams[0].tracks);
      assert.equal(state.contexts.length, 0);
      assert.deepEqual(stopped(state), [1, 1]);
    }
    const state = setup();
    const result = await ask({ type: 'video/mp4', duration: 0.1, microphone: false });
    assert.equal(result.stdout, '0\n', result.stderr);
    assert.deepEqual(state.asked, [{ video: true, audio: false }]);
    assert.deepEqual(state.recorders[0].options, { mimeType: 'video/mp4' });
  });

  it('ends the recording when the camera track ends, or when the reader goes', async () => {
    let state = setup();
    const userMedia = state.userMedia;
    fake.userMedia = async (constraints) => {
      const stream = await userMedia(constraints);
      setTimeout(() => stream.tracks[0].dispatchEvent(new Event('ended')), 200);
      return stream;
    };
    let result = await ask({ type: 'video/webm', microphone: true });
    assert.deepEqual(result, { status: 0, stdout: '0\n', stderr: 'sh: recording…\n' });
    assert.equal(await read(), 'oneend');
    assert.deepEqual(stopped(state), [1, 1]);

    state = setup();
    state.start = (recorder) => {
      recorder.ondataavailable({ data: new Blob(['one']) });
      kill();
    };
    result = await interrupted({ type: 'video/webm', microphone: true });
    assert.equal(result.stdout, '130\n', result.stderr);
    assert.equal(await read(), 'one');
    await settle();
    assert.equal(state.recorders[0].state, 'inactive');
    assert.deepEqual(stopped(state), [1, 1]);
  });

  it('errors a recording nobody reads past 64 MiB, and stops the camera', async () => {
    const state = setup();
    let recorder;
    state.start = (started) => {
      recorder = started;
    };
    const reply = await state.page.handle({
      kind: 'capture.camera',
      options: { type: 'video/webm', microphone: true },
      userMedia: state.userMedia,
    });
    const chunk = { size: MiB, arrayBuffer: async () => new ArrayBuffer(MiB) };
    for (let i = 0; i < MAX_UNREAD / MiB; i += 1) recorder.ondataavailable({ data: chunk });
    await settle();
    assert.equal(recorder.state, 'recording');
    assert.deepEqual(stopped(state), [0, 0]);
    recorder.ondataavailable({ data: chunk });
    await settle();
    assert.equal(recorder.state, 'inactive');
    assert.deepEqual(stopped(state), [1, 1]);
    await assert.rejects(reply.getReader().read(), { message: 'the program reads too slowly' });
  });

  it('stops the camera when the recording fails to start', async () => {
    const state = setup();
    state.start = () => {
      throw refusal('NotSupportedError', 'the stream cannot be recorded');
    };
    const result = await ask({ type: 'video/webm', microphone: true });
    assert.equal(
      result.stderr,
      'cat: /dev/embedder: the stream cannot be recorded\ncat: -: Not supported\n'
    );
    assert.deepEqual(stopped(state), [1, 1]);
  });
});

describe('capture.camera, refusals', () => {
  it('checks the header before it asks for the camera', async () => {
    const state = setup();
    const cases = [
      [{ type: 5 }, 'invalid type: 5'],
      [{ type: 'image/png\u001b[2J' }, 'invalid type'],
      [{ type: 'x'.repeat(65) }, 'invalid type'],
      [{ quality: 2 }, 'invalid quality: 2'],
      [{ device: '' }, 'invalid device: ""'],
      [{ device: 'a b' }, 'invalid device: "a b"'],
      [{ device: 'cam\u001b]0;pwned\u0007' }, 'invalid device'],
      [{ device: 'cam‮' }, 'invalid device'],
      [{ device: 'a'.repeat(257) }, 'invalid device'],
      [{ device: 7 }, 'invalid device: 7'],
      [{ width: 0 }, 'invalid width: 0'],
      [{ width: 1.5 }, 'invalid width: 1.5'],
      [{ width: 16385 }, 'invalid width: 16385'],
      [{ height: '720' }, 'invalid height: "720"'],
      [{ frameRate: 0 }, 'invalid frameRate: 0'],
      [{ frameRate: 1001 }, 'invalid frameRate: 1001'],
      [{ exact: 'yes' }, 'invalid exact: "yes"'],
      [{ warmup: -1 }, 'invalid warmup: -1'],
      [{ warmup: 2147484 }, 'invalid warmup: 2147484'],
      [{ duration: 0 }, 'invalid duration: 0'],
      [{ duration: 1e12 }, 'invalid duration: 1000000000000'],
      [{ microphone: '' }, 'invalid microphone: ""'],
      [{ microphone: 'mic\nline' }, 'invalid microphone'],
      [{ microphone: { deviceId: 'x' } }, 'invalid microphone: {"deviceId":"x"}'],
      [{ microphone: { '\u001b': 1 } }, 'invalid microphone'],
    ];
    for (const [options, message] of cases) {
      await assert.rejects(
        state.page.handle({ kind: 'capture.camera', options, userMedia: state.userMedia }),
        { name: 'TypeError', message },
        message
      );
    }
    for (const type of ['image/gif', 'video/ogg', '__proto__']) {
      await assert.rejects(
        state.page.handle({
          kind: 'capture.camera',
          options: { type },
          userMedia: state.userMedia,
        }),
        { name: 'NotSupportedError', message: `unsupported type: ${type}` }
      );
    }
    assert.deepEqual(state.asked, []);
    const result = await ask({ device: 'a\u0007b' });
    assert.deepEqual(result, {
      status: 0,
      stdout: '1\n',
      stderr: 'cat: /dev/embedder: invalid device\ncat: -: I/O error\n',
    });
    assert.deepEqual(fake.asked, []);
  });

  it('refuses the camera when the embedder passes no userMedia, or the browser cannot', async () => {
    let state = setup();
    fake.userMedia = undefined;
    const result = await ask({});
    assert.deepEqual(result, {
      status: 0,
      stdout: '1\n',
      stderr: 'cat: /dev/embedder: this page does not record the camera\ncat: -: Not supported\n',
    });
    const cases = [
      [{ OffscreenCanvas: undefined }, {}],
      [{ ImageCapture: undefined, document: undefined }, {}],
      [{ MediaRecorder: undefined }, { type: 'video/webm' }],
      [{ MediaStream: undefined }, { type: 'video/mp4' }],
    ];
    for (const [overrides, options] of cases) {
      state = setup(overrides);
      await assert.rejects(
        state.page.handle({ kind: 'capture.camera', options, userMedia: state.userMedia }),
        { name: 'NotSupportedError', message: 'camera capture is not supported in this browser' }
      );
      assert.deepEqual(state.asked, []);
    }
    state = setup();
    await assert.rejects(
      state.page.handle({ kind: 'capture.camera', options: { type: 'video/ogg' } }),
      {
        name: 'NotSupportedError',
        message: 'unsupported type: video/ogg',
      }
    );
  });

  it('refuses a kind it does not answer', async () => {
    const state = setup();
    for (const [kind, message] of [
      ['capture.nope', 'unsupported kind: "capture.nope"'],
      ['a\u001bb', 'unsupported kind'],
    ]) {
      await assert.rejects(state.page.handle({ kind, options: {} }), {
        name: 'NotSupportedError',
        message,
      });
    }
  });
});

describe('capture.devices', () => {
  const listed = [
    { kind: 'audioinput', deviceId: 'default', label: 'Default - Mic' },
    { kind: 'audioinput', deviceId: 'communications', label: 'Communications - Mic' },
    { kind: 'audioinput', deviceId: 'mic1', label: 'Mic' },
    { kind: 'videoinput', deviceId: 'cam1', label: 'FaceTime HD Camera' },
    { kind: 'audiooutput', deviceId: 'out1', label: 'Speakers' },
    { kind: 'videoinput', deviceId: 'cam2+/=_.-', label: 'Bad\tlabel\nhere‮' },
    { kind: 'videoinput', deviceId: 'cam 3', label: 'refused id' },
    { kind: 'audioinput', deviceId: 'mic2', label: '' },
    { kind: 'videoinput', deviceId: { toString: () => 'obj' }, label: 'object id' },
    { kind: 'videoinput', deviceId: 7, label: 'number id' },
  ];

  it('lists cameras, then microphones, without asking', async () => {
    const state = setup();
    let calls = 0;
    fake.devices = async () => {
      calls += 1;
      return listed;
    };
    const result = await os.sh(
      `printf '%s\\n' '{"kind":"capture.devices"}' | cat > /dev/embedder; exec 3<>/dev/embedder; printf '%s\\n' '{"kind":"capture.devices"}' >&3; cat <&3`
    );
    assert.deepEqual(result, {
      status: 0,
      stdout:
        'video\tcam1\tFaceTime HD Camera\nvideo\tcam2+/=_.-\tBad label here \naudio\tmic1\tMic\naudio\tmic2\t\n',
      stderr: '',
    });
    assert.equal(calls, 2);
    assert.deepEqual(state.asked, []);
  });

  it('keeps the unnamed devices a page sees before any grant', async () => {
    const state = setup();
    const reply = await state.page.handle({
      kind: 'capture.devices',
      options: {},
      devices: () => [
        { kind: 'videoinput', deviceId: '', label: '' },
        { kind: 'audioinput', deviceId: '', label: '' },
        { kind: 'audioinput' },
      ],
    });
    assert.equal(reply, 'video\t\t\naudio\t\t\naudio\t\t\n');
    assert.equal(
      await state.page.handle({ kind: 'capture.devices', devices: () => undefined }),
      ''
    );
  });

  it("falls back to the page's mediaDevices, and refuses without them", async () => {
    let state = setup({
      navigator: { mediaDevices: { enumerateDevices: async () => listed.slice(2, 4) } },
    });
    assert.equal(
      await state.page.handle({ kind: 'capture.devices', options: {} }),
      'video\tcam1\tFaceTime HD Camera\naudio\tmic1\tMic\n'
    );
    for (const navigator of [undefined, {}, { mediaDevices: {} }]) {
      state = setup({ navigator });
      await assert.rejects(state.page.handle({ kind: 'capture.devices', options: {} }), {
        name: 'NotSupportedError',
        message: 'this page does not list devices',
      });
    }
    fake.devices = undefined;
    setup({ navigator: undefined });
    const result = await os.sh(`printf '%s\\n' '{"kind":"capture.devices"}' | cat > /dev/embedder`);
    assert.match(result.stderr, /this page does not list devices/);
  });

  it('stops listing when the request is aborted', async () => {
    const state = setup();
    const controller = new AbortController();
    controller.abort('interrupted');
    await assert.rejects(
      state.page.handle({
        kind: 'capture.devices',
        signal: controller.signal,
        devices: () => new Promise(() => {}),
      }),
      { name: 'AbortError', message: 'interrupted' }
    );
  });
});
