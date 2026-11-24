import { VideoRecorder, Player } from './video.js';

const BUFFER_SECONDS = 80;
const LEVEL_WINDOW = 1024;
const START_MARGIN = 0.15;
const VOICE_GAP = 0.3;

const DEFAULTS = {
  videoDeviceId: '',
  audioDeviceId: '',
  outputDeviceId: '',
  screenLabel: '',
  mode: 'fixed',
  delay: 5,
  mirror: false,
  threshold: -40,
  silence: 1.2,
  minVoice: 0.15,
  preroll: 0.3,
  tail: 0.3,
  guard: 0.5,
  maxPhrase: 45,
  avOffset: 0,
  dissolve: 0.8,
  slowEnd: 1,
  waitMode: 'frozen',
  waitStrength: 60,
  waitFade: 2,
  trailsMode: 'off',
  trails: 70,
};

const settings = { ...DEFAULTS, ...JSON.parse(localStorage.getItem('echo-settings') || '{}') };
const save = () => localStorage.setItem('echo-settings', JSON.stringify(settings));

const $ = (id) => document.getElementById(id);

const state = {
  running: false,
  ctx: null,
  node: null,
  stream: null,
  recorder: null,
  player: null,
  sr: 48000,
  lag: null,
  output: null,
  blackout: false,
  level: -120,
  lastFrame: 0,
  phrase: 'listening',
  cand: null,
  onset: 0,
  lastVoice: 0,
  echoEnd: 0,
  guardUntil: 0,
  echo: null,
  hasFrozen: false,
  frozenAt: 0,
  composeKey: '',
  lastPhrase: null,
  screens: [],
  popup: null,
  lastTick: 0,
  wakeLock: null,
  liveCount: 0,
};

// ---------- Shared clock ----------
// Time (in seconds) at which the sound being produced now actually leaves the speakers.
function clock() {
  const ctx = state.ctx;
  const ts = ctx.getOutputTimestamp();
  if (!ts.performanceTime) return ctx.currentTime - (state.lag || 0);
  return ts.contextTime + (performance.now() - ts.performanceTime) / 1000;
}

function frameToClock(frame) {
  return frame / state.sr - (state.lag || 0);
}

// ---------- Rendering ----------
function tick() {
  if (!state.running || !state.player) return;
  const nowMs = performance.now();
  if (nowMs - state.lastTick < 4) return;
  state.lastTick = nowMs;

  const now = clock();
  const sample = state.ctx.currentTime - now;
  state.lag = state.lag === null ? sample : state.lag * 0.98 + sample * 0.02;
  const av = settings.avOffset / 1000;

  if (settings.mode === 'fixed') {
    const frame = state.player.update(now - settings.delay - state.lag - av);
    if (frame) composeFixed(frame);
  } else {
    composeSentence(now);
  }
}

// The finished picture is built once per refresh in `comp`, then copied to every screen.
const layers = { comp: null, clean: null, frozen: null };

function ensureLayers(width, height) {
  if (layers.comp && layers.comp.width === width && layers.comp.height === height) return;
  for (const name of Object.keys(layers)) {
    const c = document.createElement('canvas');
    c.width = width;
    c.height = height;
    layers[name] = c;
  }
  state.hasFrozen = false;
}

function resetPicture() {
  for (const c of Object.values(layers)) {
    if (c) c.getContext('2d').clearRect(0, 0, c.width, c.height);
  }
  state.hasFrozen = false;
  state.echo = null;
  state.composeKey = '';
}

function composeFixed(frame) {
  ensureLayers(frame.displayWidth, frame.displayHeight);
  const g = layers.comp.getContext('2d');
  g.drawImage(frame, 0, 0, layers.comp.width, layers.comp.height);
}

// Video position inside the echo, with an optional slow-down to a stop at the end.
function echoPosition(elapsed, dur) {
  const s = Math.min(settings.slowEnd, dur);
  if (s <= 0 || elapsed <= dur - s) return { pos: Math.min(elapsed, dur), slowing: false, end: dur };
  const u = Math.min(elapsed - (dur - s), 2 * s);
  return { pos: dur - s + u - (u * u) / (4 * s), slowing: true, end: dur + s };
}

function waitingAmount(until) {
  if (!state.hasFrozen) return 0;
  const fade = settings.waitFade;
  const t = until - state.frozenAt;
  return fade <= 0 ? 1 : Math.min(1, Math.max(0, t / fade));
}

