import { useCallback, useEffect, useState } from 'react';
import { getSettings, saveSettings } from '../services/settings';
import { LANGUAGES } from '../services/languages';
import { logger } from '../services/logger';
import type { AppSettings, CaptureStatus } from '../types';

const inputClass = 'w-full rounded-md border border-slate-700 bg-slate-900 px-2.5 py-2 text-xs text-slate-100 outline-none focus:border-indigo-500';

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
  return (
    <main className="popup-shell w-[400px] max-w-full bg-[#0b0814] text-slate-100">
      <header className="flex items-center justify-between border-b border-white/[0.08] px-3.5 py-2.5">
        <div className="flex items-center gap-2.5">
          <div className="logo-mark" aria-hidden="true"><i /><i /><i /><b>↔</b></div>
          <div><h1 className="text-[15px] font-semibold tracking-[-0.01em]">LiveDub</h1><p className="mt-0.5 text-[11px] text-slate-500">AI Audio Translator</p></div>
        </div>
        <button onClick={() => reload(true)} aria-label="Reload settings and status" className="control-button flex h-7 items-center gap-1 rounded-md border border-white/[0.1] bg-white/[0.03] px-2 text-[10px] font-medium text-slate-300 transition hover:border-indigo-400/40 hover:bg-indigo-500/10 hover:text-white"><span className="text-sm">↻</span> Reload</button>
      </header>
      <div className="space-y-2.5 px-3.5 py-3">
        <section className="settings-section space-y-2.5" aria-labelledby="api-heading">
          <h2 id="api-heading" className="section-heading"><span className="section-icon">⌘</span> API Configuration</h2>
          <label className="field-label">Gemini API Key<div className="mt-1.5 flex gap-2"><input aria-label="Gemini API Key" className={inputClass} type={showKey ? 'text' : 'password'} value={settings.geminiApiKey} onChange={(e) => update({ geminiApiKey: e.target.value })} placeholder="AIza…" /><button onClick={() => setShowKey((v) => !v)} className="control-button shrink-0 rounded-lg border border-white/[0.1] bg-white/[0.03] px-3 text-[11px] font-medium text-slate-300 transition hover:bg-white/[0.08] hover:text-white">{showKey ? 'Hide' : 'Show'}</button></div><a className="api-link mt-1.5 inline-block" href="https://aistudio.google.com/apikey" target="_blank" rel="noreferrer">Get your Gemini API key ↗</a></label>
        </section>
        <section className="settings-section" aria-labelledby="language-heading"><h2 id="language-heading" className="section-heading"><span className="section-icon">◎</span> Target Language</h2><select aria-label="Target Language" className={`${inputClass} mt-1.5`} value={settings.targetLang} onChange={(e) => update({ targetLang: e.target.value })}>{LANGUAGES.map((l) => <option key={l.code} value={l.code}>{l.name}</option>)}</select></section>
        <section className="settings-section space-y-2.5" aria-labelledby="audio-heading"><h2 id="audio-heading" className="section-heading"><svg className="section-icon audio-icon" aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M11 5 6 9H3v6h3l5 4V5Z" /><path d="M15.5 8.5a5 5 0 0 1 0 7" /><path d="M18.5 5.5a9 9 0 0 1 0 13" /></svg> Audio Settings</h2><label className="field-label">Translated voice <span className="value-badge">{Math.round(settings.translatedVolume * 100)}%</span><input aria-label="Translated voice volume" className="volume-slider mt-1.5" type="range" min="0" max="1" step="0.05" value={settings.translatedVolume} onChange={(e) => update({ translatedVolume: Number(e.target.value) })} /></label><div className={`field-label ${settings.muteOriginal ? 'text-slate-500' : ''}`}><div>Original audio <span className="value-badge">{settings.muteOriginal ? 'Muted' : `${Math.round(settings.originalVolume * 100)}%`}</span></div><div className="audio-control-row mt-1.5"><input aria-label="Original audio volume" className="volume-slider" type="range" min="0" max="1" step="0.05" disabled={settings.muteOriginal} value={settings.originalVolume} onChange={(e) => update({ originalVolume: Number(e.target.value) })} /><label className="mute-checkbox" title="Mute original audio"><input type="checkbox" aria-label="Mute original audio" checked={settings.muteOriginal} onChange={(e) => update({ muteOriginal: e.target.checked })} /><span>Mute</span></label></div></div></section>
        <button onClick={toggle} disabled={busy || (!active && !keyConfigured)} className={`primary-button flex h-9 w-full items-center justify-center gap-2 rounded-lg text-[13px] font-semibold text-white transition disabled:cursor-not-allowed disabled:opacity-50 ${active ? 'bg-rose-600 hover:bg-rose-500' : 'bg-indigo-600 hover:bg-violet-600'}`}><span aria-hidden="true">{busy ? '◌' : active ? '■' : '▶'}</span>{busy ? 'Please wait…' : active ? 'Stop translation' : 'Start translation'}</button>
        <div className="popup-meta"><span className={`status-dot ${status.state === 'error' ? 'text-rose-400' : status.state === 'active' ? 'text-emerald-400' : 'text-slate-400'}`}><span className="mr-1">●</span>{status.state === 'active' ? 'Translating' : status.state === 'starting' ? 'Starting…' : status.state === 'error' ? 'Error' : 'Ready'}</span><span className="meta-divider" /><span>{status.segments} segments</span><span className="meta-divider" /><span className="local-note">● Stored locally</span></div>
        {error || status.error ? <p role="alert" className="rounded-lg border border-rose-500/25 bg-rose-500/[0.08] p-2.5 text-[11px] leading-4 text-rose-200">{error || status.error}</p> : null}
      </div>
    </main>
  );
}
