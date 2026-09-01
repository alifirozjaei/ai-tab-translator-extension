const TARGET_RATE = 16000;

class VADProcessor extends AudioWorkletProcessor {
  private readonly factor: number;
  private frac = 0;
  private accSum = 0;
  private accCount = 0;

  private readonly silenceThreshold: number;
  private readonly maxSegmentFrames: number;
  private readonly interimInterval: number;
  private readonly passThrough: boolean;

  private globalFrames = 0;
  private speaking = false;
  private silenceFrames = 0;
  private segStartFrame = -1;
  private lastInterimFrame = -1;
  private segLen = 0;
  private seg: Float32Array;

  private readonly rmsWindow = 800;
  private rmsBuf: Float32Array;
  private rmsIdx = 0;
  private rmsFilled = 0;
  private rmsSumSq = 0;

  private readonly voiceOn = 0.018;
  private readonly voiceOff = 0.006;

  constructor(options?: AudioWorkletNodeOptions) {
    super();
    const opts = (options?.processorOptions ?? {}) as Record<string, number | boolean>;
    this.factor = sampleRate / TARGET_RATE;
    this.silenceThreshold = Math.max(
      200,
      Math.round(((opts.silenceThresholdMs as number) ?? 700) / 1000 * TARGET_RATE),
    );
    this.maxSegmentFrames = Math.round(((opts.maxSegmentMs as number) ?? 15000) / 1000 * TARGET_RATE);
    this.interimInterval = Math.round(((opts.interimIntervalMs as number) ?? 3500) / 1000 * TARGET_RATE);
    this.passThrough = Boolean(opts.passThrough);
    this.rmsBuf = new Float32Array(this.rmsWindow);
    this.seg = new Float32Array(this.maxSegmentFrames);
    this.port.onmessage = (e: MessageEvent) => {
      if (e.data?.type === 'reset') {
        this.speaking = false;
        this.silenceFrames = 0;
        this.segLen = 0;
        this.lastInterimFrame = -1;
      }
    };
  }

  process(
    inputs: Float32Array[][],
    outputs: Float32Array[][],
  ): boolean {
    const input = inputs[0];
    const output = outputs[0];
    const inCh = input && input[0];
    const outCh = output && output[0];

    if (inCh && outCh && this.passThrough) {
      const n = Math.min(inCh.length, outCh.length);
      for (let i = 0; i < n; i++) outCh[i] = inCh[i];
    }
    if (inCh && inCh.length) {
      for (let i = 0; i < inCh.length; i++) this.pushInput(inCh[i]);
    }
    return true;
  }

  private pushInput(x: number): void {
    this.accSum += x;
    this.accCount++;
    this.frac += 1;
    if (this.frac >= this.factor) {
      this.frac -= this.factor;
      const s = this.accSum / this.accCount;
      this.accSum = 0;
      this.accCount = 0;
      this.push16k(s);
    }
  }

  private push16k(s: number): void {
    const idx = this.globalFrames;
    this.globalFrames++;

    const i = this.rmsIdx;
    if (this.rmsFilled < this.rmsWindow) this.rmsFilled++;
    this.rmsSumSq -= this.rmsBuf[i] * this.rmsBuf[i];
    this.rmsBuf[i] = s;
    this.rmsSumSq += s * s;
    this.rmsIdx = (i + 1) % this.rmsWindow;
    const rms = Math.sqrt(this.rmsSumSq / this.rmsFilled);

    if (this.speaking) {
      if (this.segLen < this.maxSegmentFrames) {
        this.seg[this.segLen] = s;
      }
      this.segLen++;
      const segFrames = idx - this.segStartFrame + 1;

      if (rms < this.voiceOff) {
        this.silenceFrames++;
        if (this.silenceFrames >= this.silenceThreshold) {
          this.finalize(idx);
          return;
        }
      } else {
        this.silenceFrames = 0;
      }

      if (this.lastInterimFrame < 0) {
        if (segFrames >= this.interimInterval) this.emitInterim(idx);
      } else if (idx - this.lastInterimFrame >= this.interimInterval) {
        this.emitInterim(idx);
      }

      if (segFrames >= this.maxSegmentFrames) {
        this.finalize(idx);
      }
    } else {
      if (rms >= this.voiceOn) {
        this.speaking = true;
        this.silenceFrames = 0;
        this.segLen = 0;
        this.lastInterimFrame = -1;
        this.segStartFrame = idx;
        this.seg[this.segLen] = s;
        this.segLen++;
      }
    }
  }

  private emitInterim(endIdx: number): void {
    this.lastInterimFrame = endIdx;
    const samples = this.seg.slice(0, this.segLen);
    this.postSegment(samples, this.segStartFrame, endIdx, true);
  }

  private finalize(endIdx: number): void {
    const samples = this.seg.slice(0, this.segLen);
    this.postSegment(samples, this.segStartFrame, endIdx, false);
    this.speaking = false;
    this.silenceFrames = 0;
    this.segLen = 0;
    this.lastInterimFrame = -1;
  }

  private postSegment(
    samples: Float32Array,
    startFrame: number,
    endFrame: number,
    interim: boolean,
  ): void {
    this.port.postMessage(
      {
        type: 'segment',
        samples,
        startTime: startFrame / TARGET_RATE,
        endTime: endFrame / TARGET_RATE,
        interim,
      },
      [samples.buffer],
    );
  }
}

registerProcessor('vad-processor', VADProcessor);
