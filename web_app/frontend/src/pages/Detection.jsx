import { useState, useEffect, useRef } from 'react';
import { detectionAPI } from '../services/api';
import { Scan, Play, Square, Zap, Activity, CheckCircle, XCircle, AlertTriangle, Loader, Clock, Timer } from 'lucide-react';

export default function Detection() {
  const [status, setStatus] = useState({ is_running: false, buffer_size: 0, has_result: false, last_result: null });
  const [scheduler, setScheduler] = useState(null);
  const [source, setSource] = useState('0');
  const [medId, setMedId] = useState('');
  const [schedTime, setSchedTime] = useState('08:00');
  const [result, setResult] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const pollRef = useRef(null);

  const fetchStatus = async () => {
    try {
      const res = await detectionAPI.getStatus();
      setStatus(res.data);
      if (res.data.last_result) {
        setResult(res.data.last_result);
      }
    } catch { /* AI backend may be offline */ }

    // Also fetch scheduler status
    try {
      const schedRes = await detectionAPI.getSchedulerStatus();
      setScheduler(schedRes.data);
    } catch { /* ignore */ }
  };

  useEffect(() => {
    fetchStatus();
    pollRef.current = setInterval(fetchStatus, 3000);
    return () => { if (pollRef.current) clearInterval(pollRef.current); };
  }, []);

  const handleStart = async () => {
    setLoading(true); setError(null); setResult(null);
    try {
      await detectionAPI.start({
        source,
        medication_id: medId || 'test',
        scheduled_time: schedTime,
        display: false,
      });
      setTimeout(fetchStatus, 1000);
    } catch (err) {
      setError(err.response?.data?.error || err.response?.data?.detail || 'Failed to start');
    } finally { setLoading(false); }
  };

  const handleStop = async () => {
    setLoading(true); setError(null);
    try {
      await detectionAPI.stop();
      // Wait a brief moment for the backend finally block to finish cleanup
      setTimeout(fetchStatus, 1500);
    } catch (err) {
      setError(err.response?.data?.error || err.response?.data?.detail || 'Failed to stop');
    } finally { setLoading(false); }
  };

  const handleAnalyze = () => {
    if (status.last_result) {
      setResult(status.last_result);
      setError(null);
    } else {
      setError('No analysis result yet — the pipeline is still processing frames. Please wait a moment.');
    }
  };

  const classColor = (cls) => {
    if (cls === 'auto_verified') return 'var(--success)';
    if (cls === 'needs_confirmation') return 'var(--warning)';
    return 'var(--text-muted)';
  };

  const getPhases = (pd) => {
    if (!pd) return [];
    return [
      { name: 'Medicine Visible', score: pd.phase1_medicine_visible?.score || 0, passed: pd.phase1_medicine_visible?.pass },
      { name: 'Grip & Motion',    score: pd.phase2_grip_and_motion?.score || 0,  passed: pd.phase2_grip_and_motion?.pass },
      { name: 'Medicine Gone',    score: pd.phase3_medicine_gone?.score || 0,    passed: pd.phase3_medicine_gone?.pass },
    ];
  };

  const formatRemaining = (seconds) => {
    if (!seconds || seconds <= 0) return '0:00';
    const m = Math.floor(seconds / 60);
    const s = Math.floor(seconds % 60);
    return `${m}:${s.toString().padStart(2, '0')}`;
  };

  const session = scheduler?.active_session;

  return (
    <div>
      <div className="page-header">
        <div>
          <h2 className="page-title">AI Detection Pipeline</h2>
          <p className="page-description">Monitor and control the medication intake detection system</p>
        </div>
      </div>

      {/* Active Verification Session */}
      {session && (
        <div className="card mt-4" style={{ borderLeft: `4px solid ${session.status === 'taken' ? 'var(--success)' : session.status === 'missed' ? 'var(--danger)' : 'var(--warning)'}` }}>
          <div className="card-header">
            <div>
              <div className="card-title" style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <Timer size={18} />
                Verification Session — {session.time_slot}
              </div>
              <div className="card-subtitle">
                {session.medications?.map(m => `${m.name} (${m.dosage})`).join(', ')}
              </div>
            </div>
            <span className={`badge ${session.status === 'taken' ? 'badge-success' : session.status === 'missed' ? 'badge-danger' : 'badge-warning'}`}>
              {session.status === 'verifying' ? (
                <><Clock size={12} /> Verifying — {formatRemaining(session.time_remaining_seconds)} left</>
              ) : session.status === 'taken' ? (
                <><CheckCircle size={12} /> Taken</>
              ) : (
                <><XCircle size={12} /> Missed</>
              )}
            </span>
          </div>

          <div className="stat-grid" style={{ gridTemplateColumns: 'repeat(3, 1fr)' }}>
            <div className="stat-card">
              <div className="stat-icon primary"><Scan size={18} /></div>
              <div>
                <div className="stat-value">{session.expected_count}</div>
                <div className="stat-label">Expected</div>
              </div>
            </div>
            <div className="stat-card">
              <div className="stat-icon success"><CheckCircle size={18} /></div>
              <div>
                <div className="stat-value" style={{ color: 'var(--success)' }}>{session.medicines_taken}</div>
                <div className="stat-label">Detected</div>
              </div>
            </div>
            <div className="stat-card">
              <div className="stat-icon warning"><Clock size={18} /></div>
              <div>
                <div className="stat-value" style={{ color: session.time_remaining_seconds > 0 ? 'var(--warning)' : 'var(--danger)' }}>
                  {formatRemaining(session.time_remaining_seconds)}
                </div>
                <div className="stat-label">Time Left</div>
              </div>
            </div>
          </div>

          {/* Progress bar */}
          <div style={{ padding: '0 16px 16px' }}>
            <div style={{ background: 'var(--bg)', borderRadius: 8, height: 8, overflow: 'hidden' }}>
              <div style={{
                height: '100%',
                borderRadius: 8,
                transition: 'width 1s linear',
                width: `${Math.max(0, 100 - (session.time_remaining_seconds / 600 * 100))}%`,
                background: session.medicines_taken >= session.expected_count ? 'var(--success)' : 'var(--warning)',
              }} />
            </div>
          </div>
        </div>
      )}


      {/* Status + Controls */}
      <div className="grid-2">
        <div className="card">
          <div className="card-header">
            <div>
              <div className="card-title">Pipeline Status</div>
              <div className="card-subtitle">Real-time AI monitoring state</div>
            </div>
            <span className={`badge ${status.is_running ? 'badge-success' : status.has_result ? 'badge-warning' : 'badge-neutral'}`}>
              {status.is_running ? <><Activity size={12} /> Running</> : status.has_result ? '✓ Complete' : 'Stopped'}
            </span>
          </div>

          <div className="stat-grid" style={{ gridTemplateColumns: 'repeat(2, 1fr)', marginBottom: 16 }}>
            <div className="stat-card">
              <div className="stat-icon primary"><Scan size={18} /></div>
              <div>
                <div className="stat-value">{status.buffer_size}</div>
                <div className="stat-label">Buffer Frames</div>
              </div>
            </div>
            <div className="stat-card">
              <div className={`stat-icon ${status.is_running ? 'success' : ''}`}>
                {status.is_running ? <Play size={18} /> : <Square size={18} />}
              </div>
              <div>
                <div className="stat-value">{status.is_running ? 'Active' : 'Idle'}</div>
                <div className="stat-label">Engine State</div>
              </div>
            </div>
          </div>

          {/* Medicine Counter */}
          <div className="stat-grid" style={{ gridTemplateColumns: 'repeat(3, 1fr)' }}>
            <div className="stat-card">
              <div className="stat-icon success"><CheckCircle size={18} /></div>
              <div>
                <div className="stat-value" style={{ color: 'var(--success)' }}>{status.medicines_taken_count || 0}</div>
                <div className="stat-label">Medicines Taken</div>
              </div>
            </div>
            <div className="stat-card">
              <div className="stat-icon primary"><Scan size={18} /></div>
              <div>
                <div className="stat-value">{status.expected_medicine_count || 0}</div>
                <div className="stat-label">Expected</div>
              </div>
            </div>
            <div className="stat-card">
              <div className="stat-icon warning"><AlertTriangle size={18} /></div>
              <div>
                <div className="stat-value" style={{ color: (status.medicines_remaining || 0) > 0 ? 'var(--warning)' : 'var(--success)' }}>
                  {status.medicines_remaining || 0}
                </div>
                <div className="stat-label">Remaining</div>
              </div>
            </div>
          </div>
        </div>

        <div className="card">
          <div className="card-header">
            <div>
              <div className="card-title">Controls</div>
              <div className="card-subtitle">Start or stop the detection pipeline</div>
            </div>
          </div>

          <div className="form-group">
            <label className="form-label">Video Source</label>
            <input
              className="form-input"
              placeholder="0 for webcam, or file path"
              value={source}
              onChange={(e) => setSource(e.target.value)}
            />
          </div>
          <div className="form-group">
            <label className="form-label">Scheduled Time</label>
            <input
              className="form-input"
              type="time"
              value={schedTime}
              onChange={(e) => setSchedTime(e.target.value)}
            />
          </div>

          {error && (
            <div style={{ padding: '8px 12px', borderRadius: 8, background: 'var(--danger-light)', color: 'var(--danger)', fontSize: '0.85rem', marginBottom: 12 }}>
              <AlertTriangle size={14} style={{ display: 'inline', marginRight: 6 }} />{error}
            </div>
          )}

          <div style={{ display: 'flex', gap: 8 }}>
            {!status.is_running ? (
              <button className="btn btn-primary" onClick={handleStart} disabled={loading} style={{ flex: 1 }}>
                {loading ? <Loader size={16} className="spin" /> : <Play size={16} />} Start Pipeline
              </button>
            ) : (
              <button className="btn btn-danger" onClick={handleStop} disabled={loading} style={{ flex: 1 }}>
                {loading ? <Loader size={16} className="spin" /> : <Square size={16} />} Stop
              </button>
            )}
            <button
              className="btn btn-secondary"
              onClick={handleAnalyze}
              disabled={!status.has_result}
              style={{ flex: 1 }}
            >
              <Zap size={16} /> {status.has_result ? 'Show Results' : 'Waiting for analysis...'}
            </button>
          </div>
        </div>
      </div>

      {/* Analysis Results */}
      {result && (
        <div className="card mt-4">
          <div className="card-header">
            <div>
              <div className="card-title">Analysis Results</div>
              <div className="card-subtitle">3-Phase temporal verification output</div>
            </div>
            <span className="badge" style={{ background: classColor(result.classification) + '22', color: classColor(result.classification) }}>
              {result.classification || 'unknown'}
            </span>
          </div>

          <div className="stat-grid" style={{ gridTemplateColumns: 'repeat(4, 1fr)', marginBottom: 16 }}>
            <div className="stat-card">
              <div className="stat-value" style={{ color: 'var(--primary)' }}>
                {((result.final_confidence || 0) * 100).toFixed(0)}%
              </div>
              <div className="stat-label">Confidence</div>
            </div>
            {getPhases(result.phase_details).map((p, i) => (
              <div className="stat-card" key={i}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 4 }}>
                  {p.passed ? <CheckCircle size={14} style={{ color: 'var(--success)' }} /> : <XCircle size={14} style={{ color: 'var(--danger)' }} />}
                  <span className="text-sm font-bold">{p.name}</span>
                </div>
                <div className="stat-value">{(p.score * 100).toFixed(0)}%</div>
                <div className="stat-label">{p.passed ? 'Passed' : 'Failed'}</div>
              </div>
            ))}
          </div>

          <div style={{ padding: '12px 16px', background: 'var(--bg)', borderRadius: 8, fontSize: '0.85rem' }}>
            <strong>Frames analyzed:</strong> {result.frames_analyzed} &nbsp;|&nbsp;
            <strong>Action:</strong> {result.action} — <span className="text-muted">{result.message}</span>
          </div>
        </div>
      )}
    </div>
  );
}
