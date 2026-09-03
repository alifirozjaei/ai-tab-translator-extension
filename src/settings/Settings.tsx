import { useEffect, useState } from 'react';
import { getSettings, saveSettings } from '../services/settings';
import { LANGUAGES } from '../services/languages';
import type { AppSettings } from '../types';

export default function Settings() {
  const [settings, setSettings] = useState<AppSettings | null>(null);
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    getSettings().then(setSettings);
  }, []);

  if (!settings) {
    return <div className="settings-loading">Loading...</div>;
  }

  const update = (patch: Partial<AppSettings>) => setSettings({ ...settings, ...patch });

  const save = async () => {
    await saveSettings(settings);
    setSaved(true);
    setTimeout(() => setSaved(false), 2500);
  };

  return (
    <main className="settings-shell">
      {/* Header */}
      <header className="settings-header">
        <div>
          <h1 className="settings-title">AI Tab Translator</h1>
          <p className="settings-subtitle">Audio translation settings</p>
        </div>
        <button onClick={save} className="save-btn">
          Save
        </button>
      </header>

      {/* Success Message */}
      {saved && (
        <div className="success-banner">
          Settings saved.
        </div>
      )}

      {/* AI Provider Section */}
      <section className="settings-card">
        <h2 className="card-heading">AI Provider</h2>

        <label className="field-group">
          <span className="field-label">Gemini API key</span>
          <input
            className="field-input"
            type="password"
            value={settings.geminiApiKey}
            onChange={(e) => update({ geminiApiKey: e.target.value })}
            placeholder="AIza..."
          />
          <a
            className="field-link"
            href="https://aistudio.google.com/apikey"
            target="_blank"
            rel="noreferrer"
          >
            Get your Gemini API key ↗
          </a>
        </label>

        <label className="field-group">
          <span className="field-label">Target language</span>
          <select
            className="field-select"
            value={settings.targetLang}
            onChange={(e) => update({ targetLang: e.target.value })}
          >
            {LANGUAGES.map((l) => (
              <option key={l.code} value={l.code}>{l.name}</option>
            ))}
          </select>
        </label>
      </section>

      {/* Audio Section */}
      <section className="settings-card">
        <h2 className="card-heading">Audio</h2>

        <div className="volume-group">
          <div className="volume-header">
            <span className="field-label">Translated voice</span>
            <span className="volume-value">{Math.round(settings.translatedVolume * 100)}%</span>
          </div>
          <input
            className="volume-slider"
            type="range"
            min="0"
            max="1"
            step="0.05"
            value={settings.translatedVolume}
            onChange={(e) => update({ translatedVolume: Number(e.target.value) })}
          />
        </div>

        <div className="volume-group">
          <div className="volume-header">
            <span className="field-label">Original audio</span>
            <span className="volume-value">
              {settings.muteOriginal ? 'Muted' : `${Math.round(settings.originalVolume * 100)}%`}
            </span>
          </div>
          <input
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
              checked={settings.muteOriginal}
              onChange={(e) => update({ muteOriginal: e.target.checked })}
            />
            <span className="toggle-slider"></span>
            <span className="mute-text">Mute original audio</span>
          </label>
        </div>
      </section>

      {/* Advanced Settings */}
      <section className="settings-card">
        <h2 className="card-heading">Advanced</h2>

        <label className="field-group">
          <span className="field-label">Interim results</span>
          <label className="mute-toggle">
            <input
              type="checkbox"
              checked={settings.interimEnabled}
              onChange={(e) => update({ interimEnabled: e.target.checked })}
            />
            <span className="toggle-slider"></span>
            <span className="mute-text">Show partial translations while speaking</span>
          </label>
        </label>

        <label className="field-group">
          <span className="field-label">Interim interval (ms)</span>
          <input
            className="field-input"
            type="number"
            min="500"
            max="5000"
            step="100"
            value={settings.interimIntervalMs}
            onChange={(e) => update({ interimIntervalMs: Number(e.target.value) })}
          />
        </label>

        <label className="field-group">
          <span className="field-label">Silence threshold (ms)</span>
          <input
            className="field-input"
            type="number"
            min="500"
            max="5000"
            step="100"
            value={settings.silenceThresholdMs}
            onChange={(e) => update({ silenceThresholdMs: Number(e.target.value) })}
          />
        </label>

        <label className="field-group">
          <span className="field-label">Max segment duration (ms)</span>
          <input
            className="field-input"
            type="number"
            min="5000"
            max="60000"
            step="1000"
            value={settings.maxSegmentMs}
            onChange={(e) => update({ maxSegmentMs: Number(e.target.value) })}
          />
        </label>

        <label className="field-group">
          <span className="field-label">STT rate limit (per minute)</span>
          <input
            className="field-input"
            type="number"
            min="1"
            max="100"
            value={settings.sttRateLimitPerMinute}
            onChange={(e) => update({ sttRateLimitPerMinute: Number(e.target.value) })}
          />
        </label>

        <label className="field-group">
          <span className="field-label">Max STT retries</span>
          <input
            className="field-input"
            type="number"
            min="0"
            max="10"
            value={settings.maxSttRetries}
            onChange={(e) => update({ maxSttRetries: Number(e.target.value) })}
          />
        </label>
      </section>

      {/* Footer */}
      <footer className="settings-footer">
        <span className="footer-text">AI Tab Translator v1.0</span>
      </footer>
    </main>
  );
}
