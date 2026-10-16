import React, { useEffect, useState } from 'react';
import { HardDrive, Cloud, AlertTriangle, CheckCircle, Info, RefreshCw } from 'lucide-react';
import { storageAPI } from '../../services/api';

/**
 * Storage usage, device and cloud (Module 6 FE-4, Module 10 FE-5).
 *
 * The two halves live in different processes and had never been added up.
 * Frames are files on the camera machine's disk, which only the AI backend can
 * see; records are documents in Mongo, which the AI backend cannot measure.
 * Neither side could answer "how much is LOCUS using", so no dashboard ever
 * showed it.
 *
 * The suggestions come from the server and describe what is reclaimable NOW.
 * A panel that always advises clearing old data teaches people to stop reading
 * it, so when there is nothing to do it says so and stops talking.
 *
 * The cloud figure is sampled and scaled rather than measured: collStats is
 * per COLLECTION, which on a shared database is everybody's data and is not
 * one wearer's to see. It is labelled approximate rather than dressed up.
 */

const bytes = (b) => {
  if (b === null || b === undefined) return '--';
  if (b < 1024) return `${b} B`;
  if (b < 1048576) return `${(b / 1024).toFixed(0)} KB`;
  if (b < 1073741824) return `${(b / 1048576).toFixed(1)} MB`;
  return `${(b / 1073741824).toFixed(2)} GB`;
};

const STORE_LABELS = {
  keyframes: 'Moments',
  medication_evidence: 'Medication evidence',
  social: 'People',
  activities: 'Activities',
  items: 'Belongings',
};

const TONE = {
  healthy: 'var(--success, #16a34a)',
  disk_low: 'var(--danger, #dc2626)',
  frames_overdue: 'var(--warning, #d97706)',
};

export default function StorageUsage() {
  const [d, setD] = useState(null);
  const [busy, setBusy] = useState(true);
  const [err, setErr] = useState(null);

  const load = async () => {
    setBusy(true);
    try {
      const res = await storageAPI.getUsage();
      setD(res.data);
      setErr(null);
    } catch (e) {
      setErr(e?.response?.data?.error || 'Could not read storage usage.');
    } finally {
      setBusy(false);
    }
  };

  useEffect(() => { load(); }, []);

  if (busy && !d) return <div style={{ color: 'var(--text-secondary)' }}>Checking storage…</div>;
  if (err) {
    return (
      <div>
        <div style={{ color: 'var(--text-secondary)', marginBottom: 8 }}>{err}</div>
        <button className="btn btn-secondary" onClick={load}>Try again</button>
      </div>
    );
  }

  const device = d?.device || {};
  const cloud = d?.cloud || {};
  const down = !!device.unavailable;
  const stores = Object.entries(device.stores || {}).filter(([, v]) => v.files > 0);
  const usedPct = device.disk
    ? Math.min(100, Math.round((1 - device.disk.free_bytes / device.disk.total_bytes) * 100))
    : null;

  const box = {
    background: 'var(--bg)', borderRadius: 12, padding: 14,
    border: '1px solid var(--border-light)', flex: 1, minWidth: 190,
  };
  const label = {
    fontSize: '0.72rem', fontWeight: 700, letterSpacing: '0.04em',
    color: 'var(--text-secondary)', display: 'flex', alignItems: 'center',
    gap: 6, marginBottom: 8,
  };
  const big = { fontSize: '1.6rem', fontWeight: 700, color: 'var(--text-primary)', lineHeight: 1.1 };
  const sub = { fontSize: '0.78rem', color: 'var(--text-secondary)', marginTop: 4 };

  return (
    <div>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 }}>
        <div style={{ fontWeight: 700, display: 'flex', alignItems: 'center', gap: 8 }}>
          <HardDrive size={16} /> Storage
        </div>
        <button onClick={load} title="Refresh" aria-label="Refresh storage usage"
          style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--text-secondary)', padding: 4 }}>
          <RefreshCw size={15} />
        </button>
      </div>

      <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap', marginBottom: 14 }}>
        <div style={box}>
          <div style={label}><HardDrive size={13} /> ON THE CAMERA MACHINE</div>
          {down ? (
            <div style={{ color: 'var(--text-secondary)', fontSize: '0.88rem' }}>
              Not reachable right now.
            </div>
          ) : (
            <>
              <div style={big}>{bytes(device.total_bytes)}</div>
              <div style={sub}>{device.total_files} files · kept {device.retention_hours}h</div>
              {usedPct !== null && (
                <div style={{ marginTop: 10 }}>
                  <div style={{ height: 6, background: 'var(--border-light)', borderRadius: 999, overflow: 'hidden' }}>
                    <div style={{
                      height: '100%', width: `${usedPct}%`, borderRadius: 999,
                      background: usedPct > 95 ? 'var(--danger, #dc2626)' : 'var(--primary, #2563eb)',
                    }} />
                  </div>
                  <div style={sub}>
                    {bytes(device.disk.free_bytes)} free of {bytes(device.disk.total_bytes)}
                  </div>
                </div>
              )}
            </>
          )}
        </div>

        <div style={box}>
          <div style={label}><Cloud size={13} /> IN THE CLOUD</div>
          <div style={big}>
            {bytes(cloud.bytes)}
            <span style={{ fontSize: '0.8rem', fontWeight: 400, color: 'var(--text-secondary)', marginLeft: 6 }}>
              approx.
            </span>
          </div>
          <div style={sub}>
            {cloud.events?.count ?? 0} events · {cloud.notifications?.count ?? 0} notifications
          </div>
          {cloud.retention && (
            <div style={{ ...sub, marginTop: 8 }}>
              Routine events {cloud.retention.routine_days} days · medication and people{' '}
              {Math.round(cloud.retention.clinical_days / 365)} year
            </div>
          )}
        </div>
      </div>

      {!down && stores.length > 0 && (
        <div style={{ marginBottom: 14 }}>
          {stores.map(([k, v]) => (
            <div key={k} style={{
              display: 'flex', justifyContent: 'space-between',
              fontSize: '0.86rem', padding: '3px 0',
            }}>
              <span style={{ color: 'var(--text-primary)' }}>{STORE_LABELS[k] || k}</span>
              <span style={{ color: 'var(--text-secondary)' }}>{v.files} · {bytes(v.bytes)}</span>
            </div>
          ))}
        </div>
      )}

      <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
        {(d?.suggestions || []).map((s, i) => {
          const Icon = s.kind === 'healthy' ? CheckCircle
            : (s.kind === 'disk_low' || s.kind === 'frames_overdue') ? AlertTriangle : Info;
          return (
            <div key={i} style={{ display: 'flex', gap: 8, alignItems: 'flex-start', fontSize: '0.88rem' }}>
              <Icon size={15} style={{ marginTop: 2, flexShrink: 0, color: TONE[s.kind] || 'var(--text-secondary)' }} />
              <div>
                <span style={{ color: 'var(--text-primary)' }}>{s.text}</span>
                {s.detail && (
                  <span style={{ color: 'var(--text-secondary)', marginLeft: 5 }}>{s.detail}</span>
                )}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