function drawFrozen(g, w, h, amount, alpha) {
  if (!state.hasFrozen) return;
  const k = amount * (settings.waitStrength / 100);
  g.globalAlpha = alpha;
  switch (settings.waitMode) {
    case 'dim': g.filter = `brightness(${1 - k})`; break;
    case 'bw': g.filter = `grayscale(${k})`; break;
    case 'blur': g.filter = `blur(${(k * 24 * w) / 1920}px)`; break;
    case 'black': g.globalAlpha = alpha * (1 - k); break;
  }
  g.drawImage(layers.frozen, 0, 0, w, h);
  g.filter = 'none';
  g.globalAlpha = 1;
}

function composeSentence(now) {
  const cfg = state.recorder.config;
  if (!cfg) return;
  ensureLayers(cfg.width, cfg.height);
  const { width: w, height: h } = layers.comp;
  const echo = state.echo;

  let frame = null;
  let next = null;
  let blend = 0;
  let echoAlpha = 0;
  let transition = false;

  if (echo && !echo.ended) {
    const elapsed = now - echo.start;
    if (elapsed >= 0) {
      const p = echoPosition(elapsed, echo.dur);
      if (elapsed >= p.end) {
        freezeCurrent(now);
        echo.ended = true;
      } else {
        const target = echo.v0 + p.pos;
        frame = state.player.update(target);
        if (p.slowing && frame) {
          next = state.player.peekNext();
          const t0 = frame.timestamp / 1e6;
          const t1 = next ? next.timestamp / 1e6 : t0;
          blend = t1 > t0 ? Math.min(1, Math.max(0, (target - t0) / (t1 - t0))) : 0;
        }
        echoAlpha = settings.dissolve > 0 ? Math.min(1, elapsed / settings.dissolve) : 1;
        transition = echoAlpha < 1 || p.slowing;
      }
    }
  }

  const playing = echo && !echo.ended && (frame || now >= echo.start);
  const trails =
    settings.trails > 0 &&
    ((settings.trailsMode === 'always' && playing) || (settings.trailsMode === 'transitions' && transition));

  const amount = waitingAmount(playing ? echo.start : now);
  const key = `${amount.toFixed(3)}|${state.hasFrozen}`;
  if (!frame && !trails && key === state.composeKey) return;
  state.composeKey = frame ? '' : key;

  const c = layers.clean.getContext('2d');
  c.fillStyle = '#000';
  c.fillRect(0, 0, w, h);
  if (!frame || echoAlpha < 1) drawFrozen(c, w, h, amount, 1);
  if (frame) {
    c.globalAlpha = echoAlpha;
    c.drawImage(frame, 0, 0, w, h);
    if (next && blend > 0) {
      c.globalAlpha = echoAlpha * blend;
      c.drawImage(next, 0, 0, w, h);
    }
    c.globalAlpha = 1;
  }

  const g = layers.comp.getContext('2d');
  g.globalAlpha = trails ? 1 - settings.trails / 100 : 1;
  g.drawImage(layers.clean, 0, 0);
  g.globalAlpha = 1;
}

// Keeps the picture on screen as the frozen image until the next echo.
function freezeCurrent(now) {
  if (!layers.frozen) return;
  const f = layers.frozen.getContext('2d');
  f.drawImage(layers.clean, 0, 0);
  state.hasFrozen = true;
  state.frozenAt = now;
  state.composeKey = '';
}

function drawFrame(canvas, frame, mirror) {
  const win = canvas.ownerDocument.defaultView;
  const w = Math.round(canvas.clientWidth * win.devicePixelRatio);
  const h = Math.round(canvas.clientHeight * win.devicePixelRatio);
  if (!w || !h) return;
  if (canvas.width !== w || canvas.height !== h) {
    canvas.width = w;
    canvas.height = h;
  }
  const g = canvas.getContext('2d');
  g.setTransform(1, 0, 0, 1, 0, 0);
  g.fillStyle = '#000';
  g.fillRect(0, 0, w, h);
  if (!frame) return;
  const fw = frame.displayWidth || frame.width;
  const fh = frame.displayHeight || frame.height;
  const scale = Math.min(w / fw, h / fh);
  const dw = fw * scale;
  const dh = fh * scale;
  if (mirror) {
    g.translate(w, 0);
    g.scale(-1, 1);
  }
  g.drawImage(frame, (w - dw) / 2, (h - dh) / 2, dw, dh);
}

function projectedFrame() {
  return state.running && !state.blackout ? layers.comp : null;
}

function drawProjection(canvas) {
  tick();
  drawFrame(canvas, projectedFrame(), settings.mirror);
}

