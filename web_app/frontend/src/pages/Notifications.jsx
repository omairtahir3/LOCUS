import { useState, useEffect } from 'react';
import { notificationAPI, userAPI } from '../services/api';
import { useAuth } from '../context/AuthContext';
import { Bell, Pill, AlertTriangle, CheckCircle, Check, Trash2, Filter, Clock, MessageSquare, Mail, ThumbsUp, Phone } from 'lucide-react';
import { formatSmartDate } from '../utils/dateUtils';

const typeConfig = {
  missed_dose:       { icon: Pill,  bg: 'var(--danger-light)',  color: 'var(--danger)',  label: 'Missed Dose' },
  camera_off_alert:  { icon: AlertTriangle, bg: '#FEF3C7',      color: '#D97706',        label: 'Camera Off' },
  skipped_medicine:  { icon: AlertTriangle, bg: '#FEF3C7',      color: '#D97706',        label: 'Camera Off' },
  dose_confirmed:    { icon: CheckCircle, bg: 'var(--success-light)', color: 'var(--success)', label: 'Dose Confirmed' },
  dose_reminder:     { icon: Bell,  bg: 'var(--info-light)',    color: 'var(--info)',    label: 'Reminder' },
  emergency:         { icon: AlertTriangle, bg: 'var(--warning-light)', color: 'var(--warning)', label: 'Emergency' },
  status_check:      { icon: Bell,  bg: 'var(--accent-light)',  color: 'var(--accent)',  label: 'Status Check' },
  caregiver_message: { icon: Bell,  bg: 'var(--primary-light)', color: 'var(--primary)', label: 'Message' },
  system:            { icon: Bell,  bg: 'var(--surface-hover)', color: 'var(--text-secondary)', label: 'System' },
};

