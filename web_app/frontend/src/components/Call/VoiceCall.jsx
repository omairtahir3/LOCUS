import { Phone, PhoneOff, Mic, MicOff, AlertTriangle } from 'lucide-react';

/**
 * The call itself: one panel that covers ringing, connecting and talking.
 *
 * Deliberately a single fixed panel rather than a modal. A call can arrive
 * while the person is anywhere in the app, and during an emergency it must not
 * be something that can be scrolled past or dismissed by clicking beside it.
 *
 * Nothing here knows about WebRTC. It renders what useVoiceCall reports and
 * calls back into it, so the media code stays in one place.
 */

const LABEL = {
  calling: 'Calling...',
  ringing: 'Incoming call',
  connecting: 'Connecting...',
  connected: 'Connected',
  declined: 'Call declined',
  busy: 'They are on another call',
  failed: 'Could not connect',
  ended: 'Call ended',
};

export default function VoiceCall({ call }) {
  const { state, peer, error, muted, answer, decline, hangUp, toggleMute, reset } = call;
  if (state === 'idle') return null;

  const live = state === 'calling' || state === 'connecting' || state === 'connected';
  const over = state === 'ended' || state === 'declined' || state === 'failed' || state === 'busy';
  const sos = !!peer?.sos;

  const btn = (bg) => ({
    width: 48, height: 48, borderRadius: '50%', border: 'none', cursor: 'pointer',
    display: 'flex', alignItems: 'center', justifyContent: 'center', background: bg, color: '#fff',
  });

  return (
    <div
      role="dialog"
      aria-live="assertive"
      aria-label={sos ? 'Emergency call' : 'Voice call'}
      style={{
        position: 'fixed', right: 20, bottom: 20, zIndex: 2000, width: 300,
        background: 'var(--surface)', borderRadius: 16, padding: 18,
        boxShadow: 'var(--shadow-xl)',
        // An emergency call is outlined in red so it is not mistaken for an
        // ordinary one at a glance.
        border: sos ? '2px solid var(--danger)' : '1px solid var(--border)',
      }}
    >
      {sos && (
        <div style={{
          display: 'flex', alignItems: 'center', gap: 6, marginBottom: 10,
          color: 'var(--danger)', fontWeight: 700, fontSize: '0.78rem', letterSpacing: 0.4,
        }}>
          <AlertTriangle size={14} /> EMERGENCY
        </div>
      )}

      <div style={{ fontWeight: 700, fontSize: '1.05rem', color: 'var(--text-primary)' }}>
        {peer?.name || 'Unknown'}
      </div>
      <div style={{ color: 'var(--text-secondary)', fontSize: '0.88rem', marginTop: 2 }}>
        {error || LABEL[state] || state}
      </div>

      {state === 'connected' && (
        <div style={{ fontSize: '0.75rem', color: 'var(--text-muted)', marginTop: 6 }}>
          Speaking directly, not through the server.
        </div>
      )}

      <div style={{ display: 'flex', gap: 10, marginTop: 16, alignItems: 'center' }}>
        {state === 'ringing' && (
          <>
            <button onClick={answer} title="Answer" style={btn('var(--success)')}>
              <Phone size={20} />
            </button>
            <button onClick={decline} title="Decline" style={btn('var(--danger)')}>
              <PhoneOff size={20} />
            </button>
          </>
        )}

        {live && (
          <>
            <button
              onClick={toggleMute}
              title={muted ? 'Unmute' : 'Mute'}
              disabled={state !== 'connected'}
              style={{
                ...btn(muted ? 'var(--warning)' : 'var(--border-light)'),
                color: muted ? '#fff' : 'var(--text-secondary)',
                opacity: state === 'connected' ? 1 : 0.5,
              }}
            >
              {muted ? <MicOff size={18} /> : <Mic size={18} />}
            </button>
            <button onClick={() => hangUp()} title="Hang up" style={btn('var(--danger)')}>
              <PhoneOff size={20} />
            </button>
          </>
        )}

        {over && (
          <button
            onClick={reset}
            className="btn"
            style={{ height: 38, padding: '0 16px', fontWeight: 600 }}
          >
            Close
          </button>
        )}
      </div>
    </div>
  );
}
