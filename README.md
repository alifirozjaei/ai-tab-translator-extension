# LiveDub — AI Audio Translator

A browser extension that provides real-time AI voice translation for audio/video
playing in a tab.

It runs **entirely in your browser**. There is no backend, no accounts, no
tracking, and no cloud storage. All AI requests are sent directly from your
browser to the AI provider using **your own API key**.

> ⚠️ **Personal use only.** This is not a commercial product. No payments,
> subscriptions, usage limits, analytics, accounts, or SaaS features are
> included or planned.

---

## Features (MVP)

- **Tab audio capture** — captures the audio of the active tab via
  `chrome.tabCapture` + `AudioWorklet` (no microphone permission).
- **Speech recognition** — streaming speech-to-text with automatic language
  detection (via Google Gemini inline audio).
- **Translation** — translate each recognized sentence into your chosen target
  language (Gemini).
- **Voice dubbing** — reads the translated text aloud using the browser's
  built-in `speechSynthesis` engine.
- **Audio controls** — independently adjust translated/original audio and mute
  the original track.
- **Settings** — manage your API key and target language, stored locally.

---

## Architecture

```
Browser Tab Audio
     │
     ▼
Audio Capture Layer      (browser adapter → AudioWorklet VAD/segmentation)
     │
     ▼
Speech Recognition API  (Google Gemini inline audio → transcript)
     │
     ▼
Translation API         (Google Gemini text → target language)
     │
     ▼
Text-To-Speech          (browser speechSynthesis in the content script)
     │
     ▼
Audio Playback + Subtitle Overlay (React overlay injected into the page)
```

### Browser targets

The application code is shared. Browser-specific behavior is isolated in
`src/platform/browser.ts`, the browser manifests, and the capture branch:

- Chrome and Edge use Manifest V3, `tabCapture`, and `offscreen`.
- Firefox uses a persistent Manifest V2 background page and its audio/display
  capture fallback because Firefox does not support Chrome's MV3 service-worker
  and offscreen combination.

Firefox may show a browser capture picker when starting a session. This is a
browser platform limitation of tab-audio capture, not a separate translation
pipeline.

### Extension parts

| Part | Path | Role |
|------|------|------|
| Background | `src/background/service-worker.ts` | Orchestrates start/stop, capture lifecycle, relay. |
| Offscreen audio engine | `src/offscreen/main.ts` | Captures tab audio, runs VAD, calls STT + translation. |
| AudioWorklet | `src/audio/processor.ts` | 16 kHz downmix + voice-activity/silence segmentation. |
| Content script | `src/content/main.tsx` + `subtitle-overlay.tsx` | Injects the subtitle overlay and plays dubbed speech. |
| Popup | `src/popup/App.tsx` | Start/stop, language, mode, export controls. |
| Settings | `src/settings/Settings.tsx` | API key + preferences. |
| Services | `src/services/*` | Gemini client, STT, translation, TTS, SRT/VTT export. |
| Storage | `src/services/settings.ts` | `chrome.storage.local` read/write. |

---

## Installation

### Prerequisites

- Node.js 18+ and npm.
- Google Chrome 116+ (for `chrome.offscreen` and MV3).

### 1. Install dependencies

```bash
cd ai-tab-translator-extension
npm install
```

### 2. Build packages

```bash
npm run build:all
```

Output goes to `release/` with one unpacked directory and one zip per browser:

- `npm run build:chrome` — `release/chrome/` and `livedub-chrome-v*.zip`
- `npm run build:edge` — `release/edge/` and `livedub-edge-v*.zip`
- `npm run build:firefox` — `release/firefox/` and `livedub-firefox-v*.zip`
- `npm run build:all` — all three packages

### 3. Load the extension in Chrome

1. Open the extensions manager for your browser.
2. Enable **Developer mode** (top-right toggle).
3. Click **Load unpacked**.
4. Select the `dist/` folder.
5. Pin the **LiveDub** icon from the extensions menu.

> Rebuild (`npm run build`) and click the **reload** ↻ icon on the extension
> card after any code change.

---

## API Key Setup

The extension uses the **Google Gemini API**. Requests are made directly from
your browser to Google using your key — it is never sent anywhere else.

1. Go to <https://aistudio.google.com/apikey> and sign in with a Google account.
2. Click **Create API key** and copy the key (starts with `AIza...`).
3. Ensure the **Gemini API** is enabled for your Google Cloud project (the
   key creation flow usually does this for you; if not, enable it in Google
   Cloud Console → APIs & Services).
4. In the extension, click the **Settings** button (or open Options) and paste
   your key.
5. Click **Save all**.

The default models are:
- **Speech recognition:** `gemini-3.5-transcribe` (dedicated speech-to-text model — auto-detects 85+ languages incl. Farsi, low-latency, smart transcription).
- **Translation:** `gemini-2.5-flash` (good multilingual translation quality at low latency).

You can change them under **Advanced** in Settings. The streaming variant
`gemini-3.5-transcribe-live` (Live API over WebSocket) is the planned Phase 1/2
upgrade for sub-second, fully-streaming transcription.

### Cost note

Gemini Flash has a generous free tier. Transcription of short audio segments
consumes tokens based on audio duration. Check Google's Gemini pricing for
details — as a personal user this is usually negligible.

---

## How to use

1. Open any website with audio/video (e.g. a YouTube video) **in the active tab**.
2. Click the **AI Tab Translator** extension icon.
3. Pick your **Target language** and **Mode**.
4. Click **Start**.
5. The original tab audio is captured. Subtitles appear on the page and/or the
   translation is spoken aloud.
6. Click **Stop** when done, then **Export SRT / VTT** to download the session.

> **Important:** capture must be triggered from the extension's popup (click the
> icon) on the tab you want to capture. `chrome.tabCapture` follows
> `activeTab`-style rules.

---

## Notes & limitations (MVP)

- **Voice dubbing** uses the browser's built-in `speechSynthesis` voices, which
  vary per OS. Quality and available languages depend on installed system
  voices. This keeps everything offline and free; a future phase could route
  TTS through an AI API (ElevenLabs, Gemini, etc.).
- **Muting the original audio** uses `chrome.tabs.update(..., { muted: true })`,
  which is best-effort in some Chrome builds.
- Latency depends on Gemini round-trip time and segment length; expect roughly
  1.5–4 s for a short sentence.
- The MV3 service worker is stateless and can sleep; the heavy processing lives
  in the offscreen document, which keeps streaming state alive during a session.

---

## Development

- **Typecheck:** `npm run typecheck`
- **Build:** `npm run build`
- **Structure** (`src/`):
  - `background/` — service worker
  - `content/` — overlay + message handling (compiled as IIFE)
  - `popup/`, `settings/` — React pages
  - `offscreen/` — audio engine page
  - `audio/` — AudioWorklet + WAV encoder
  - `services/` — Gemini, STT, translation, TTS, export, languages, storage

### Roadmap

- **Phase 1 (done):** capture, Gemini STT, translation, subtitle overlay, popup/settings.
- **Phase 2 (in progress):** TTS + audio playback + synchronization.
- **Phase 3:** speaker detection and multiple voices.

---

## Security

- Permissions are limited to what is required: `tabs`, `activeTab`, `tabCapture`,
  `storage`, `scripting`, `offscreen`.
- The API key is stored **only** in `chrome.storage.local` and is never sent to
  any server other than the API provider you configure.
- No remote code execution. Everything is bundled locally.
- No tracking or hidden network calls.
