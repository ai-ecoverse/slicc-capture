const types = ['image/png', 'image/jpeg', 'image/webp'];
const movies = {
  'video/webm': ['video/webm;codecs=vp9', 'video/webm;codecs=vp8', 'video/webm'],
  'video/mp4': ['video/mp4;codecs=avc1', 'video/mp4'],
};
const voiced = {
  'video/webm': ['video/webm;codecs=vp9,opus', 'video/webm;codecs=vp8,opus', 'video/webm'],
  'video/mp4': ['video/mp4;codecs=avc1,mp4a.40.2', 'video/mp4;codecs=avc1,opus', 'video/mp4'],
};
const cursors = ['always', 'motion', 'never'];
const surfaces = ['monitor', 'window', 'browser'];
const unsupported = 'screen capture is not supported in this browser';
const blind = 'camera capture is not supported in this browser';
const longest = 2147483;
const ids = /^[\w+/=.-]{1,256}$/;
const unprintable = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u;
const pseudo = ['default', 'communications'];
const named = { deviceId: 'device', width: 'width', height: 'height', frameRate: 'frameRate' };

export const kinds = { 'capture.screen': {}, 'capture.camera': {}, 'capture.devices': {} };

export const MAX_UNREAD = 64 * 1024 * 1024;

function fail(name, message) {
  return new DOMException(message, name);
}

function aborted(signal) {
  const reason = signal.reason;
  if (reason?.name === 'AbortError') return reason;
  return fail('AbortError', String(reason?.message ?? reason));
}

function race(promise, signal) {
  return new Promise((resolve, reject) => {
    const stop = () => reject(aborted(signal));
    if (signal.aborted) stop();
    signal.addEventListener('abort', stop, { once: true });
    Promise.resolve(promise)
      .then(resolve, reject)
      .finally(() => signal.removeEventListener('abort', stop));
  });
}

function sleep(ms, signal) {
  let timer;
  const wait = new Promise((resolve) => {
    timer = setTimeout(resolve, ms);
  });
  return race(wait, signal).finally(() => clearTimeout(timer));
}

function stopAll(stream) {
  for (const track of stream?.getTracks?.() ?? []) track.stop();
}

function shown(value) {
  let dirty = false;
  const text = JSON.stringify(value, (key, item) => {
    if (unprintable.test(key) || (typeof item === 'string' && unprintable.test(item))) dirty = true;
    return item;
  });
  return dirty || text === undefined || text.length > 64 ? '' : `: ${text}`;
}

function invalid(field, value) {
  return new TypeError(`invalid ${field}${shown(value)}`);
}

const whole = (value, least) => Number.isInteger(value) && value >= least;
const seconds = (value) => Number.isFinite(value) && value >= 0 && value <= longest;
const flag = (value) => typeof value === 'boolean';
const device = (value) => typeof value === 'string' && ids.test(value);
const size = (value) => whole(value, 1) && value <= 16384;

const shared = {
  quality: (value) => typeof value === 'number' && value >= 0 && value <= 1,
  duration: (value) => seconds(value) && value > 0,
  microphone: (value) => flag(value) || device(value),
};

const screens = {
  ...shared,
  cursor: (value) => cursors.includes(value),
  surface: (value) => surfaces.includes(value),
  delay: seconds,
  rect: (value) =>
    whole(value?.x, 0) && whole(value?.y, 0) && whole(value?.width, 1) && whole(value?.height, 1),
  system: flag,
};

const cameras = {
  ...shared,
  device,
  width: size,
  height: size,
  frameRate: (value) => Number.isFinite(value) && value > 0 && value <= 1000,
  exact: flag,
  warmup: seconds,
};

function check(options, fields) {
  const { type = 'image/png', quality, duration } = options;
  if (typeof type !== 'string' || !/^[\x20-\x7e]{1,64}$/.test(type)) throw invalid('type', type);
  const video = Object.hasOwn(movies, type);
  if (!types.includes(type) && !video) {
    throw fail('NotSupportedError', `unsupported type: ${type}`);
  }
  for (const [field, valid] of Object.entries(fields)) {
    if (options[field] !== undefined && !valid(options[field]))
      throw invalid(field, options[field]);
  }
  return { type, quality, video, duration };
}

