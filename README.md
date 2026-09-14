# AI Tab Translator

A Chrome extension that provides **real-time AI voice translation (dubbing)** for
audio/video playing in a tab. The original speech is dubbed into your chosen
language, with a configurable playback delay so the translated voice trails the
original by the amount you set.

It runs **entirely in your browser**. There is no backend, no accounts, no
tracking, and no cloud storage. All AI requests go directly from your browser
to Google Gemini using **your own API key**.

> ⚠️ **Personal use only.** No payments, subscriptions, analytics, accounts, or
> SaaS features are included or planned.

---

## Features

- **Live voice dubbing** — tab audio is streamed to the Gemini **Live API**
  (`gemini-3.5-live-translate-preview`) over WebSocket; the dubbed voice is
  played as it is generated. No intermediate text needed for the voice track.
- **Configurable playback delay** — 0–10 s slider (default 5 s). The dubbed
  voice starts this long after the original audio, for scripted/overdub-style
  listening.
- **Low-bandwidth mode (8 kHz)** — halves the upstream audio sent to the API
  for weak/slow networks (translation quality drops slightly).
- **Keeps translating the source tab** — switching to another tab no longer
  stops the dub; the captured tab keeps translating until you press Stop.
- **Audio controls** — separate translated/original volume and mute-original
  toggle.
- **Subtitles mode (legacy)** — the fallback REST pipeline (VAD → STT →
  translation → `speechSynthesis`) is still available for profiles that stored
  `liveTranslateEnabled: false`.
- **Settings** — API key, target language, models, and advanced tuning, stored
  locally.

---

## Architecture

```
Browser tab audio
      │
      ▼
Offscreen document (audio engine)
      │  chrome.tabCapture → AudioWorklet (16 kHz PCM, 100 ms chunks)
      ▼
Gemini Live API (WebSocket)  ──►  dubbed voice (24 kHz PCM)
      │                              │
      │                              ▼
      │                    Playback worklet (delay line + ring buffer)
      │                              │
      │                              ▼
      │                      Speakers (original audio mix)
      ▼
transcriptions (optional) → stored locally
```

- **Service worker** (`src/background/service-worker.ts`) — MV3 orchestrator:
  start/stop, session state persisted to `storage.session`, keep-alive, and a
  watchdog that recreates the offscreen document if Chrome terminates it.
- **Offscreen audio engine** (`src/offscreen/main.ts`) — capture, WebSocket
  session, reconnect with exponential backoff, and a watchdog that resumes a
  suspended `AudioContext` and re-establishes the live session on network
  blips.
- **Audio worklets** (`src/audio/live-processors.ts`) — `pcm-stream` (capture +
  optional 8 kHz downsampling) and `playback` (delay line + ring buffer with a
  160 ms fade on interruption).

### Browser targets

- **Chrome / Edge (Manifest V3)** — supported; requires Chrome 116+.
- **Firefox** — a `manifest.firefox.json` exists but the current build is
  **not functional** (the MV3 ESM bundle is not loadable as an MV2 background
  script). Treat Firefox as unsupported until that path is reworked.

---

## Installation

### Prerequisites

- Node.js 18+ and npm.
- Google Chrome 116+.

### 1. Install dependencies

```bash
npm install
```

### 2. Build

```bash
npm run build:chrome
```

Output goes to `release/chrome/` plus `release/ai-tab-translator-chrome-v0.1.0.zip`.

Other targets: `npm run build:edge`, `npm run build:firefox`, `npm run build:all`.

### 3. Load the extension in Chrome

1. Open `chrome://extensions`.
2. Enable **Developer mode** (top-right toggle).
3. Click **Load unpacked** and select the **`release/chrome`** folder.
4. Pin the **AI Tab Translator** icon from the extensions menu.

> Rebuild (`npm run build:chrome`) and click the **reload** ↻ on the extension
> card after any code change.

---

## API Key Setup

The extension uses the **Google Gemini API**. Requests go directly from your
browser to Google using your key — it is never sent anywhere else.

1. Go to <https://aistudio.google.com/apikey> and create a key (starts with
   `AIza...`).
2. Make sure the **Gemini API** is enabled for your Google Cloud project.
3. Open the extension popup, paste the key into **API Configuration**, and
   configure your **Target language**.

Models:

- **Live dubbing:** `gemini-3.5-live-translate-preview` (Live API, voice → voice).
- **Subtitles (REST) mode:** STT `gemini-3.5-transcribe` + translation
  `gemini-2.5-flash`. Both editable under **Advanced** in the Settings page
  (`chrome-extension://…/settings/index.html`, or right-click the icon).

---

## How to use

