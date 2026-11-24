// Compressed video recording (WebCodecs) into a rolling memory,
// and a player that can show the picture from any moment in the past.
// Times are in seconds, on the shared clock given by `clock()`.

const KEYFRAME_INTERVAL = 1;
const FEED_AHEAD = 0.15;
const MAX_DECODE_QUEUE = 12;

const CODEC_CANDIDATES = ['avc1.64002A', 'avc1.640028', 'avc1.4D401F', 'vp09.00.40.08', 'vp8'];

async function pickCodec(width, height, framerate) {
  for (const codec of CODEC_CANDIDATES) {
    const config = {
      codec,
      width,
      height,
      framerate,
      bitrate: Math.round(width * height * framerate * 0.12),
      latencyMode: 'realtime',
      hardwareAcceleration: 'prefer-hardware',
    };
    if (codec.startsWith('avc1')) config.avc = { format: 'annexb' };
    try {
      const enc = await VideoEncoder.isConfigSupported(config);
      const dec = await VideoDecoder.isConfigSupported({ codec, codedWidth: width, codedHeight: height });
      if (enc.supported && dec.supported) return config;
    } catch {
      // try the next codec
    }
  }
  throw new Error('No compatible video codec found in this browser.');
}

export class ChunkStore {
  constructor(retainSeconds) {
    this.retain = retainSeconds;
    this.chunks = [];
    this.firstSeq = 0;
  }

  get endSeq() {
    return this.firstSeq + this.chunks.length;
  }

  get(seq) {
    return this.chunks[seq - this.firstSeq];
  }

  push(chunk) {
    this.chunks.push(chunk);
    const cutoff = chunk.t - this.retain;
    let drop = 0;
    for (let i = 1; i < this.chunks.length; i++) {
      if (this.chunks[i].t > cutoff) break;
      if (this.chunks[i].key) drop = i;
    }
    if (drop > 0) {
      this.chunks.splice(0, drop);
      this.firstSeq += drop;
    }
  }

  get oldestTime() {
    return this.chunks.length ? this.chunks[0].t : null;
  }

  get newestTime() {
    return this.chunks.length ? this.chunks[this.chunks.length - 1].t : null;
  }

  keyframeAtOrBefore(t) {
    for (let i = this.chunks.length - 1; i >= 0; i--) {
      const c = this.chunks[i];
      if (c.key && c.t <= t) return this.firstSeq + i;
    }
    return -1;
  }

  clear() {
    this.firstSeq += this.chunks.length;
    this.chunks = [];
  }
}

export class VideoRecorder {
  constructor(track, clock, retainSeconds, onLiveFrame) {
    this.track = track;
    this.clock = clock;
    this.onLiveFrame = onLiveFrame;
    this.store = new ChunkStore(retainSeconds);
    this.config = null;
    this.encoder = null;
    this.lastKeyTime = -Infinity;
    this.pendingTimes = new Map();
    this.running = false;
    this.error = null;
  }

  async start() {
    this.running = true;
    const processor = new MediaStreamTrackProcessor({ track: this.track });
    this.reader = processor.readable.getReader();
    const settings = this.track.getSettings();
    this.framerate = settings.frameRate || 30;
    this.loop();
  }

  async setupEncoder(frame) {
    this.config = await pickCodec(frame.displayWidth, frame.displayHeight, this.framerate);
    this.encoder = new VideoEncoder({
      output: (chunk) => this.onChunk(chunk),
      error: (e) => {
        this.error = e;
        console.error('Video encoder:', e);
      },
    });
    this.encoder.configure(this.config);
  }

  async loop() {
    while (this.running) {
      const { value: frame, done } = await this.reader.read();
      if (done) break;
      const t = this.clock();
      try {
        if (this.onLiveFrame) this.onLiveFrame(frame);
        if (!this.encoder) await this.setupEncoder(frame);
        if (this.encoder.state === 'configured' && this.encoder.encodeQueueSize < 6) {
          const key = t - this.lastKeyTime >= KEYFRAME_INTERVAL;
          if (key) this.lastKeyTime = t;
          this.pendingTimes.set(frame.timestamp, t);
          this.encoder.encode(frame, { keyFrame: key });
        }
      } catch (e) {
        this.error = e;
        console.error(e);
      } finally {
        frame.close();
      }
    }
  }