export default function Notifications() {
  const { user } = useAuth();
  const [notifications, setNotifications] = useState([]);
  const [unreadCount, setUnreadCount] = useState(0);
  const [loading, setLoading] = useState(true);
  const [filter, setFilter] = useState('all');

  useEffect(() => { loadNotifs(); }, [filter]);

  const loadNotifs = async () => {
    try {
      setLoading(true);
      const params = { limit: 50 };
      if (filter === 'unread') params.unread_only = 'true';
      const res = await notificationAPI.getAll(params);
      setNotifications(res.data?.notifications || []);
      setUnreadCount(res.data?.unread_count || 0);
    } catch {} finally { setLoading(false); }
  };

  const markRead = async (id) => {
    await notificationAPI.markRead(id);
    loadNotifs();
  };

  const markAllRead = async () => {
    await notificationAPI.markAllRead();
    loadNotifs();
  };

  const acknowledge = async (id) => {
    await notificationAPI.acknowledge(id);
    loadNotifs();
  };

  const dismiss = async (id) => {
    await notificationAPI.dismiss(id);
    loadNotifs();
  };

  const handleSnoozeNotif = async (id, mins) => {
    await notificationAPI.snooze(id, { snooze_duration_minutes: mins });
    loadNotifs();
  };

  const handleRespondNotif = async (id, responseMsg) => {
    await notificationAPI.respond(id, { message: responseMsg });
    loadNotifs();
  };

  const filtered = notifications.filter(n => {
    if (filter === 'all' || filter === 'unread') return true;
    const t = n.type || '';
    if (filter === 'missed') return t === 'missed_dose' || t === 'consecutive_misses';
    if (filter === 'alerts') return t !== 'missed_dose' && t !== 'consecutive_misses' && t !== 'camera_off_alert' && t !== 'dose_reminder';
    return t === filter;
  });

  return (
    <div>
      <div className="page-header">
        <div>
          <h2 className="page-title">Notifications</h2>
          <p className="page-description">{unreadCount} unread notifications</p>
        </div>
        <div style={{ display: 'flex', gap: 8 }}>
          <button className="btn btn-secondary btn-sm" onClick={markAllRead}>
            <Check size={14} /> Mark All Read
          </button>
        </div>
      </div>

      {/* Filter tabs */}
      <div style={{ display: 'flex', gap: 8, marginBottom: 20, flexWrap: 'wrap' }}>
        {[
          { key: 'all', label: 'All' },
          { key: 'unread', label: 'Unread' },
          ...(user?.role !== 'caregiver' ? [{ key: 'dose_reminder', label: 'Reminders' }] : []),
          { key: 'missed', label: 'Missed' },
          { key: 'camera_off_alert', label: 'Camera Off' },
          { key: 'alerts', label: 'Alerts' },
        ].map(f => (
          <button
            key={f.key}
            className={`btn btn-sm ${filter === f.key ? 'btn-primary' : 'btn-secondary'}`}
            onClick={() => setFilter(f.key)}
          >
            {f.label}
          </button>
        ))}
      </div>

      <div className="card" style={{ padding: 0, overflow: 'hidden' }}>
        {loading ? (
          <div className="empty-state"><p>Loading notifications...</p></div>
        ) : filtered.length === 0 ? (
          <div className="empty-state">
            <Bell size={48} />
            <h3>No notifications</h3>
            <p>You're all caught up!</p>
          </div>
        ) : (
          <div>
            {filtered.map((n) => {
              const cfg = typeConfig[n.type] || typeConfig.system;
              const Icon = cfg.icon;
              return (
                <div
                  key={n._id}
                  className={`notification-item ${!n.is_read ? 'unread' : ''}`}
                  style={{ borderBottom: '1px solid var(--border-light)', borderRadius: 0, padding: '16px 20px' }}
                >
                  <div className="notification-icon" style={{ background: cfg.bg, color: cfg.color }}>
                    <Icon size={16} />
                  </div>
                  <div className="notification-body" style={{ flex: 1 }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                      <span className="notification-title">{n.title}</span>
                      <span className={`badge ${
                        n.type === 'missed_dose' ? 'badge-danger' :
                        n.type === 'emergency' ? 'badge-warning' :
                        n.type === 'dose_confirmed' ? 'badge-success' : 'badge-neutral'
                      }`} style={{ fontSize: '0.6rem' }}>{cfg.label}</span>
                      {n.escalated && <span className="badge badge-danger" style={{ fontSize: '0.6rem', fontWeight: 800, display: 'inline-flex', alignItems: 'center', gap: 4 }}><AlertTriangle size={11} /> ESCALATED</span>}
                    </div>
                    <div className="notification-message" style={{ marginTop: 4 }}>{n.message}</div>
                    
                    <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginTop: 6 }}>
                      <span className="notification-time">{formatSmartDate(n.createdAt)}</span>
                      {n.delivery?.email?.sent && <span className="badge badge-neutral" style={{ fontSize: '0.65rem', display: 'inline-flex', alignItems: 'center', gap: 4 }}><Mail size={11} /> Email ✓</span>}
                      {n.delivery?.push?.sent && <span className="badge badge-neutral" style={{ fontSize: '0.65rem', display: 'inline-flex', alignItems: 'center', gap: 4 }}><Bell size={11} /> Push ✓</span>}
                    </div>

                    {['dose_reminder', 'camera_off_alert', 'skipped_medicine'].includes(n.type) && !n.is_dismissed && (
                      <div style={{ display: 'flex', gap: 8, marginTop: 10, flexWrap: 'wrap' }}>
                        {n.medication_log_id && (
                          <button className="btn btn-success btn-sm" style={{ background: '#D1FAE5', color: '#059669', border: '1px solid #059669', fontWeight: 600 }} onClick={async () => {
                            try {
                              await userAPI.updateLog(n.medication_log_id, {
                                status: 'taken',
                                verification_method: user?.role === 'caregiver' ? 'manual_caregiver' : 'manual',
                                notes: user?.role === 'caregiver' ? 'Confirmed by caregiver' : 'Taken (Manual)'
                              });
                              await notificationAPI.acknowledge(n._id);
                              loadNotifs();
                            } catch (err) { console.error(err); }
                          }}>
                            <CheckCircle size={14} style={{ marginRight: 4 }} /> Mark as Taken
                          </button>
                        )}
                        {n.type === 'dose_reminder' && (
                          <>
                            <button className="btn btn-secondary btn-sm" onClick={() => handleSnoozeNotif(n._id, 10)}>
                              <Clock size={14} style={{ marginRight: 4 }} /> Snooze 10m
                            </button>
                            <button className="btn btn-secondary btn-sm" onClick={() => handleSnoozeNotif(n._id, 30)}>
                              <Clock size={14} style={{ marginRight: 4 }} /> +30m
                            </button>
                          </>
                        )}
                      </div>
                    )}

                    {n.type === 'status_check' && !n.acknowledged_at && (
                      <div style={{ display: 'flex', gap: 8, marginTop: 10, flexWrap: 'wrap' }}>
                        <button className="btn btn-primary btn-sm" onClick={() => handleRespondNotif(n._id, "I'm okay, all good!")}>
                          <ThumbsUp size={14} style={{ marginRight: 4 }} /> I'm Okay
                        </button>
                        <button className="btn btn-secondary btn-sm" onClick={() => handleRespondNotif(n._id, "Please call me")}>
                          <Phone size={14} style={{ marginRight: 4 }} /> Please Call Me
                        </button>
                      </div>
                    )}
                  </div>
                  <div style={{ display: 'flex', gap: 4, alignItems: 'center', alignSelf: 'flex-start' }}>
                    {!n.is_read && (
                      <button className="btn btn-ghost btn-sm" onClick={() => markRead(n._id)} title="Mark read">
                        <Check size={14} />
                      </button>
                    )}
                    {n.requires_acknowledgement && !n.acknowledged_at && (
                      <button className="btn btn-primary btn-sm" onClick={() => acknowledge(n._id)}>
                        Acknowledge
                      </button>
                    )}
                    <button className="btn btn-ghost btn-sm" onClick={() => dismiss(n._id)} title="Dismiss">
                      <Trash2 size={14} />
                    </button>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}
