import React, { useEffect, useState } from 'react';
import { ShieldOff, EyeOff, Eye, MapPin, Trash2, Plus } from 'lucide-react';
import { privacyAPI } from '../../services/api';

/**
 * Privacy Mode (Module A FE-4 and FE-5, Module 10 FE-3).
 *
 * It lives in Settings and nowhere else, by the wearer's choice. It briefly had
 * a cut-down copy on the dashboard for FE 10-3's "one-tap access"; that reading
 * of one-tap is now Settings being one tap from anywhere, rather than a second
 * copy of the same switch on the page people look at every day.
 *
 * The three states are deliberately not a checkbox. "Stop recording me" and
 * "stop keeping pictures I am recognisable in" are different things to want,
 * and collapsing them would have forced the stricter one on anybody who only
 * wanted the softer one.
 */

const MODES = [
  { key: 'off', label: 'Recording', icon: Eye,
    hint: 'The camera is working normally.' },
  { key: 'blur', label: 'Blurred', icon: EyeOff,
    hint: 'Frames are still kept, pixelated so nobody is recognisable.' },
  { key: 'paused', label: 'Paused', icon: ShieldOff,
    hint: 'Nothing is recorded and nothing is analysed.' },
];

const ROOM_LABELS = {
  bathroom: 'Washroom', bedroom: 'Bedroom', kitchen: 'Kitchen',
  living: 'Living room', dining: 'Dining room', office: 'Office / study',
};

