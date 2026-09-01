import { useEffect, useState } from 'react';
import { getSettings, saveSettings } from '../services/settings';
import { LANGUAGES } from '../services/languages';
import type { AppSettings, TranslationMode } from '../types';

const MODES: Array<{ value: TranslationMode; label: string }> = [
  { value: 'subtitles', label: 'Subtitles only' },
  { value: 'voice', label: 'Translated voice' },
  { value: 'both', label: 'Voice + subtitles' },
];

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="rounded-xl border border-slate-800 bg-slate-900 p-5">
      <h2 className="mb-4 text-sm font-semibold text-slate-200">{title}</h2>
      <div className="space-y-4">{children}</div>
    </section>
  );
}

function Field({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string;
  children: React.ReactNode;
}) {
  return (
    <div>
      <label className="mb-1 block text-xs font-medium text-slate-400">{label}</label>
      {children}
      {hint && <p className="mt-1 text-[11px] text-slate-500">{hint}</p>}
    </div>
  );
}

const inputClass =
  'w-full rounded-lg border border-slate-700 bg-slate-950 px-3 py-2 text-sm text-slate-100 outline-none focus:border-indigo-500';

export default function Settings() {
  const [settings, setSettings] = useState<AppSettings | null>(null);
  const [saved, setSaved] = useState<string | null>(null);
  const [showKey, setShowKey] = useState(false);

  useEffect(() => {
    getSettings().then(setSettings);
  }, []);

  const update = (patch: Partial<AppSettings>) => {
    setSettings((s) => (s ? { ...s, ...patch } : s));
  };
  const updateSubtitles = (patch: Partial<AppSettings['subtitles']>) => {
    setSettings((s) => (s ? { ...s, subtitles: { ...s.subtitles, ...patch } } : s));
  };

  const save = async () => {
    if (!settings) return;
    await saveSettings(settings);
    setSaved('Saved at ' + new Date().toLocaleTimeString());
    setTimeout(() => setSaved(null), 3000);
  };

  const removeKey = async () => {
    update({ geminiApiKey: '' });
    setSaved('API key removed (unsaved until you click Save).');
  };

  if (!settings) return <div className="p-8 text-sm text-slate-400">Loading…</div>;

  return (
    <div className="mx-auto max-w-2xl px-4 py-8">
      <header className="mb-6 flex items-center justify-between">
        <div>
          <h1 className="text-lg font-bold text-slate-100">Settings</h1>
          <p className="text-xs text-slate-500">Everything is stored only in chrome.storage.local. No data leaves your browser except direct requests to your own API key provider.</p>
        </div>
        <button
          onClick={save}
          className="rounded-lg bg-indigo-600 px-5 py-2 text-sm font-semibold text-white hover:bg-indigo-500"
        >
          Save
        </button>
      </header>

      {saved && (
        <div className="mb-4 rounded-lg border border-emerald-700 bg-emerald-950/40 px-3 py-2 text-xs text-emerald-300">
          {saved}
        </div>
      )}

      <div className="space-y-5">
        <Section title="AI provider">
          <Field
            label="Gemini API key"
            hint="Get one free at https://aistudio.google.com/apikey — enable the Gemini API for your Google Cloud project. Your key never leaves the browser."
          >
            <div className="flex gap-2">
              <input
                type={showKey ? 'text' : 'password'}
                value={settings.geminiApiKey}
                onChange={(e) => update({ geminiApiKey: e.target.value })}
                placeholder="AIza…"
                className={inputClass}
              />
              <button
                onClick={() => setShowKey((v) => !v)}
                className="shrink-0 rounded-lg border border-slate-700 px-3 text-xs text-slate-300 hover:bg-slate-800"
              >
                {showKey ? 'Hide' : 'Show'}
              </button>
              <button
                onClick={removeKey}
                className="shrink-0 rounded-lg border border-red-800 px-3 text-xs text-red-300 hover:bg-red-950/40"
              >
                Remove
              </button>
            </div>
          </Field>
        </Section>

        <Section title="Translation">
          <Field label="Target language">
            <select
              value={settings.targetLang}
              onChange={(e) => update({ targetLang: e.target.value })}
              className={inputClass}
            >
              {LANGUAGES.map((lang) => (
                <option key={lang.code} value={lang.code}>
                  {lang.name}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Mode">
            <div className="flex flex-wrap gap-2">
              {MODES.map((m) => (
                <label
                  key={m.value}
                  className="flex cursor-pointer items-center gap-2 rounded-lg border border-slate-700 bg-slate-950 px-3 py-2 text-sm"
                >
                  <input
                    type="radio"
                    name="mode"
                    checked={settings.mode === m.value}
                    onChange={() => update({ mode: m.value })}
                    className="accent-indigo-500"
                  />
                  {m.label}
                </label>
              ))}
            </div>
          </Field>
          <Field label="Original audio">
            <label className="flex cursor-pointer items-center gap-2 text-sm text-slate-300">
              <input
                type="checkbox"
                checked={settings.muteOriginal}
                onChange={(e) => update({ muteOriginal: e.target.checked })}
                className="accent-indigo-500"
              />
              Mute the original tab audio while capturing
            </label>
          </Field>
          <Field label={`Original background volume: ${Math.round(settings.originalVolume * 100)}%`}
            hint="In voice/both modes the original audio plays quietly in the background under the translated voice."
          >
            <input
              type="range"
              min={0}
              max={0.5}
              step={0.05}
              value={settings.originalVolume}
              onChange={(e) => update({ originalVolume: Number(e.target.value) })}
              className="w-full accent-indigo-500"
            />
          </Field>
        </Section>

        <Section title="Subtitle appearance">
          <Field label={`Font size: ${settings.subtitles.fontSize}px`}>
            <input
              type="range"
              min={16}
              max={56}
              value={settings.subtitles.fontSize}
              onChange={(e) => updateSubtitles({ fontSize: Number(e.target.value) })}
              className="w-full accent-indigo-500"
            />
          </Field>
          <Field label="Position">
            <select
              value={settings.subtitles.position}
              onChange={(e) => updateSubtitles({ position: e.target.value as 'top' | 'bottom' })}
              className={inputClass}
            >
              <option value="bottom">Bottom</option>
              <option value="top">Top</option>
            </select>
          </Field>
          <Field label={`Background opacity: ${Math.round(settings.subtitles.bgOpacity * 100)}%`}>
            <input
              type="range"
              min={0}
              max={1}
              step={0.05}
              value={settings.subtitles.bgOpacity}
              onChange={(e) => updateSubtitles({ bgOpacity: Number(e.target.value) })}
              className="w-full accent-indigo-500"
            />
          </Field>
          <label className="flex cursor-pointer items-center gap-2 text-sm text-slate-300">
            <input
              type="checkbox"
              checked={settings.subtitles.showOriginal}
              onChange={(e) => updateSubtitles({ showOriginal: e.target.checked })}
              className="accent-indigo-500"
            />
            Show original text under the translation
          </label>
          <label className="flex cursor-pointer items-center gap-2 text-sm text-slate-300">
            <input
              type="checkbox"
              checked={settings.subtitles.originalFirst}
              onChange={(e) => updateSubtitles({ originalFirst: e.target.checked })}
              className="accent-indigo-500"
            />
            Show original text above the translation
          </label>
        </Section>

        <Section title="Advanced">
          <Field
            label="Speech recognition model"
            hint="gemini-3.5-transcribe auto-detects 85+ languages (incl. Farsi). The live streaming variant (gemini-3.5-transcribe-live) is a future upgrade."
          >
            <input
              type="text"
              value={settings.sttModel}
              onChange={(e) => update({ sttModel: e.target.value })}
              className={inputClass}
            />
          </Field>
          <Field
            label="Translation model"
            hint="gemini-2.5-flash gives the best multilingual translation quality at low latency."
          >
            <input
              type="text"
              value={settings.translationModel}
              onChange={(e) => update({ translationModel: e.target.value })}
              className={inputClass}
            />
          </Field>
          <div className="grid grid-cols-3 gap-3">
            <Field label={`Interim every ${settings.interimIntervalMs}ms`} hint="Live subtitle cadence">
              <input
                type="range"
                min={1500}
                max={8000}
                step={250}
                value={settings.interimIntervalMs}
                onChange={(e) => update({ interimIntervalMs: Number(e.target.value) })}
                className="w-full accent-indigo-500"
              />
            </Field>
            <Field label={`Silence ${settings.silenceThresholdMs}ms`} hint="Pause that ends a sentence">
              <input
                type="range"
                min={300}
                max={2000}
                step={50}
                value={settings.silenceThresholdMs}
                onChange={(e) => update({ silenceThresholdMs: Number(e.target.value) })}
                className="w-full accent-indigo-500"
              />
            </Field>
            <Field label={`Max ${Math.round(settings.maxSegmentMs / 1000)}s`} hint="Longest speech chunk">
              <input
                type="range"
                min={5000}
                max={30000}
                step={1000}
                value={settings.maxSegmentMs}
                onChange={(e) => update({ maxSegmentMs: Number(e.target.value) })}
                className="w-full accent-indigo-500"
              />
            </Field>
          </div>
        </Section>
      </div>

      <div className="mt-6 flex justify-end gap-2">
        <button
          onClick={save}
          className="rounded-lg bg-indigo-600 px-6 py-2 text-sm font-semibold text-white hover:bg-indigo-500"
        >
          Save all
        </button>
      </div>
    </div>
  );
}
