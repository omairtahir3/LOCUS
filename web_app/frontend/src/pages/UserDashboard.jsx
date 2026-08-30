import { useState, useEffect } from 'react';
import { userAPI, authAPI, detectionAPI } from '../services/api';
import { formatTime12Hour } from '../utils/dateUtils';
import { useAuth } from '../context/AuthContext';
import {
  Pill, CheckCircle, XCircle, Clock, AlertTriangle, TrendingUp,
  ChevronRight, Calendar, Zap, Bell, Target, ArrowRight, Activity, Camera
} from 'lucide-react';

export default function UserDashboard() {
  const { user } = useAuth();
  const [schedule, setSchedule] = useState([]);
  const [adherence, setAdherence] = useState(null);
  const [loading, setLoading] = useState(true);

  // AI Config State
  const [configModal, setConfigModal] = useState(false);
  const [cameraUrl, setCameraUrl] = useState('');
  const [savingConfig, setSavingConfig] = useState(false);
  const [rtmpHost, setRtmpHost] = useState('');

  useEffect(() => {
    loadData();
    authAPI.getRtmpHost().then(res => setRtmpHost(res.data.host)).catch(() => setRtmpHost(window.location.hostname));
    const interval = setInterval(() => {
      if (!document.hidden) loadData();
    }, 30000);
    return () => clearInterval(interval);
  }, []);

  const loadData = async () => {
    try {
      const [schedRes, adhRes] = await Promise.all([
        userAPI.getSchedule(),
        userAPI.getAdherence(),
      ]);
      setSchedule(schedRes.data || []);
      setAdherence(adhRes.data || null);
    } catch (err) {
      console.error('Dashboard load error:', err);
    } finally {
      setLoading(false);
    }
  };

  const markAsTaken = async (item) => {
    try {
      if (item.id) {
        await userAPI.updateLog(item.id, {
          status: 'taken',
          verification_method: 'manual',
          notes: 'Manually verified'
        });
      } else {
        const timeParts = item.scheduled_time.split(':');
        const dt = new Date();
        dt.setHours(parseInt(timeParts[0], 10), parseInt(timeParts[1], 10), 0, 0);
        await userAPI.createLog({
          medication_id: item.medication_id,
          scheduled_time: dt.toISOString(),
          status: 'taken',
          verification_method: 'manual',
        });
      }
      loadData();
    } catch (err) {
      console.error('Failed to update medication status:', err);
    }
  };

  const markAsMissed = async (item) => {
    try {
      if (item.id || item.log_id) {
        await userAPI.updateLog(item.log_id || item.id, {
          status: 'missed',
          verification_method: 'manual',
          notes: 'Manually marked as missed'
        });
      } else {
        const timeParts = item.scheduled_time.split(':');
        const dt = new Date();
        dt.setHours(parseInt(timeParts[0], 10), parseInt(timeParts[1], 10), 0, 0);
        await userAPI.createLog({
          medication_id: item.medication_id,
          scheduled_time: dt.toISOString(),
          status: 'missed',
          verification_method: 'manual',
        });
      }
      loadData();
    } catch (err) {
      console.error('Failed to mark as missed:', err);
    }
  };

  const markAsCameraOff = async (item) => {
    try {
      if (item.id || item.log_id) {
        await userAPI.updateLog(item.log_id || item.id, {
          status: 'camera_off',
          verification_method: 'manual',
          notes: 'Manually marked as camera off'
        });
      } else {
        const timeParts = item.scheduled_time.split(':');
        const dt = new Date();
        dt.setHours(parseInt(timeParts[0], 10), parseInt(timeParts[1], 10), 0, 0);
        await userAPI.createLog({
          medication_id: item.medication_id,
          scheduled_time: dt.toISOString(),
          status: 'camera_off',
          verification_method: 'manual',
        });
      }
      loadData();
    } catch (err) {
      console.error('Failed to update medication status:', err);
    }
  };

  const saveCameraConfig = async () => {
    setSavingConfig(true);
    try {
      let finalUrl = cameraUrl.replace('rtsp://locus_ai:LocusRead2026@127.0.0.1:8554/live/', '');
      if (finalUrl && !finalUrl.startsWith('rtsp')) {
        finalUrl = `rtsp://locus_ai:LocusRead2026@127.0.0.1:8554/live/${finalUrl}`;
      }

      await detectionAPI.configure({
        user_id: user._id,
        camera_stream_url: finalUrl
      });
      
      // Update user context temporarily so the UI reflects changes without full reload
      if (user) {
        user.camera_stream_url = finalUrl;
      }

      setConfigModal(false);
    } catch (err) {
      alert('Failed to save AI configuration');
    } finally {
      setSavingConfig(false);
    }
  };

  const dismissMed = async (item) => {
    try {
      // Set back to scheduled — the AI pipeline continues watching and
      // will update the status to "needs_verification" if it detects intake.
      if (item.log_id || item.id) {
        await userAPI.updateLog(item.log_id || item.id, {
          status: 'scheduled',
          notes: 'Dismissed — awaiting camera verification',
        });
      }
      loadData();
    } catch (err) {
      console.error('Failed to dismiss medication:', err);
    }
  };

  const snoozeMed = async (item) => {
    try {
      if (item.log_id || item.id) {
        await userAPI.snoozeLog(item.log_id || item.id, { snooze_duration_minutes: 10 });
      }
      loadData();
    } catch (err) {
      console.error('Failed to snooze medication:', err);
    }
  };

  const adherencePercent = adherence?.overall_adherence ?? adherence?.adherence_percentage ?? 0;
  const todayAdherence = adherence?.adherence_percentage || 0;
  const takenWeek = adherence?.total_taken || adherence?.taken || 0;
  const totalWeek = adherence?.total_scheduled || 0;
  const missedWeek = adherence?.total_missed || adherence?.missed || 0;
  const skippedWeek = adherence?.skipped || 0;

  const todayTotal = schedule.length;
  const todayTaken = schedule.filter(s => s.status === 'taken').length;
  const todayUpcoming = schedule.filter(s => s.status === 'scheduled' || (s.status === 'camera_off' && s.notes === 'pending_camera_verification')).length;

  const upcoming = schedule
    .filter(s => s.status === 'scheduled')
    .sort((a, b) => {
      const ta = a.scheduled_time?.split(':') || [0, 0];
      const tb = b.scheduled_time?.split(':') || [0, 0];
      return (ta[0] * 60 + +ta[1]) - (tb[0] * 60 + +tb[1]);
    })[0];

  if (loading && schedule.length === 0) {
    return (
      <div className="empty-state" style={{ minHeight: '60vh', display: 'flex', flexDirection: 'column', justifyContent: 'center' }}>
        <div style={{ width: 40, height: 40, border: '3px solid var(--border)', borderTopColor: 'var(--primary)', borderRadius: '50%', animation: 'spin 1s linear infinite', margin: '0 auto 20px' }} />
        <p>Your wellness summary is loading...</p>
        <style>{`@keyframes spin { to { transform: rotate(360deg); } }`}</style>
      </div>
    );
  }

  return (
    <div className="user-dash-container">
      <style>{`
        .user-dash-container {
          animation: slideUp 0.6s cubic-bezier(0.2, 0.8, 0.2, 1);
        }
        @keyframes slideUp {
          from { opacity: 0; transform: translateY(20px); }
          to { opacity: 1; transform: translateY(0); }
        }

        .header-greeting {
          margin-bottom: 40px;
        }
        .header-greeting h1 {
          font-size: 2rem;
          font-weight: 800;
          color: var(--text-primary);
          letter-spacing: -0.03em;
          margin-bottom: 8px;
        }
        .header-greeting p {
          font-size: 1.1rem;
          color: var(--text-secondary);
        }

        .main-stat-row {
          display: grid;
          grid-template-columns: 2fr 1fr 1fr;
          gap: 24px;
          margin-bottom: 32px;
        }
        @media (max-width: 1024px) {
          .main-stat-row { grid-template-columns: 1fr; }
        }

        .hero-dose-card {
          background: linear-gradient(135deg, #0D9488 0%, #0F766E 100%);
          color: white;
          border-radius: 32px;
          padding: 32px;
          display: flex;
          justify-content: space-between;
          align-items: center;
          box-shadow: 0 20px 40px -10px rgba(13, 148, 136, 0.4);
          position: relative;
          overflow: hidden;
        }
        .hero-dose-card::after {
          content: '';
          position: absolute;
          top: -20px;
          right: -20px;
          width: 150px;
          height: 150px;
          background: rgba(255,255,255,0.1);
          border-radius: 50%;
        }

        .square-stat {
          background: white;
          border-radius: 32px;
          padding: 24px;
          border: 1px solid var(--border);
          display: flex;
          flex-direction: column;
          justify-content: center;
          align-items: center;
          text-align: center;
          transition: transform 0.2s;
        }
        .square-stat:hover {
          transform: scale(1.02);
          border-color: var(--primary-light);
        }

        .schedule-timeline {
          background: white;
          border-radius: 32px;
          padding: 32px;
          border: 1px solid var(--border);
        }
        .time-slot {
          display: flex;
          align-items: center;
          gap: 20px;
          padding: 20px;
          border-radius: 20px;
          transition: all 0.2s;
          margin-bottom: 12px;
        }
        .time-slot.taken { background: #F0FDFA; border: 1px solid #CCFBF1; }
        .time-slot.missed { background: #FEF2F2; border: 1px solid #FEE2E2; }
        .time-slot.upcoming { background: #F8FAFC; border: 1px solid #F1F5F9; }
        .time-slot.camera_off { background: #FFFBEB; border: 1px solid #FDE68A; }

        .time-label {
          font-size: 1.1rem;
          font-weight: 800;
          color: var(--text-primary);
          min-width: 60px;
        }

        .progress-circle-lg {
          position: relative;
          width: 120px;
          height: 120px;
        }
        .progress-circle-lg svg { transform: rotate(-90deg); }
        .circle-bg { fill: none; stroke: #F1F5F9; stroke-width: 10; }
        .circle-fill { 
          fill: none; 
          stroke: var(--primary); 
          stroke-width: 10; 
          stroke-linecap: round; 
          transition: stroke-dashoffset 1.5s ease-out;
        }
        .circle-text {
          position: absolute;
          top: 50%;
          left: 50%;
          transform: translate(-50%, -50%);
          font-size: 1.5rem;
          font-weight: 800;
          color: var(--text-primary);
        }
      `}</style>

      <header className="header-greeting">
        <h1>Hello, {user?.name?.split(' ')[0]}!</h1>
        <p>You're doing great. Stay on track today.</p>
      </header>

      <div className="card" style={{ marginBottom: 32, borderRadius: 32 }}>
        <div className="card-header" style={{ padding: '24px 32px' }}>
          <div>
            <h3 className="card-title">My Live AI Monitor</h3>
            <p className="card-subtitle">Real-time camera feed & AI status</p>
          </div>
          <button 
            className="btn btn-outline-primary btn-sm" 
            onClick={() => {
              const url = user?.camera_stream_url || '';
              if (url.includes('127.0.0.1:8554/live/')) {
                setCameraUrl(url.split('/live/')[1]);
              } else {
                setCameraUrl(url);
              }
              setConfigModal(true);
            }}>
            <Camera size={16} style={{ marginRight: 6 }} /> AI Camera Settings
          </button>
        </div>
      </div>

      <div className="main-stat-row">
        {upcoming ? (
          <div className="hero-dose-card">
            <div>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: '0.9rem', fontWeight: 700, marginBottom: 12, opacity: 0.9 }}>
                <Zap size={16} /> NEXT UPCOMING DOSE
              </div>
              <h2 style={{ fontSize: '2.2rem', fontWeight: 800, marginBottom: 4 }}>{formatTime12Hour(upcoming.scheduled_time)}</h2>
              <div style={{ fontSize: '1.2rem', fontWeight: 600 }}>{upcoming.medication_name}</div>
              <div style={{ opacity: 0.8, fontSize: '0.95rem' }}>{upcoming.dosage}</div>
            </div>
            <div style={{ textAlign: 'right' }}>
              <div style={{ background: 'rgba(255,255,255,0.2)', padding: '16px', borderRadius: '24px', backdropFilter: 'blur(10px)' }}>
                <Pill size={40} />
              </div>
            </div>
          </div>
        ) : (
          <div className="hero-dose-card" style={{ background: 'linear-gradient(135deg, #6366F1 0%, #4F46E5 100%)', boxShadow: '0 20px 40px -10px rgba(99, 102, 241, 0.4)' }}>
            <div>
              <h2 style={{ fontSize: '1.8rem', fontWeight: 800, marginBottom: 8 }}>All caught up!</h2>
              <p style={{ opacity: 0.9 }}>No more doses scheduled for today.</p>
            </div>
            <CheckCircle size={50} style={{ opacity: 0.3 }} />
          </div>
        )}

        <div className="square-stat">
          <div style={{ color: 'var(--primary)', marginBottom: 12 }}><Target size={32} /></div>
          <div style={{ fontSize: '1.8rem', fontWeight: 800 }}>{todayTaken}/{todayTotal}</div>
          <div style={{ fontSize: '0.8rem', fontWeight: 600, color: '#64748B', textTransform: 'uppercase' }}>Taken Today</div>
        </div>

        <div className="square-stat">
          <div style={{ color: 'var(--accent)', marginBottom: 12 }}><TrendingUp size={32} /></div>
          <div style={{ fontSize: '1.8rem', fontWeight: 800 }}>{adherencePercent.toFixed(0)}%</div>
          <div style={{ fontSize: '0.8rem', fontWeight: 600, color: '#64748B', textTransform: 'uppercase' }}>Weekly Goal</div>
        </div>
      </div>

      <div className="grid-2">
        <section className="schedule-timeline">
          <div className="card-header" style={{ marginBottom: 24 }}>
            <h3 className="card-title">Today's Timeline</h3>
            <div className="badge badge-primary">{todayUpcoming} Remaining</div>
          </div>

          <div style={{ display: 'flex', flexDirection: 'column' }}>
            {schedule.length === 0 ? (
              <div style={{ textAlign: 'center', padding: '40px 0' }}>
                <Activity size={40} style={{ margin: '0 auto 16px', opacity: 0.1 }} />
                <p className="text-muted">No medications on your schedule.</p>
              </div>
            ) : (
              schedule.map((s, i) => (
                <div key={i} className={`time-slot ${s.status}`}>
                  <div className="time-label">{formatTime12Hour(s.scheduled_time)}</div>
                  <div style={{ flex: 1 }}>
                    <div style={{ fontWeight: 700, fontSize: '1.1rem' }}>{s.medication_name}</div>
                    <div style={{ fontSize: '0.85rem', color: '#64748B' }}>{s.dosage}</div>
                  </div>
                  <div>
                    {s.status === 'taken' && <span className="badge badge-success"><CheckCircle size={14} /> Taken</span>}

                    {s.status === 'missed' && (
                      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                        <span className="badge badge-danger"><XCircle size={14} /> Missed</span>
                      </div>
                    )}
                    {(s.status === 'camera_off' || s.status === 'skipped') && (
                      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                        <span className="badge badge-warning"><AlertTriangle size={14} /> Camera Off</span>
                      </div>
                    )}
                    {['scheduled', 'pending', 'snoozed'].includes(s.status) && (
                      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                        <span className="badge" style={{ background: '#E0F2FE', color: '#0369A1', border: '1px solid #BAE6FD', display: 'inline-flex', alignItems: 'center', gap: 4 }}>
                          <Activity size={14} /> {s.status === 'snoozed' ? 'Snoozed' : 'Pending Camera Verification'}
                        </span>
                      </div>
                    )}
                    {s.status === 'needs_verification' && (
                      <div style={{ display: 'flex', gap: 8 }}>
                        <span className="badge badge-warning"><Activity size={14} /> Verification Needed</span>
                      </div>
                    )}
                  </div>
                </div>
              ))
            )}
          </div>
        </section>

        <section style={{ display: 'flex', flexDirection: 'column', gap: 24 }}>
          <div className="card" style={{ textAlign: 'center', padding: 40, borderRadius: 32 }}>
            <h3 style={{ fontSize: '1.2rem', fontWeight: 800, marginBottom: 24 }}>Weekly Progress</h3>
            <div className="progress-circle-lg" style={{ margin: '0 auto 24px' }}>
              <svg width="120" height="120" viewBox="0 0 120 120">
                <circle className="circle-bg" cx="60" cy="60" r="50" />
                <circle 
                  className="circle-fill" 
                  cx="60" cy="60" r="50"
                  strokeDasharray={2 * Math.PI * 50}
                  strokeDashoffset={(1 - adherencePercent / 100) * 2 * Math.PI * 50}
                />
              </svg>
              <div className="circle-text">{adherencePercent.toFixed(0)}%</div>
            </div>
            <p style={{ color: '#64748B', fontSize: '0.95rem', lineHeight: 1.5 }}>
              You've taken <strong>{takenWeek}</strong> out of <strong>{totalWeek}</strong> scheduled doses this week.
              <br/>
              <span style={{color: 'var(--danger)'}}>Missed: <strong>{missedWeek}</strong></span>
              <span style={{margin: '0 8px'}}>•</span>
              <span style={{color: 'var(--warning)'}}>Camera Off: <strong>{skippedWeek}</strong></span>
            </p>
          </div>

          <div className="card" style={{ borderRadius: 32, padding: 32, background: '#F8FAFC' }}>
            <h4 style={{ fontWeight: 800, marginBottom: 16, display: 'flex', alignItems: 'center', gap: 10 }}>
              <Bell size={20} color="var(--primary)" /> Health Tip
            </h4>
            <p style={{ fontSize: '0.9rem', color: '#475569', lineHeight: 1.6 }}>
              Consistency is key! Taking your medications at the same time every day helps maintain stable levels in your system. Use the AI verification to stay hands-free.
            </p>
          </div>
        </section>
      </div>

      {/* AI Config Modal */}
      {configModal && (
        <div className="modal-overlay" onClick={() => setConfigModal(false)}>
          <div className="modal" onClick={e => e.stopPropagation()} style={{ maxWidth: 500 }}>
            <h3 style={{ marginTop: 0, marginBottom: 8, fontSize: '1.25rem' }}>AI Camera Configuration</h3>
            <p className="text-muted text-sm" style={{ marginBottom: 20 }}>
              To connect a third-party camera (e.g. GoPro), configure it to stream via RTMP to LOCUS.
            </p>
            
            <div style={{ background: 'var(--surface-hover)', padding: '16px', borderRadius: '8px', marginBottom: 24, border: '1px solid var(--border)' }}>
              <div style={{ fontSize: '0.85rem', fontWeight: 600, color: 'var(--text-secondary)', marginBottom: 8, textTransform: 'uppercase', letterSpacing: '0.05em' }}>
                Camera Configuration URL
              </div>
              <div style={{ fontSize: '0.9rem', color: 'var(--text-primary)', marginBottom: 4 }}>
                Copy and paste this exact URL into your camera's RTMP streaming settings:
              </div>
              <code style={{ display: 'block', padding: '10px', background: 'var(--bg)', borderRadius: '4px', border: '1px dashed var(--border-light)', wordBreak: 'break-all', userSelect: 'all', fontSize: '1.05rem', fontWeight: 700 }}>
                rtmp://{rtmpHost || window.location.hostname}/live/{user?._id}
              </code>
            </div>

            <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 12 }}>
              <button className="btn btn-primary" onClick={() => setConfigModal(false)}>Close</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
