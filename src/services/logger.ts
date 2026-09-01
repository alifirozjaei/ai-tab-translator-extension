const PREFIX = '[AI Tab Translator]';

const isDev: boolean = import.meta.env.DEV;

export function describeError(error: unknown): string {
  if (error instanceof Error) {
    return `${error.name}: ${error.message}`;
  }
  try {
    return JSON.stringify(error);
  } catch {
    return String(error);
  }
}

export const logger = {
  debug: (...args: unknown[]) => {
    if (isDev) console.debug(PREFIX, ...args);
  },
  info: (...args: unknown[]) => console.info(PREFIX, ...args),
  warn: (...args: unknown[]) => console.warn(PREFIX, ...args),
  error: (...args: unknown[]) => console.error(PREFIX, ...args),
};