function drawLive(frame) {
  state.liveCount++;
  if (state.liveCount % 2) drawFrame($('livePreview'), frame, false);
}

function controlLoop() {
  tick();
  drawFrame($('outputPreview'), projectedFrame(), settings.mirror);
  updateMeter();
  updateBufferInfo();
  if (state.recorder?.error) showWarning('Video error: ' + state.recorder.error.message);
  requestAnimationFrame(controlLoop);
}

// ---------- Sentence by sentence mode ----------
const PHRASE_LABELS = {
  listening: ['WAITING', 'Waiting for someone to speak.'],
  speaking: ['RECORDING', 'Recording until the person stops.'],
  echo: ['PLAYING BACK', 'Not recording during playback.'],
  guard: ['PAUSE', 'Listening again in a moment.'],
};

function setPhrase(name) {
  state.phrase = name;
  const el = $('phraseState');
  el.textContent = PHRASE_LABELS[name][0];
  el.className = name;
  $('phraseHelp').textContent = PHRASE_LABELS[name][1];
}

function phraseStep(msg) {
  const sr = state.sr;
  const f = msg.frame;
  const voiced = msg.db > settings.threshold;

  switch (state.phrase) {
    case 'listening':
      if (voiced) {
        if (!state.cand || (f - state.cand.last) / sr > VOICE_GAP) {
          state.cand = { start: f, voiced: 0, last: f };
        }
        state.cand.voiced += LEVEL_WINDOW / sr;
        state.cand.last = f;
        if (state.cand.voiced >= settings.minVoice) {
          state.onset = state.cand.start;
          state.lastVoice = f;
          state.cand = null;
          setPhrase('speaking');
        }
      }
      break;
    case 'speaking':
      if (voiced) state.lastVoice = f;
      if ((f - state.lastVoice) / sr >= settings.silence) {
        endPhrase(state.lastVoice + LEVEL_WINDOW);
      } else if ((f - state.onset) / sr >= settings.maxPhrase) {
        endPhrase(msg.now);
      }
      break;
    case 'echo':
      if (msg.now >= state.echoEnd) startGuard(state.echoEnd);
      break;
    case 'guard':
      if (msg.now >= state.guardUntil) setPhrase('listening');
      break;
  }
}

function startGuard(fromFrame) {
  state.guardUntil = fromFrame + settings.guard * state.sr;
  state.cand = null;
  setPhrase('guard');
}

function endPhrase(endFrame) {
  const sr = state.sr;
  const oldest = state.lastFrame - (BUFFER_SECONDS - 5) * sr;
  const from = Math.max(state.onset - settings.preroll * sr, oldest);
  const to = Math.min(endFrame + settings.tail * sr, state.lastFrame);
  state.lastPhrase = { from, to };
  playSegment(from, to);
}

function playSegment(from, to) {
  const sr = state.sr;
  from = Math.round(from);
  const length = Math.round(to - from);
  if (length <= 0 || from < state.lastFrame - (BUFFER_SECONDS - 2) * sr) {
    setPhrase('listening');
    return;
  }
  const start = Math.round((state.ctx.currentTime + START_MARGIN) * sr);
  state.node.port.postMessage({ type: 'play', from, length, start });
  state.echoEnd = start + length;
  const v0 = frameToClock(from) - settings.avOffset / 1000;
  if (state.echo && !state.echo.ended) freezeCurrent(clock());
  state.player.clearImage();
  state.player.seek(v0);
  state.echo = { start: start / sr, dur: length / sr, v0, ended: false };
  setPhrase('echo');
}

function forcePlay() {
  if (!state.running || settings.mode !== 'phrase') return;
  if (state.phrase === 'speaking') {
    endPhrase(state.lastFrame);
  } else if (state.phrase !== 'echo' && state.lastPhrase) {
    playSegment(state.lastPhrase.from, state.lastPhrase.to);
  }
}

function onWorkletMessage(msg) {
  if (msg.type !== 'level') return;
  state.level = msg.db;
  state.lastFrame = msg.now;
  if (settings.mode === 'phrase') phraseStep(msg);
}

// ---------- Modes ----------
function applyMode() {
  document.querySelectorAll('input[name=mode]').forEach((r) => (r.checked = r.value === settings.mode));
  $('fixedSettings').hidden = settings.mode !== 'fixed';
  $('phraseSettings').hidden = settings.mode !== 'phrase';
  if (!state.running) return;
  state.cand = null;
  state.player.clearImage();
  resetPicture();
  if (settings.mode === 'fixed') {
    sendDelay();
  } else {
    state.node.port.postMessage({ type: 'phrase' });
    setPhrase('listening');
  }
}

