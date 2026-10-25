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

export const kinds = { 'capture.screen': {} };

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

function invalid(field, value) {
  return new TypeError(`invalid ${field}: ${JSON.stringify(value)}`);
}

const whole = (value, least) => Number.isInteger(value) && value >= least;

const checks = {
  quality: (value) => typeof value === 'number' && value >= 0 && value <= 1,
  cursor: (value) => cursors.includes(value),
  surface: (value) => surfaces.includes(value),
  delay: (value) => Number.isFinite(value) && value >= 0,
  rect: (value) =>
    whole(value?.x, 0) && whole(value?.y, 0) && whole(value?.width, 1) && whole(value?.height, 1),
  duration: (value) => Number.isFinite(value) && value > 0,
  system: (value) => typeof value === 'boolean',
  microphone: (value) => typeof value === 'boolean' || (typeof value === 'string' && value !== ''),
};

function parse(options = {}) {
  const { type = 'image/png', quality, cursor, surface, delay, rect } = options;
  const { duration, system, microphone } = options;
  const video = Object.hasOwn(movies, type);
  if (!types.includes(type) && !video) {
    throw fail('NotSupportedError', `unsupported type: ${type}`);
  }
  for (const [field, valid] of Object.entries(checks)) {
    if (options[field] !== undefined && !valid(options[field]))
      throw invalid(field, options[field]);
  }
  if (video && rect !== undefined) throw fail('NotSupportedError', 'rect: not with video');
  const track = {};
  if (cursor !== undefined) track.cursor = cursor;
  if (surface !== undefined) track.displaySurface = surface;
  return {
    constraints: { video: track, audio: Boolean(video && system) },
    type,
    quality,
    delay: delay ?? 0,
    rect,
    video,
    duration,
    microphone: video && microphone ? microphone : undefined,
  };
}

async function pick(display, constraints, signal, timeout) {
  const pending = Promise.resolve().then(() => display(constraints));
  let timer;
  const late = new Promise((_, reject) => {
    timer = setTimeout(
      () => reject(fail('TimeoutError', 'timed out waiting for the picker')),
      timeout
    );
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
  if (audio.length < 2) return { tracks: [track, ...audio] };
  const context = new (env('AudioContext'))();
  const destination = context.createMediaStreamDestination();
  const Stream = env('MediaStream');
  for (const one of audio) context.createMediaStreamSource(new Stream([one])).connect(destination);
  return { tracks: [track, ...destination.stream.getAudioTracks()], context };
}

function supported(request, display, userMedia, env) {
  if (typeof display !== 'function') throw fail('NotSupportedError', unsupported);
  if (request.microphone && typeof userMedia !== 'function') {
    throw fail('NotSupportedError', 'this page does not record the microphone');
  }
  if (request.video) {
    if (!env('MediaRecorder') || !env('MediaStream')) throw fail('NotSupportedError', unsupported);
    choose(env, request.type, false);
  } else if (!env('OffscreenCanvas') || !(env('ImageCapture') || env('document'))) {
    throw fail('NotSupportedError', unsupported);
  }
}

async function listen(userMedia, microphone, signal) {
  const audio = microphone === true ? true : { deviceId: { exact: microphone } };
  const pending = Promise.resolve().then(() => userMedia({ audio, video: false }));
  try {
    return await race(pending, signal);
  } catch (error) {
    pending.then(stopAll, () => {});
    throw error;
  }
}

function film({ env, stream, mic, track, type, duration, signal, progress }) {
  const audio = [...audible(stream), ...audible(mic)];
  const mimeType = choose(env, type, audio.length > 0);
  const { tracks, context } = mix(env, track, audio);
  const recorder = new (env('MediaRecorder'))(new (env('MediaStream'))(tracks), { mimeType });
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
    context?.close();
  };
  return new ReadableStream({
    start(controller) {
      recorder.ondataavailable = (event) => {
        const blob = event.data;
        if (!blob?.size) return;
        queue = queue.then(async () => {
          const bytes = new Uint8Array(await blob.arrayBuffer());
          if (!finished) controller.enqueue(bytes);
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
      signal.addEventListener('abort', abort, { once: true });
      track.addEventListener('ended', end, { once: true });
      if (duration) timer = setTimeout(end, duration * 1000);
      recorder.start(250);
      progress(duration ? `recording for ${duration} s…` : 'recording…');
    },
    cancel() {
      end();
      finish();
    },
  });
}

export function create(overrides = {}) {
  const env = (name) => (name in overrides ? overrides[name] : globalThis[name]);
  const timeout = overrides.timeout ?? 300000;

  async function handle({
    options,
    signal = new AbortController().signal,
    progress = () => {},
    display,
    userMedia,
  }) {
    const request = parse(options);
    supported(request, display, userMedia, env);
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
      progress('waiting for the picker…');
      stream = await pick(display, request.constraints, local.signal, timeout);
      const track = stream?.getVideoTracks?.()[0];
      if (!track) throw fail('NotFoundError', 'the capture has no video track');
      if (track.readyState === 'ended') throw fail('AbortError', 'the capture was stopped');
      track.addEventListener(
        'ended',
        () => local.abort(fail('AbortError', 'the capture was stopped')),
        {
          once: true,
        }
      );
      if (request.delay > 0) {
        progress(`waiting ${request.delay} s…`);
        await sleep(request.delay * 1000, local.signal);
      }
      if (request.video) {
        if (request.constraints.audio && !audible(stream).length) progress('no audio was shared');
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

  return { kinds, handle };
}

const page = create();

export const handle = page.handle;

export default page;
