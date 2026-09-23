import { useEffect, useState } from 'react';
import { Activity, Brain, Home, Package, AlertTriangle, Pill, Footprints, CalendarDays, ShieldCheck } from 'lucide-react';
import UserSelector from '../components/Layout/UserSelector';
import { useSelectedUser } from '../context/SelectedUserContext';
import { eventLogsAPI } from '../services/api';

// The page used to render a hard-coded array: a plausible-looking day with
// "Met with neighbor Mrs. Johnson" and "~2,400 steps" that came from nowhere
// and never changed. Everything below is what the Core Module actually
// recorded, from /api/event-logs/timeline.

const KIND = {
  routine:    { icon: Home,          color: 'var(--primary)' },
  medication: { icon: Pill,          color: 'var(--success)' },
  social:     { icon: Brain,         color: 'var(--accent)' },
  items:      { icon: Package,       color: 'var(--info)' },
  anomaly:    { icon: AlertTriangle, color: 'var(--warning)' },
};

const today = () => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};
const timeOf = (iso) => new Date(iso).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });

export default function ActivityFeed() {
  const { selectedUser } = useSelectedUser() || {};
  const [date, setDate] = useState(today());
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    eventLogsAPI
      .timeline({ date, ...(selectedUser?._id ? { userId: selectedUser._id } : {}) })
      .then(({ data }) => { if (!cancelled) setData(data); })
      .catch((e) => { if (!cancelled) setError(e?.response?.data?.error || 'Could not load the timeline'); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [date, selectedUser?._id]);

  const items = data?.items || [];
  const anomalies = data?.anomalies || [];
  const s = data?.summary;

  // Steps come from the phone, everything else from the camera. null means
  // the phone has not reported, which is not the same as "did not walk", so
  // it shows as a dash rather than a zero.
  const steps = s?.steps;

  const SEVERITY = {
    urgent:  { color: 'var(--danger, #dc2626)', label: 'Needs attention now' },
    warning: { color: 'var(--warning)',         label: 'Worth a look' },
    info:    { color: 'var(--info)',            label: 'Just so you know' },
  };

  return (
    <div>
      <div className="page-header" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
        <div>
          <h2 className="page-title">Activity Feed</h2>
          <p className="page-description">What the camera recorded, hour by hour</p>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
          <label style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
            <CalendarDays size={16} style={{ color: 'var(--text-muted)' }} />
            <input
              type="date" value={date} max={today()}
              onChange={(e) => setDate(e.target.value)}
              className="form-input"
              style={{ padding: '6px 10px', fontSize: '0.9rem', height: 32, borderRadius: 8 }}
            />
          </label>
          <UserSelector />
        </div>
      </div>

      <div className="grid-2">
        <div className="card">
          <div className="card-header">
            <div>
              <div className="card-title">Timeline</div>
              <div className="card-subtitle">
                {loading ? 'Loading…' : `${items.length} ${items.length === 1 ? 'entry' : 'entries'} on ${new Date(date).toLocaleDateString([], { weekday: 'long', day: 'numeric', month: 'long' })}`}
              </div>
            </div>
          </div>

          {error && <div className="text-sm" style={{ color: 'var(--warning)' }}>{error}</div>}

          {!loading && !error && items.length === 0 && (
            <div style={{ padding: '28px 4px', textAlign: 'center' }}>
              <Activity size={28} style={{ color: 'var(--text-muted)', marginBottom: 10 }} />
              <div style={{ fontWeight: 600, marginBottom: 6 }}>Nothing recorded on this day</div>
              <div className="text-sm text-muted" style={{ maxWidth: 380, margin: '0 auto', lineHeight: 1.6 }}>
                The feed fills as the camera runs. Room sessions, medication, familiar
                faces and tracked items all appear here. Pick another date, or check the
                camera was on.
              </div>
            </div>
          )}

          <div style={{ display: 'flex', flexDirection: 'column' }}>
            {items.map((act, i) => {
              const meta = KIND[act.kind] || KIND.routine;
              const Icon = meta.icon;
              return (
                <div key={`${act.at}-${i}`} style={{ display: 'flex', gap: 14, padding: '12px 0', position: 'relative' }}>
                  {i < items.length - 1 && (
                    <div style={{ position: 'absolute', left: 17, top: 44, bottom: -12, width: 2, background: 'var(--border)', zIndex: 0 }} />
                  )}
                  <div style={{
                    width: 36, height: 36, borderRadius: '50%', background: meta.color + '20',
                    display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0, zIndex: 1,
                  }}>
                    <Icon size={16} style={{ color: meta.color }} />
                  </div>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8 }}>
                      <span style={{ fontWeight: 600, fontSize: '0.85rem' }}>{act.title}</span>
                      <span className="text-xs text-muted" style={{ flexShrink: 0 }}>{timeOf(act.at)}</span>
                    </div>
                    <div className="text-sm text-muted">{act.detail}</div>
                  </div>
                </div>
              );
            })}
          </div>
        </div>

        <div>
          <div className="stat-grid" style={{ marginBottom: 16 }}>
            <div className="stat-card">
              <div className="stat-icon success"><Pill size={18} /></div>
              <div>
                <div className="stat-value">{s ? s.medication : '—'}</div>
                <div className="stat-label">Doses Seen</div>
              </div>
            </div>
            <div className="stat-card">
              <div className="stat-icon accent"><Brain size={18} /></div>
              <div>
                <div className="stat-value">{s ? s.social : '—'}</div>
                <div className="stat-label">Social Interactions</div>
              </div>
            </div>
            <div className="stat-card">
              <div className="stat-icon primary"><Footprints size={18} /></div>
              <div>
                <div className="stat-value">{steps == null ? '—' : steps.toLocaleString()}</div>
                <div className="stat-label">Steps Today</div>
              </div>
            </div>
            <div className="stat-card">
              <div className="stat-icon info"><Package size={18} /></div>
              <div>
                <div className="stat-value">{s ? s.items_seen : '—'}</div>
                <div className="stat-label">Items Found</div>
              </div>
            </div>
          </div>

          {/* Anomalies: the routine monitor's findings for this day, listed
              rather than only counted. */}
          <div className="card" style={{ marginBottom: 16 }}>
            <div className="card-title" style={{ marginBottom: 4 }}>Anomalies</div>
            <div className="card-subtitle" style={{ marginBottom: 12 }}>
              {anomalies.length
                ? `${anomalies.length} thing${anomalies.length === 1 ? '' : 's'} LOCUS noticed`
                : 'Nothing out of the ordinary'}
            </div>
            {anomalies.length === 0 ? (
              <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                <ShieldCheck size={18} style={{ color: 'var(--success)' }} />
                <span className="text-sm text-muted">
                  The day matched the usual pattern. Missed doses, long stretches without
                  movement and items left behind would appear here.
                </span>
              </div>
            ) : (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
                {anomalies.map((a, i) => {
                  const sev = SEVERITY[a.severity] || SEVERITY.info;
                  return (
                    <div key={`${a.at}-${i}`} style={{
                      display: 'flex', gap: 10, padding: '10px 12px', borderRadius: 10,
                      background: 'var(--surface-alt, rgba(0,0,0,0.02))',
                      borderLeft: `3px solid ${sev.color}`,
                    }}>
                      <AlertTriangle size={16} style={{ color: sev.color, flexShrink: 0, marginTop: 2 }} />
                      <div style={{ minWidth: 0 }}>
                        <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8, alignItems: 'baseline' }}>
                          <span style={{ fontWeight: 600, fontSize: '0.85rem' }}>{a.title}</span>
                          <span className="text-xs text-muted" style={{ flexShrink: 0 }}>{timeOf(a.at)}</span>
                        </div>
                        <div className="text-sm text-muted">{a.detail}</div>
                        <div className="text-xs" style={{ color: sev.color, marginTop: 2 }}>{sev.label}</div>
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </div>

          <div className="card">
            <div className="card-title" style={{ marginBottom: 4 }}>Where the day was spent</div>
            <div className="card-subtitle" style={{ marginBottom: 12 }}>
              {s?.tracked_minutes
                ? `${Math.floor(s.tracked_minutes / 60)}h ${s.tracked_minutes % 60}m across the rooms the camera recognised`
                : 'Rooms the camera recognised'}
            </div>
            {s?.rooms?.length ? (
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
                {s.rooms.map((room) => (
                  <span key={room} style={{
                    padding: '6px 12px', borderRadius: 999, fontSize: '0.8rem', fontWeight: 600,
                    background: 'var(--primary)20', color: 'var(--primary)', textTransform: 'capitalize',
                  }}>{room}</span>
                ))}
              </div>
            ) : (
              <div className="text-sm text-muted" style={{ lineHeight: 1.6 }}>
                No room sessions yet for this day. A room is recorded once the camera
                has seen enough of it to be sure, so short passes through a hallway
                will not appear.
              </div>
            )}
          </div>

          {steps == null && (
            <div className="card" style={{ marginTop: 16 }}>
              <div className="card-title" style={{ marginBottom: 4 }}>No step count for this day</div>
              <div className="text-sm text-muted" style={{ lineHeight: 1.6 }}>
                Steps are counted by the phone, not the camera. Open the LOCUS app on the
                phone and allow physical activity access. Phones without a step sensor
                will not report one.
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
