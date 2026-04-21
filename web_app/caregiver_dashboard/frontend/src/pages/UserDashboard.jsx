import { useState, useEffect } from 'react';
import { userAPI } from '../services/api';
import { useAuth } from '../context/AuthContext';
import {
  Pill, CheckCircle, XCircle, Clock, AlertTriangle, TrendingUp,
  ChevronRight, Calendar, Zap
} from 'lucide-react';

export default function UserDashboard() {
  const { user } = useAuth();
  const [schedule, setSchedule] = useState([]);
  const [adherence, setAdherence] = useState(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    loadData();
    const interval = setInterval(loadData, 10000);
    return () => clearInterval(interval);
  }, []);

  const loadData = async () => {
    try {
      const [schedRes, adhRes] = await Promise.all([
        userAPI.getSchedule(),
        userAPI.getDailySummary(),
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
      // Reconstruct the correct date matching the schedule slot, not just 'now'
      const timeParts = item.scheduled_time.split(':');
      const dt = new Date();
      dt.setHours(parseInt(timeParts[0], 10), parseInt(timeParts[1], 10), 0, 0);

      await userAPI.createLog({
        medication_id: item.medication_id,
        scheduled_time: dt.toISOString(),
        status: 'taken',
        verification_method: 'manual',
      });
      loadData();
    } catch (err) {
      console.error('Failed to mark as taken:', err);
    }
  };

  const statusIcon = (s) => {
    switch (s) {
      case 'taken': return <CheckCircle size={16} style={{ color: 'var(--success)' }} />;
      case 'missed': return <XCircle size={16} style={{ color: 'var(--danger)' }} />;
      case 'snoozed': return <Clock size={16} style={{ color: 'var(--warning)' }} />;
      case 'needs_verification': return <AlertTriangle size={16} style={{ color: 'var(--warning)' }} />;
      default: return <Clock size={16} style={{ color: 'var(--text-muted)' }} />;
    }
  };

  // Find next upcoming dose
  const now = new Date();
  const upcoming = schedule
    .filter(s => s.status === 'scheduled')
    .sort((a, b) => {
      const ta = a.scheduled_time?.split(':') || [0, 0];
      const tb = b.scheduled_time?.split(':') || [0, 0];
      return (ta[0] * 60 + +ta[1]) - (tb[0] * 60 + +tb[1]);
    })[0];

  const adherencePercent = adherence?.adherence_percentage || 0;
  const taken = adherence?.taken || 0;
  const total = adherence?.total_scheduled || schedule.length;
  const circumference = 2 * Math.PI * 36;
  const offset = circumference - (adherencePercent / 100) * circumference;

  if (loading) {
    return <div className="empty-state"><p>Loading your dashboard...</p></div>;
  }

  return (
    <div>
      <div className="page-header">
        <div>
          <h2 className="page-title">Welcome back, {user?.name?.split(' ')[0] || 'User'}</h2>
          <p className="page-description">
            <Calendar size={14} style={{ display: 'inline', marginRight: 4 }} />
            {new Date().toLocaleDateString('en-US', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' })}
          </p>
        </div>
      </div>

      {/* Stats Grid */}
      <div className="stat-grid" style={{ gridTemplateColumns: 'repeat(4, 1fr)' }}>
        <div className="stat-card">
          <div className="stat-icon primary"><Pill size={20} /></div>
          <div>
            <div className="stat-value">{total}</div>
            <div className="stat-label">Total Doses Today</div>
          </div>
        </div>
        <div className="stat-card">
          <div className="stat-icon success"><CheckCircle size={20} /></div>
          <div>
            <div className="stat-value" style={{ color: 'var(--success)' }}>{taken}</div>
            <div className="stat-label">Taken</div>
          </div>
        </div>
        <div className="stat-card">
          <div className="stat-icon danger"><XCircle size={20} /></div>
          <div>
            <div className="stat-value" style={{ color: 'var(--danger)' }}>{adherence?.missed || 0}</div>
            <div className="stat-label">Missed</div>
          </div>
        </div>
        <div className="stat-card">
          <div className="stat-icon warning"><TrendingUp size={20} /></div>
          <div>
            <div className="stat-value">{adherencePercent.toFixed(0)}%</div>
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
              <p>No medications scheduled for today</p>
            </div>
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
              {schedule.map((s, i) => (
                <div key={i} style={{
                  display: 'flex', alignItems: 'center', gap: 12,
                  padding: '12px 16px',
                  borderRadius: 'var(--radius-md)',
                  border: '1px solid var(--border-light)',
                  background: s.status === 'taken' ? 'var(--success-light)' :
                              s.status === 'missed' ? 'var(--danger-light)' : 'var(--surface)',
                  transition: 'all 0.15s',
                }}>
                  <div style={{ fontWeight: 700, fontSize: '0.95rem', minWidth: 50 }}>
                    {s.scheduled_time}
                  </div>
                  <div style={{ flex: 1 }}>
                    <div style={{ fontWeight: 600, fontSize: '0.9rem' }}>{s.medication_name}</div>
                    <div className="text-muted text-xs">{s.dosage}</div>
                  </div>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                    <span className={`badge ${
                      s.status === 'taken' ? 'badge-success' :
                      s.status === 'missed' ? 'badge-danger' :
                      s.status === 'needs_verification' ? 'badge-warning' : 'badge-neutral'
                    }`}>
                      {statusIcon(s.status)} {s.status}
                    </span>
                    {s.status === 'scheduled' && (
                      <button
                        className="btn btn-primary btn-sm"
                        onClick={() => markAsTaken(s)}
                        style={{ padding: '4px 12px', fontSize: '0.75rem' }}
                      >
                        <CheckCircle size={12} /> Take
                      </button>
                    )}
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>

        {/* Adherence Ring + Next Dose */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: 20 }}>
          {/* Adherence Ring */}
          <div className="card" style={{ textAlign: 'center' }}>
            <div className="card-header" style={{ justifyContent: 'center' }}>
              <div className="card-title">Today's Adherence</div>
            </div>
            <div className="progress-ring" style={{ margin: '12px auto' }}>
              <svg width="80" height="80" viewBox="0 0 80 80">
                <circle className="progress-ring-bg" cx="40" cy="40" r="36" />
                <circle
                  className="progress-ring-fill"
                  cx="40" cy="40" r="36"
                  stroke={adherencePercent >= 80 ? 'var(--success)' : adherencePercent >= 50 ? 'var(--warning)' : 'var(--danger)'}
                  strokeDasharray={circumference}
                  strokeDashoffset={offset}
                />
              </svg>
              <div className="progress-ring-text">{adherencePercent.toFixed(0)}%</div>
            </div>
            <div className="text-muted text-sm">{taken} of {total} doses completed</div>
          </div>

          {/* Next Upcoming Dose */}
          {upcoming && (
            <div className="card" style={{
              borderLeft: '4px solid var(--primary)',
            }}>
              <div className="card-header">
                <div>
                  <div className="card-title" style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                    <Zap size={16} /> Next Dose
                  </div>
                </div>
              </div>
              <div style={{ display: 'flex', alignItems: 'center', gap: 16 }}>
                <div style={{
                  width: 56, height: 56,
                  borderRadius: 'var(--radius-md)',
                  background: 'var(--primary-light)',
                  color: 'var(--primary)',
                  display: 'flex', alignItems: 'center', justifyContent: 'center',
                  fontSize: '1.1rem', fontWeight: 700
                }}>
                  {upcoming.scheduled_time}
                </div>
                <div>
                  <div style={{ fontWeight: 600, fontSize: '1rem' }}>{upcoming.medication_name}</div>
                  <div className="text-muted text-sm">{upcoming.dosage}</div>
                </div>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
