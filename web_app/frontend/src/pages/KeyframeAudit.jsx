import { useState, useEffect } from 'react';
import { eventLogsAPI, relationshipsAPI, detectionAPI, caregiverAPI } from '../services/api';
// Local IDB import removed
import { useAuth } from '../context/AuthContext';
import { Camera, Eye, Activity, Clock, Image, ChevronDown, ChevronUp, Zap, Pill, CheckCircle, User, AlertTriangle } from 'lucide-react';
import UserSelector from '../components/Layout/UserSelector';

const PHASE_LABELS = {
  phase1_pill_visible: { label: 'Phase 1 — Pill Visible', short: 'P1', color: '#3b82f6' },
  phase2_grip_motion:  { label: 'Phase 2 — Grip & Motion', short: 'P2', color: '#f59e0b' },
  phase3_pill_gone:    { label: 'Phase 3 — Pill Gone', short: 'P3', color: '#10b981' },
};

export default function KeyframeAudit() {
  const { user } = useAuth();
  const { selectedUser, setSelectedUser } = useSelectedUser();
  const [keyframes, setKeyframes] = useState([]);
  const [evidenceFrames, setEvidenceFrames] = useState([]);
  const [unknownFaces, setUnknownFaces] = useState([]);
  const [namingEvent, setNamingEvent] = useState(null);
  const [personName, setPersonName] = useState('');
  const [relationshipType, setRelationshipType] = useState('');
  
  // Duplicate resolution state
  const [duplicateConflicts, setDuplicateConflicts] = useState(null);
  const [userMap, setUserMap] = useState({});
  const [loading, setLoading] = useState(true);
  const [expanded, setExpanded] = useState({});
  const [lastResult, setLastResult] = useState(null);
  const [filter, setFilter] = useState('all'); // 'all' | 'medicine_only'
  const [page, setPage] = useState(1);
  const [users, setUsers] = useState([]);
  const PER_PAGE = 12;

  useEffect(() => {
    loadData();
    // Auto-refresh every 30 seconds
    const interval = setInterval(loadData, 30000);
    return () => clearInterval(interval);
  }, [user, selectedUser]);

  const loadData = async () => {
    try {
      let currentSelectedUser = selectedUser;
      let map = {};
      
      if (user?.role === 'caregiver') {
        const usersRes = await caregiverAPI.getUsers().catch(() => ({ data: [] }));
        const list = usersRes.data || [];
        setUsers(list);
        list.forEach(u => {
          map[u._id] = u.name;
        });
        
        if (list.length > 0 && !currentSelectedUser) {
          currentSelectedUser = list[0]._id;
          setSelectedUser(currentSelectedUser);
        }
      }
      
      const queryParams = { limit: 40 };
      if (currentSelectedUser) {
        queryParams.user_id = currentSelectedUser;
      }

      // Don't pass user_id — the Node.js proxy handles filtering by role:
      // caregivers see monitored users' frames, normal users see only their own
      const [kfRes, evidenceRes, statusRes, unknownFacesRes] = await Promise.all([
        detectionAPI.getKeyframes(queryParams),
        detectionAPI.getMedicationFrames(queryParams).catch(() => ({ data: [] })),
        detectionAPI.getStatus(),
        eventLogsAPI.getKeyframes({ type: 'unknown_face', limit: 40 }).catch(() => ({ data: [] })),
      ]);
      
      let allFrames = kfRes.data || [];
      
      // Local IndexedDB merging is disabled. Keyframes are now fetched centrally.
      
      allFrames.sort((a, b) => new Date(b.saved_at) - new Date(a.saved_at));
      
      const evidence = evidenceRes.data || [];
      evidence.sort((a, b) => new Date(b.saved_at || b.detected_at || 0) - new Date(a.saved_at || a.detected_at || 0));
      
      setUserMap(map);
      setKeyframes(allFrames);
      setEvidenceFrames(evidence);
      setUnknownFaces(unknownFacesRes.data || []);
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

  // Evidence frames from dedicated evidence storage
  const medicineTakenFrames = evidenceFrames;
  
  const handleConfirmFace = async (force_new = false, merge_into = null) => {
    if (!personName) return;
    try {
      await relationshipsAPI.confirmFace({
        eventId: namingEvent._id,
        personName,
        relationshipType,
        force_new,
        merge_into
      });
      setNamingEvent(null);
      setPersonName('');
      setRelationshipType('');
      setDuplicateConflicts(null);
      loadData();
    } catch (e) {
      if (e.response?.status === 409 && e.response.data.duplicates) {
        setDuplicateConflicts(e.response.data.duplicates);
      } else {
        alert(e.response?.data?.error || 'Error confirming face');
      }
    }
  };

  const handleDismissFace = async (eventId) => {
    try {
      await relationshipsAPI.dismissFace({ eventId });
      loadData();
    } catch (e) {
      alert(e.response?.data?.error || 'Error dismissing face');
    }
  };

  const handleAcknowledge = async (eventId) => {
    try {
      await relationshipsAPI.acknowledgeAction({ eventId });
      loadData();
    } catch (e) {
      alert('Error acknowledging');
    }
  };

  const displayFrames = filter === 'medicine_only' ? [] : keyframes;

  if (loading) {
    return <div className="empty-state"><p>Loading keyframe data...</p></div>;
  }

  return (
    <div style={{ padding: '0 20px', maxWidth: '1400px', margin: '0 auto', marginBottom: '80px' }}>
      <div className="page-header" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <div>
          <h2 className="page-title">Keyframe Confidence Audit</h2>
          <p className="page-description">Per-frame AI evidence for medication intake verification</p>
        </div>
        <UserSelector />
        <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
          <button
            className={`btn btn-sm ${filter === 'all' ? 'btn-primary' : 'btn-secondary'}`}
            onClick={() => setFilter('all')}
          >All Frames ({keyframes.length})</button>
          <button
            className={`btn btn-sm ${filter === 'medicine_only' ? 'btn-primary' : 'btn-secondary'}`}
            onClick={() => setFilter('medicine_only')}
          >
            <Pill size={14} /> Medicine Evidence ({evidenceFrames.length})
          </button>
          <button
            className={`btn btn-sm ${filter === 'unknown_faces' ? 'btn-primary' : 'btn-secondary'}`}
            onClick={() => setFilter('unknown_faces')}
          >
            <User size={14} /> Unknown Faces ({unknownFaces.length})
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

          <div className="stat-grid">
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

      {/* Medicine Verification Evidence — from evidence_storage */}
      {evidenceFrames.length > 0 && (
        <div className="card" style={{ marginBottom: 24, borderLeft: '4px solid var(--success)' }}>
          <div className="card-header">
            <div>
              <div className="card-title" style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <CheckCircle size={18} color="var(--success)" /> Medicine Verification Evidence
              </div>
              <div className="card-subtitle">
                {evidenceFrames.length} evidence frame(s) from AI detection
              </div>
            </div>
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(220px, 1fr))', gap: 12, padding: 16 }}>
            {evidenceFrames.map(ev => {
              const phaseInfo = PHASE_LABELS[ev.phase_role] || { label: ev.phase_role || 'Evidence', short: '??', color: '#888' };
              const evId = ev.id || ev.keyframe_id;
              return (
                <div key={evId} style={{
                  border: `2px solid ${phaseInfo.color}44`,
                  borderRadius: 'var(--radius-md)',
                  overflow: 'hidden',
                  background: 'var(--surface)',
                }}>
                  <img
                    loading="lazy"
                    src={detectionAPI.getMedicationFrameImage(evId)}
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
                        {((ev.detection_confidence || ev.phase_score || 0) * 100).toFixed(0)}% conf
                      </span>
                    </div>
                    <div style={{ fontSize: '0.78rem', fontWeight: 600, marginBottom: 2 }}>{phaseInfo.label}</div>
                    {user?.role === 'caregiver' && (
                      <div style={{ fontSize: '0.75rem', fontWeight: 500, display: 'flex', alignItems: 'center', gap: 4, marginBottom: 2, color: 'var(--primary)' }}>
                        <User size={12} /> {userMap[ev.user_id] || 'Unknown User'}
                      </div>
                    )}
                    <div style={{ fontSize: '0.7rem', color: 'var(--text-muted)' }}>
                      {ev.medication_name || 'Unknown'} · {ev.detection_status || ''}
                    </div>
                    <div style={{ fontSize: '0.65rem', color: 'var(--text-muted)', marginTop: 4 }}>
                      {(ev.saved_at || ev.detected_at) ? new Date(ev.saved_at || ev.detected_at).toLocaleString() : ''}
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      )}

      {/* Keyframe Timeline / Medicine Evidence Grid */}
      <div className="card">
        <div className="card-header">
          <div>
            <div className="card-title"><Camera size={18} style={{ display: 'inline', marginRight: 8 }} />
              {filter === 'medicine_only' ? 'Medicine Evidence Frames' : filter === 'unknown_faces' ? 'Unknown Faces' : 'Captured Keyframes'}
            </div>
            <div className="card-subtitle">
              {filter === 'medicine_only' ? `${evidenceFrames.length} evidence frames` : filter === 'unknown_faces' ? `${unknownFaces.length} unknown faces` : `${keyframes.length} frames`}
            </div>
          </div>
        </div>

        {filter === 'medicine_only' ? (
          /* ─── Medicine Evidence Grid ─── */
          evidenceFrames.length === 0 ? (
            <div className="empty-state">
              <Image size={48} />
              <h3>No medicine evidence yet</h3>
              <p>Evidence frames are captured when the AI pipeline detects medication intake.</p>
            </div>
          ) : (
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(280px, 1fr))', gap: 12, padding: 16 }}>
              {evidenceFrames.map(ev => {
                const phaseInfo = PHASE_LABELS[ev.phase_role] || { label: ev.phase_role || 'Evidence', short: '??', color: '#888' };
                const evId = ev.id || ev.keyframe_id;
                const isOpen = expanded[evId];
                return (
                  <div key={evId} style={{
                    border: `2px solid ${phaseInfo.color}44`,
                    borderRadius: 'var(--radius-md)',
                    overflow: 'hidden',
                    background: 'var(--surface)',
                    position: 'relative'
                  }}>
                    {/* Expand/Collapse Header */}
                    <div 
                      onClick={() => setExpanded(prev => ({ ...prev, [evId]: !prev[evId] }))}
                      style={{ padding: '10px 12px', display: 'flex', gap: 12, cursor: 'pointer', background: 'var(--surface-hover)', alignItems: 'center' }}
                    >
                      <img 
                        src={detectionAPI.getMedicationFrameImage(evId)}
                        alt={phaseInfo.label}
                        style={{ width: '100%', height: 180, objectFit: 'cover', borderBottom: `2px solid ${phaseInfo.color}44` }}
                        onError={(e) => { e.target.style.display = 'none'; }}
                      />
                    <div style={{ padding: '10px 12px' }}>
                      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 6 }}>
                        <span className="badge" style={{
                          background: phaseInfo.color + '22', color: phaseInfo.color,
                          fontSize: '0.7rem', fontWeight: 700
                        }}>{phaseInfo.short}</span>
                        <span className="badge" style={{
                          background: ev.detection_status === 'taken' ? 'var(--success)22' : 'var(--warning)22',
                          color: ev.detection_status === 'taken' ? 'var(--success)' : 'var(--warning)',
                          fontSize: '0.65rem', fontWeight: 600
                        }}>{ev.detection_status || 'pending'}</span>
                      </div>
                      <div style={{ fontSize: '0.78rem', fontWeight: 600, marginBottom: 2 }}>{phaseInfo.label}</div>
                      {user?.role === 'caregiver' && (
                        <div style={{ fontSize: '0.75rem', fontWeight: 500, display: 'flex', alignItems: 'center', gap: 4, marginBottom: 2, color: 'var(--primary)' }}>
                          <User size={12} /> {userMap[ev.user_id] || 'Unknown User'}
                        </div>
                      )}
                      <div style={{ fontSize: '0.7rem', color: 'var(--text-muted)' }}>
                        {ev.medication_name || 'Unknown'} · {((ev.detection_confidence || ev.phase_score || 0) * 100).toFixed(0)}% confidence
                      </div>
                      <div style={{ fontSize: '0.65rem', color: 'var(--text-muted)', marginTop: 4 }}>
                        {(ev.saved_at || ev.detected_at) ? new Date(ev.saved_at || ev.detected_at).toLocaleString() : ''}
                      </div>
                      </div>
                    </div>
                    {/* Expanded: full-size image */}
                    {isOpen && (
                      <div style={{ padding: 12, borderTop: '1px solid var(--border-light)' }}>
                        <img
                          src={detectionAPI.getMedicationFrameImage(evId)}
                          alt={`Evidence ${evId}`}
                          style={{ width: '100%', maxHeight: 400, objectFit: 'contain', borderRadius: 'var(--radius-md)', background: '#000' }}
                        />
                        <div style={{ marginTop: 8, fontSize: '0.75rem', color: 'var(--text-secondary)', display: 'grid', gridTemplateColumns: 'repeat(2, 1fr)', gap: 8 }}>
                          <div><strong>ID:</strong> {evId?.slice(0, 8)}...</div>
                          <div><strong>Phase:</strong> {phaseInfo.label}</div>
                          <div><strong>Medicine:</strong> {ev.medication_name}</div>
                          <div><strong>Status:</strong> {ev.detection_status}</div>
                          <div><strong>Confidence:</strong> {((ev.detection_confidence || 0) * 100).toFixed(1)}%</div>
                          <div><strong>Phase Score:</strong> {((ev.phase_score || 0) * 100).toFixed(1)}%</div>
                        </div>
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          )
        ) : filter === 'unknown_faces' ? (
          /* ─── Unknown Faces Grid ─── */
          unknownFaces.length === 0 ? (
            <div className="empty-state">
              <User size={48} />
              <h3>No unknown faces detected</h3>
              <p>When the system detects a face it doesn't recognize, it will appear here for you to name or dismiss.</p>
            </div>
          ) : (
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(280px, 1fr))', gap: 12, padding: 16 }}>
              {unknownFaces.map(ev => {
                const evId = ev._id;
                const kfId = ev.keyframe_id;
                return (
                  <div key={evId} style={{
                    border: `1px solid var(--border)`,
                    borderRadius: 'var(--radius-md)',
                    overflow: 'hidden',
                    background: 'var(--surface)',
                    position: 'relative'
                  }}>
                    {kfId && (
                      <img
                        loading="lazy"
                        src={detectionAPI.getKeyframeImage(kfId)}
                        alt="Unknown Face"
                        style={{ width: '100%', height: 200, objectFit: 'cover' }}
                        onError={(e) => { e.target.style.display = 'none'; }}
                      />
                    )}
                    <div style={{ padding: '12px' }}>
                      <div style={{ fontSize: '0.85rem', fontWeight: 600, marginBottom: 8 }}>Unknown Person Detected</div>
                      <div style={{ fontSize: '0.75rem', color: 'var(--text-muted)', marginBottom: 16 }}>
                        {new Date(ev.timestamp).toLocaleString()}
                      </div>
                      <div style={{ display: 'flex', gap: 8 }}>
                        <button className="btn btn-primary btn-sm" style={{ flex: 1 }} onClick={() => setNamingEvent(ev)}>Name Person</button>
                        <button className="btn btn-secondary btn-sm" style={{ flex: 1 }} onClick={() => handleDismissFace(evId)}>Dismiss</button>
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>
          )
        ) : (
          /* ─── Regular Keyframes List ─── */
          keyframes.length === 0 ? (
            <div className="empty-state">
              <Image size={48} />
              <h3>No keyframes captured yet</h3>
              <p>Run the AI detection pipeline to capture keyframes for auditing.</p>
            </div>
          ) : (
          <>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
              {keyframes.slice((page - 1) * PER_PAGE, page * PER_PAGE).map((kf) => {
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
                        loading="lazy"
                        src={kf.base64_image ? `data:image/jpeg;base64,${kf.base64_image}` : detectionAPI.getKeyframeImage(kf.keyframe_id)}
                        alt=""
                        style={{ width: '100%', height: '100%', objectFit: 'cover' }}
                        onError={(e) => { e.target.style.display = 'none'; }}
                      />
                    </div>
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div style={{ fontSize: '0.85rem', fontWeight: 600, display: 'flex', alignItems: 'center', gap: 8 }}>
                        <Clock size={12} />
                        {kf.saved_at ? new Date(kf.saved_at).toLocaleString() : 'Unknown time'}
                        {user?.role === 'caregiver' && (
                          <span className="badge" style={{ background: 'var(--primary-light)', color: 'var(--primary)', fontSize: '0.65rem', display: 'inline-flex', alignItems: 'center' }}>
                            <User size={10} style={{ marginRight: 4 }} />
                            {userMap[kf.user_id] || 'Unknown User'}
                          </span>
                        )}
                        {isMedFrame && phaseInfo && (
                          <span className="badge" style={{
                            background: phaseInfo.color + '22', color: phaseInfo.color,
                            fontSize: '0.65rem', fontWeight: 700
                          }}>{phaseInfo.short} · {kf.medication_name}</span>
                        )}
                        {kf.type === 'face_crop' && (
                          <span className="badge" style={{
                            background: 'var(--primary-light)', color: 'var(--primary)',
                            fontSize: '0.65rem', fontWeight: 700
                          }}>Face Crop</span>
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
                        loading="lazy"
                        src={kf.base64_image ? `data:image/jpeg;base64,${kf.base64_image}` : detectionAPI.getKeyframeImage(kf.keyframe_id)}
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

            {/* Pagination controls */}
            {keyframes.length > PER_PAGE && (
              <div style={{
                display: 'flex', justifyContent: 'center', alignItems: 'center',
                gap: 12, padding: '16px 0'
              }}>
                <button
                  className="btn btn-sm btn-secondary"
                  disabled={page <= 1}
                  onClick={() => setPage(p => Math.max(1, p - 1))}
                >Previous</button>
                <span style={{ fontSize: '0.85rem', color: 'var(--text-secondary)' }}>
                  Page {page} of {Math.ceil(keyframes.length / PER_PAGE)}
                </span>
                <button
                  className="btn btn-sm btn-secondary"
                  disabled={page >= Math.ceil(keyframes.length / PER_PAGE)}
                  onClick={() => setPage(p => p + 1)}
                >Next</button>
              </div>
            )}
          </>
          )
        )}
      </div>

      {/* Name Person Modal */}
      {namingEvent && (
        <div style={{
          position: 'fixed', top: 0, left: 0, right: 0, bottom: 0,
          background: 'rgba(0,0,0,0.5)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 1000
        }}>
          <div className="card" style={{ width: 400, maxWidth: '90%', padding: 24 }}>
            <h3>Name this Person</h3>
            <div style={{ marginTop: 16 }}>
              <label className="form-label">Name</label>
              <input type="text" className="form-input" value={personName} onChange={e => setPersonName(e.target.value)} placeholder="e.g., John Doe" />
            </div>
            <div style={{ marginTop: 16 }}>
              <label className="form-label">Relationship (Optional)</label>
              <input type="text" className="form-input" value={relationshipType} onChange={e => setRelationshipType(e.target.value)} placeholder="e.g., Son, Caregiver" />
            </div>
            <div style={{ display: 'flex', gap: 12, marginTop: 24, justifyContent: 'flex-end' }}>
              <button className="btn btn-secondary" onClick={() => { setNamingEvent(null); setPersonName(''); setRelationshipType(''); setDuplicateConflicts(null); }}>Cancel</button>
              <button className="btn btn-primary" onClick={() => handleConfirmFace(false, null)} disabled={!personName}>Confirm</button>
            </div>
          </div>
        </div>
      )}

      {/* Duplicate Resolution Modal */}
      {duplicateConflicts && (
        <div style={{
          position: 'fixed', top: 0, left: 0, right: 0, bottom: 0,
          background: 'rgba(0,0,0,0.6)', backdropFilter: 'blur(4px)',
          display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 1000, padding: 20
        }}>
          <div className="card" style={{ width: '100%', maxWidth: 500 }}>
            <h3 style={{ marginBottom: 12, display: 'flex', alignItems: 'center', gap: 8, color: 'var(--warning-dark)' }}>
              <AlertTriangle size={20} />
              Duplicate Name Detected
            </h3>
            <p style={{ marginBottom: 16, fontSize: '0.9rem', color: 'var(--text-secondary)' }}>
              You already have {duplicateConflicts.length} record(s) for "{personName}". 
              Are you confirming the same person from a different angle, or is this a new person who shares the same name?
            </p>
            
            <div style={{ display: 'flex', flexDirection: 'column', gap: 10, maxHeight: 300, overflowY: 'auto', marginBottom: 20 }}>
              {duplicateConflicts.map(dup => (
                <button 
                  key={dup.id}
                  onClick={() => handleConfirmFace(false, dup.id)}
                  style={{ 
                    padding: 12, borderRadius: 8, border: '1px solid var(--border-light)', 
                    background: '#fff', textAlign: 'left', cursor: 'pointer', transition: 'all 0.2s'
                  }}
                  className="hover:border-primary hover:bg-primary-50"
                >
                  <div style={{ fontWeight: 600 }}>Merge into {dup.name}</div>
                  <div style={{ fontSize: '0.8rem', color: 'var(--text-muted)' }}>
                    {dup.relationship_type ? `Relation: ${dup.relationship_type}` : 'No relation set'} | Added {new Date(dup.createdAt).toLocaleDateString()}
                  </div>
                </button>
              ))}
            </div>

            <div style={{ display: 'flex', gap: 12, justifyContent: 'space-between', borderTop: '1px solid var(--border-light)', paddingTop: 16 }}>
              <button className="btn btn-secondary" onClick={() => setDuplicateConflicts(null)}>Back</button>
              <button className="btn btn-outline-primary" onClick={() => handleConfirmFace(true, null)}>
                Keep Separate (New Person)
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
