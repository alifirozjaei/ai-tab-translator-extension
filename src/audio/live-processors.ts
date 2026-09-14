const LIVE_TARGET_RATE = 16000;
// 1600 samples @16kHz = 100ms of audio per packet sent to the Live API.
const LIVE_CHUNK = 1600;
const LIVE_OUTPUT_RATE = 24000;

class PcmStreamProcessor extends AudioWorkletProcessor {
  private readonly factor: number;
  private readonly lowQuality: boolean;
  private readonly rate: number;
  private readonly cap: number;
  private frac = 0;
  private accSum = 0;
  private accCount = 0;
  private buf: Int16Array;
  private len = 0;
  // Pair accumulator for the 16kHz -> 8kHz downsampling (anti-alias: the mean
  // of each pair instead of dropping every other sample, which would alias the
  // 4-8kHz band down into 0-4kHz).
  private pairFirst: number | null = null;

  constructor(options?: AudioWorkletNodeOptions) {
    super();
    const opts = (options?.processorOptions ?? {}) as Record<string, unknown>;
    // Low-bandwidth mode halves the uplink: 16kHz -> 8kHz and label the stream
    // accordingly. Chunk boundaries stay at ~100ms either way.
    this.lowQuality = opts.lowQuality === true;
    this.rate = this.lowQuality ? 8000 : LIVE_TARGET_RATE;
    this.factor = sampleRate / LIVE_TARGET_RATE;
    this.cap = this.lowQuality ? 800 : LIVE_CHUNK;
    this.buf = new Int16Array(this.cap);
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
        if (this.lowQuality) {
          if (this.pairFirst === null) {
            this.pairFirst = s;
          } else {
            const avg = (this.pairFirst + s) / 2;
            this.pairFirst = null;
            this.pushSample(avg);
          }
        } else {
          this.pushSample(s);
        }
      }
    }
    return true;
  }

  private pushSample(s: number): void {
    const clamped = Math.max(-1, Math.min(1, s));
    this.buf[this.len++] = clamped < 0 ? clamped * 0x8000 : clamped * 0x7fff;
    if (this.len >= this.cap) {
      const chunk = this.buf.slice(0, this.len);
      this.port.postMessage({ type: 'chunk', data: chunk, rate: this.rate }, [chunk.buffer]);
      this.len = 0;
    }
  }
}

class PlaybackProcessor extends AudioWorkletProcessor {
  private readonly targetRate: number;
  // Delay line: samples wait here until `delaySec` after their arrival time.
  private readonly pending: Float32Array;
  private readonly pendingTimes: Float64Array;
  private pw = 0;
  private pr = 0;
  private pc = 0;
  private delaySec = 0;
  // On interruption the buffer fades out over ~160ms, then the remainder is
  // discarded so already-cancelled dub never plays at full volume.
  private fading = false;
  private fadeRemain = 0;
  private fadeTotal = 0;
  // true when the fade must end with a full discard (interrupt stop); false
  // for the short fade-in of a new turn (keep the new audio).
  private pruneOnFadeEnd = false;
  // false = fade-out (interrupt clears, 1 -> 0); true = fade-in (new turn
  // starts silent and ramps up 0 -> 1). S1: the ramp direction must match.
  private fadeIn = false;

  constructor(options?: AudioWorkletNodeOptions) {
    super();
    const opts = (options?.processorOptions ?? {}) as Record<string, number>;
    this.targetRate = opts.targetRate ?? sampleRate;
    // Fixed capacity at the maximum possible delay (10s) + 3s headroom. It is
    // NOT resized on live delay changes, so sizing for the max avoids the
    // overflow/drop that a delay increase would otherwise cause.
    const cap = Math.round(this.targetRate * 13);
    this.pending = new Float32Array(cap);
    this.pendingTimes = new Float64Array(cap);
    this.delaySec = Math.min(10, Math.max(0, (opts.delayMs ?? 0) / 1000));
    this.port.onmessage = (e: MessageEvent) => this.handle(e.data);
  }

  private handle(data: any): void {
    if (!data) return;
    if (data.type === 'clear') {
      // Interrupt: fade the currently playing dub, then discard what remains.
      this.fading = true;
      this.fadeIn = false;
      this.fadeTotal = Math.round(this.targetRate * 0.16);
      this.fadeRemain = this.fadeTotal;
      this.pruneOnFadeEnd = true;
      return;
    }
    if (data.type === 'delay' && typeof data.ms === 'number') {
      this.delaySec = Math.min(10, Math.max(0, data.ms / 1000));
      return;
    }
    if (data.type === 'audio' && data.data instanceof Int16Array) {
      this.appendInt16(data.data);
    }
  }

  private appendInt16(i16: Int16Array): void {
    if (this.fading && this.pruneOnFadeEnd) {
      // A new turn arrived while the interrupt-fade was running: the old
      // (cancelled) dub is dropped and the new audio ramps UP over ~10ms so
      // there is no hard click (N11); the new audio is NOT pruned (S1: the
      // fade-in ramp goes 0 -> 1, unlike the interrupt fade-out 1 -> 0).
      this.pr = this.pw;
      this.pc = 0;
      this.fading = true;
      this.fadeIn = true;
      this.fadeTotal = Math.round(this.targetRate * 0.01);
      this.fadeRemain = this.fadeTotal;
      this.pruneOnFadeEnd = false;
    }
    const ratio = LIVE_OUTPUT_RATE / this.targetRate;
    const n = i16.length;
    if (n === 0) return;
    const outLen = Math.floor(n / ratio);
    const now = currentTime;
    for (let oi = 0; oi < outLen; oi++) {
      const pos = oi * ratio;
      const i0 = Math.floor(pos);
      const i1 = Math.min(i0 + 1, n - 1);
      const frac = pos - i0;
      const s = (i16[i0] * (1 - frac) + i16[i1] * frac) / 32768;
      this.pending[this.pw] = s;
      this.pendingTimes[this.pw] = now;
      this.pw = (this.pw + 1) % this.pending.length;
      if (this.pc === this.pending.length) {
        this.pr = (this.pr + 1) % this.pending.length;
      } else {
        this.pc++;
      }
    }
  }

  process(_inputs: Float32Array[][], outputs: Float32Array[][]): boolean {
    const out = outputs[0]?.[0];
    if (!out) return true;
    const now = currentTime;
    for (let i = 0; i < out.length; i++) {
      if (this.pc > 0 && now >= this.pendingTimes[this.pr] + this.delaySec) {
        let sample = this.pending[this.pr];
        if (this.fading) {
          const k = this.fadeTotal > 0 ? this.fadeRemain / this.fadeTotal : 0;
          sample *= this.fadeIn ? 1 - k : k;
          this.fadeRemain--;
          if (this.fadeRemain <= 0) {
            this.fading = false;
            if (this.pruneOnFadeEnd) {
              // Interrupt fade done: discard the rest of the cancelled buffer.
              // Emit this faded sample and `continue` WITHOUT advancing the
              // pointers again, so pc lands on exactly 0 (N8).
              this.pruneOnFadeEnd = false;
              this.pr = this.pw;
              this.pc = 0;
              out[i] = sample;
              continue;
            }
            // New-turn fade-in finished: keep the (new) buffer as-is.
          }
        }
        out[i] = sample;
        this.pr = (this.pr + 1) % this.pending.length;
        this.pc--;
      } else {
        out[i] = 0;
      }
    }
    return true;
  }
}

registerProcessor('pcm-stream', PcmStreamProcessor);
registerProcessor('playback', PlaybackProcessor);