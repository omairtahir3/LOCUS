import { useState, useEffect } from 'react';
import { Link } from 'react-router-dom';
import { caregiverAPI, notificationAPI } from '../services/api';
import { useAuth } from '../context/AuthContext';
import { 
  Users, Pill, AlertTriangle, Bell, CheckCircle, 
  Clock, ChevronRight, Activity, TrendingUp, Calendar,
  ArrowUpRight, MoreHorizontal
} from 'lucide-react';

const AVATAR_COLORS = ['#0D9488', '#6366F1', '#EC4899', '#F59E0B', '#10B981', '#3B82F6'];

export default function Dashboard() {
  const { user } = useAuth();
  const [users, setUsers] = useState([]);
  const [summaries, setSummaries] = useState({});
  const [notifications, setNotifications] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  useEffect(() => {
    loadData();
    const interval = setInterval(loadData, 5000);
    return () => clearInterval(interval);
  }, []);

  const loadData = async () => {
    try {
      const [usersRes, notifsRes] = await Promise.all([
        caregiverAPI.getUsers(),
        notificationAPI.getAll({ limit: 5 }),
      ]);
      const userList = usersRes.data || [];
      setUsers(userList);
      setNotifications(notifsRes.data?.notifications || []);

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
      console.error('Load data error:', err);
      setError(`Could not load dashboard data.`);
    } finally {
      setLoading(false);
    }
  };

  const totalUsers = users.length;
  const avgAdherence = users.length > 0 
    ? Object.values(summaries).reduce((sum, s) => sum + (s?.today_adherence?.adherence_percentage || 0), 0) / users.length 
    : 0;
  const missedDoses = Object.values(summaries).reduce((sum, s) => sum + (s?.today_adherence?.missed || 0), 0);

  if (loading && users.length === 0) {
    return (
      <div className="empty-state" style={{ minHeight: '60vh', display: 'flex', flexDirection: 'column', justifyContent: 'center' }}>
        <div style={{ width: 40, height: 40, border: '3px solid var(--border)', borderTopColor: 'var(--primary)', borderRadius: '50%', animation: 'spin 1s linear infinite', margin: '0 auto 20px' }} />
        <p>Syncing your care network...</p>
        <style>{`@keyframes spin { to { transform: rotate(360deg); } }`}</style>
      </div>
    );
  }

  return (
    <div className="dashboard-wrapper">
      <style>{`
        .dashboard-wrapper {
          animation: fadeIn 0.5s ease-out;
        }
        @keyframes fadeIn {
          from { opacity: 0; transform: translateY(10px); }
          to { opacity: 1; transform: translateY(0); }
        }
        
        .welcome-section {
          margin-bottom: 32px;
          display: flex;
          justify-content: space-between;
          align-items: flex-end;
        }
        .welcome-text h1 {
          font-size: 1.8rem;
          font-weight: 800;
          color: var(--text-primary);
          margin-bottom: 4px;
        }
        .welcome-text p {
          color: var(--text-secondary);
          font-size: 0.95rem;
        }

        .premium-stat-grid {
          display: grid;
          grid-template-columns: repeat(auto-fit, minmax(240px, 1fr));
          gap: 20px;
          margin-bottom: 32px;
        }

        .p-stat-card {
          background: var(--surface);
          border-radius: 24px;
          padding: 24px;
          border: 1px solid var(--border);
          position: relative;
          overflow: hidden;
          transition: all 0.3s ease;
        }
        .p-stat-card:hover {
          transform: translateY(-4px);
          box-shadow: var(--shadow-lg);
          border-color: var(--primary-light);
        }
        .p-stat-icon {
          width: 48px;
          height: 48px;
          border-radius: 16px;
          display: flex;
          align-items: center;
          justify-content: center;
          margin-bottom: 16px;
        }
        .p-stat-value {
          font-size: 2rem;
          font-weight: 800;
          color: var(--text-primary);
          line-height: 1;
          margin-bottom: 4px;
        }
        .p-stat-label {
          font-size: 0.85rem;
          font-weight: 600;
          color: var(--text-secondary);
          text-transform: uppercase;
          letter-spacing: 0.05em;
        }
        .p-stat-trend {
          position: absolute;
          top: 24px;
          right: 24px;
          font-size: 0.75rem;
          font-weight: 700;
          display: flex;
          align-items: center;
          gap: 4px;
        }

        .family-grid {
          display: grid;
          grid-template-columns: repeat(auto-fill, minmax(300px, 1fr));
          gap: 20px;
        }
        .member-card {
          background: var(--surface);
          border-radius: 24px;
          padding: 20px;
          border: 1px solid var(--border);
          transition: all 0.2s;
          display: flex;
          flex-direction: column;
          gap: 16px;
        }
        .member-card:hover {
          border-color: var(--primary);
          box-shadow: var(--shadow-md);
        }
        .member-header {
          display: flex;
          align-items: center;
          gap: 12px;
        }
        .member-info h4 {
          font-size: 1rem;
          font-weight: 700;
          color: var(--text-primary);
        }
        .member-info p {
          font-size: 0.75rem;
          color: var(--text-secondary);
        }
        
        .adherence-bar-container {
          height: 6px;
          background: var(--border-light);
          border-radius: 3px;
          overflow: hidden;
          margin-top: 8px;
        }
        .adherence-bar-fill {
          height: 100%;
          transition: width 1s ease-out;
        }

        .notif-item-premium {
          display: flex;
          gap: 16px;
          padding: 16px;
          border-radius: 16px;
          transition: all 0.2s;
          border: 1px solid transparent;
        }
        .notif-item-premium:hover {
          background: var(--surface-hover);
          border-color: var(--border-light);
        }
        .notif-icon-box {
          width: 40px;
          height: 40px;
          border-radius: 12px;
          display: flex;
          align-items: center;
          justify-content: center;
          flex-shrink: 0;
        }
      `}</style>

      <div className="welcome-section">
        <div className="welcome-text">
          <h1>Welcome, {user?.name?.split(' ')[0]}!</h1>
          <p>Here's how your family is doing today.</p>
        </div>
        <div style={{ display: 'flex', gap: '12px' }}>
          <div className="badge badge-neutral" style={{ padding: '8px 16px', borderRadius: '12px' }}>
            <Calendar size={14} style={{ marginRight: 8 }} />
            {new Date().toLocaleDateString('en-US', { month: 'long', day: 'numeric' })}
          </div>
        </div>
      </div>

      <div className="premium-stat-grid">
        <div className="p-stat-card">
          <div className="p-stat-icon" style={{ background: 'rgba(13, 148, 136, 0.1)', color: 'var(--primary)' }}>
            <Users size={24} />
          </div>
          <div className="p-stat-value">{totalUsers}</div>
          <div className="p-stat-label">Active Members</div>
          <div className="p-stat-trend" style={{ color: 'var(--success)' }}>
            <TrendingUp size={12} /> Live
          </div>
        </div>

        <div className="p-stat-card">
          <div className="p-stat-icon" style={{ background: 'rgba(99, 102, 241, 0.1)', color: 'var(--accent)' }}>
            <CheckCircle size={24} />
          </div>
          <div className="p-stat-value">{avgAdherence.toFixed(0)}%</div>
          <div className="p-stat-label">Daily Adherence</div>
          <div className="p-stat-trend" style={{ color: avgAdherence >= 80 ? 'var(--success)' : 'var(--warning)' }}>
            {avgAdherence >= 80 ? 'Stable' : 'Needs attention'}
          </div>
        </div>

        <div className="p-stat-card">
          <div className="p-stat-icon" style={{ background: 'rgba(239, 68, 68, 0.1)', color: 'var(--danger)' }}>
            <AlertTriangle size={24} />
          </div>
          <div className="p-stat-value">{missedDoses}</div>
          <div className="p-stat-label">Missed Doses</div>
          {missedDoses > 0 && <div className="p-stat-trend" style={{ color: 'var(--danger)' }}>Critical</div>}
        </div>
      </div>

      <div className="grid-2">
        <section>
          <div className="card-header" style={{ marginBottom: 20 }}>
            <h3 className="card-title" style={{ fontSize: '1.1rem' }}>Family Status</h3>
            <Link to="/family" className="btn btn-ghost btn-sm">Manage All</Link>
          </div>
          
          <div className="family-grid">
            {users.length === 0 ? (
              <div className="card" style={{ gridColumn: '1 / -1', textAlign: 'center', padding: 40 }}>
                <Users size={48} style={{ margin: '0 auto 16px', opacity: 0.2 }} />
                <h4>No family members connected</h4>
                <p className="text-muted text-sm">Add members to start monitoring.</p>
              </div>
            ) : (
              users.map((u, i) => {
                const summary = summaries[u._id];
                const adherence = summary?.today_adherence?.adherence_percentage || 0;
                return (
                  <div key={u._id} className="member-card">
                    <div className="member-header">
                      <div className="avatar" style={{ background: AVATAR_COLORS[i % AVATAR_COLORS.length] }}>
                        {u.name?.charAt(0)?.toUpperCase()}
                      </div>
                      <div className="member-info" style={{ flex: 1 }}>
                        <h4>{u.name}</h4>
                        <p>{u.email}</p>
                      </div>
                      <Link to={`/family/${u._id}`} className="btn btn-icon btn-ghost btn-sm">
                        <ArrowUpRight size={18} />
                      </Link>
                    </div>
                    
                    <div>
                      <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '0.8rem', fontWeight: 700 }}>
                        <span style={{ color: 'var(--text-secondary)' }}>Daily Adherence</span>
                        <span style={{ color: adherence >= 80 ? 'var(--success)' : 'var(--warning)' }}>{adherence}%</span>
                      </div>
                      <div className="adherence-bar-container">
                        <div 
                          className="adherence-bar-fill" 
                          style={{ 
                            width: `${adherence}%`, 
                            background: adherence >= 80 ? 'var(--success)' : adherence >= 50 ? 'var(--warning)' : 'var(--danger)' 
                          }} 
                        />
                      </div>
                    </div>

                    <div style={{ display: 'flex', gap: '8px' }}>
                      <div className="badge badge-neutral" style={{ fontSize: '0.65rem', flex: 1, justifyContent: 'center' }}>
                        {summary?.medications?.length || 0} Meds
                      </div>
                      <div className={`badge ${summary?.today_adherence?.missed > 0 ? 'badge-danger' : 'badge-success'}`} style={{ fontSize: '0.65rem', flex: 1, justifyContent: 'center' }}>
                        {summary?.today_adherence?.missed || 0} Missed
                      </div>
                    </div>
                  </div>
                );
              })
            )}
          </div>
        </section>

        <section>
          <div className="card" style={{ height: '100%', borderRadius: 28 }}>
            <div className="card-header" style={{ marginBottom: 12 }}>
              <h3 className="card-title" style={{ fontSize: '1.1rem' }}>Live Activity</h3>
              <Link to="/notifications" className="btn btn-ghost btn-sm">View Feed</Link>
            </div>
            
            <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
              {notifications.length === 0 ? (
                <div style={{ textAlign: 'center', padding: '60px 0' }}>
                  <Bell size={40} style={{ margin: '0 auto 12px', opacity: 0.1 }} />
                  <p className="text-muted text-sm">No recent activity.</p>
                </div>
              ) : (
                notifications.map((n) => (
                  <div key={n._id} className="notif-item-premium">
                    <div className="notif-icon-box" style={{
                      background: n.type === 'missed_dose' ? 'var(--danger-light)' : 
                                  n.type === 'emergency' ? 'var(--warning-light)' : 'var(--info-light)',
                      color: n.type === 'missed_dose' ? 'var(--danger)' :
                             n.type === 'emergency' ? 'var(--warning)' : 'var(--info)'
                    }}>
                      {n.type === 'missed_dose' ? <Pill size={18} /> :
                       n.type === 'emergency' ? <AlertTriangle size={18} /> :
                       <Activity size={18} />}
                    </div>
                    <div style={{ flex: 1 }}>
                      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
                        <h5 style={{ fontSize: '0.9rem', fontWeight: 700, margin: 0 }}>{n.title}</h5>
                        <span style={{ fontSize: '0.7rem', color: 'var(--text-muted)' }}>
                          {new Date(n.createdAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                        </span>
                      </div>
                      <p style={{ fontSize: '0.8rem', color: 'var(--text-secondary)', marginTop: 2, marginBottom: 0 }}>{n.message}</p>
                    </div>
                  </div>
                ))
              )}
            </div>
            
            {notifications.length > 0 && (
              <button className="btn btn-secondary w-full" style={{ marginTop: 'auto', borderRadius: 12 }}>
                Clear All Notifications
              </button>
            )}
          </div>
        </section>
      </div>
    </div>
  );
}
