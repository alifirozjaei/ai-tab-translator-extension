import { logger } from './logger';

export interface LiveTranslateHandlers {
  onAudio?: (pcm24k: Int16Array) => void;
  onInputTranscript?: (text: string, languageCode?: string) => void;
  onOutputTranscript?: (text: string, languageCode?: string) => void;
  onTurnComplete?: () => void;
  onInterrupted?: () => void;
  onState?: (state: string) => void;
  onError?: (message: string) => void;
}

const WS_URL =
  'wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent';

export class LiveTranslateSession {
  private ws: WebSocket | null = null;
  private ready = false;

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
    return new Promise((resolve, reject) => {
      const url = `${WS_URL}?key=${encodeURIComponent(this.apiKey)}`;
      let settled = false;
      const ws = new WebSocket(url);
      this.ws = ws;
      ws.binaryType = 'arraybuffer';

      const timeout = setTimeout(() => {
        if (!settled) {
          settled = true;
          try {
            ws.close();
          } catch {
            /* ignore */
          }
          reject(new Error('Live session setup timed out after 15s.'));
        }
      }, 15000);

      ws.onopen = () => {
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
            settled = true;
            clearTimeout(timeout);
            this.ready = true;
            logger.info('live: setup complete');
          }
          return;
        }

        if (msg.error) {
          const em = msg.error?.message ?? 'Live API error';
          logger.error('live: server error', msg.error);
          if (!settled) {
            settled = true;
            clearTimeout(timeout);
            reject(new Error(em));
          } else {
            this.handlers.onError?.(em);
          }
          return;
        }

        this.handleServerMessage(msg);
      };

      ws.onerror = () => {
        logger.error('live: WebSocket network error');
        if (!settled) {
          settled = true;
          clearTimeout(timeout);
          reject(new Error('Live WebSocket network error.'));
        }
      };

      ws.onclose = (ev) => {
        this.ready = false;
        const reason = ev.reason || '(no reason)';
        logger.warn('live: WebSocket closed', { code: ev.code, reason });
        if (!settled) {
          settled = true;
          clearTimeout(timeout);
          reject(new Error(`Live WebSocket closed during setup (code ${ev.code}): ${reason}`));
        } else {
          this.handlers.onState?.('closed');
        }
      };
    });
  }

  sendAudio(dataBase64: string): boolean {
    if (!this.isReady) return false;
    try {
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
    this.ready = false;
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