1. Open any website with audio/video (e.g. a YouTube video) **in the active tab**.
2. Click the **AI Tab Translator** extension icon.
3. Set **Target language**, choose the **Playback delay** (e.g. 5 s).
4. Toggle **Low bandwidth (8 kHz)** only if your network is slow.
5. Click **Start**. The original keeps playing; after the delay, the dubbed
   voice joins it. The popup shows the session as **Translating** with a
   segment counter.
6. Click **Stop** when done. Switching tabs does **not** stop the dub — the
   original tab keeps translating until you stop it.

> **Important:** capture must be started from the popup on the tab you want to
> dub. `chrome.tabCapture` follows active-tab rules.

---

## Notes & limitations

- **Latency:** even with the delay set to *Off*, the Live API adds ~1–3 s of
  its own processing (turn detection + synthesis). The delay setting is added
  **on top** of that.
- **Mute original is the default** — with `muteOriginal` on, the delay only
  adds latency to the single audible track; disable mute if you want the
  original plus the delayed dub.
- **8 kHz mode is opt-in** and not guaranteed by the Gemini Live API — if a
  model rejects it, a clear error appears; turn the toggle off.
- **Network resilience:** transient failures (blips, quota, 5xx) do not stop
  the session — the engine reconnects with backoff. Only fatal errors (bad API
  key, permission denied) stop it, and the UI reflects that.
- On very weak/lossy networks, the dubbed voice may have audible gaps; lowering
  the delay and enabling 8 kHz mode helps.

---

## Troubleshooting

| Symptom | Likely cause / fix |
|---|---|
| “Translating” but no audio after a network drop | Automatic; reconnects within seconds. Watch the popup for a status change. |
| Switched tabs and the dub stopped | Old builds stopped; current builds re-capture the original tab automatically. If it still stops repeatedly, the tab may have been discarded — press **Stop** then **Start** again. |
| Error appears on Start | Wrong API key, quota, or model rejection — fix the key or check the message. |
| Content pages show “cannot be captured” | `chrome://` pages can't be captured; use a normal website. |

---

## Development

- **Typecheck:** `npm run typecheck`
- **Build (Chrome):** `npm run build:chrome`
- **Structure (`src/`):**
  - `background/` — MV3 service worker (state persistence, watchdogs, messaging)
  - `offscreen/` — audio engine page (capture, Live WebSocket, REST pipeline)
  - `audio/` — AudioWorklet processors (capture, playback + delay line)
  - `popup/`, `settings/` — React pages
  - `content/` — TTS playback listener for Subtitles mode
  - `services/` — Gemini REST client, Live session, settings, languages, logging
  - `platform/browser.ts` — cross-browser `chrome`/`browser` surface

---

## Publishing a release

Releases are automated with GitHub Actions (`.github/workflows/release.yml`).
Push a semver tag matching `v*`, and the pipeline builds and publishes
everything:

```bash
git tag v1.0.0
git push origin v1.0.0
```

The workflow:

1. Checks out the tag and installs dependencies from the lockfile (`npm ci`).
2. Syncs the extension version to the tag — `package.json`, `package-lock.json`
   and all three manifests get the tag version (without the `v`) on the CI
   workspace, so ZIP names and the in-browser version match the Release.
3. Runs `npm run typecheck`, then `npm run build:all`.
4. Fails (before any Release is created) if any expected ZIP is missing.
5. Publishes a GitHub Release marked **latest**, with auto-generated release
   notes and the Chrome, Edge, and Firefox ZIPs attached:
   - `release/ai-tab-translator-chrome-v<VERSION>.zip`
   - `release/ai-tab-translator-edge-v<VERSION>.zip`
   - `release/ai-tab-translator-firefox-v<VERSION>.zip`

New versions are the same flow:

```bash
git tag v1.1.0
git push origin v1.1.0
```

> Do not force-push or delete a tag after it has been released — Release
> records are immutable and rebuilding under the same tag creates confusion.

---

## Security & privacy

- Permissions are limited to `tabs`, `activeTab`, `tabCapture`, `storage`,
  `scripting`, `offscreen`; host permission covers only
  `generativelanguage.googleapis.com`.
- The API key is stored **only** in `chrome.storage.local` (plain text, MV3
  limitation) and is sent only to Google. Note: the Live WebSocket carries the
  key as a `?key=` query parameter, so it is visible in DevTools network
  inspection — avoid sharing DevTools traces.
- No remote code execution, no tracking, no hidden network calls.

---

## Roadmap (short)

- [x] Live voice dubbing via Gemini Live API
- [x] Configurable playback delay
- [x] Low-bandwidth uplink mode
- [x] Tab-switch resilience + self-healing lifecycle
- [ ] Verify 8 kHz acceptance across Gemini models
- [ ] Rework the Firefox build or drop the target