function screen(options = {}) {
  const request = check(options, screens);
  const { cursor, surface, delay, rect, system, microphone } = options;
  if (request.video && rect !== undefined) throw fail('NotSupportedError', 'rect: not with video');
  const track = {};
  if (cursor !== undefined) track.cursor = cursor;
  if (surface !== undefined) track.displaySurface = surface;
  const audio = Boolean(request.video && system);
  return {
    ...request,
    constraints: { video: track, audio },
    delay: delay ?? 0,
    say: true,
    rect,
    system: audio,
    microphone: request.video && microphone ? microphone : undefined,
  };
}

function camera(options = {}) {
  const request = check(options, cameras);
  const { device, exact, warmup = 1.5, microphone } = options;
  const mode = exact ? 'exact' : 'ideal';
  const track = {};
  if (device !== undefined) track.deviceId = { exact: device };
  for (const field of ['width', 'height', 'frameRate']) {
    if (options[field] !== undefined) track[field] = { [mode]: options[field] };
  }
  let audio = false;
  if (request.video && microphone) {
    audio = microphone === true ? true : { deviceId: { exact: microphone } };
  }
  return {
    ...request,
    constraints: { video: Object.keys(track).length > 0 ? track : true, audio },
    delay: request.video ? 0 : warmup,
  };
}

