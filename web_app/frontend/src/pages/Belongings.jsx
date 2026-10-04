import { useCallback, useEffect, useRef, useState } from 'react';
import { Package, Plus, Trash2, Upload, X, AlertTriangle, CheckCircle2 } from 'lucide-react';
import { userItemsAPI } from '../services/api';

/**
 * Personal Belongings on the web.
 *
 * There was no way to see or manage enrolled items here at all: enrolment
 * existed only on the phone, where it capped at FIVE photographs and asked for
 * three. That cap is why an enrolled phone had four pictures, which agreed with
 * each other at 0.699, and why the matcher spent its life filling the gap from
 * its own sightings until it drifted off the object entirely.
 *
 * So this page is not only a convenience. Ten to fifteen photographs is hard
 * work on a phone and easy at a desk, where a folder of pictures can be dropped
 * in at once.
 *
 * Gallery health is shown rather than hidden, because "4 photos, agreement
 * 0.70" is the number that predicted every recognition failure that followed,
 * and nobody could see it.
 */

const MIN_PHOTOS = 10;
const MAX_PHOTOS = 15;

// What to photograph. The first five are the angles the phone already asked
// for; the rest are the ones that were missing, and their absence is why an
// item across a room went unrecognised.
const PROMPTS = [
  'Front, main view', 'Back, logos or camera', 'Side profile', 'Top, angled',
  'Distinctive marks, case or stickers', 'Held in a hand', 'Lying on a table',
  'Further away, across the room', 'In dimmer light', 'Turned part way',
  'Close up on a detail', 'A different background', 'Partly covered',
  'From below', 'Any other angle',
];

/** How much a gallery agrees with itself, in words. */
function healthOf(gallery) {
  if (!gallery || typeof gallery.mean !== 'number') return null;
  const { mean, photos } = gallery;
  if (photos < MIN_PHOTOS) {
    return { tone: 'bad', text: `${photos} photo${photos === 1 ? '' : 's'}, below the ${MIN_PHOTOS} needed` };
  }
  if (mean >= 0.8) return { tone: 'good', text: `${photos} photos, agreement ${mean.toFixed(2)}` };
  if (mean >= 0.7) return { tone: 'ok', text: `${photos} photos, agreement ${mean.toFixed(2)}, a loose set` };
  return { tone: 'bad', text: `${photos} photos, agreement ${mean.toFixed(2)}, too scattered to match on` };
}

const TONE = { good: 'var(--success)', ok: 'var(--warning)', bad: 'var(--danger)' };

export default function Belongings() {
  const [items, setItems] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [adding, setAdding] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await userItemsAPI.getAll();
      setItems(Array.isArray(res.data) ? res.data : (res.data?.items || []));
      setError(null);
    } catch (e) {
      setError(e.response?.data?.error || 'Could not load your belongings');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  const remove = async (item) => {
    if (!window.confirm(
      `Remove "${item.item_name}"?\n\nIt will stop being recognised, and its photographs are deleted. `
      + `Past sightings stay in your memory timeline.`)) return;
    try {
      await userItemsAPI.remove(item._id);
      load();
    } catch (e) {
      setError(e.response?.data?.error || 'Could not remove that item');
    }
  };

  return (
    <div style={{ padding: 24, maxWidth: 1000, margin: '0 auto' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 4 }}>
        <Package size={26} color="var(--primary)" />
        <h1 style={{ margin: 0, fontSize: '1.6rem' }}>Personal Belongings</h1>
        <div style={{ flex: 1 }} />
        <button className="btn btn-primary" onClick={() => setAdding(true)}
          style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
          <Plus size={16} /> Enrol an item
        </button>
      </div>
      <p style={{ color: 'var(--text-secondary)', marginTop: 0 }}>
        The things the camera watches for. Each needs {MIN_PHOTOS} to {MAX_PHOTOS} photographs
        before it can be told apart from similar objects.
      </p>

      {error && (
        <div style={{
          background: 'var(--danger-light)', color: 'var(--danger)', padding: 12,
          borderRadius: 10, marginBottom: 16, display: 'flex', gap: 8, alignItems: 'center',
        }}>
          <AlertTriangle size={16} /> {error}
        </div>
      )}

      {loading ? (
        <div style={{ padding: 40, textAlign: 'center', color: 'var(--text-muted)' }}>Loading...</div>
      ) : items.length === 0 ? (
        <div style={{
          padding: 48, textAlign: 'center', background: 'var(--surface)',
          border: '1px solid var(--border)', borderRadius: 16,
        }}>
          <Package size={44} color="var(--text-muted)" style={{ opacity: 0.5 }} />
          <div style={{ fontWeight: 600, marginTop: 10 }}>Nothing enrolled yet</div>
          <div style={{ color: 'var(--text-muted)', fontSize: '0.9rem', marginTop: 4 }}>
            Enrol a phone, keys or a wallet and the camera will start keeping track of where you put it.
          </div>
        </div>
      ) : (
        <div style={{ display: 'grid', gap: 12 }}>
          {items.map((it) => {
            const health = healthOf(it.gallery);
            return (
              <div key={it._id} style={{
                display: 'flex', alignItems: 'center', gap: 16, padding: 16,
                background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 14,
              }}>
                <div style={{
                  width: 46, height: 46, borderRadius: 12, flexShrink: 0,
                  background: 'var(--primary-light)', display: 'flex',
                  alignItems: 'center', justifyContent: 'center',
                }}>
                  <Package size={22} color="var(--primary)" />
                </div>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontWeight: 700 }}>{it.item_name}</div>
                  {health && (
                    <div style={{ fontSize: '0.82rem', color: TONE[health.tone], marginTop: 2 }}>
                      {health.text}
                    </div>
                  )}
                </div>
                <button className="btn" onClick={() => remove(it)} title="Remove"
                  style={{ color: 'var(--danger)' }}>
                  <Trash2 size={16} />
                </button>
              </div>
            );
          })}
        </div>
      )}

      {adding && (
        <EnrolDialog
          onClose={() => setAdding(false)}
          onDone={() => { setAdding(false); load(); }}
          onError={setError}
        />
      )}
    </div>
  );
}

