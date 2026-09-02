import { useCallback, useEffect, useState } from 'react';
import { getSettings, saveSettings } from '../services/settings';
import { LANGUAGES } from '../services/languages';
import { logger } from '../services/logger';
import type { AppSettings, CaptureStatus } from '../types';

const inputClass = 'w-full rounded-md border border-slate-700 bg-slate-900 px-2.5 py-2 text-xs text-slate-100 outline-none focus:border-indigo-500';
const MODELS = ['gemini-3.5-live-translate-preview', 'gemini-2.5-flash-native-audio-preview-09-2025'];

export default function App() {
  const [settings, setSettings] = useState<AppSettings | null>(null);
  const [status, setStatus] = useState<CaptureStatus>({ state: 'idle', segments: 0 });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [showKey, setShowKey] = useState(false);
  const reload = useCallback(async (syncSettings = false) => {
    if (syncSettings) setSettings(await getSettings());
    try { const result = await chrome.runtime.sendMessage({ type: 'GET_STATUS' }); if (result) setStatus(result); } catch { /* worker restarting */ }
  }, []);
  useEffect(() => { reload(true); const timer = setInterval(() => reload(), 1500); return () => clearInterval(timer); }, [reload]);
  const update = (patch: Partial<AppSettings>) => setSettings((s) => {
    if (!s) return s;
    const next = { ...s, ...patch };
    void saveSettings(next);
    void chrome.runtime.sendMessage({ type: 'UPDATE_SETTINGS', settings: next }).catch(() => {});
    return next;
  });
  const active = status.state === 'active' || status.state === 'starting';
  const keyConfigured = !!settings?.geminiApiKey.trim();
  const toggle = async () => {
    if (!settings) return;
    setBusy(true); setError('');
    try { const fresh = await saveSettings(settings); const result = await chrome.runtime.sendMessage({ type: active ? 'STOP' : 'START', settings: fresh }); if (!result?.ok) setError(result?.error ?? 'Operation failed.'); }
    catch (e) { logger.error('capture toggle failed', e); setError(String(e)); }
    finally { setBusy(false); await reload(true); }
  };
  if (!settings) return <div className="w-80 p-4 text-xs text-slate-400">Loading…</div>;
  return <main className="w-80 bg-slate-950 text-slate-100">
    <header className="flex items-center justify-between border-b border-slate-800 px-3.5 py-3"><div><h1 className="text-sm font-semibold">AI Tab Translator</h1><p className="text-[10px] text-slate-500">Translation audio only</p></div><button onClick={() => reload(true)} className="rounded-md border border-slate-700 px-2 py-1 text-[11px] text-slate-300 hover:bg-slate-800">↻ Reload</button></header>
    <div className="space-y-3.5 p-3.5">
      <section className="space-y-2 rounded-lg border border-slate-800 bg-slate-900/70 p-3"><label className="block text-[10px] font-medium uppercase tracking-wide text-slate-500">Gemini API key</label><div className="flex gap-1.5"><input className={inputClass} type={showKey ? 'text' : 'password'} value={settings.geminiApiKey} onChange={(e) => update({ geminiApiKey: e.target.value })} placeholder="AIza…" /><button onClick={() => setShowKey((v) => !v)} className="rounded-md border border-slate-700 px-2 text-[11px]">{showKey ? 'Hide' : 'Show'}</button></div><label className="block text-[10px] font-medium uppercase tracking-wide text-slate-500">Translation model<select className={`${inputClass} mt-1`} value={settings.liveTranslateModel} onChange={(e) => update({ liveTranslateModel: e.target.value, translationModel: e.target.value })}>{!MODELS.includes(settings.liveTranslateModel) && <option value={settings.liveTranslateModel}>{settings.liveTranslateModel}</option>}{MODELS.map((model) => <option key={model} value={model}>{model}</option>)}</select></label></section>
      <label className="block text-[10px] font-medium uppercase tracking-wide text-slate-500">Target language<select className={`${inputClass} mt-1.5`} value={settings.targetLang} onChange={(e) => update({ targetLang: e.target.value })}>{LANGUAGES.map((l) => <option key={l.code} value={l.code}>{l.name}</option>)}</select></label>
      <section className="space-y-3 rounded-lg border border-slate-800 bg-slate-900/70 p-3"><label className="block text-xs">Translated voice <span className="float-right text-slate-400">{Math.round(settings.translatedVolume * 100)}%</span><input className="mt-1.5 w-full accent-indigo-500" type="range" min="0" max="1" step="0.05" value={settings.translatedVolume} onChange={(e) => update({ translatedVolume: Number(e.target.value) })} /></label><label className="block text-xs">Original audio <span className="float-right text-slate-400">{settings.muteOriginal ? 'Muted' : `${Math.round(settings.originalVolume * 100)}%`}</span><input className="mt-1.5 w-full accent-indigo-500" type="range" min="0" max="1" step="0.05" disabled={settings.muteOriginal} value={settings.originalVolume} onChange={(e) => update({ originalVolume: Number(e.target.value) })} /></label><label className="flex items-center gap-2 text-xs"><input type="checkbox" className="accent-indigo-500" checked={settings.muteOriginal} onChange={(e) => update({ muteOriginal: e.target.checked })} /> Mute original audio</label></section>
      <button onClick={toggle} disabled={busy || (!active && !keyConfigured)} className={`w-full rounded-md px-3 py-2.5 text-sm font-semibold text-white disabled:cursor-not-allowed disabled:opacity-50 ${active ? 'bg-red-600 hover:bg-red-500' : 'bg-indigo-600 hover:bg-indigo-500'}`}>{busy ? 'Please wait…' : active ? 'Stop translation' : 'Start translation'}</button><div className="flex items-center justify-between text-[11px] text-slate-500"><span className={status.state === 'error' ? 'text-red-400' : status.state === 'active' ? 'text-emerald-400' : ''}>{status.state === 'active' ? 'Translating' : status.state === 'starting' ? 'Starting…' : status.state === 'error' ? 'Error' : 'Ready'}</span><span>{status.segments} segments</span></div>{error || status.error ? <p className="rounded-md border border-red-800 bg-red-950/50 p-2 text-[11px] text-red-200">{error || status.error}</p> : null}
    </div>
  </main>;
}
