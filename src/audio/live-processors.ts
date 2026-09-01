const LIVE_TARGET_RATE = 16000;
const LIVE_CHUNK = 1600;
const LIVE_OUTPUT_RATE = 24000;

class PcmStreamProcessor extends AudioWorkletProcessor {
  private readonly factor: number;
  private frac = 0;
  private accSum = 0;
  private accCount = 0;
  private buf: Int16Array = new Int16Array(LIVE_CHUNK);
  private len = 0;

  constructor(options?: AudioWorkletNodeOptions) {
    super();
    this.factor = sampleRate / LIVE_TARGET_RATE;
  }

  process(inputs: Float32Array[][]): boolean {
    const ch = inputs[0]?.[0];
    if (!ch || ch.length === 0) return true;
    for (let i = 0; i < ch.length; i++) {
      this.accSum += ch[i];
      this.accCount++;
      this.frac += 1;
      if (this.frac >= this.factor) {
        this.frac -= this.factor;
        const s = this.accSum / this.accCount;
        this.accSum = 0;
        this.accCount = 0;
        const clamped = Math.max(-1, Math.min(1, s));
        this.buf[this.len++] = clamped < 0 ? clamped * 0x8000 : clamped * 0x7fff;
        if (this.len >= LIVE_CHUNK) {
          const chunk = this.buf.slice(0, this.len);
          this.port.postMessage({ type: 'chunk', data: chunk }, [chunk.buffer]);
          this.len = 0;
        }
      }
    }
    return true;
  }
}

class PlaybackProcessor extends AudioWorkletProcessor {
  private readonly targetRate: number;
  private readonly ring: Float32Array;
  private head = 0;
  private tail = 0;

  constructor(options?: AudioWorkletNodeOptions) {
    super();
    const opts = (options?.processorOptions ?? {}) as Record<string, number>;
    this.targetRate = opts.targetRate ?? sampleRate;
    this.ring = new Float32Array(this.targetRate * 12);
    this.port.onmessage = (e: MessageEvent) => this.handle(e.data);
  }

  private handle(data: any): void {
    if (!data) return;
    if (data.type === 'clear') {
      this.head = 0;
      this.tail = 0;
      return;
    }
    if (data.type === 'audio' && data.data instanceof Int16Array) {
      this.appendInt16(data.data);
    }
  }

  private appendInt16(i16: Int16Array): void {
    const ratio = LIVE_OUTPUT_RATE / this.targetRate;
    const n = i16.length;
    if (n === 0) return;
    const outLen = Math.floor(n / ratio);
    for (let oi = 0; oi < outLen; oi++) {
      const pos = oi * ratio;
      const i0 = Math.floor(pos);
      const i1 = Math.min(i0 + 1, n - 1);
      const frac = pos - i0;
      const s = (i16[i0] * (1 - frac) + i16[i1] * frac) / 32768;
      this.ring[this.head] = s;
      this.head = (this.head + 1) % this.ring.length;
      if (this.head === this.tail) this.tail = (this.tail + 1) % this.ring.length;
    }
  }

  process(_inputs: Float32Array[][], outputs: Float32Array[][]): boolean {
    const out = outputs[0]?.[0];
    if (!out) return true;
    for (let i = 0; i < out.length; i++) {
      if (this.tail !== this.head) {
        out[i] = this.ring[this.tail];
        this.tail = (this.tail + 1) % this.ring.length;
      } else {
        out[i] = 0;
      }
    }
    return true;
  }
}

registerProcessor('pcm-stream', PcmStreamProcessor);
registerProcessor('playback', PlaybackProcessor);