/** Pick a name and 10 to 15 photographs, then enrol. */
function EnrolDialog({ onClose, onDone, onError }) {
  const [name, setName] = useState('');
  const [frames, setFrames] = useState([]);   // data: URLs
  const [busy, setBusy] = useState(false);
  const fileRef = useRef(null);

  const addFiles = async (fileList) => {
    const room = MAX_PHOTOS - frames.length;
    const chosen = Array.from(fileList).filter(f => f.type.startsWith('image/')).slice(0, room);
    const read = await Promise.all(chosen.map(f => new Promise((res) => {
      const r = new FileReader();
      r.onload = () => res(r.result);
      r.onerror = () => res(null);
      r.readAsDataURL(f);
    })));
    setFrames(prev => [...prev, ...read.filter(Boolean)]);
  };

  const submit = async () => {
    if (!name.trim() || frames.length < MIN_PHOTOS) return;
    setBusy(true);
    try {
      await userItemsAPI.enroll(name.trim(), frames);
      onDone();
    } catch (e) {
      const d = e.response?.data;
      onError(d?.detail ? `${d.error}. ${d.detail}` : (d?.error || 'Enrolment failed'));
      setBusy(false);
    }
  };

  const enough = frames.length >= MIN_PHOTOS;

  return (
    <div
      onClick={onClose}
      style={{
        position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.5)', zIndex: 1000,
        display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 20,
      }}
    >
      <div onClick={(e) => e.stopPropagation()} style={{
        background: 'var(--surface)', borderRadius: 18, padding: 22,
        width: 'min(720px, 100%)', maxHeight: '90vh', overflowY: 'auto',
      }}>
        <div style={{ display: 'flex', alignItems: 'center', marginBottom: 6 }}>
          <h2 style={{ margin: 0, fontSize: '1.2rem' }}>Enrol an item</h2>
          <div style={{ flex: 1 }} />
          <button className="btn" onClick={onClose}><X size={16} /></button>
        </div>
        <p style={{ color: 'var(--text-secondary)', fontSize: '0.88rem', marginTop: 0 }}>
          {MIN_PHOTOS} to {MAX_PHOTOS} photographs, from different angles and distances, and a
          couple in the light you actually live in. The more it sees here, the less it has to
          guess later.
        </p>

        <input
          className="form-input"
          placeholder="What is it? e.g. Car Keys"
          value={name}
          onChange={(e) => setName(e.target.value)}
          style={{ marginBottom: 14 }}
        />

        <div
          onDragOver={(e) => e.preventDefault()}
          onDrop={(e) => { e.preventDefault(); addFiles(e.dataTransfer.files); }}
          onClick={() => fileRef.current?.click()}
          style={{
            border: '2px dashed var(--border)', borderRadius: 14, padding: 20,
            textAlign: 'center', cursor: 'pointer', marginBottom: 14,
          }}
        >
          <Upload size={22} color="var(--text-muted)" />
          <div style={{ fontWeight: 600, marginTop: 6 }}>
            Drop photographs here, or click to choose
          </div>
          <div style={{ fontSize: '0.8rem', color: 'var(--text-muted)' }}>
            {frames.length} of {MAX_PHOTOS} added
          </div>
          <input
            ref={fileRef}
            type="file"
            accept="image/*"
            multiple
            hidden
            onChange={(e) => { addFiles(e.target.files); e.target.value = ''; }}
          />
        </div>

        {frames.length > 0 && (
          <div style={{
            display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(92px, 1fr))',
            gap: 8, marginBottom: 14,
          }}>
            {frames.map((src, i) => (
              <div key={i} style={{ position: 'relative' }}>
                <img src={src} alt="" style={{
                  width: '100%', height: 78, objectFit: 'cover', borderRadius: 8,
                }} />
                <div style={{
                  fontSize: '0.64rem', color: 'var(--text-muted)', marginTop: 2,
                  overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                }}>
                  {PROMPTS[i] || `Angle ${i + 1}`}
                </div>
                <button
                  onClick={() => setFrames(f => f.filter((_, k) => k !== i))}
                  title="Remove"
                  style={{
                    position: 'absolute', top: 2, right: 2, border: 'none', cursor: 'pointer',
                    background: 'rgba(0,0,0,0.6)', color: '#fff', borderRadius: '50%',
                    width: 20, height: 20, lineHeight: 0,
                  }}
                >
                  <X size={11} />
                </button>
              </div>
            ))}
          </div>
        )}

        <div style={{
          display: 'flex', alignItems: 'center', gap: 8, marginBottom: 14,
          color: enough ? 'var(--success)' : 'var(--text-muted)', fontSize: '0.86rem',
        }}>
          {enough ? <CheckCircle2 size={15} /> : <AlertTriangle size={15} />}
          {enough
            ? `${frames.length} photographs, enough to enrol`
            : `${MIN_PHOTOS - frames.length} more needed. Fewer than ${MIN_PHOTOS} and it cannot be told apart from similar objects.`}
        </div>

        <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
          <button className="btn" onClick={onClose}>Cancel</button>
          <button
            className="btn btn-primary"
            disabled={!enough || !name.trim() || busy}
            onClick={submit}
            style={{ opacity: (!enough || !name.trim() || busy) ? 0.5 : 1 }}
          >
            {busy ? 'Enrolling...' : 'Enrol'}
          </button>
        </div>
      </div>
    </div>
  );
}
