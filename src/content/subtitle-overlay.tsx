import { useEffect, useState, useSyncExternalStore } from 'react';
import type { CSSProperties } from 'react';
import { subscribe, getOverlayState, DEFAULT_PREFS } from './store';

export default function SubtitleOverlay() {
  const state = useSyncExternalStore(subscribe, getOverlayState);
  const segment = state.segment;
  const prefs = { ...DEFAULT_PREFS, ...state.prefs };
  const mode = state.mode;
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    if (!segment) {
      setVisible(false);
      return;
    }
    setVisible(true);
    const duration = Math.max(2500, (segment.endTime - segment.startTime) * 1000 + 2500);
    const timer = setTimeout(() => setVisible(false), duration);
    return () => clearTimeout(timer);
  }, [segment?.id, segment?.translatedText, segment?.startTime, segment?.endTime]);

  if (!segment || !visible || mode === 'voice') return null;

  const primary = segment.translatedText || segment.sourceText;
  const secondary = prefs.showOriginal && segment.sourceText ? segment.sourceText : null;
  const atBottom = prefs.position === 'bottom';

  const containerStyle: CSSProperties = {
    position: 'fixed',
    left: '50%',
    transform: 'translateX(-50%)',
    bottom: atBottom ? '10%' : 'auto',
    top: atBottom ? 'auto' : '8%',
    width: 'max-content',
    maxWidth: '88%',
    textAlign: 'center',
    padding: '10px 18px',
    borderRadius: '12px',
    background: `rgba(8, 10, 18, ${prefs.bgOpacity})`,
    color: '#ffffff',
    fontSize: prefs.fontSize,
    fontFamily: 'system-ui, -apple-system, "Segoe UI", Roboto, sans-serif',
    fontWeight: 600,
    lineHeight: 1.35,
    textShadow: '0 1px 3px rgba(0,0,0,0.6)',
    boxShadow: '0 4px 24px rgba(0,0,0,0.35)',
    whiteSpace: 'pre-wrap',
    wordBreak: 'break-word',
    pointerEvents: 'none',
  };

  return (
    <div
      style={{
        position: 'fixed',
        inset: 0,
        display: 'flex',
        alignItems: atBottom ? 'flex-end' : 'flex-start',
        justifyContent: 'center',
        pointerEvents: 'none',
      }}
    >
      <div style={containerStyle}>
        {!segment.interim && (
          <div
            style={{
              fontSize: Math.max(11, Math.round(prefs.fontSize * 0.4)),
              color: '#93c5fd',
              marginBottom: 2,
              fontWeight: 700,
              textTransform: 'uppercase',
              letterSpacing: 1,
            }}
          >
            Live
          </div>
        )}
        <div style={{ opacity: segment.interim ? 0.75 : 1 }}>{primary}</div>
        {secondary && (
          <div
            style={{
              fontSize: Math.max(12, Math.round(prefs.fontSize * 0.66)),
              color: '#cbd5e1',
              marginTop: 4,
              fontWeight: 500,
            }}
          >
            {secondary}
          </div>
        )}
      </div>
    </div>
  );
}
