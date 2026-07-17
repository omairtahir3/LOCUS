import { useState, useEffect } from 'react';
import { useParams, Link } from 'react-router-dom';
import { caregiverAPI, medicationAPI } from '../services/api';
import {
  ArrowLeft, Pill, CheckCircle, XCircle, Clock, AlertTriangle,
  MessageSquare, PhoneCall, Send, Shield, Eye, TrendingDown, Zap, Bell
} from 'lucide-react';
import { formatSmartDate } from '../utils/dateUtils';

export default function FamilyMemberDetail() {
  const { userId } = useParams();
  const [summary, setSummary] = useState(null);
  const [schedule, setSchedule] = useState([]);
  const [verificationEvents, setVerificationEvents] = useState([]);
  const [anomalies, setAnomalies] = useState([]);
  const [loading, setLoading] = useState(true);
  const [msgModal, setMsgModal] = useState(false);
  const [msgTitle, setMsgTitle] = useState('');
  const [msgBody, setMsgBody] = useState('');
  const [sending, setSending] = useState(false);

  useEffect(() => {
    loadData();

    // Refresh every 30s (not 5s) — skip when tab is hidden
    const interval = setInterval(() => {
      if (!loading && !document.hidden) loadData();
    }, 30000);

    return () => clearInterval(interval);
  }, [userId]);

  const loadData = async () => {
    try {
      setLoading(true);
      const [sumRes, schRes, verRes, anomRes] = await Promise.all([
        caregiverAPI.getUserSummary(userId),
        medicationAPI.getSchedule(userId),
        caregiverAPI.getVerificationEvents(userId, { limit: 10 }).catch(() => ({ data: [] })),
        caregiverAPI.getAnomalies(userId).catch(() => ({ data: [] })),
      ]);
      setSummary(sumRes.data);
      setSchedule(schRes.data || []);
      setVerificationEvents(verRes.data || []);
      setAnomalies(anomRes.data || []);
    } catch (err) {
      console.error(err);
    } finally {
      setLoading(false);
    }
  };

  const sendMessage = async () => {
    if (!msgTitle || !msgBody) return;
    setSending(true);
    try {
      await caregiverAPI.sendMessage(userId, { title: msgTitle, message: msgBody });
      setMsgModal(false);
      setMsgTitle('');
      setMsgBody('');
      loadData();
    } catch (err) {
      alert('Failed to send message');
    } finally {
      setSending(false);
    }
  };

  const requestStatusCheck = async () => {
    try {
      await caregiverAPI.statusCheck(userId);
      alert('Status check request sent!');
    } catch (err) {
      alert('Failed to send status check');
    }
  };

  if (loading) {
    return <div className="empty-state"><p>Loading family member data...</p></div>;
  }

  const user = summary?.user;
  const adherence = summary?.today_adherence;
  const alerts = summary?.pending_alerts || [];

  const statusIcon = (s) => {
    switch (s) {
      case 'taken': return <CheckCircle size={16} style={{ color: 'var(--success)' }} />;
      case 'missed': return <XCircle size={16} style={{ color: 'var(--danger)' }} />;
      case 'snoozed': return <Clock size={16} style={{ color: 'var(--warning)' }} />;
      default: return <Clock size={16} style={{ color: 'var(--text-muted)' }} />;
    }
  };

  const classificationBadge = (cls) => {
    if (cls === 'auto_verified') return 'badge-success';
    if (cls === 'needs_confirmation') return 'badge-warning';
    return 'badge-danger';
  };

  const anomalySeverityStyle = (severity) => {
    if (severity === 'critical') return { bg: 'var(--danger-light)', color: 'var(--danger)', icon: <AlertTriangle size={18} /> };
    if (severity === 'warning') return { bg: 'var(--warning-light)', color: 'var(--warning)', icon: <TrendingDown size={18} /> };
    return { bg: 'var(--info-light)', color: 'var(--info)', icon: <Eye size={18} /> };
  };

  return (
    <div>
      {/* Back + Header */}
      <Link to="/family" className="btn btn-ghost btn-sm mb-4" style={{ marginLeft: -8 }}>
        <ArrowLeft size={16} /> Back to Family Members
      </Link>

      <div style={{ display: 'flex', gap: 20, alignItems: 'flex-start', marginBottom: 24, flexWrap: 'wrap' }}>
        <div className="avatar avatar-lg" style={{ background: '#0D9488', fontSize: '1.4rem' }}>
          {user?.name?.charAt(0)?.toUpperCase()}
        </div>
        <div style={{ flex: 1 }}>
          <h2 style={{ fontSize: '1.4rem', fontWeight: 700 }}>{user?.name}</h2>
          <p className="text-muted text-sm">{user?.email} • {user?.phone || 'No phone'}</p>
        </div>
        <div style={{ display: 'flex', gap: 8 }}>
          <button className="btn btn-secondary btn-sm" onClick={() => setMsgModal(true)}>
            <MessageSquare size={16} /> Send Message
          </button>
          <button className="btn btn-primary btn-sm" onClick={requestStatusCheck}>
            <PhoneCall size={16} /> Status Check
          </button>
        </div>
      </div>

      {/* Behavioral Anomaly Alerts */}
      {anomalies.length > 0 && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 10, marginBottom: 20 }}>
          {anomalies.map((a, i) => {
            const style = anomalySeverityStyle(a.severity);
            return (
              <div key={i} style={{
                display: 'flex', alignItems: 'center', gap: 14,
                padding: '14px 18px',
                borderRadius: 'var(--radius-md)',
                background: style.bg,
                border: `1px solid ${style.color}33`,
              }}>
                <div style={{
                  width: 40, height: 40, borderRadius: 'var(--radius-md)',
                  display: 'flex', alignItems: 'center', justifyContent: 'center',
                  background: style.color + '22', color: style.color, flexShrink: 0,
                }}>
                  {style.icon}
                </div>
                <div style={{ flex: 1 }}>
                  <div style={{ fontWeight: 700, fontSize: '0.9rem', color: style.color }}>{a.title}</div>
                  <div style={{ fontSize: '0.8rem', color: 'var(--text-secondary)', marginTop: 2 }}>{a.message}</div>
                </div>
                <span className={`badge ${a.severity === 'critical' ? 'badge-danger' : a.severity === 'warning' ? 'badge-warning' : 'badge-info'}`}>
                  {a.severity}
                </span>
              </div>
            );
          })}
        </div>
      )}

      {/* Stats */}
      <div className="stat-grid">
        <div className="stat-card">
          <div className="stat-icon success"><CheckCircle size={18} /></div>
          <div>
            <div className="stat-value">{adherence?.taken || 0}</div>
            <div className="stat-label">Taken</div>
          </div>
        </div>
        <div className="stat-card">
          <div className="stat-icon danger"><XCircle size={18} /></div>
          <div>
            <div className="stat-value">{adherence?.missed || 0}</div>
            <div className="stat-label">Missed</div>
          </div>
        </div>
        <div className="stat-card">
          <div className="stat-icon warning"><Clock size={18} /></div>
          <div>
            <div className="stat-value">{adherence?.snoozed || 0}</div>
            <div className="stat-label">Snoozed</div>
          </div>
        </div>
        <div className="stat-card">
          <div className="stat-icon primary"><Pill size={18} /></div>
          <div>
            <div className="stat-value">{adherence?.adherence_percentage?.toFixed(0) || 0}%</div>
            <div className="stat-label">Adherence</div>
          </div>
        </div>
      </div>

      <div className="grid-2">
        {/* Today's Schedule */}
        <div className="card">
          <div className="card-header">
            <div>
              <div className="card-title">Today's Schedule</div>
              <div className="card-subtitle">{schedule.length} doses scheduled</div>
            </div>
          </div>
          {schedule.length === 0 ? (
            <div className="empty-state">
              <Pill size={36} />
              <p>No medications scheduled today</p>
            </div>
          ) : (
            <div className="table-wrapper">
              <table className="table">
                <thead>
                  <tr>
                    <th>Time</th>
                    <th>Medication</th>
                    <th>Dosage</th>
                    <th>Status</th>
                    <th>Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {schedule.map((s, i) => (
                    <tr key={i}>
                      <td style={{ fontWeight: 600 }}>{s.scheduled_time}</td>
                      <td>{s.medication_name}</td>
                      <td className="text-muted">{s.dosage}</td>
                      <td>
                        {(() => {
                          const displayStatus = (s.status === 'camera_off' && s.notes === 'pending_camera_verification')
                            ? 'scheduled' : (s.status === 'skipped' ? 'camera_off' : s.status);
                          return (
                            <span className={`badge ${
                              displayStatus === 'taken' ? 'badge-success' :
                              displayStatus === 'needs_verification' ? 'badge-warning' :
                              displayStatus === 'missed' ? 'badge-danger' :
                              displayStatus === 'snoozed' ? 'badge-secondary' : 'badge-neutral'
                            }`}>
                              {statusIcon(displayStatus)} {(displayStatus || '').toUpperCase().replace('_', ' ')}
                            </span>
                          );
                        })()}
                        {s.status === 'taken' && s.verification_method && (
                            <div style={{ fontSize: '0.7rem', marginTop: 4, color: 'var(--text-muted)' }}>
                              Verified: {['visual', 'Camera', 'ai_visual'].includes(s.verification_method) ? 'Camera' : ['manual', 'manual_caregiver'].includes(s.verification_method) ? 'Caregiver' : s.verification_method}
                            </div>
                        )}
                      </td>
                      <td>
                        {(s.status === 'scheduled' || s.status === 'needs_verification' || s.status === 'missed' || s.status === 'camera_off' || s.status === 'skipped') && (
                          <div style={{ display: 'flex', gap: 6 }}>
                            <button
                              className="btn btn-sm"
                              style={{ background: 'var(--success-light)', color: 'var(--success)', border: '1px solid var(--success)', borderRadius: 8, fontSize: '0.75rem', padding: '4px 10px' }}
                              onClick={async () => {
                                try {
                                  if (s.log_id || s.id) {
                                    await medicationAPI.updateLog(s.log_id || s.id, {
                                      status: 'taken',
                                      verification_method: 'manual',
                                      notes: 'Confirmed by caregiver',
                                    });
                                  } else {
                                    const [hh, mm] = s.scheduled_time.split(':');
                                    const dt = new Date();
                                    dt.setHours(parseInt(hh), parseInt(mm), 0, 0);
                                    await medicationAPI.createLog({
                                      medication_id: s.medication_id,
                                      scheduled_time: dt.toISOString(),
                                      status: 'taken',
                                      verification_method: 'manual',
                                      notes: 'Confirmed by caregiver',
                                    });
                                  }
                                  loadData();
                                } catch (err) {
                                  console.error('Failed to mark as taken:', err);
                                  alert('Failed to update. Please try again.');
                                }
                              }}
                            >
                              <CheckCircle size={12} /> Taken
                            </button>
                            {s.status === 'needs_verification' && (
                              <button
                                className="btn btn-sm"
                                style={{ background: '#FEF3C7', color: '#92400E', border: '1px solid #FDE68A', borderRadius: 8, fontSize: '0.75rem', padding: '4px 10px' }}
                                onClick={async () => {
                                  try {
                                    if (s.log_id || s.id) {
                                      await medicationAPI.updateLog(s.log_id || s.id, {
                                        status: 'scheduled',
                                        notes: 'Rescheduled by caregiver',
                                      });
                                    }
                                    loadData();
                                  } catch (err) {
                                    console.error('Failed to reschedule:', err);
                                    alert('Failed to reschedule. Please try again.');
                                  }
                                }}
                              >
                                <Clock size={12} /> Reschedule
                              </button>
                            )}
                          </div>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>

        {/* Pending Alerts */}
        <div className="card">
          <div className="card-header">
            <div>
              <div className="card-title">Pending Alerts</div>
              <div className="card-subtitle">{alerts.length} unread</div>
            </div>
          </div>
          {alerts.length === 0 ? (
            <div className="empty-state">
              <CheckCircle size={36} />
              <p>No pending alerts for this family member</p>
            </div>
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
              {alerts.map((a) => {
                const typeConfig = {
                  missed_dose:       { icon: Pill,  bg: 'var(--danger-light)',  color: 'var(--danger)' },
                  camera_off_alert:  { icon: AlertTriangle, bg: '#FEF3C7',      color: '#D97706' },
                  skipped_medicine:  { icon: AlertTriangle, bg: '#FEF3C7',      color: '#D97706' },
                  dose_confirmed:    { icon: CheckCircle, bg: 'var(--success-light)', color: 'var(--success)' },
                  dose_reminder:     { icon: Bell,  bg: 'var(--info-light)',    color: 'var(--info)' },
                  emergency:         { icon: AlertTriangle, bg: 'var(--warning-light)', color: 'var(--warning)' },
                  status_check:      { icon: Bell,  bg: 'var(--accent-light)',  color: 'var(--accent)' },
                  caregiver_message: { icon: Bell,  bg: 'var(--primary-light)', color: 'var(--primary)' },
                  system:            { icon: Bell,  bg: 'var(--surface-hover)', color: 'var(--text-secondary)' },
                };
                const cfg = typeConfig[a.type] || typeConfig.system;
                const Icon = cfg.icon;
                return (
                <div key={a._id} className="notification-item unread">
                  <div className="notification-icon" style={{
                    background: cfg.bg, color: cfg.color
                  }}>
                    <Icon size={16} />
                  </div>
                  <div className="notification-body">
                    <div className="notification-title">{a.title}</div>
                    <div className="notification-message">{a.message}</div>
                    <div className="notification-time">{formatSmartDate(a.createdAt)}</div>
                  </div>
                </div>
                );
              })}
            </div>
          )}
        </div>
      </div>

      {/* AI Verification Events */}
      <div className="card" style={{ marginTop: 20 }}>
        <div className="card-header">
          <div>
            <div className="card-title" style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <Shield size={18} /> AI Verification Events
            </div>
            <div className="card-subtitle">Recent camera-based medication intake verifications</div>
          </div>
          <Link to="/keyframes" className="btn btn-ghost btn-sm">
            <Eye size={14} /> View Keyframes
          </Link>
        </div>

        {verificationEvents.length === 0 ? (
          <div className="empty-state">
            <Shield size={36} />
            <p>No AI verification events recorded yet</p>
          </div>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            {verificationEvents.map((ev) => (
              <div key={ev._id} style={{
                display: 'flex', alignItems: 'center', gap: 14,
                padding: '12px 16px',
                borderRadius: 'var(--radius-md)',
                border: '1px solid var(--border-light)',
                background: ev.classification === 'auto_verified' ? 'var(--success-light)' : 'var(--danger-light)',
                transition: 'all 0.15s',
              }}>
                <div style={{
                  width: 44, height: 44, borderRadius: 'var(--radius-md)',
                  display: 'flex', alignItems: 'center', justifyContent: 'center',
                  background: ev.classification === 'auto_verified' ? 'var(--success)' : 'var(--danger)',
                  color: 'white', fontWeight: 700, fontSize: '0.85rem',
                }}>
                  {(ev.confidence_score * 100).toFixed(0)}%
                </div>
                <div style={{ flex: 1 }}>
                  <div style={{ fontWeight: 600, fontSize: '0.9rem' }}>{ev.medication_name}</div>
                  <div style={{ fontSize: '0.75rem', color: 'var(--text-muted)', marginTop: 2 }}>
                    {ev.scheduled_time ? formatSmartDate(ev.scheduled_time) : 'Unknown time'}
                    {ev.dosage && <span> - {ev.dosage}</span>}
                  </div>
                </div>
                <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-end', gap: 4 }}>
                  <span className={`badge ${classificationBadge(ev.classification)}`}>
                    {ev.classification === 'auto_verified' ? 'Auto Verified' : 'Unverified'}
                  </span>
                  <span style={{ fontSize: '0.7rem', color: 'var(--text-muted)' }}>
                    {ev.action === 'log_automatically' ? 'Logged automatically' :
                     ev.action === 'request_user_confirmation' ? 'Awaiting confirmation' : 'Discarded'}
                  </span>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Message Modal */}
      {msgModal && (
        <div className="modal-overlay" onClick={() => setMsgModal(false)}>
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <div className="modal-header">
              <h3 className="modal-title">Send Message to {user?.name}</h3>
              <button className="btn btn-ghost btn-sm" onClick={() => setMsgModal(false)}>✕</button>
            </div>
            <div className="form-group">
              <label className="form-label">Title</label>
              <input
                className="form-input"
                placeholder="Reminder about medications"
                value={msgTitle}
                onChange={(e) => setMsgTitle(e.target.value)}
              />
            </div>
            <div className="form-group">
              <label className="form-label">Message</label>
              <textarea
                className="form-input"
                rows={4}
                placeholder="Type your message..."
                value={msgBody}
                onChange={(e) => setMsgBody(e.target.value)}
                style={{ resize: 'vertical' }}
              />
            </div>
            <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
              <button className="btn btn-secondary" onClick={() => setMsgModal(false)}>Cancel</button>
              <button className="btn btn-primary" onClick={sendMessage} disabled={sending}>
                <Send size={16} /> {sending ? 'Sending...' : 'Send'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
