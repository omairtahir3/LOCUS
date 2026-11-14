import { useState, useEffect } from 'react';
import AdherenceStrip from '../components/Adherence/AdherenceStrip';
import { useParams, Link } from 'react-router-dom';
import { caregiverAPI, medicationAPI, authAPI } from '../services/api';
import {
  ArrowLeft, Pill, CheckCircle, XCircle, Clock, AlertTriangle,
  MessageSquare, PhoneCall, Send, Shield, Eye, TrendingDown, Zap, Bell, Camera
} from 'lucide-react';
import { formatSmartDate, formatTime12Hour } from '../utils/dateUtils';
import Loading from '../components/Feedback/Loading';
import { doseLabel } from '../utils/doseStatus';
import PageHeader from '../components/Layout/PageHeader';
import DaySummary from '../components/Today/DaySummary';

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
  
  // AI Config State
  const [configModal, setConfigModal] = useState(false);
  const [rtmpHost, setRtmpHost] = useState('');
  const [doseHistory, setDoseHistory] = useState([]);

  useEffect(() => {
    loadData();
    authAPI.getRtmpHost().then(res => setRtmpHost(res.data.host)).catch(() => setRtmpHost(window.location.hostname));

    // Refresh every 30s (not 5s) — skip when tab is hidden
    const interval = setInterval(() => {
      if (!loading && !document.hidden) loadData();
    }, 30000);

    return () => clearInterval(interval);
  }, [userId]);

  const loadData = async () => {
    try {
      setLoading(true);
      const [sumRes, schRes, verRes, anomRes, histRes] = await Promise.all([
        caregiverAPI.getUserSummary(userId),
        medicationAPI.getSchedule(userId),
        caregiverAPI.getVerificationEvents(userId, { limit: 10 }).catch(() => ({ data: [] })),
        caregiverAPI.getAnomalies(userId).catch(() => ({ data: [] })),
        // A month of doses, so the strip can show the shape of the habit rather
        // than today's number. Non-fatal: the rest of the page stands without it.
        medicationAPI.getHistory({ userId, limit: 200 }).catch(() => ({ data: [] })),
      ]);
      setSummary(sumRes.data);
      setSchedule(schRes.data || []);
      setVerificationEvents(verRes.data || []);
      setAnomalies(anomRes.data || []);
      setDoseHistory(Array.isArray(histRes.data) ? histRes.data : (histRes.data?.logs || []));
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
    } catch {
      alert('Failed to send message');
    } finally {
      setSending(false);
    }
  };

  const requestStatusCheck = async () => {
    try {
      await caregiverAPI.statusCheck(userId);
      alert('Status check request sent!');
    } catch {
      alert('Failed to send status check');
    }
  };

  if (loading) {
    return <Loading rows={5} label="Loading family member data" />;
  }

  const user = summary?.user;
  const alerts = summary?.pending_alerts || [];

  const statusIcon = (s) => {
    switch (s) {
      case 'taken': return <CheckCircle size={16} style={{ color: 'var(--success-text)' }} />;
      case 'missed': return <XCircle size={16} style={{ color: 'var(--danger-text)' }} />;
      case 'snoozed': return <Clock size={16} style={{ color: 'var(--warning-text)' }} />;
      default: return <Clock size={16} style={{ color: 'var(--text-muted)' }} />;
    }
  };

  const classificationBadge = (cls) => {
    if (cls === 'auto_verified') return 'badge-success';
    if (cls === 'needs_confirmation') return 'badge-warning';
    return 'badge-danger';
  };

  const anomalySeverityStyle = (severity) => {
    if (severity === 'critical') return { bg: 'var(--danger-light)', color: 'var(--danger-text)', icon: <AlertTriangle size={18} /> };
    if (severity === 'warning') return { bg: 'var(--warning-light)', color: 'var(--warning-text)', icon: <TrendingDown size={18} /> };
    return { bg: 'var(--info-light)', color: 'var(--info-text)', icon: <Eye size={18} /> };
  };

  return (
    <div>
      <Link to="/family" className="page-back">
        <ArrowLeft size={16} aria-hidden="true" /> All family members
      </Link>

      <PageHeader
        title={
          <span className="person-title">
            {(user?.picture || user?.profile_picture) ? (
          <img 
            src={user.picture || user.profile_picture} 
            alt="" 
            className="avatar avatar-lg" 
            referrerPolicy="no-referrer"
            crossOrigin="anonymous"
            style={{ objectFit: 'cover', borderRadius: '50%', border: '2px solid var(--primary)', width: 56, height: 56 }} 
            onError={(e) => { e.target.style.display = 'none'; }}
          />
            ) : (
              <span className="avatar avatar-lg" style={{ background: 'var(--primary)', fontSize: '1.3rem' }}>
                {user?.name?.charAt(0)?.toUpperCase()}
              </span>
            )}
            {user?.name}
          </span>
        }
        description={[user?.email, user?.phone].filter(Boolean).join(' · ') || 'No contact details'}
        actions={<>
          <button 
            className="btn btn-outline-primary btn-sm" 
            onClick={() => setConfigModal(true)}>
            <Camera size={16} /> AI Camera
          </button>
          <button className="btn btn-secondary btn-sm" onClick={() => setMsgModal(true)}>
            <MessageSquare size={16} /> Send Message
          </button>
          <button className="btn btn-primary btn-sm" onClick={requestStatusCheck}>
            <PhoneCall size={16} /> Status check
          </button>
        </>}
      />

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
                  {a.severity === 'critical' ? 'Needs attention now'
                    : a.severity === 'warning' ? 'Worth a look' : 'For information'}
                </span>
              </div>
            );
          })}
        </div>
      )}

      {/* This person's whole day, not four dose counters. Scoped by the route
          param rather than the dock's selection, because the caregiver asked
          for THIS person by opening their page. */}
      <DaySummary
        userId={userId}
        name={user?.name}
        homeLocation={user?.home_location}
        canAct
      />

      {/* The 30-day strip is a WIDE object -- thirty day cells and a legend --
          and it was the first of THREE children in a two-column grid. So it
          was squeezed into half the width, where the cells wrapped onto a
          second line, and the third child (Pending Alerts) started a new row
          on its own and left the bottom-right quarter of the page empty.
          Full width here: the strip gets its single row back, and the two
          cards below pair off evenly with no hole after them. */}
      <div style={{ marginBottom: 20 }}>
        <AdherenceStrip logs={doseHistory} days={30} name={summary?.user?.name} />
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
                  </tr>
                </thead>
                <tbody>
                  {schedule.map((s, i) => (
                    <tr key={i}>
                      <td style={{ fontWeight: 600 }}>{formatTime12Hour(s.scheduled_time)}</td>
                      <td>{s.medication_name}</td>
                      <td className="text-muted">{s.dosage}</td>
                      <td>
                        {(() => {
                          const displayStatus = (s.status === 'camera_off' && s.notes === 'pending_camera_verification')
                            ? 'scheduled' : s.status;
                          return (
                            <span className={`badge ${
                              displayStatus === 'taken' ? 'badge-success' :
                              displayStatus === 'needs_verification' ? 'badge-warning' :
                              (displayStatus === 'camera_off' || displayStatus === 'skipped') ? 'badge-warning' :
                              displayStatus === 'missed' ? 'badge-danger' :
                              displayStatus === 'snoozed' ? 'badge-secondary' : 'badge-neutral'
                            }`}>
                              {statusIcon(displayStatus)} {doseLabel(displayStatus)}
                            </span>
                          );
                        })()}
                        {s.status === 'taken' && s.verification_method && (
                            <div style={{ fontSize: '0.7rem', marginTop: 4, color: 'var(--text-muted)' }}>
                              Verified: {['visual', 'Camera', 'ai_visual'].includes(s.verification_method) ? 'Camera' : s.verification_method === 'manual_caregiver' ? 'Caregiver' : s.verification_method === 'manual' ? 'Manual' : s.verification_method}
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
            /* is-inset: already inside a bordered card, so the dashed box and
               its 44px of padding drew a box inside a box and made "nothing to
               report" the tallest thing on the page. */
            <div className="empty-state is-inset">
              <CheckCircle size={36} />
              <p>No pending alerts for this family member</p>
            </div>
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
              {alerts.map((a) => {
                const typeConfig = {
                  missed_dose:       { icon: Pill,  bg: 'var(--danger-light)',  color: 'var(--danger-text)' },
                  camera_off_alert:  { icon: AlertTriangle, bg: '#FEF3C7',      color: '#D97706' },
                  skipped_medicine:  { icon: AlertTriangle, bg: '#FEF3C7',      color: '#D97706' },
                  dose_confirmed:    { icon: CheckCircle, bg: 'var(--success-light)', color: 'var(--success-text)' },
                  dose_reminder:     { icon: Bell,  bg: 'var(--info-light)',    color: 'var(--info)' },
                  emergency:         { icon: AlertTriangle, bg: 'var(--warning-light)', color: 'var(--warning-text)' },
                  status_check:      { icon: Bell,  bg: 'var(--accent-light)',  color: 'var(--accent)' },
                  caregiver_message: { icon: Bell,  bg: 'var(--primary-light)', color: 'var(--primary-text)' },
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
          <div className="empty-state is-inset">
            <Shield size={36} />
            <p>No AI verification events recorded yet</p>
          </div>
        ) : (
          /* Every row was filled edge to edge with --success-light, so a
             healthy week read as two solid green bars stacked under a white
             card -- louder than the emergency banner, and unlike anything
             else on the dashboard. The colour moves to the confidence chip,
             which is the one part of the row that is actually a judgement;
             the row itself returns to a surface with a hairline, the same
             shape as a notification. Nothing is removed. */
          <div className="verify-list">
            {verificationEvents.map((ev) => {
              const verified = ev.classification === 'auto_verified';
              return (
                <div key={ev._id} className={`verify-row ${verified ? 'is-verified' : 'is-unverified'}`}>
                  <span className="verify-score">
                    {(ev.confidence_score * 100).toFixed(0)}%
                  </span>
                  <div className="verify-main">
                    <div className="verify-name">{ev.medication_name}</div>
                    <div className="verify-when">
                      {ev.scheduled_time ? formatSmartDate(ev.scheduled_time) : 'Unknown time'}
                      {ev.dosage && <span> &middot; {ev.dosage}</span>}
                    </div>
                  </div>
                  <div className="verify-side">
                    <span className={`badge ${classificationBadge(ev.classification)}`}>
                      {verified ? 'Auto Verified' : 'Unverified'}
                    </span>
                    <span className="verify-action">
                      {ev.action === 'log_automatically' ? 'Logged automatically' :
                       ev.action === 'request_user_confirmation' ? 'Awaiting confirmation' : 'Discarded'}
                    </span>
                  </div>
                </div>
              );
            })}
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

      {/* AI Config Modal */}
      {configModal && (
        <div className="modal-overlay" onClick={() => setConfigModal(false)}>
          <div className="modal" onClick={e => e.stopPropagation()} style={{ maxWidth: 500 }}>
            <h3 style={{ marginTop: 0, marginBottom: 8, fontSize: '1.25rem' }}>AI Camera Configuration</h3>
            <p className="text-muted text-sm" style={{ marginBottom: 20 }}>
              To connect a third-party camera (e.g. GoPro), configure it to stream via RTMP to LOCUS.
            </p>
            
            <div style={{ background: 'var(--surface-hover)', padding: '16px', borderRadius: '8px', marginBottom: 24, border: '1px solid var(--border)' }}>
              <div style={{ fontSize: '0.85rem', fontWeight: 600, color: 'var(--text-secondary)', marginBottom: 8 }}>
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
