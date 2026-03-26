import { useState, useEffect } from 'react';
import { Link } from 'react-router-dom';
import { caregiverAPI, notificationAPI } from '../services/api';
import { Users, Pill, AlertTriangle, Bell, CheckCircle, Clock, ChevronRight } from 'lucide-react';

const AVATAR_COLORS = ['#0D9488', '#6366F1', '#EC4899', '#F59E0B', '#10B981', '#3B82F6'];

export default function Dashboard() {
  const [users, setUsers] = useState([]);
  const [summaries, setSummaries] = useState({});
  const [notifications, setNotifications] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  useEffect(() => {
    loadData();
  }, []);

  const loadData = async () => {
    try {
      setLoading(true);
      const [usersRes, notifsRes] = await Promise.all([
        caregiverAPI.getUsers(),
        notificationAPI.getAll({ limit: 5 }),
      ]);
      const userList = usersRes.data || [];
      setUsers(userList);
      setNotifications(notifsRes.data?.notifications || []);

      // Load summaries for each user
      const sums = {};
      await Promise.all(
        userList.map(async (u) => {
          try {
            const res = await caregiverAPI.getUserSummary(u._id);
            sums[u._id] = res.data;
          } catch { sums[u._id] = null; }
        })
      );
      setSummaries(sums);
    } catch (err) {
      setError('Could not load dashboard data. Make sure the backend is running on port 5000.');
    } finally {
      setLoading(false);
    }
  };

  const totalUsers = users.length;
  const totalAlerts = notifications.length;
  const avgAdherence = Object.values(summaries).reduce((sum, s) => {
    return sum + (s?.today_adherence?.adherence_percentage || 0);
  }, 0) / (totalUsers || 1);

  const missedDoses = Object.values(summaries).reduce((sum, s) => {
    return sum + (s?.today_adherence?.missed || 0);
  }, 0);

  if (loading) {
    return (
      <div className="empty-state">
        <div className="coming-soon-badge" style={{ margin: '0 auto' }}>
          <img src="/logo_icon.png" alt="" style={{ height: 16, animation: 'pulse 1.5s infinite' }} />
          Loading...
        </div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="empty-state">
        <AlertTriangle size={48} />
        <h3>Connection Error</h3>
        <p>{error}</p>
        <button className="btn btn-primary btn-sm mt-4" onClick={loadData}>Retry</button>
      </div>
    );
  }

  return (
    <div>
      {/* Stats */}
      <div className="stat-grid">
        <div className="stat-card">
          <div className="stat-icon primary"><Users size={20} /></div>
          <div>
            <div className="stat-value">{totalUsers}</div>
            <div className="stat-label">Family Members</div>
          </div>
        </div>
        <div className="stat-card">
          <div className="stat-icon success"><CheckCircle size={20} /></div>
          <div>
            <div className="stat-value">{avgAdherence.toFixed(0)}%</div>
            <div className="stat-label">Avg. Adherence Today</div>
          </div>
        </div>
        <div className="stat-card">
          <div className="stat-icon danger"><AlertTriangle size={20} /></div>
          <div>
            <div className="stat-value">{missedDoses}</div>
            <div className="stat-label">Missed Doses Today</div>
          </div>
        </div>
        <div className="stat-card">
          <div className="stat-icon warning"><Bell size={20} /></div>
          <div>
            <div className="stat-value">{totalAlerts}</div>
            <div className="stat-label">Pending Alerts</div>
          </div>
        </div>
      </div>

      {/* Content grid */}
      <div className="grid-2">
        {/* Family members list */}
        <div className="card">
          <div className="card-header">
            <div>
              <div className="card-title">Family Members</div>
              <div className="card-subtitle">Family you're monitoring</div>
            </div>
            <Link to="/family" className="btn btn-ghost btn-sm">View All <ChevronRight size={14} /></Link>
          </div>

          {users.length === 0 ? (
            <div className="empty-state">
              <Users size={40} />
              <h3>No family members yet</h3>
              <p>Ask your family members to link you as their caregiver from their app.</p>
            </div>
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
              {users.map((u, i) => {
                const summary = summaries[u._id];
                const adherence = summary?.today_adherence?.adherence_percentage;
                return (
                  <Link
                    key={u._id}
                    to={`/family/${u._id}`}
                    style={{
                      display: 'flex', alignItems: 'center', gap: 12,
                      padding: '10px 12px', borderRadius: 'var(--radius-md)',
                      textDecoration: 'none', color: 'inherit', transition: 'background 0.15s'
                    }}
                    className="notification-item"
                  >
                    <div className="avatar" style={{ background: AVATAR_COLORS[i % AVATAR_COLORS.length] }}>
                      {u.name?.charAt(0)?.toUpperCase()}
                    </div>
                    <div style={{ flex: 1 }}>
                      <div className="font-bold text-sm">{u.name}</div>
                      <div className="text-xs text-muted">{u.email}</div>
                    </div>
                    {adherence !== undefined && (
                      <span className={`badge ${adherence >= 80 ? 'badge-success' : adherence >= 50 ? 'badge-warning' : 'badge-danger'}`}>
                        {adherence}%
                      </span>
                    )}
                    <ChevronRight size={16} style={{ color: 'var(--text-muted)' }} />
                  </Link>
                );
              })}
            </div>
          )}
        </div>

        {/* Recent Alerts */}
        <div className="card">
          <div className="card-header">
            <div>
              <div className="card-title">Recent Alerts</div>
              <div className="card-subtitle">Latest notifications</div>
            </div>
            <Link to="/notifications" className="btn btn-ghost btn-sm">View All <ChevronRight size={14} /></Link>
          </div>

          {notifications.length === 0 ? (
            <div className="empty-state">
              <Bell size={40} />
              <h3>All clear</h3>
              <p>No new notifications at the moment.</p>
            </div>
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
              {notifications.slice(0, 5).map((n) => (
                <div key={n._id} className={`notification-item ${!n.is_read ? 'unread' : ''}`}>
                  <div className="notification-icon" style={{
                    background: n.type === 'missed_dose' ? 'var(--danger-light)' : 
                                n.type === 'emergency' ? 'var(--warning-light)' : 'var(--info-light)',
                    color: n.type === 'missed_dose' ? 'var(--danger)' :
                           n.type === 'emergency' ? 'var(--warning)' : 'var(--info)'
                  }}>
                    {n.type === 'missed_dose' ? <Pill size={16} /> :
                     n.type === 'emergency' ? <AlertTriangle size={16} /> :
                     <Bell size={16} />}
                  </div>
                  <div className="notification-body">
                    <div className="notification-title">{n.title}</div>
                    <div className="notification-message">{n.message}</div>
                    <div className="notification-time">
                      <Clock size={10} style={{ display: 'inline', marginRight: 4 }} />
                      {new Date(n.createdAt).toLocaleString()}
                    </div>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