  onChunk(chunk) {
    const t = this.pendingTimes.get(chunk.timestamp);
    if (t === undefined) return;
    this.pendingTimes.delete(chunk.timestamp);
    const data = new Uint8Array(chunk.byteLength);
    chunk.copyTo(data);
    this.store.push({ t, key: chunk.type === 'key', data });
  }

  stop() {
    this.running = false;
    try { this.reader?.cancel(); } catch {}
    try { this.encoder?.close(); } catch {}
  }
}

export class Player {
  constructor(recorder) {
    this.recorder = recorder;
    this.decoder = null;
    this.nextSeq = -1;
    this.queue = [];
    this.current = null;
    this.currentTime = null;
  }

  get store() {
    return this.recorder.store;
  }

  createDecoder() {
    if (this.decoder && this.decoder.state !== 'closed') {
      try { this.decoder.close(); } catch {}
    }
    const cfg = this.recorder.config;
    this.decoder = new VideoDecoder({
      output: (frame) => this.queue.push(frame),
      error: (e) => {
        console.error('Video decoder:', e);
        this.decoder = null;
      },
    });
    this.decoder.configure({
      codec: cfg.codec,
      codedWidth: cfg.width,
      codedHeight: cfg.height,
      hardwareAcceleration: 'prefer-hardware',
      optimizeForLatency: true,
    });
  }

  dropQueue() {
    for (const f of this.queue) f.close();
    this.queue = [];
  }

  seek(t) {
    if (!this.recorder.config) return false;
    const seq = this.store.keyframeAtOrBefore(t);
    if (seq < 0) return false;
    this.dropQueue();
    this.createDecoder();
    this.nextSeq = seq;
    this.currentTime = null;
    this.feed(t);
    return true;
  }

  feed(target) {
    if (!this.decoder || this.decoder.state !== 'configured') return;
    while (
      this.nextSeq < this.store.endSeq &&
      this.decoder.decodeQueueSize < MAX_DECODE_QUEUE
    ) {
      const c = this.store.get(this.nextSeq);
      if (c.t > target + FEED_AHEAD) break;
      this.decoder.decode(new EncodedVideoChunk({
        type: c.key ? 'key' : 'delta',
        timestamp: Math.round(c.t * 1e6),
        data: c.data,
      }));
      this.nextSeq++;
    }
  }

  // Advances playback to time `target` and returns the picture to show.
  update(target) {
    if (!this.recorder.config) return this.current;

    const key = this.store.keyframeAtOrBefore(target);
    const broken =
      !this.decoder ||
      this.decoder.state !== 'configured' ||
      this.nextSeq < this.store.firstSeq;
    const wentBack = this.currentTime !== null && this.currentTime > target + 0.25;
    const fellBehind = key > this.nextSeq && this.store.get(key).t < target - 0.5;

    if (key >= 0 && (broken || wentBack || fellBehind)) {
      this.seek(target);
    } else {
      this.feed(target);
    }

    let latest = null;
    while (this.queue.length && this.queue[0].timestamp / 1e6 <= target) {
      if (latest) latest.close();
      latest = this.queue.shift();
    }
    if (latest) {
      if (this.current) this.current.close();
      this.current = latest;
      this.currentTime = latest.timestamp / 1e6;
    }
    return this.current;
  }

  // The decoded picture right after the current one, if already available.
  peekNext() {
    return this.queue.length ? this.queue[0] : null;
  }

  clearImage() {
    if (this.current) this.current.close();
    this.current = null;
    this.currentTime = null;
  }

  reset() {
    this.dropQueue();
    if (this.decoder && this.decoder.state !== 'closed') {
      try { this.decoder.close(); } catch {}
    }
    this.decoder = null;
    this.nextSeq = -1;
  }
}