async function ask(source, constraints, signal, timeout) {
  const pending = Promise.resolve().then(() => source(constraints));
  let timer;
  const late = new Promise((_, reject) => {
    if (timeout) {
      timer = setTimeout(
        () => reject(fail('TimeoutError', 'timed out waiting for the picker')),
        timeout
      );
    }
  });
  try {
    return await race(Promise.race([pending, late]), signal);
  } catch (error) {
    pending.then(stopAll, () => {});
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

async function grab(stream, track, env, signal) {
  const ImageCapture = env('ImageCapture');
  if (ImageCapture) {
    const pending = Promise.resolve(new ImageCapture(track).grabFrame());
    let bitmap;
    try {
      bitmap = await race(pending, signal);
    } catch (error) {
      pending.then(
        (late) => late?.close?.(),
        () => {}
      );
      throw error;
    }
    return {
      source: bitmap,
      width: bitmap.width,
      height: bitmap.height,
      close: () => bitmap.close?.(),
    };
  }
  const video = env('document').createElement('video');
  const close = () => {
    video.pause();
    video.srcObject = null;
  };
  const ready = new Promise((resolve, reject) => {
    video.onloadedmetadata = () => video.play().catch(reject);
    video.onloadeddata = resolve;
    video.onerror = () => reject(new Error('the capture could not be played'));
  });
  video.muted = true;
  video.playsInline = true;
  video.srcObject = stream;
  try {
    await race(ready, signal);
  } catch (error) {
    close();
    throw error;
  }
  return { source: video, width: video.videoWidth, height: video.videoHeight, close };
}

async function encode(frame, request, env, signal) {
  const { type, quality, rect } = request;
  const { x, y, width, height } = rect ?? { x: 0, y: 0, width: frame.width, height: frame.height };
  if (!(frame.width > 0 && frame.height > 0)) throw new Error('the capture has no frame');
  if (x + width > frame.width || y + height > frame.height) {
    throw new RangeError('-R: rectangle outside the capture');
  }
  const canvas = new (env('OffscreenCanvas'))(width, height);
  canvas.getContext('2d').drawImage(frame.source, x, y, width, height, 0, 0, width, height);
  const blob = await race(
    canvas.convertToBlob(quality === undefined ? { type } : { type, quality }),
    signal
  );
  if (blob.type !== type)
    throw fail('NotSupportedError', `${type} is not supported by this browser`);
  return new Uint8Array(await race(blob.arrayBuffer(), signal));
}

const audible = (stream) => (stream?.getTracks?.() ?? []).filter((track) => track.kind === 'audio');

function choose(env, type, audio) {
  const Recorder = env('MediaRecorder');
  const list = audio ? voiced[type] : movies[type];
  const mimeType = list.find((candidate) => Recorder?.isTypeSupported?.(candidate));
  if (!mimeType) throw fail('NotSupportedError', `${type} is not supported by this browser`);
  return mimeType;
}

function mix(env, track, audio) {
  if (audio.length < 2) return { tracks: [track, ...audio], close() {} };
  const context = new (env('AudioContext'))();
  let mixed = [];
  const close = () => {
    for (const one of mixed) one.stop();
    context.close();
  };
  try {
    const destination = context.createMediaStreamDestination();
    mixed = destination.stream.getAudioTracks();
    const Stream = env('MediaStream');
    for (const one of audio)
      context.createMediaStreamSource(new Stream([one])).connect(destination);
    return { tracks: [track, ...mixed], close };
  } catch (error) {
    close();
    throw error;
  }
}

function browser(request, env, message) {
  if (request.video) {
    if (!env('MediaRecorder') || !env('MediaStream')) throw fail('NotSupportedError', message);
    choose(env, request.type, false);
  } else if (!env('OffscreenCanvas') || !(env('ImageCapture') || env('document'))) {
    throw fail('NotSupportedError', message);
  }
}

function listen(userMedia, microphone, signal) {
  const audio = microphone === true ? true : { deviceId: { exact: microphone } };
  return ask(userMedia, { audio, video: false }, signal);
}

function film({ env, stream, mic, track, type, duration, signal, progress }) {
  const audio = [...audible(stream), ...audible(mic)];
  const mimeType = choose(env, type, audio.length > 0);
  const mixer = mix(env, track, audio);
  let recorder;
  let timer;
  let finished = false;
  let queue = Promise.resolve();
  const end = () => {
    if (recorder.state !== 'inactive') recorder.stop();
  };
  let abort;
  const finish = () => {
    if (finished) return;
    finished = true;
    clearTimeout(timer);
    signal.removeEventListener('abort', abort);
    track.removeEventListener('ended', end);
    stopAll(stream);
    stopAll(mic);
    mixer.close();
  };
  const start = (controller) => {
    recorder.ondataavailable = (event) => {
      const blob = event.data;
      if (!blob?.size) return;
      queue = queue.then(async () => {
        const bytes = new Uint8Array(await blob.arrayBuffer());
        if (finished) return;
        if (bytes.length > controller.desiredSize) {
          end();
          finish();
          controller.error(new Error('the program reads too slowly'));
          return;
        }
        controller.enqueue(bytes);
      });
    };
    recorder.onstop = () =>
      queue.then(() => {
        if (finished) return;
        finish();
        controller.close();
      });
    recorder.onerror = (event) => {
      if (finished) return;
      finish();
      controller.error(event.error ?? new Error('the recording failed'));
    };
    abort = () => {
      end();
      if (finished) return;
      finish();
      controller.error(aborted(signal));
    };
    recorder.start(250);
    signal.addEventListener('abort', abort, { once: true });
    track.addEventListener('ended', end, { once: true });
    if (duration) timer = setTimeout(end, duration * 1000);
    progress(duration ? `recording for ${duration} s…` : 'recording…');
  };
  try {
    recorder = new (env('MediaRecorder'))(new (env('MediaStream'))(mixer.tracks), { mimeType });
    return new ReadableStream(
      {
        start,
        cancel() {
          end();
          finish();
        },
      },
      new ByteLengthQueuingStrategy({ highWaterMark: MAX_UNREAD })
    );
  } catch (error) {
    finished = true;
    mixer.close();
    throw error;
  }
}

function explain(error, audio) {
  if (error?.name === 'NotFoundError') {
    return fail('NotFoundError', audio ? 'no camera or microphone' : 'no camera');
  }
  if (error?.name === 'OverconstrainedError') {
    const name = String(error.constraint ?? '');
    const field = Object.hasOwn(named, name) ? named[name] : 'constraints';
    return fail('NotSupportedError', `no camera matches the ${field} asked for`);
  }
  return error;
}

const label = (value) => String(value ?? '').replace(new RegExp(unprintable, 'gu'), ' ');

async function list(devices, env, signal) {
  let enumerate = devices;
  if (typeof enumerate !== 'function') {
    const media = env('navigator')?.mediaDevices;
    if (typeof media?.enumerateDevices !== 'function') {
      throw fail('NotSupportedError', 'this page does not list devices');
    }
    enumerate = () => media.enumerateDevices();
  }
  const found = (await race(Promise.resolve().then(enumerate), signal)) ?? [];
  const rows = [];
  for (const [kind, name] of [
    ['videoinput', 'video'],
    ['audioinput', 'audio'],
  ]) {
    for (const one of found) {
      const id = one?.deviceId ?? '';
      if (
        one?.kind !== kind ||
        typeof id !== 'string' ||
        pseudo.includes(id) ||
        (id && !ids.test(id))
      )
        continue;
      rows.push(`${name}\t${id}\t${label(one.label)}\n`);
    }
  }
  return rows.join('');
}

export function create(overrides = {}) {
  const env = (name) => (name in overrides ? overrides[name] : globalThis[name]);
  const timeout = overrides.timeout ?? 300000;

  async function shoot(request, open, words, { signal, progress, userMedia }) {
    const local = new AbortController();
    const forward = () => local.abort(signal.reason);
    if (signal.aborted) forward();
    signal.addEventListener('abort', forward, { once: true });
    let stream;
    let mic;
    let frame;
    let keep = false;
    try {
      if (local.signal.aborted) throw aborted(local.signal);
      stream = await open(local.signal);
      const track = stream?.getVideoTracks?.()[0];
      if (!track) throw fail('NotFoundError', words.missing);
      if (track.readyState === 'ended') throw fail('AbortError', words.stopped);
      track.addEventListener('ended', () => local.abort(fail('AbortError', words.stopped)), {
        once: true,
      });
      if (request.delay > 0) {
        if (request.say) progress(`waiting ${request.delay} s…`);
        await sleep(request.delay * 1000, local.signal);
      }
      if (request.video) {
        if (request.system && !audible(stream).length) progress('no audio was shared');
        if (request.microphone) mic = await listen(userMedia, request.microphone, local.signal);
        const { type, duration } = request;
        const reply = film({ env, stream, mic, track, type, duration, signal, progress });
        keep = true;
        return reply;
      }
      frame = await grab(stream, track, env, local.signal);
      return await encode(frame, request, env, local.signal);
    } finally {
      signal.removeEventListener('abort', forward);
      frame?.close();
      if (!keep) {
        stopAll(stream);
        stopAll(mic);
      }
    }
  }

  function onScreen(options, context) {
    const request = screen(options);
    if (typeof context.display !== 'function') throw fail('NotSupportedError', unsupported);
    if (request.microphone && typeof context.userMedia !== 'function') {
      throw fail('NotSupportedError', 'this page does not record the microphone');
    }
    browser(request, env, unsupported);
    const open = (signal) => {
      context.progress('waiting for the picker…');
      return ask(context.display, request.constraints, signal, timeout);
    };
    const words = { missing: 'the capture has no video track', stopped: 'the capture was stopped' };
    return shoot(request, open, words, context);
  }

  function onCamera(options, context) {
    const request = camera(options);
    if (typeof context.userMedia !== 'function') {
      throw fail('NotSupportedError', 'this page does not record the camera');
    }
    browser(request, env, blind);
    const open = async (signal) => {
      try {
        return await ask(context.userMedia, request.constraints, signal);
      } catch (error) {
        throw explain(error, request.constraints.audio);
      }
    };
    return shoot(
      request,
      open,
      { missing: 'no camera', stopped: 'the camera was stopped' },
      context
    );
  }

  async function handle({
    kind = 'capture.screen',
    options,
    signal = new AbortController().signal,
    progress = () => {},
    display,
    userMedia,
    devices,
  }) {
    const context = { signal, progress, display, userMedia };
    if (kind === 'capture.screen') return onScreen(options, context);
    if (kind === 'capture.camera') return onCamera(options, context);
    if (kind === 'capture.devices') return list(devices, env, signal);
    throw fail('NotSupportedError', `unsupported kind${shown(kind)}`);
  }

  return { kinds, handle };
}

const page = create();

export const handle = page.handle;

export default page;
