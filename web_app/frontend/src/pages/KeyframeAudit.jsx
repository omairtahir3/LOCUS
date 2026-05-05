import { useState, useEffect } from 'react';
import { detectionAPI } from '../services/api';
import { Camera, Eye, Activity, Clock, Image, ChevronDown, ChevronUp, Zap, Pill, CheckCircle } from 'lucide-react';

const PHASE_LABELS = {
  phase1_pill_visible: { label: 'Phase 1 — Pill Visible', short: 'P1', color: '#3b82f6' },
  phase2_grip_motion:  { label: 'Phase 2 — Grip & Motion', short: 'P2', color: '#f59e0b' },
  phase3_pill_gone:    { label: 'Phase 3 — Pill Gone', short: 'P3', color: '#10b981' },
};

export default function KeyframeAudit() {
  const [keyframes, setKeyframes] = useState([]);
  const [loading, setLoading] = useState(true);
  const [expanded, setExpanded] = useState({});
  const [lastResult, setLastResult] = useState(null);
  const [filter, setFilter] = useState('all'); // 'all' | 'medicine_only'

  useEffect(() => {
    loadData();
  }, []);

  const loadData = async () => {
    setLoading(true);
    try {
      const [kfRes, medKfRes, statusRes] = await Promise.all([
        detectionAPI.getKeyframes({ limit: 50 }),
        detectionAPI.getKeyframes({ limit: 50, medication_only: true }),
        detectionAPI.getStatus(),
      ]);
      
      const generalFrames = kfRes.data || [];
      const medFrames = medKfRes.data || [];
      
      // Combine and deduplicate
      const allFrames = [...medFrames, ...generalFrames];
      const uniqueFrames = Array.from(new Map(allFrames.map(f => [f.keyframe_id, f])).values());
      // Sort by date descending
      uniqueFrames.sort((a, b) => new Date(b.saved_at) - new Date(a.saved_at));
      
      setKeyframes(uniqueFrames);
      setLastResult(statusRes.data?.last_result || null);
    } catch (err) {
      console.error('Failed to load keyframes:', err);
    } finally {
      setLoading(false);
    }
  };

  const toggleExpand = (id) => {
    setExpanded(prev => ({ ...prev, [id]: !prev[id] }));
  };

  const getBlurLabel = (score) => {
    if (score >= 100) return { label: 'Sharp', color: 'var(--success)' };
    if (score >= 50) return { label: 'Soft', color: 'var(--warning)' };
    return { label: 'Blurry', color: 'var(--danger)' };
  };

  const getMotionLabel = (score) => {
    if (score >= 15) return { label: 'High', color: 'var(--danger)' };
    if (score >= 5) return { label: 'Medium', color: 'var(--warning)' };
    return { label: 'Low', color: 'var(--text-muted)' };
  };

  // Separate medicine-taken frames and general frames
  const medicineTakenFrames = keyframes.filter(kf => kf.medicine_taken);
  const generalFrames = keyframes.filter(kf => !kf.medicine_taken);
  const displayFrames = filter === 'medicine_only' ? medicineTakenFrames : keyframes;

  if (loading) {
    return <div className="empty-state"><p>Loading keyframe data...</p></div>;
  }

  return (
    <div>
      <div className="page-header">
        <div>
          <h2 className="page-title">Keyframe Confidence Audit</h2>
          <p className="page-description">Per-frame AI evidence for medication intake verification</p>
        </div>
        <div style={{ display: 'flex', gap: 8 }}>
          <button
            className={`btn btn-sm ${filter === 'all' ? 'btn-primary' : 'btn-secondary'}`}
            onClick={() => setFilter('all')}
          >All Frames ({keyframes.length})</button>
          <button
            className={`btn btn-sm ${filter === 'medicine_only' ? 'btn-primary' : 'btn-secondary'}`}
            onClick={() => setFilter('medicine_only')}
          >
            <Pill size={14} /> Medicine Evidence ({medicineTakenFrames.length})
          </button>
          <button className="btn btn-secondary btn-sm" onClick={loadData}>
            <Eye size={16} /> Refresh
          </button>
        </div>
      </div>

      {/* Latest Detection Result Summary */}
      {lastResult && (
        <div className="card" style={{ marginBottom: 24, borderLeft: `4px solid ${
          lastResult.classification === 'auto_verified' ? 'var(--success)' :
          lastResult.classification === 'needs_confirmation' ? 'var(--warning)' : 'var(--text-muted)'
        }` }}>
          <div className="card-header">
            <div>
              <div className="card-title" style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <Zap size={18} /> Latest Detection Result
              </div>
              <div className="card-subtitle">
                {lastResult.frames_analyzed} frames analyzed
              </div>
            </div>
            <span className={`badge ${
              lastResult.classification === 'auto_verified' ? 'badge-success' :
              lastResult.classification === 'needs_confirmation' ? 'badge-warning' : 'badge-neutral'
            }`}>
              {lastResult.classification || 'unknown'}
            </span>
          </div>

          <div className="stat-grid" style={{ gridTemplateColumns: 'repeat(4, 1fr)' }}>
            <div className="stat-card">
              <div className="stat-value" style={{ color: 'var(--primary)' }}>
                {((lastResult.final_confidence || 0) * 100).toFixed(0)}%
              </div>
              <div className="stat-label">Overall Confidence</div>
            </div>
            {['phase1_medicine_visible', 'phase2_grip_and_motion', 'phase3_medicine_gone'].map((key, i) => {
              const phase = lastResult.phase_details?.[key];
              const names = ['Medicine Visible', 'Grip & Motion', 'Medicine Gone'];
              return (
                <div className="stat-card" key={key}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 4 }}>
                    <span style={{
                      width: 8, height: 8, borderRadius: '50%',
                      background: phase?.pass ? 'var(--success)' : 'var(--danger)'
                    }} />
                    <span className="text-sm" style={{ fontWeight: 600 }}>{names[i]}</span>
                  </div>
                  <div className="stat-value">{((phase?.score || 0) * 100).toFixed(0)}%</div>
                  <div className="stat-label">{phase?.pass ? 'Passed' : 'Failed'}</div>
                </div>
              );
            })}
          </div>
        </div>
      )}

      {/* Medicine Verification Evidence — grouped by detection event */}
      {medicineTakenFrames.length > 0 && filter !== 'medicine_only' && (
        <div className="card" style={{ marginBottom: 24, borderLeft: '4px solid var(--success)' }}>
          <div className="card-header">
            <div>
              <div className="card-title" style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <CheckCircle size={18} color="var(--success)" /> Medicine Verification Evidence
              </div>
              <div className="card-subtitle">
                {medicineTakenFrames.length} best-evidence keyframes from verified intake(s)
              </div>
            </div>
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(220px, 1fr))', gap: 12, padding: 16 }}>
            {medicineTakenFrames.map(kf => {
              const phaseInfo = PHASE_LABELS[kf.phase_role] || { label: kf.phase_role, short: '??', color: '#888' };
              return (
                <div key={kf.keyframe_id} style={{
                  border: `2px solid ${phaseInfo.color}44`,
                  borderRadius: 'var(--radius-md)',
                  overflow: 'hidden',
                  background: 'var(--surface)',
                }}>
                  <img
                    src={detectionAPI.getKeyframeImage(kf.keyframe_id)}
                    alt={phaseInfo.label}
                    style={{ width: '100%', height: 140, objectFit: 'cover', borderBottom: `2px solid ${phaseInfo.color}44` }}
                    onError={(e) => { e.target.style.display = 'none'; }}
                  />
                  <div style={{ padding: '10px 12px' }}>
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 6 }}>
                      <span className="badge" style={{
                        background: phaseInfo.color + '22', color: phaseInfo.color,
                        fontSize: '0.7rem', fontWeight: 700
                      }}>{phaseInfo.short}</span>
                      <span style={{ fontSize: '0.7rem', color: 'var(--text-muted)' }}>
                        {((kf.detection_confidence || 0) * 100).toFixed(0)}% conf
                      </span>
                    </div>
                    <div style={{ fontSize: '0.78rem', fontWeight: 600, marginBottom: 2 }}>{phaseInfo.label}</div>
                    <div style={{ fontSize: '0.7rem', color: 'var(--text-muted)' }}>
                      {kf.medication_name || 'Unknown'} · {kf.detection_status}
                    </div>
                    <div style={{ fontSize: '0.65rem', color: 'var(--text-muted)', marginTop: 4 }}>
                      {kf.detected_at ? new Date(kf.detected_at).toLocaleString() : ''}
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      )}

      {/* Keyframe Timeline */}
      <div className="card">
        <div className="card-header">
          <div>
            <div className="card-title"><Camera size={18} style={{ display: 'inline', marginRight: 8 }} />
              {filter === 'medicine_only' ? 'Medicine Evidence Frames' : 'Captured Keyframes'}
            </div>
            <div className="card-subtitle">{displayFrames.length} frames</div>
          </div>
        </div>

        {displayFrames.length === 0 ? (
          <div className="empty-state">
            <Image size={48} />
            <h3>No keyframes captured yet</h3>
            <p>Run the AI detection pipeline to capture keyframes for auditing.</p>
          </div>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            {displayFrames.map((kf) => {
              const blur = getBlurLabel(kf.blur_score || 0);
              const motion = getMotionLabel(kf.motion_score || 0);
              const isOpen = expanded[kf.keyframe_id];
              const isMedFrame = kf.medicine_taken;
              const phaseInfo = PHASE_LABELS[kf.phase_role];

              return (
                <div key={kf.keyframe_id} style={{
                  border: isMedFrame ? `2px solid ${phaseInfo?.color || 'var(--success)'}66` : '1px solid var(--border)',
                  borderRadius: 'var(--radius-md)',
                  overflow: 'hidden',
                  transition: 'all 0.2s ease',
                  background: isMedFrame ? `${phaseInfo?.color || 'var(--success)'}08` : 'transparent',
                }}>
                  {/* Header row */}
                  <div
                    onClick={() => toggleExpand(kf.keyframe_id)}
                    style={{
                      display: 'flex', alignItems: 'center', gap: 16,
                      padding: '12px 16px', cursor: 'pointer',
                      background: isOpen ? 'var(--surface-hover)' : 'transparent',
                      transition: 'background 0.15s',
                    }}
                  >
                    <div style={{
                      width: 48, height: 48, borderRadius: 'var(--radius-sm)',
                      overflow: 'hidden', flexShrink: 0, border: '1px solid var(--border)',
                      background: '#f1f5f9'
                    }}>
                      <img
                        src={detectionAPI.getKeyframeImage(kf.keyframe_id)}
                        alt=""
                        style={{ width: '100%', height: '100%', objectFit: 'cover' }}
                        onError={(e) => { e.target.style.display = 'none'; }}
                      />
                    </div>
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div style={{ fontSize: '0.85rem', fontWeight: 600, display: 'flex', alignItems: 'center', gap: 8 }}>
                        <Clock size={12} />
                        {kf.saved_at ? new Date(kf.saved_at).toLocaleString() : 'Unknown time'}
                        {isMedFrame && phaseInfo && (
                          <span className="badge" style={{
                            background: phaseInfo.color + '22', color: phaseInfo.color,
                            fontSize: '0.65rem', fontWeight: 700
                          }}>{phaseInfo.short} · {kf.medication_name}</span>
                        )}
                      </div>
                      <div style={{ fontSize: '0.75rem', color: 'var(--text-muted)', marginTop: 2 }}>
                        {kf.width}x{kf.height}
                        {isMedFrame && ` · ${((kf.detection_confidence || 0) * 100).toFixed(0)}% confidence · ${kf.detection_status}`}
                      </div>
                    </div>
                    <div style={{ display: 'flex', gap: 12, alignItems: 'center' }}>
                      {isMedFrame && (
                        <div style={{ textAlign: 'center' }}>
                          <div style={{ fontSize: '0.7rem', fontWeight: 600, color: 'var(--text-muted)' }}>PHASE</div>
                          <span className="badge" style={{
                            background: (phaseInfo?.color || '#888') + '22',
                            color: phaseInfo?.color || '#888', fontSize: '0.7rem'
                          }}>{((kf.phase_score || 0) * 100).toFixed(0)}%</span>
                        </div>
                      )}
                      <div style={{ textAlign: 'center' }}>
                        <div style={{ fontSize: '0.7rem', fontWeight: 600, color: 'var(--text-muted)' }}>BLUR</div>
                        <span className="badge" style={{
                          background: blur.color + '22', color: blur.color, fontSize: '0.7rem'
                        }}>{blur.label} ({(kf.blur_score || 0).toFixed(0)})</span>
                      </div>
                      <div style={{ textAlign: 'center' }}>
                        <div style={{ fontSize: '0.7rem', fontWeight: 600, color: 'var(--text-muted)' }}>MOTION</div>
                        <span className="badge" style={{
                          background: motion.color + '22', color: motion.color, fontSize: '0.7rem'
                        }}>{motion.label} ({(kf.motion_score || 0).toFixed(1)})</span>
                      </div>
                    </div>
                    {isOpen ? <ChevronUp size={16} /> : <ChevronDown size={16} />}
                  </div>

                  {/* Expanded view: full image */}
                  {isOpen && (
                    <div style={{ padding: 16, borderTop: '1px solid var(--border-light)' }}>
                      <img
                        src={detectionAPI.getKeyframeImage(kf.keyframe_id)}
                        alt={`Keyframe ${kf.keyframe_id}`}
                        style={{
                          width: '100%', maxHeight: 400, objectFit: 'contain',
                          borderRadius: 'var(--radius-md)', background: '#000'
                        }}
                      />
                      <div style={{
                        marginTop: 12, fontSize: '0.8rem', color: 'var(--text-secondary)',
                        display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 12
                      }}>
                        <div><strong>ID:</strong> {kf.keyframe_id?.slice(0, 8)}...</div>
                        <div><strong>Blur Score:</strong> {(kf.blur_score || 0).toFixed(1)}</div>
                        <div><strong>Motion Score:</strong> {(kf.motion_score || 0).toFixed(1)}</div>
                        {isMedFrame && (
                          <>
                            <div><strong>Medicine:</strong> {kf.medication_name}</div>
                            <div><strong>Phase:</strong> {phaseInfo?.label || kf.phase_role}</div>
                            <div><strong>Status:</strong> {kf.detection_status}</div>
                          </>
                        )}
                      </div>
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}