function setMode(mode) {
  if (settings.mode === mode) return;
  settings.mode = mode;
  save();
  applyMode();
}

function sendDelay() {
  if (state.running && settings.mode === 'fixed') {
    state.node.port.postMessage({ type: 'fixed', delayFrames: settings.delay * state.sr });
  }
}

// ---------- Devices ----------
function fillSelect(select, items, selected, emptyLabel) {
  select.innerHTML = '';
  if (emptyLabel !== undefined) select.add(new Option(emptyLabel, ''));
  items.forEach((item) => select.add(new Option(item.label, item.value)));
  if (items.some((i) => i.value === selected) || (emptyLabel !== undefined && selected === '')) {
    select.value = selected;
  }
}

async function refreshDevices() {
  const devices = await navigator.mediaDevices.enumerateDevices();
  const list = (kind, name) =>
    devices
      .filter((d) => d.kind === kind && d.deviceId && d.deviceId !== 'default' && d.deviceId !== 'communications')
      .map((d, i) => ({ value: d.deviceId, label: d.label || `${name} ${i + 1}` }));

  const videos = list('videoinput', 'Camera');
  const audios = list('audioinput', 'Sound input');
  const outputs = list('audiooutput', 'Sound output');

  fillSelect($('videoDevice'), videos, settings.videoDeviceId);
  fillSelect($('audioDevice'), audios, settings.audioDeviceId);
  fillSelect($('audioOutput'), outputs, settings.outputDeviceId, 'Mac default output');
  return devices.some((d) => d.label);
}

async function refreshScreens() {
  state.screens = [];
  if ('getScreenDetails' in window) {
    try {
      const details = await window.getScreenDetails();
      state.screens = details.screens;
      details.onscreenschange = refreshScreens;
    } catch {
      state.screens = [];
    }
  }
  const select = $('screen');
  select.innerHTML = '';
  if (!state.screens.length) {
    select.add(new Option('This screen (move the window by hand)', ''));
    return;
  }
  state.screens.forEach((s, i) => {
    const name = s.label || `Écran ${i + 1}`;
    const tag = s.isPrimary ? ' — principal' : '';
    select.add(new Option(`${name} (${s.width}×${s.height})${tag}`, String(i)));
  });
  let index = state.screens.findIndex((s) => s.label && s.label === settings.screenLabel);
  if (index < 0) index = state.screens.findIndex((s) => !s.isPrimary);
  select.value = String(Math.max(0, index));
}

async function openProjection() {
  if (!state.screens.length) await refreshScreens();
  const s = state.screens[Number($('screen').value)];
  const popup = state.popup && !state.popup.closed ? state.popup : null;

  if (popup) {
    if (s) {
      popup.moveTo(s.availLeft, s.availTop);
      popup.resizeTo(s.availWidth, s.availHeight);
    }
    popup.focus();
    return;
  }

  const features = s
    ? `popup,left=${s.availLeft},top=${s.availTop},width=${s.availWidth},height=${s.availHeight}`
    : 'popup,width=960,height=540';
  state.popup = window.open('projection.html', 'echo-projection', features);
  if (!state.popup) {
    showWarning('The projection window was blocked: click “Open projection window” again, and allow pop-ups for this site if needed.');
  }
}

async function askPermission() {
  const probe = await navigator.mediaDevices.getUserMedia({ video: true, audio: true });
  probe.getTracks().forEach((t) => t.stop());
  await refreshDevices();
}

