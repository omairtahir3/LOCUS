import { useState, useEffect } from 'react';
import { detectionAPI } from '../services/api';
import { Camera, Eye, Activity, Clock, Image, ChevronDown, ChevronUp, Zap } from 'lucide-react';

export default function KeyframeAudit() {
  const [keyframes, setKeyframes] = useState([]);
  const [loading, setLoading] = useState(true);
  const [expanded, setExpanded] = useState({});
  const [lastResult, setLastResult] = useState(null);

  useEffect(() => {
    loadData();
  }, []);

  const loadData = async () => {
    setLoading(true);
    try {
      const [kfRes, statusRes] = await Promise.all([
        detectionAPI.getKeyframes({ limit: 50 }),
        detectionAPI.getStatus(),
      ]);
      setKeyframes(kfRes.data || []);
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
        <button className="btn btn-secondary btn-sm" onClick={loadData}>
          <Eye size={16} /> Refresh
        </button>
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

      {/* Keyframe Timeline */}
      <div className="card">
        <div className="card-header">
          <div>
            <div className="card-title"><Camera size={18} style={{ display: 'inline', marginRight: 8 }} />Captured Keyframes</div>
            <div className="card-subtitle">{keyframes.length} frames stored on disk</div>
          </div>
        </div>

        {keyframes.length === 0 ? (
          <div className="empty-state">
            <Image size={48} />
            <h3>No keyframes captured yet</h3>
            <p>Run the AI detection pipeline to capture keyframes for auditing.</p>
          </div>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            {keyframes.map((kf) => {
              const blur = getBlurLabel(kf.blur_score || 0);
              const motion = getMotionLabel(kf.motion_score || 0);
              const isOpen = expanded[kf.keyframe_id];

              return (
                <div key={kf.keyframe_id} style={{
                  border: '1px solid var(--border)',
                  borderRadius: 'var(--radius-md)',
                  overflow: 'hidden',
                  transition: 'all 0.2s ease'
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
                      </div>
                      <div style={{ fontSize: '0.75rem', color: 'var(--text-muted)', marginTop: 2 }}>
                        {kf.width}x{kf.height}
                      </div>
                    </div>
                    <div style={{ display: 'flex', gap: 12, alignItems: 'center' }}>
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
