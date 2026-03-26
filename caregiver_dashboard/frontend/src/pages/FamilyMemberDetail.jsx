import { useState, useEffect } from 'react';
import { useParams, Link } from 'react-router-dom';
import { caregiverAPI, medicationAPI } from '../services/api';
import {
  ArrowLeft, Pill, CheckCircle, XCircle, Clock, AlertTriangle,
  MessageSquare, PhoneCall, Send
} from 'lucide-react';

export default function FamilyMemberDetail() {
  const { userId } = useParams();
  const [summary, setSummary] = useState(null);
  const [schedule, setSchedule] = useState([]);
  const [loading, setLoading] = useState(true);
  const [msgModal, setMsgModal] = useState(false);
  const [msgTitle, setMsgTitle] = useState('');
  const [msgBody, setMsgBody] = useState('');
  const [sending, setSending] = useState(false);

  useEffect(() => { loadData(); }, [userId]);

  const loadData = async () => {
    try {
      setLoading(true);
      const [sumRes, schRes] = await Promise.all([
        caregiverAPI.getUserSummary(userId),
        medicationAPI.getSchedule(userId),
      ]);
      setSummary(sumRes.data);
      setSchedule(schRes.data || []);
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

      {/* Stats */}
      <div className="stat-grid" style={{ gridTemplateColumns: 'repeat(4, 1fr)' }}>
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
                  </tr>
                </thead>
                <tbody>
                  {schedule.map((s, i) => (
                    <tr key={i}>
                      <td style={{ fontWeight: 600 }}>{s.scheduled_time}</td>
                      <td>{s.medication_name}</td>
                      <td className="text-muted">{s.dosage}</td>
                      <td>
                        <span className={`badge ${
                          s.status === 'taken' ? 'badge-success' :
                          s.status === 'missed' ? 'badge-danger' :
                          s.status === 'snoozed' ? 'badge-warning' : 'badge-neutral'
                        }`}>
                          {statusIcon(s.status)} {s.status}
                        </span>
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
              {alerts.map((a) => (
                <div key={a._id} className="notification-item unread">
                  <div className="notification-icon" style={{
                    background: 'var(--danger-light)', color: 'var(--danger)'
                  }}>
                    <AlertTriangle size={16} />
                  </div>
                  <div className="notification-body">
                    <div className="notification-title">{a.title}</div>
                    <div className="notification-message">{a.message}</div>
                    <div className="notification-time">{new Date(a.createdAt).toLocaleString()}</div>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
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