// ---------- Start ----------
async function start() {
  stop();
  setStatus('Starting…');
  hideWarning();
  try {
    if (!(await refreshDevices())) await askPermission();
    const videoId = $('videoDevice').value;
    const audioId = $('audioDevice').value;

    const ctx = new AudioContext({ latencyHint: 'interactive' });
    ctx.onerror = () => showWarning('Sound error: check the chosen sound output.');
    await ctx.audioWorklet.addModule('js/audio-worklet.js');

    const stream = await navigator.mediaDevices.getUserMedia({
      video: {
        deviceId: videoId ? { exact: videoId } : undefined,
        width: { ideal: 1920 },
        height: { ideal: 1080 },
        frameRate: { ideal: 60 },
      },
      audio: {
        deviceId: audioId ? { exact: audioId } : undefined,
        echoCancellation: false,
        noiseSuppression: false,
        autoGainControl: false,
        channelCount: { ideal: 2 },
      },
    });

    const source = ctx.createMediaStreamSource(stream);
    const node = new AudioWorkletNode(ctx, 'delay-processor', {
      numberOfInputs: 1,
      numberOfOutputs: 1,
      outputChannelCount: [2],
      channelCount: 2,
      channelCountMode: 'explicit',
      processorOptions: { bufferSeconds: BUFFER_SECONDS },
    });
    node.port.onmessage = (e) => onWorkletMessage(e.data);
    source.connect(node);
    node.connect(ctx.destination);

    if (settings.outputDeviceId && ctx.setSinkId) {
      await ctx.setSinkId(settings.outputDeviceId).catch(() => showWarning('Sound output not found: using the Mac default output.'));
    }
    await ctx.resume();

    Object.assign(state, { ctx, node, stream, sr: ctx.sampleRate, lag: null, output: null });

    const videoTrack = stream.getVideoTracks()[0];
    state.recorder = new VideoRecorder(videoTrack, clock, BUFFER_SECONDS, drawLive);
    await state.recorder.start();
    state.player = new Player(state.recorder);
    state.running = true;

    const v = videoTrack.getSettings();
    $('inputInfo').textContent =
      `${v.width}×${v.height}, ${Math.round(v.frameRate || 0)} fps`;

    applyMode();
    requestWakeLock();
    setStatus('Running');
  } catch (e) {
    console.error(e);
    stop();
    setStatus('Error');
    showWarning(e.message || String(e));
  }
}

function stop() {
  state.running = false;
  state.recorder?.stop();
  state.player?.reset();
  state.player?.clearImage();
  state.stream?.getTracks().forEach((t) => t.stop());
  state.ctx?.close();
  state.wakeLock?.release().catch(() => {});
  Object.assign(state, { recorder: null, player: null, stream: null, ctx: null, node: null, wakeLock: null });
  resetPicture();
  drawFrame($('livePreview'), null, false);
  setStatus('Stopped');
}

async function requestWakeLock() {
  try {
    state.wakeLock = await navigator.wakeLock?.request('screen');
  } catch {
    // not critical
  }
}

// ---------- Interface ----------
function setStatus(text) {
  $('status').textContent = text;
  $('start').textContent = state.running ? 'Stop' : 'Start';
}

function showWarning(text) {
  const el = $('warning');
  el.textContent = text;
  el.hidden = false;
}

function hideWarning() {
  $('warning').hidden = true;
}

const dbToPercent = (db) => Math.min(100, Math.max(0, ((db + 80) / 80) * 100));

const meter = { shown: -120, peak: -120, peakAt: 0 };

function updateMeter() {
  const now = performance.now();
  const level = state.running ? state.level : -120;
  meter.shown = Math.max(level, meter.shown - 1.5);
  if (level >= meter.peak || now - meter.peakAt > 1500) {
    meter.peak = level;
    meter.peakAt = now;
  }
  const bar = $('meterBar');
  bar.style.width = dbToPercent(meter.shown) + '%';
  bar.classList.toggle('voice', level > settings.threshold);
  $('meterPeak').style.left = dbToPercent(meter.peak) + '%';
  $('meterThreshold').style.left = dbToPercent(settings.threshold) + '%';
  $('levelValue').textContent = state.running ? `${Math.round(meter.shown)} dB` : '—';
}

function updateBufferInfo() {
  const store = state.recorder?.store;
  const el = $('bufferInfo');
  if (!store || store.oldestTime === null) {
    el.textContent = '';
    return;
  }
  const filled = store.newestTime - store.oldestTime;
  el.textContent =
    filled < settings.delay
      ? `Getting ready… ${filled.toFixed(1)} of ${settings.delay.toFixed(1)} s`
      : '';
}

const RANGES = [
  'delay', 'threshold', 'silence', 'minVoice', 'preroll', 'tail', 'guard', 'maxPhrase', 'avOffset',
  'dissolve', 'slowEnd', 'waitStrength', 'waitFade', 'trails',
];

function showRange(key) {
  const input = $(key);
  const step = Number(input.step);
  const decimals = step < 0.1 ? 2 : step < 1 ? 1 : 0;
  $(key + 'Value').textContent = settings[key].toFixed(decimals);
}

function setRange(key, value) {
  const input = $(key);
  const clamped = Math.min(Number(input.max), Math.max(Number(input.min), value));
  settings[key] = Math.round(clamped * 100) / 100;
  input.value = settings[key];
  showRange(key);
  state.composeKey = '';
  save();
  if (key === 'delay') sendDelay();
}

