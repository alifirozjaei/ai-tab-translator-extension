/** Cross-browser WebExtensions surface. Firefox exposes both `browser` and
 * `chrome`; Chromium browsers expose `chrome` on versions supported here. */
export const browserApi = ((globalThis as any).browser ?? (globalThis as any).chrome) as typeof chrome;

export const isFirefox = /Firefox/i.test(globalThis.navigator?.userAgent ?? '');
export const hasOffscreen = Boolean(browserApi?.offscreen?.createDocument);
export const hasTabCapture = Boolean(browserApi?.tabCapture?.getMediaStreamId);
