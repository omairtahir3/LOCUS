import { useState, useEffect } from 'react';
import { notificationAPI } from '../services/api';
import { Bell, Pill, AlertTriangle, CheckCircle, Check, Trash2, Filter } from 'lucide-react';

const typeConfig = {
  missed_dose:       { icon: Pill,  bg: 'var(--danger-light)',  color: 'var(--danger)',  label: 'Missed Dose' },
  dose_confirmed:    { icon: CheckCircle, bg: 'var(--success-light)', color: 'var(--success)', label: 'Dose Confirmed' },
  dose_reminder:     { icon: Bell,  bg: 'var(--info-light)',    color: 'var(--info)',    label: 'Reminder' },
  emergency:         { icon: AlertTriangle, bg: 'var(--warning-light)', color: 'var(--warning)', label: 'Emergency' },
  status_check:      { icon: Bell,  bg: 'var(--accent-light)',  color: 'var(--accent)',  label: 'Status Check' },
  caregiver_message: { icon: Bell,  bg: 'var(--primary-light)', color: 'var(--primary)', label: 'Message' },
  system:            { icon: Bell,  bg: 'var(--surface-hover)', color: 'var(--text-secondary)', label: 'System' },
};

export default function Notifications() {
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

  const filtered = filter === 'all' ? notifications :
    filter === 'unread' ? notifications :
    notifications.filter(n => n.type === filter);

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
          { key: 'missed_dose', label: 'Missed Doses' },
          { key: 'emergency', label: 'Emergency' },
          { key: 'dose_confirmed', label: 'Confirmed' },
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
                    <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                      <span className="notification-title">{n.title}</span>
                      <span className={`badge ${
                        n.type === 'missed_dose' ? 'badge-danger' :
                        n.type === 'emergency' ? 'badge-warning' :
                        n.type === 'dose_confirmed' ? 'badge-success' : 'badge-neutral'
                      }`} style={{ fontSize: '0.6rem' }}>{cfg.label}</span>
                    </div>
                    <div className="notification-message">{n.message}</div>
                    <div className="notification-time">{new Date(n.createdAt).toLocaleString()}</div>
                  </div>
                  <div style={{ display: 'flex', gap: 4, alignItems: 'center' }}>
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