function toggleMirror() {
  settings.mirror = !settings.mirror;
  $('mirror').checked = settings.mirror;
  save();
}

function toggleBlackout() {
  state.blackout = !state.blackout;
  $('blackout').checked = state.blackout;
}

function handleKey(e) {
  if (e.metaKey || e.ctrlKey || e.altKey || e.repeat && e.key === ' ') return;
  const tag = e.target?.tagName;
  if (tag === 'SELECT') return;
  if (tag === 'INPUT' && e.key.startsWith('Arrow')) return;

  switch (e.key) {
    case ' ': forcePlay(); break;
    case 'f': case 'F': setMode('fixed'); break;
    case 'p': case 'P': setMode('phrase'); break;
    case 'm': case 'M': toggleMirror(); break;
    case 'n': case 'N': toggleBlackout(); break;
    case 'ArrowUp':
    case 'ArrowDown': {
      const dir = e.key === 'ArrowUp' ? 1 : -1;
      if (settings.mode === 'fixed') setRange('delay', settings.delay + dir * 0.5);
      else setRange('threshold', settings.threshold + dir);
      break;
    }
    default:
      return;
  }
  e.preventDefault();
}

function bindUi() {
  for (const key of RANGES) {
    $(key).value = settings[key];
    showRange(key);
    $(key).addEventListener('input', (e) => setRange(key, Number(e.target.value)));
  }

  document.querySelectorAll('input[name=mode]').forEach((r) =>
    r.addEventListener('change', () => setMode(r.value)),
  );

  for (const key of ['waitMode', 'trailsMode']) {
    $(key).value = settings[key];
    $(key).addEventListener('change', (e) => {
      settings[key] = e.target.value;
      state.composeKey = '';
      save();
    });
  }

  $('mirror').checked = settings.mirror;
  $('mirror').addEventListener('change', toggleMirror);
  $('blackout').addEventListener('change', toggleBlackout);

  $('start').addEventListener('click', () => (state.running ? stop() : start()));
  $('openProjection').addEventListener('click', openProjection);
  $('forcePlay').addEventListener('click', forcePlay);
  const restartOnChange = (key) => (e) => {
    settings[key] = e.target.value;
    save();
    if (state.running) start();
  };
  $('videoDevice').addEventListener('change', restartOnChange('videoDeviceId'));
  $('audioDevice').addEventListener('change', restartOnChange('audioDeviceId'));

  $('audioOutput').addEventListener('change', async (e) => {
    settings.outputDeviceId = e.target.value;
    save();
    if (state.ctx?.setSinkId) {
      await state.ctx.setSinkId(settings.outputDeviceId).catch((err) => showWarning(err.message));
    }
  });

  $('screen').addEventListener('change', (e) => {
    settings.screenLabel = state.screens[Number(e.target.value)]?.label || '';
    save();
  });

  document.querySelectorAll('button, input[type=checkbox], input[type=radio]').forEach((el) =>
    el.addEventListener('click', () => el.blur()),
  );
  window.addEventListener('keydown', handleKey);
  window.addEventListener('pagehide', () => state.popup?.close());
  document.addEventListener('visibilitychange', () => {
    if (state.running && document.visibilityState === 'visible') requestWakeLock();
  });
  navigator.mediaDevices.addEventListener('devicechange', refreshDevices);
}

function checkBrowser() {
  const missing = ['VideoEncoder', 'VideoDecoder', 'MediaStreamTrackProcessor', 'AudioWorkletNode'].filter(
    (name) => !(name in window),
  );
  if (missing.length) {
    showWarning('This browser is not supported: please use an up-to-date Google Chrome.');
    $('start').disabled = true;
  } else if (!('getScreenDetails' in window)) {
    showWarning('Screen choice is not available in this browser: please use Google Chrome.');
  }
}

window.app = { handleKey, drawProjection };

bindUi();
applyMode();
setPhrase('listening');
checkBrowser();
refreshDevices()
  .then((known) => known || askPermission())
  .catch(() => showWarning('Camera and microphone access was refused: allow it in Chrome (icon left of the address bar), then reload the page.'));
navigator.permissions
  ?.query({ name: 'window-management' })
  .then((p) => (p.state === 'granted' ? refreshScreens() : $('screen').add(new Option('Click “Open projection window” to list the screens', ''))))
  .catch(() => refreshScreens());
requestAnimationFrame(controlLoop);
