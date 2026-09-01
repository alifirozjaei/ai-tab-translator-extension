import { useCallback, useEffect, useState } from 'react';
import { clearSegments, getSegments, getSettings, hasApiKey, saveSettings } from '../services/settings';
import { LANGUAGES } from '../services/languages';
import { buildSrt, buildVtt } from '../services/export';
import { logger } from '../services/logger';
import type { AppSettings, CaptureStatus, TranslationMode } from '../types';

const STATUS_META: Record<string, { label: string; className: string }> = {
  idle: { label: 'Idle', className: 'bg-slate-700 text-slate-200' },
  starting: { label: 'Starting', className: 'bg-amber-500/20 text-amber-300' },
  active: { label: 'Active', className: 'bg-emerald-500/20 text-emerald-300' },
  error: { label: 'Error', className: 'bg-red-500/20 text-red-300' },
};

const MODES: Array<{ value: TranslationMode; label: string; hint: string }> = [
  { value: 'subtitles', label: 'Subtitles only', hint: 'Show translated text on the page' },
  { value: 'voice', label: 'Translated voice', hint: 'Speak the translation (mute original)' },
  { value: 'both', label: 'Voice + subtitles', hint: 'Dubbed voice with live subtitles' },
];

export default function App() {
  const [settings, setSettings] = useState<AppSettings | null>(null);
  const [status, setStatus] = useState<CaptureStatus>({ state: 'idle', segments: 0 });
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);

  const refreshStatus = useCallback(async () => {
    try {
      const res = await chrome.runtime.sendMessage({ type: 'GET_STATUS' });
      if (res && typeof res === 'object') setStatus(res as CaptureStatus);
    } catch {
      /* service worker not ready */
    }
  }, []);

  useEffect(() => {
    getSettings().then(setSettings);
    refreshStatus();
    const timer = setInterval(refreshStatus, 1000);
    return () => clearInterval(timer);
  }, [refreshStatus]);

  const update = (patch: Partial<AppSettings>) => {
    setSettings((s) => (s ? { ...s, ...patch } : s));
  };

  const start = async () => {
    if (!settings) return;
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      await saveSettings({
        targetLang: settings.targetLang,
        mode: settings.mode,
        muteOriginal: settings.muteOriginal,
      });
      const fresh = await getSettings();
      const res = await chrome.runtime.sendMessage({ type: 'START', settings: fresh });
      if (!res?.ok) {
        setError(res?.error ?? 'Failed to start.');
        logger.error('start failed:', res?.error);
      }
    } catch (e) {
      logger.error('start threw:', e);
      setError(String(e));
    } finally {
      setBusy(false);
      refreshStatus();
    }
  };

  const stop = async () => {
    setBusy(true);
    setError(null);
    try {
      await chrome.runtime.sendMessage({ type: 'STOP' });
    } catch (e) {
      logger.error('stop threw:', e);
      setError(String(e));
    } finally {
      setBusy(false);
      refreshStatus();
    }
  };

  const exportSubtitles = async (format: 'srt' | 'vtt') => {
    setError(null);
    const segments = await getSegments();
    const content = format === 'srt' ? buildSrt(segments) : buildVtt(segments);
    if (!content.trim()) {
      setNotice('No final subtitles recorded yet. Start a session and speak first.');
      return;
    }
    const blob = new Blob([content], { type: 'text/plain;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `subtitles.${format}`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  };

  const clearTranscript = async () => {
    await clearSegments();
    refreshStatus();
  };

  if (!settings) {
    return <div className="w-80 p-4 text-sm text-slate-400">Loading…</div>;
  }

  const keyConfigured = hasApiKey(settings);
  const active = status.state === 'active' || status.state === 'starting';
  const meta = STATUS_META[status.state] ?? STATUS_META.idle;

  return (
    <div className="w-80 bg-slate-950 text-slate-100">
      <div className="flex items-center justify-between border-b border-slate-800 px-4 py-3">
        <div className="flex items-center gap-2">
          <span className="text-lg">🌐</span>
          <h1 className="text-sm font-semibold">AI Tab Translator</h1>
        </div>
        <span className={`rounded-full px-2 py-0.5 text-[11px] font-medium ${meta.className}`}>
          {meta.label}
        </span>
      </div>

      <div className="space-y-4 p-4">
        <div className="flex items-center justify-between rounded-lg border border-slate-800 bg-slate-900 px-3 py-2">
          <div>
            <div className="text-[11px] text-slate-400">API status</div>
            <div className={`text-xs font-medium ${keyConfigured ? 'text-emerald-400' : 'text-red-400'}`}>
              {keyConfigured ? 'Gemini key connected' : 'Missing API key'}
            </div>
          </div>
          <button
            onClick={() => chrome.runtime.openOptionsPage()}
            className="rounded-md bg-slate-800 px-2.5 py-1.5 text-xs text-slate-200 hover:bg-slate-700"
          >
            Settings
          </button>
        </div>

        <div>
          <label className="mb-1 block text-[11px] font-medium text-slate-400">Target language</label>
          <select
            value={settings.targetLang}
            onChange={(e) => update({ targetLang: e.target.value })}
            className="w-full rounded-lg border border-slate-800 bg-slate-900 px-3 py-2 text-sm outline-none focus:border-indigo-500"
          >
            {LANGUAGES.map((lang) => (
              <option key={lang.code} value={lang.code}>
                {lang.name}
              </option>
            ))}
          </select>
        </div>

        <div>
          <label className="mb-1 block text-[11px] font-medium text-slate-400">Mode</label>
          <div className="space-y-1.5">
            {MODES.map((m) => {
              const selected = settings.mode === m.value;
              return (
                <label
                  key={m.value}
                  className={`flex cursor-pointer items-start gap-2.5 rounded-lg border px-3 py-2.5 transition-colors ${
                    selected
                      ? 'border-indigo-500 bg-indigo-950/60'
                      : 'border-slate-800 bg-slate-900 hover:bg-slate-800/50'
                  }`}
                >
                  <span
                    className={`mt-0.5 flex h-4 w-4 shrink-0 items-center justify-center rounded-full border-2 ${
                      selected ? 'border-indigo-400' : 'border-slate-600'
                    }`}
                  >
                    {selected && <span className="h-2 w-2 rounded-full bg-indigo-400" />}
                  </span>
                  <input
                    type="radio"
                    name="mode"
                    value={m.value}
                    checked={selected}
                    onChange={() => update({ mode: m.value })}
                    className="sr-only"
                  />
                  <div>
                    <div className={`text-sm ${selected ? 'font-semibold text-indigo-200' : 'text-slate-200'}`}>
                      {m.label}
                    </div>
                    <div className="text-[11px] text-slate-500">{m.hint}</div>
                  </div>
                </label>
              );
            })}
          </div>
        </div>

        <label className="flex cursor-pointer items-center gap-2 text-sm">
          <input
            type="checkbox"
            checked={settings.muteOriginal}
            onChange={(e) => update({ muteOriginal: e.target.checked })}
            className="accent-indigo-500"
          />
          Mute original tab audio (best-effort)
        </label>

        <div className="flex gap-2">
          {active ? (
            <button
              onClick={stop}
              disabled={busy}
              className="flex-1 rounded-lg bg-red-600 px-4 py-2.5 text-sm font-semibold text-white hover:bg-red-500 disabled:opacity-50"
            >
              Stop
            </button>
          ) : (
            <button
              onClick={start}
              disabled={busy || !keyConfigured}
              className="flex-1 rounded-lg bg-indigo-600 px-4 py-2.5 text-sm font-semibold text-white hover:bg-indigo-500 disabled:cursor-not-allowed disabled:opacity-50"
            >
              Start
            </button>
          )}
        </div>

        {error && (
          <div className="rounded-lg border border-red-700 bg-red-950/50 px-3 py-2.5 text-xs text-red-200">
            <div className="mb-0.5 font-semibold text-red-300">Error</div>
            {error}
          </div>
        )}
        {!error && status.state === 'error' && status.error && (
          <div className="rounded-lg border border-red-700 bg-red-950/50 px-3 py-2.5 text-xs text-red-200">
            <div className="mb-0.5 font-semibold text-red-300">Error</div>
            {status.error}
          </div>
        )}
        {notice && (
          <div className="rounded-lg border border-slate-700 bg-slate-900 px-3 py-2 text-xs text-slate-300">
            {notice}
          </div>
        )}

        <div className="border-t border-slate-800 pt-3">
          <div className="mb-2 flex items-center justify-between">
            <span className="text-[11px] font-medium text-slate-400">
              Transcript ({status.segments} lines)
            </span>
          </div>
          <div className="flex gap-2">
            <button
              onClick={() => exportSubtitles('srt')}
              className="flex-1 rounded-md border border-slate-700 px-2 py-1.5 text-xs text-slate-200 hover:bg-slate-800"
            >
              Export SRT
            </button>
            <button
              onClick={() => exportSubtitles('vtt')}
              className="flex-1 rounded-md border border-slate-700 px-2 py-1.5 text-xs text-slate-200 hover:bg-slate-800"
            >
              Export VTT
            </button>
            <button
              onClick={clearTranscript}
              className="rounded-md border border-slate-700 px-2 py-1.5 text-xs text-slate-400 hover:bg-slate-800"
              title="Clear recorded transcript"
            >
              Clear
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
