import { useCallback, useEffect, useState } from 'react';
import { getSettings, saveSettings } from '../services/settings';
import { LANGUAGES } from '../services/languages';
import { logger } from '../services/logger';
import type { AppSettings, CaptureStatus } from '../types';
import { browserApi } from '../platform/browser';

export default function App() {
  const [settings, setSettings] = useState<AppSettings | null>(null);
  const [status, setStatus] = useState<CaptureStatus>({ state: 'idle', segments: 0 });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [showKey, setShowKey] = useState(false);

  const reload = useCallback(async (syncSettings = false) => {
    if (syncSettings) setSettings(await getSettings());
    try {
      const result = await browserApi.runtime.sendMessage({ type: 'GET_STATUS' });
      if (result) setStatus(result);
    } catch { /* worker restarting */ }
  }, []);

  useEffect(() => {
    reload(true);
    const timer = setInterval(() => reload(), 1500);
    return () => clearInterval(timer);
  }, [reload]);

  const update = (patch: Partial<AppSettings>) => setSettings((s) => {
    if (!s) return s;
    const next = { ...s, ...patch };
    void saveSettings(next);
    void browserApi.runtime.sendMessage({ type: 'UPDATE_SETTINGS', settings: next }).catch(() => {});
    return next;
  });

  const active = status.state === 'active' || status.state === 'starting';
  const keyConfigured = !!settings?.geminiApiKey.trim();

  const toggle = async () => {
    if (!settings) return;
    setBusy(true); setError('');
    try {
      const fresh = await saveSettings(settings);
      const result = await browserApi.runtime.sendMessage({ type: active ? 'STOP' : 'START', settings: fresh });
      if (!result?.ok) setError(result?.error ?? 'Operation failed.');
    } catch (e) {
      logger.error('capture toggle failed', e);
      setError(String(e));
    } finally {
      setBusy(false);
      await reload(true);
    }
  };

  if (!settings) {
    return (
      <div className="popup-shell">
        <div className="loading-state">Loading...</div>
      </div>
    );
  }

  return (
    <main className="popup-shell">
      {/* Header */}
      <header className="header">
        <div className="header-left">
          <div className="logo-mark" aria-hidden="true">
            <svg viewBox="0 0 28 28" fill="none" xmlns="http://www.w3.org/2000/svg">
              <circle cx="14" cy="14" r="13" stroke="url(#logo-grad)" strokeWidth="2"/>
              <path d="M10 18V10L18 14L10 18Z" fill="url(#logo-grad)"/>
              <defs>
                <linearGradient id="logo-grad" x1="0" y1="0" x2="28" y2="28">
                  <stop stopColor="#2dd4bf"/>
                  <stop offset="1" stopColor="#06b6d4"/>
                </linearGradient>
              </defs>
            </svg>
          </div>
          <div className="brand">
            <h1 className="brand-name">AI Tab Translator</h1>
            <p className="brand-sub">AI Audio Translator</p>
          </div>
        </div>
        <button
          onClick={() => reload(true)}
          aria-label="Reload settings and status"
          className="reload-btn"
        >
          <svg width="12" height="12" viewBox="0 0 12 12" fill="none">
            <path d="M10.5 6A4.5 4.5 0 1 1 6 1.5M10.5 1.5V4.5H7.5" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round"/>
          </svg>
        </button>
      </header>

      <div className="content">
        {/* API Key Section */}
        <section className="settings-card">
          <h2 className="card-heading">API Configuration</h2>
          <label className="field-group">
            <span className="field-label">Gemini API Key</span>
            <div className="input-row">
              <input
                aria-label="Gemini API Key"
                className="field-input"
                type={showKey ? 'text' : 'password'}
                value={settings.geminiApiKey}
                onChange={(e) => update({ geminiApiKey: e.target.value })}
                placeholder="AIza..."
              />
              <button
                onClick={() => setShowKey((v) => !v)}
                className="toggle-visibility-btn"
              >
                {showKey ? 'Hide' : 'Show'}
              </button>
            </div>
            <a
              className="field-link"
              href="https://aistudio.google.com/apikey"
              target="_blank"
              rel="noreferrer"
            >
              Get your Gemini API key ↗
            </a>
          </label>
        </section>

        {/* Language Selector */}
        <section className="settings-card">
          <h2 className="card-heading">Target Language</h2>
          <div className="language-row">
            <select
              aria-label="Target Language"
              className="language-select"
              value={settings.targetLang}
              onChange={(e) => update({ targetLang: e.target.value })}
            >
              {LANGUAGES.map((l) => (
                <option key={l.code} value={l.code}>{l.name}</option>
              ))}
            </select>
            <button
              onClick={toggle}
              disabled={busy || (!active && !keyConfigured)}
              className={`start-btn ${active ? 'active' : ''}`}
            >
              {busy ? '...' : active ? 'Stop' : 'Start'}
            </button>
          </div>
        </section>

        {/* Playback Delay */}
        <section className="settings-card">
          <h2 className="card-heading">Playback Delay</h2>
          <div className="volume-group">
            <div className="volume-header">
              <span className="field-label">Start dub after</span>
              <span className="volume-value">{(settings.playbackDelayMs / 1000).toFixed(1)}s</span>
            </div>
            <input
              aria-label="Playback delay in seconds"
              className="volume-slider"
              type="range"
              min="0"
              max="10000"
              step="500"
              value={settings.playbackDelayMs}
              onChange={(e) => update({ playbackDelayMs: Number(e.target.value) })}
            />
            <div className="delay-presets">
              {[0, 1000, 2000, 3000, 5000, 10000].map((ms) => (
                <button
                  key={ms}
                  type="button"
                  onClick={() => update({ playbackDelayMs: ms })}
                  className={`delay-chip ${settings.playbackDelayMs === ms ? 'active' : ''}`}
                >
                  {ms === 0 ? 'Off' : `${ms / 1000}s`}
                </button>
              ))}
            </div>
            <p className="delay-hint">The original audio plays first; the translated voice starts after this delay.</p>
          </div>
        </section>

        {/* Audio Settings */}
        <section className="settings-card">
          <h2 className="card-heading">Audio Settings</h2>

          {/* Translated Voice */}
          <div className="volume-group">
            <div className="volume-header">
              <span className="field-label">Translated voice</span>
              <span className="volume-value">{Math.round(settings.translatedVolume * 100)}%</span>
            </div>
            <input
              aria-label="Translated voice volume"
              className="volume-slider"
              type="range"
              min="0"
              max="1"
              step="0.05"
              value={settings.translatedVolume}
              onChange={(e) => update({ translatedVolume: Number(e.target.value) })}
            />
          </div>

          {/* Original Audio */}
          <div className="volume-group">
            <div className="volume-header">
              <span className="field-label">Original audio</span>
              <span className="volume-value">
                {settings.muteOriginal ? 'Muted' : `${Math.round(settings.originalVolume * 100)}%`}
              </span>
            </div>
            <div className="original-audio-row">
              <input
                aria-label="Original audio volume"
                className="volume-slider"
                type="range"
                min="0"
                max="1"
                step="0.05"
                disabled={settings.muteOriginal}
                value={settings.originalVolume}
                onChange={(e) => update({ originalVolume: Number(e.target.value) })}
              />
              <label className="mute-toggle">
                <input
                  type="checkbox"
                  aria-label="Mute original audio"
                  checked={settings.muteOriginal}
                  onChange={(e) => update({ muteOriginal: e.target.checked })}
                />
                <span className="toggle-slider"></span>
                <span className="mute-text">Mute</span>
              </label>
            </div>
          </div>

          {/* Low-bandwidth upstream */}
          <div className="volume-group">
            <div className="volume-header">
              <span className="field-label">Low bandwidth (8 kHz)</span>
              <span className="volume-value">{settings.lowQualityAudio ? 'On' : 'Off'}</span>
            </div>
            <div className="original-audio-row">
              <p className="delay-hint">
                Halves the audio sent to the API for weak networks. Translation quality drops; applies on next
                Start.
              </p>
              <label className="mute-toggle">
                <input
                  type="checkbox"
                  aria-label="Low bandwidth audio"
                  checked={settings.lowQualityAudio}
                  onChange={(e) => update({ lowQualityAudio: e.target.checked })}
                />
                <span className="toggle-slider"></span>
                <span className="mute-text">{settings.lowQualityAudio ? 'On' : 'Off'}</span>
              </label>
            </div>
          </div>
        </section>

        {/* Status Bar */}
        <footer className="status-bar">
          <span className={`status-indicator ${status.state === 'error' ? 'error' : status.state === 'active' ? 'active' : ''}`}>
            <span className="status-dot"></span>
            {status.state === 'active' ? 'Translating' : status.state === 'starting' ? 'Starting...' : status.state === 'error' ? 'Error' : 'Ready'}
          </span>
          <span className="status-divider"></span>
          <span>{status.segments} segments</span>
          <span className="status-divider"></span>
          <span className="local-badge">● Stored locally</span>
        </footer>

        {/* Error Display */}
        {(error || status.error) && (
          <div className="error-banner" role="alert">
            {error || status.error}
          </div>
        )}
      </div>
    </main>
  );
}
