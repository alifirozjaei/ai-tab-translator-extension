import { logger } from './logger';

export interface LiveTranslateHandlers {
  onAudio?: (pcm24k: Int16Array) => void;
  onInputTranscript?: (text: string, languageCode?: string) => void;
  onOutputTranscript?: (text: string, languageCode?: string) => void;
  onTurnComplete?: () => void;
  onInterrupted?: () => void;
  onState?: (state: string) => void;
  onError?: (message: string, info?: { code?: number; status?: string }) => void;
}

const WS_URL =
  'wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent';

export class LiveTranslateSession {
  private ws: WebSocket | null = null;
  private ready = false;
  // Once closed, pending socket callbacks are ignored so a superseded session
  // can never fire into (or corrupt) the currently active one.
  private dead = false;
  // Handles for the pending setup promise so close() can settle it immediately.
  private setupTimer: ReturnType<typeof setTimeout> | null = null;
  private rejectSetup: ((e: Error) => void) | null = null;

  constructor(
    private readonly apiKey: string,
    private readonly model: string,
    private readonly targetLanguage: string,
    private readonly handlers: LiveTranslateHandlers,
    private readonly echoTargetLanguage = true,
    private readonly includeTranscriptions = false,
  ) {}

  get isReady(): boolean {
    return this.ready && this.ws?.readyState === WebSocket.OPEN;
  }

  start(): Promise<void> {
    this.dead = false;
    return new Promise((resolve, reject) => {
      const url = `${WS_URL}?key=${encodeURIComponent(this.apiKey)}`;
      let settled = false;
      const ws = new WebSocket(url);
      this.ws = ws;
      ws.binaryType = 'arraybuffer';
      this.rejectSetup = reject;

      const timeout = setTimeout(() => {
        if (!settled) {
          settled = true;
          this.setupTimer = null;
          this.rejectSetup = null;
          try {
            ws.close();
          } catch {
            /* ignore */
          }
          reject(new Error('Live session setup timed out after 15s.'));
        }
      }, 15000);
      this.setupTimer = timeout;

      // On any settle path, drop the class-level handles so close() knows the
      // setup promise is no longer pending.
      const onSettle = () => {
        settled = true;
        clearTimeout(timeout);
        this.setupTimer = null;
        this.rejectSetup = null;
      };

      ws.onopen = () => {
        if (this.dead) return;
        const setup: Record<string, unknown> = {
          model: `models/${this.model}`,
          generationConfig: {
            responseModalities: ['AUDIO'],
            translationConfig: {
              targetLanguageCode: this.targetLanguage,
              echoTargetLanguage: this.echoTargetLanguage,
            },
          },
        };
        if (this.includeTranscriptions) {
          const gc = setup.generationConfig as Record<string, unknown>;
          gc.inputAudioTranscription = {};
          gc.outputAudioTranscription = {};
        }
        logger.info('live: WebSocket open, sending setup', JSON.stringify({ setup }));
        ws.send(JSON.stringify({ setup }));
      };

      ws.onmessage = (ev) => {
        if (this.dead) return;
        let raw: string;
        if (typeof ev.data === 'string') {
          raw = ev.data;
        } else {
          raw = new TextDecoder().decode(ev.data as ArrayBuffer);
        }
        let msg: any;
        try {
          msg = JSON.parse(raw);
        } catch {
          logger.warn('live: could not parse message', raw.slice(0, 120));
          return;
        }

        if (msg.setupComplete) {
          if (!settled) {
            onSettle();
            this.ready = true;
            logger.info('live: setup complete');
          }
          return;
        }

        if (msg.error) {
          const em = msg.error?.message ?? 'Live API error';
          const code = typeof msg.error?.code === 'number' ? (msg.error.code as number) : undefined;
          const status = typeof msg.error?.status === 'string' ? (msg.error.status as string) : undefined;
          logger.error('live: server error', msg.error);
          if (!settled) {
            onSettle();
            reject(new Error(em));
          } else {
            this.handlers.onError?.(em, { code, status });
          }
          return;
        }

        this.handleServerMessage(msg);
      };

      ws.onerror = () => {
        if (this.dead) return;
        logger.error('live: WebSocket network error');
        if (!settled) {
          onSettle();
          reject(new Error('Live WebSocket network error.'));
        }
      };

      ws.onclose = (ev) => {
        this.ready = false;
        if (this.dead) return;
        const reason = ev.reason || '(no reason)';
        logger.warn('live: WebSocket closed', { code: ev.code, reason });
        if (!settled) {
          onSettle();
          reject(new Error(`Live WebSocket closed during setup (code ${ev.code}): ${reason}`));
        } else {
          this.handlers.onState?.('closed');
        }
      };
    });
  }

  sendAudio(dataBase64: string): boolean {
    if (this.dead || !this.isReady) return false;
    // Backpressure: if the uplink is stalled, drop rather than grow the buffer.
    try {
      if ((this.ws?.bufferedAmount ?? 0) > 64 * 1024) return false;
      this.ws!.send(
        JSON.stringify({
          realtimeInput: {
            mediaChunks: [{ data: dataBase64, mimeType: 'audio/pcm;rate=16000' }],
          },
        }),
      );
      return true;
    } catch (error) {
      logger.error('live: failed to send audio chunk', error);
      return false;
    }
  }

  close(): void {
    this.dead = true;
    this.ready = false;
    // Settle a pending setup immediately instead of letting the caller hang
    // for up to the 15s timeout.
    if (this.setupTimer) {
      clearTimeout(this.setupTimer);
      this.setupTimer = null;
    }
    this.rejectSetup?.(new Error('Live session closed during setup.'));
    this.rejectSetup = null;
    try {
      this.ws?.close();
    } catch {
      /* ignore */
    }
    this.ws = null;
  }

  private handleServerMessage(msg: any): void {
    const sc = msg.serverContent;
    if (!sc) return;

    if (sc.interrupted) {
      this.handlers.onInterrupted?.();
    }
    if (sc.turnComplete) {
      this.handlers.onTurnComplete?.();
    }

    if (sc.inputTranscription?.text) {
      this.handlers.onInputTranscript?.(sc.inputTranscription.text, sc.inputTranscription.languageCode);
    }
    if (sc.outputTranscription?.text) {
      this.handlers.onOutputTranscript?.(sc.outputTranscription.text, sc.outputTranscription.languageCode);
    }

    const parts = sc.modelTurn?.parts;
    if (Array.isArray(parts)) {
      for (const part of parts) {
        if (part.inlineData?.data) {
          const audio = base64ToInt16(part.inlineData.data);
          if (audio && audio.length > 0) {
            this.handlers.onAudio?.(audio);
          }
        }
      }
    }
  }
}

export function base64ToInt16(b64: string): Int16Array {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  const out = new Int16Array(bytes.byteLength / 2);
  for (let i = 0; i < out.length; i++) {
    out[i] = bytes[i * 2] | (bytes[i * 2 + 1] << 8);
  }
  return out;
}