const since = (iso) => {
  if (!iso) return null;
  const mins = Math.round((Date.now() - new Date(iso)) / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins} min ago`;
  const h = Math.floor(mins / 60);
  return `${h} hour${h === 1 ? '' : 's'} ago`;
};

export default function PrivacyPanel() {
  const [p, setP] = useState(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState(null);
  const [place, setPlace] = useState({ label: '', lat: '', lng: '', radius_m: 50 });

  const load = async () => {
    try {
      const res = await privacyAPI.get();
      setP(res.data);
      setErr(null);
    } catch {
      setErr('Could not read your privacy settings.');
    }
  };

  useEffect(() => {
    load();
    // The pipeline can switch capture off by itself, so this panel is not the
    // only writer. Polled while open so "the washroom is private" appears
    // without the person reloading to find out.
    const t = setInterval(load, 15000);
    return () => clearInterval(t);
  }, []);

  const save = async (patch) => {
    setBusy(true);
    try {
      await privacyAPI.set(patch);
      await load();
      setErr(null);
    } catch (e) {
      setErr(e?.response?.data?.error || 'Could not save that.');
    } finally {
      setBusy(false);
    }
  };

  if (!p) {
    return <div className="text-sm text-muted">{err || 'Loading privacy settings...'}</div>;
  }

  const current = MODES.find(m => m.key === p.mode) || MODES[0];

  return (
    <div>
      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginBottom: 10 }}>
        {MODES.map(mode => {
          const Icon = mode.icon;
          const on = p.mode === mode.key;
          return (
            <button
              key={mode.key}
              onClick={() => !on && save({ mode: mode.key })}
              disabled={busy}
              style={{
                display: 'flex', alignItems: 'center', gap: 8,
                padding: '10px 16px', borderRadius: 10, cursor: busy ? 'wait' : 'pointer',
                fontWeight: 600, fontSize: '0.9rem',
                border: on ? '2px solid var(--primary)' : '1px solid var(--border)',
                background: on ? 'var(--primary-light)' : 'var(--surface)',
                color: on ? 'var(--primary)' : 'var(--text-secondary)',
              }}
            >
              <Icon size={16} />
              {mode.label}
            </button>
          );
        })}
      </div>

      <div className="text-xs text-muted" style={{ marginBottom: 20 }}>
        {current.hint}
        {p.mode !== 'off' && p.mode_set_at && (
          // A wearer who switches this on and forgets is the likeliest way the
          // feature does harm, so how long it has been on is always on screen.
          <> Switched on {since(p.mode_set_at)}.</>
        )}
      </div>

      {p.auto_dead && (
        <div style={{
          marginTop: 10, padding: '10px 12px', borderRadius: 8,
          background: 'var(--primary-light)', color: 'var(--primary)',
          fontSize: '0.85rem', fontWeight: 600,
          display: 'flex', alignItems: 'center', gap: 8,
        }}>
          <ShieldOff size={15} />
          Recording is off right now: {p.auto_dead_reason}
        </div>
      )}

      {err && <div className="text-xs" style={{ color: 'var(--danger)', marginTop: 8 }}>{err}</div>}

          <div style={{ fontWeight: 600, fontSize: '0.9rem', marginBottom: 6 }}>
            Rooms to never record in
          </div>
          <p className="text-xs text-muted" style={{ marginBottom: 10 }}>
            The camera recognises a room from what is in it. When it sees one of
            these it stops recording and destroys anything it had already kept
            from that room.
          </p>
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginBottom: 20 }}>
            {(p.known_rooms || []).map(room => {
              const on = (p.sensitive_rooms || []).includes(room);
              return (
                <button
                  key={room}
                  onClick={() => save({
                    sensitive_rooms: on
                      ? p.sensitive_rooms.filter(r => r !== room)
                      : [...(p.sensitive_rooms || []), room],
                  })}
                  disabled={busy}
                  style={{
                    padding: '6px 14px', borderRadius: 20, fontSize: '0.85rem',
                    fontWeight: 600, cursor: busy ? 'wait' : 'pointer',
                    border: 'none',
                    background: on ? 'var(--primary)' : 'var(--border-light)',
                    color: on ? '#fff' : 'var(--text-secondary)',
                  }}
                >
                  {ROOM_LABELS[room] || room}
                </button>
              );
            })}
          </div>

          <div style={{ fontWeight: 600, fontSize: '0.9rem', marginBottom: 6 }}>
            Places to never record in
          </div>
          <p className="text-xs text-muted" style={{ marginBottom: 10 }}>
            Recording stops while the wearer is inside one of these circles.
          </p>
          {(p.sensitive_places || []).length === 0 && (
            <p className="text-xs text-muted" style={{ marginBottom: 10 }}>None yet.</p>
          )}
          {(p.sensitive_places || []).map((pl, i) => (
            <div key={i} style={{
              display: 'flex', alignItems: 'center', gap: 10, marginBottom: 8,
              paddingBottom: 8, borderBottom: '1px solid var(--border)',
            }}>
              <MapPin size={15} style={{ color: 'var(--primary)', flexShrink: 0 }} />
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontSize: '0.88rem', fontWeight: 600 }}>
                  {pl.label || 'Unnamed place'}
                </div>
                <div className="text-xs text-muted">
                  {Number(pl.lat).toFixed(5)}, {Number(pl.lng).toFixed(5)} · within {pl.radius_m} m
                </div>
              </div>
              <button
                className="btn"
                disabled={busy}
                onClick={() => save({
                  sensitive_places: p.sensitive_places.filter((_, j) => j !== i),
                })}
                title="Remove"
                style={{ width: 30, height: 30, padding: 0, display: 'flex', alignItems: 'center', justifyContent: 'center' }}
              >
                <Trash2 size={14} />
              </button>
            </div>
          ))}

          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center', marginTop: 10 }}>
            <input
              className="form-input" placeholder="Name, e.g. the clinic"
              value={place.label}
              onChange={(e) => setPlace({ ...place, label: e.target.value })}
              style={{ flex: '1 1 160px', height: 34, fontSize: '0.85rem' }}
            />
            <input
              className="form-input" placeholder="Latitude" value={place.lat}
              onChange={(e) => setPlace({ ...place, lat: e.target.value })}
              style={{ width: 110, height: 34, fontSize: '0.85rem' }}
            />
            <input
              className="form-input" placeholder="Longitude" value={place.lng}
              onChange={(e) => setPlace({ ...place, lng: e.target.value })}
              style={{ width: 110, height: 34, fontSize: '0.85rem' }}
            />
            <input
              className="form-input" type="number" min="20" max="2000" value={place.radius_m}
              onChange={(e) => setPlace({ ...place, radius_m: e.target.value })}
              title="Radius in metres"
              style={{ width: 80, height: 34, fontSize: '0.85rem' }}
            />
            <button
              className="btn btn-primary"
              disabled={busy || place.lat === '' || place.lng === ''}
              onClick={async () => {
                await save({
                  sensitive_places: [...(p.sensitive_places || []), {
                    label: place.label,
                    lat: Number(place.lat),
                    lng: Number(place.lng),
                    radius_m: Number(place.radius_m) || 50,
                  }],
                });
                setPlace({ label: '', lat: '', lng: '', radius_m: 50 });
              }}
              style={{ height: 34, display: 'flex', alignItems: 'center', gap: 6 }}
            >
              <Plus size={14} /> Add
            </button>
          </div>
    </div>
  );
}
