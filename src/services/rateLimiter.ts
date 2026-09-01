import { describeError } from './logger';

export class RateLimiter {
  readonly perMinute: number;
  private slots: number[] = [];

  constructor(perMinute: number) {
    this.perMinute = perMinute;
  }

  async waitForSlot(): Promise<void> {
    const now = Date.now();
    this.slots = this.slots.filter((t) => now - t < 60_000);
    if (this.perMinute <= 0) return;
    if (this.slots.length >= this.perMinute) {
      const oldest = this.slots[0];
      const waitMs = 60_000 - (now - oldest) + 200;
      await sleep(waitMs);
    }
    this.slots.push(Date.now());
  }
}

export function parseRetryDelay(message: string): number | null {
  const m = message.match(/retry\s+in\s+([\d.]+)\s*s/i);
  if (m) return parseFloat(m[1]);
  const status = message.match(/HTTP\s+429/);
  if (status) return 30;
  return null;
}

export async function withRetry<T>(
  fn: () => Promise<T>,
  context: string,
  maxRetries: number,
  onRetry: (message: string, delayMs: number, attempt: number, max: number) => void,
): Promise<T> {
  for (let attempt = 1; ; attempt++) {
    try {
      return await fn();
    } catch (error) {
      const message = describeError(error);
      const delay = parseRetryDelay(message);
      if (delay != null && attempt <= maxRetries) {
        const waitMs = delay * 1000 + 1000;
        onRetry(message, waitMs, attempt, maxRetries);
        await sleep(waitMs);
        continue;
      }
      throw error;
    }
  }
}

export function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}