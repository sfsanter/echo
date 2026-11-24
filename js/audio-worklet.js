// Rolling audio buffer: records the input continuously, plays it back with a fixed
// delay or plays back one segment ("sentence by sentence" mode), and measures the level.

const LEVEL_WINDOW = 1024;

class DelayProcessor extends AudioWorkletProcessor {
  constructor(options) {
    super();
    const seconds = options.processorOptions.bufferSeconds;
    this.capacity = Math.ceil(seconds * sampleRate);
    this.buf = [new Float32Array(this.capacity), new Float32Array(this.capacity)];
    this.firstFrame = -1;
    this.mode = 'fixed';
    this.delayFrames = 0;
    this.play = null;
    this.levelSum = 0;
    this.levelCount = 0;
    this.levelStart = 0;
    this.port.onmessage = (e) => this.onMessage(e.data);
  }

  onMessage(msg) {
    switch (msg.type) {
      case 'fixed':
        this.mode = 'fixed';
        this.delayFrames = Math.max(0, Math.round(msg.delayFrames));
        this.play = null;
        break;
      case 'phrase':
        this.mode = 'phrase';
        this.play = null;
        break;
      case 'play':
        this.play = { from: msg.from, length: msg.length, start: msg.start };
        break;
    }
  }

  sample(ch, frame) {
    if (this.firstFrame < 0 || frame < this.firstFrame || frame < currentFrame - this.capacity + 128) {
      return 0;
    }
    return this.buf[ch][frame % this.capacity];
  }

  process(inputs, outputs) {
    const input = inputs[0];
    const output = outputs[0];
    const n = output[0].length;
    const base = currentFrame;

    if (input && input.length > 0) {
      if (this.firstFrame < 0) this.firstFrame = base;
      const left = input[0];
      const right = input[1] || input[0];
      let sum = 0;
      for (let i = 0; i < n; i++) {
        const idx = (base + i) % this.capacity;
        const l = left[i];
        const r = right[i];
        this.buf[0][idx] = l;
        this.buf[1][idx] = r;
        const m = Math.max(l * l, r * r);
        sum += m;
      }
      if (this.levelCount === 0) this.levelStart = base;
      this.levelSum += sum;
      this.levelCount += n;
      if (this.levelCount >= LEVEL_WINDOW) {
        const rms = Math.sqrt(this.levelSum / this.levelCount);
        const db = rms > 0 ? 20 * Math.log10(rms) : -120;
        this.port.postMessage({ type: 'level', frame: this.levelStart, now: base + n, db });
        this.levelSum = 0;
        this.levelCount = 0;
      }
    }

    const outL = output[0];
    const outR = output[1] || output[0];

    if (this.mode === 'fixed') {
      for (let i = 0; i < n; i++) {
        const src = base + i - this.delayFrames;
        outL[i] = this.sample(0, src);
        outR[i] = this.sample(1, src);
      }
    } else if (this.play) {
      const p = this.play;
      for (let i = 0; i < n; i++) {
        const k = base + i - p.start;
        if (k >= 0 && k < p.length) {
          outL[i] = this.sample(0, p.from + k);
          outR[i] = this.sample(1, p.from + k);
        } else {
          outL[i] = 0;
          outR[i] = 0;
        }
      }
      if (base + n >= p.start + p.length) this.play = null;
    } else {
      outL.fill(0);
      if (outR !== outL) outR.fill(0);
    }
    return true;
  }
}

registerProcessor('delay-processor', DelayProcessor);
