import { useState, useEffect } from 'react';
import { Link, useNavigate, useOutletContext } from 'react-router-dom';
import { caregiverAPI, notificationAPI } from '../services/api';
import { useAuth } from '../context/AuthContext';
import { useSelectedUser } from '../context/SelectedUserContext';
import DaySummary from '../components/Today/DaySummary';
import { formatClockTime } from '../utils/dateUtils';
import { adherencePct, NO_DATA, NO_DATA_LABEL } from '../utils/adherence';
import {
  Users, Pill, AlertTriangle, Bell, CheckCircle,
  Clock, ChevronRight, Activity, TrendingUp, Calendar,
  ArrowUpRight, MoreHorizontal, XCircle, EyeOff
} from 'lucide-react';

const AVATAR_COLORS = ['#0D9488', '#6366F1', '#EC4899', '#F59E0B', '#10B981', '#3B82F6'];

export default function Dashboard() {
  const { user } = useAuth();
  const { selectedUser } = useSelectedUser() || {};
  const navigate = useNavigate();
  const [users, setUsers] = useState([]);
  const [summaries, setSummaries] = useState({});
  const [notifications, setNotifications] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const { openChat } = useOutletContext();

  useEffect(() => {
    if (user && user.role !== 'caregiver' && user.role !== 'admin') {
      navigate('/my-dashboard', { replace: true });
      return;
    }
    loadData();
    // Refresh every 30s — not 5s — to avoid hammering the backend
    const interval = setInterval(() => {
      if (!document.hidden) loadData();
    }, 30000);
    return () => clearInterval(interval);
  }, []);

  const loadData = async () => {
    try {
      const [usersRes, notifsRes] = await Promise.all([
        caregiverAPI.getUsers(),
        notificationAPI.getAll({ limit: 5, unread_only: true }),
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

  // The dose aggregates that fed the old hero are gone with it. They summed
  // today_adherence, which is labelled today and carries period '7_days', so
  // every one of them stated a week's figure as a day's.
  const handleClearNotifications = async () => {
    try {
      await notificationAPI.markAllRead();
      setNotifications([]);
    } catch (err) {
      console.error('Error clearing notifications', err);
    }
  };


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
        /* A 3px rail reading top-to-bottom: identity without tinting the card,
           so the value keeps its ink token and stays legible. */

        /* 4px is enough to feel alive; 4px of lift at 0.3s read as drifting. */

        @media (prefers-reduced-motion: reduce) {
          .dashboard-wrapper { animation: none; }
        }

        /* ── Today ──────────────────────────────────────────────────────
           One feature surface carrying the answer, then the figures. The depth
           and the teal belong to this surface alone -- everything below it
           stays flat, so the eye lands here first and only once. */
        .today {
          position: relative;
          overflow: hidden;
          padding: 30px 34px 26px;
          margin-bottom: 28px;
          border-radius: var(--radius-xl);
          color: #EAFBF7;
          /* Every stop is dark enough that white clears 4.5:1 on it -- the
             first attempt ran up to #0D9488, where white is 3.74:1 and the
             labels failed outright. Darkest teal 7.4:1, lightest 4.9:1. */
          background:
            radial-gradient(118% 140% at 88% -18%, rgba(94, 234, 212, .22) 0%, rgba(94, 234, 212, 0) 58%),
            linear-gradient(152deg, #085952 0%, #0a766d 52%, #0b7e74 100%);
          box-shadow: var(--lift-3);
        }
        /* A soft inner edge so the surface reads as lit rather than printed. */
        .today::after {
          content: '';
          position: absolute; inset: 0;
          border-radius: inherit;
          box-shadow: inset 0 1px 0 rgba(255,255,255,.18), inset 0 0 0 1px rgba(255,255,255,.07);
          pointer-events: none;
        }
        .today-line {
          position: relative;
          font-size: clamp(1.5rem, 1.05rem + 1.7vw, 2.3rem);
          line-height: 1.14;
          letter-spacing: -0.025em;
          font-weight: 600;
          color: #FFFFFF;
          max-width: 22ch;
          margin: 0 0 24px;
          text-wrap: balance;
        }
        .today-figures {
          position: relative;
          display: flex; flex-wrap: wrap; margin: 0;
          padding-top: 20px;
          border-top: 1px solid rgba(255,255,255,.16);
        }
        .today-figures > div { padding-right: 30px; margin-right: 30px; border-right: 1px solid rgba(255,255,255,.13); }
        .today-figures > div:last-child { border-right: 0; margin-right: 0; padding-right: 0; }
        .today-figures dt {
          font-size: var(--text-sm);
          color: rgba(233, 252, 248, .88);  /* 6.0:1 on the mid stop */
          margin-bottom: 6px;
        }
        .today-figures dd {
          margin: 0;
          font-size: var(--text-2xl);
          font-weight: 700;
          line-height: 1;
          color: #FFFFFF;
          font-variant-numeric: tabular-nums;
          font-feature-settings: 'tnum' 1;
        }
        /* Light enough to clear the teal: the danger token is a text colour for
           white surfaces and would sink into this one. */
                /* No red here. Any red pale enough to sit on this teal falls under
           4.5:1, and tinting the number would make colour the only signal.
           The figure stays white and a mark beside it carries the state --
           the same rule the strip follows. */
        .today-figures .is-bad { color: #FFFFFF; }
        .today-figures .is-bad::after {
          content: '';
          display: inline-block;
          width: 7px; height: 7px;
          margin-left: 8px;
          vertical-align: 0.34em;
          border-radius: var(--radius-full);
          background: #FF8A8A;
          box-shadow: 0 0 0 3px rgba(255, 138, 138, .22);
        }
        .today-figures .unit { font-size: var(--text-lg); font-weight: 500; color: rgba(233,252,248,.8); }
        .today-scope {
          position: relative;
          margin: 20px 0 0;
          font-size: var(--text-sm);
          color: rgba(233, 252, 248, .82);  /* 5.4:1 */
          max-width: 62ch;
        }
        @media (max-width: 640px) {
          .today { padding: 24px 22px 20px; }
          .today-figures > div { padding-right: 18px; margin-right: 18px; }
        }

        .dashboard-grid {
          display: grid;
          grid-template-columns: 1.7fr 1.3fr;
          gap: 24px;
        }
        @media (max-width: 1024px) {
          .dashboard-grid { grid-template-columns: 1fr; }
        }

        .family-grid {
          display: grid;
          grid-template-columns: repeat(auto-fit, minmax(340px, 1fr));
          gap: 20px;
        }
        @media (max-width: 768px) {
          .welcome-section { flex-direction: column; align-items: flex-start; gap: 16px; }
          .family-grid { grid-template-columns: 1fr; }
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
          border-color: var(--primary-text);
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

      {/* The whole day for the selected person: rooms, activities, people,
          belongings, routine findings, location and alerts, with medication as
          one small card. The family roster stays below -- that is the part of
          this page that is genuinely about everyone. */}
      <DaySummary
        userId={selectedUser?._id}
        name={selectedUser?.name}
        homeLocation={summaries[selectedUser?._id]?.user?.home_location}
        canAct
      />

      <div className="dashboard-grid">
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
                const adherence = adherencePct(summary?.today_adherence);
                return (
                  <div key={u._id} className="member-card">
                    <div className="member-header">
                      {(u.picture || u.profile_picture) ? (
                        <img 
                          src={u.picture || u.profile_picture} 
                          alt="" 
                          className="avatar" 
                          referrerPolicy="no-referrer"
                          crossOrigin="anonymous"
                          style={{ objectFit: 'cover', borderRadius: '50%', border: '2px solid var(--primary)' }} 
                          onError={(e) => { e.target.style.display = 'none'; }}
                        />
                      ) : (
                        <div className="avatar" style={{ background: AVATAR_COLORS[i % AVATAR_COLORS.length] }}>
                          {u.name?.charAt(0)?.toUpperCase()}
                        </div>
                      )}
                      <div className="member-info" style={{ flex: 1 }}>
                        <h4>{u.name}</h4>
                        <p>{u.email}</p>
                      </div>
                      <div style={{ display: 'flex', gap: 8 }}>
                        <button onClick={() => openChat(u._id, u.name)} className="btn btn-icon btn-ghost btn-sm" title="Open Chat">
                          <svg className="w-[18px] h-[18px]" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M8 12h.01M12 12h.01M16 12h.01M21 12c0 4.418-4.03 8-9 8a9.863 9.863 0 01-4.255-.949L3 20l1.395-3.72C3.512 15.042 3 13.574 3 12c0-4.418 4.03-8 9-8s9 3.582 9 8z" /></svg>
                        </button>
                        <Link to={`/family/${u._id}`} className="btn btn-icon btn-ghost btn-sm">
                          <ArrowUpRight size={18} />
                        </Link>
                      </div>
                    </div>
                    
                    <div>
                      <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '0.8rem', fontWeight: 700 }}>
                        <span style={{ color: 'var(--text-secondary)' }}>Daily Adherence</span>
                        {adherence === null
                          ? <span style={{ color: 'var(--text-muted)' }} title={NO_DATA_LABEL}>{NO_DATA}</span>
                          : <span style={{ color: adherence >= 80 ? 'var(--success-text)' : 'var(--warning-text)' }}>{adherence}%</span>}
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
                          {formatClockTime(n.createdAt)}
                        </span>
                      </div>
                      <p style={{ fontSize: '0.8rem', color: 'var(--text-secondary)', marginTop: 2, marginBottom: 0 }}>{n.message}</p>
                    </div>
                  </div>
                ))
              )}
            </div>
            
            {notifications.length > 0 && (
              <button 
                className="btn btn-secondary w-full" 
                style={{ marginTop: 'auto', borderRadius: 12 }}
                onClick={handleClearNotifications}
              >
                Clear All Notifications
              </button>
            )}
          </div>
        </section>
      </div>
    </div>
  );
}
