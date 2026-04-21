import { useState, useEffect } from 'react';
import { userAPI } from '../services/api';
import { Clock, CheckCircle, XCircle, AlertTriangle, TrendingUp, Calendar, Filter } from 'lucide-react';

export default function UserHistory() {
  const [history, setHistory] = useState([]);
  const [adherence, setAdherence] = useState(null);
  const [loading, setLoading] = useState(true);
  const [statusFilter, setStatusFilter] = useState('all');

  useEffect(() => { loadData(); }, []);

  const loadData = async () => {
    setLoading(true);
    try {
      const [histRes, adhRes] = await Promise.all([
        userAPI.getHistory({ limit: 50 }),
        userAPI.getAdherence(),
      ]);
      setHistory(histRes.data || []);
      setAdherence(adhRes.data || null);
    } catch (err) {
      console.error('History load error:', err);
    } finally {
      setLoading(false);
    }
  };

  const filtered = statusFilter === 'all'
    ? history
    : history.filter(h => h.status === statusFilter);

  // Group by date
  const grouped = {};
  filtered.forEach(log => {
    const dt = log.scheduled_time ? new Date(log.scheduled_time).toLocaleDateString() : 'Unknown';
    if (!grouped[dt]) grouped[dt] = [];
    grouped[dt].push(log);
  });

  const statusIcon = (s) => {
    switch (s) {
      case 'taken': return <CheckCircle size={14} style={{ color: 'var(--success)' }} />;
      case 'missed': return <XCircle size={14} style={{ color: 'var(--danger)' }} />;
      case 'needs_verification': return <AlertTriangle size={14} style={{ color: 'var(--warning)' }} />;
      default: return <Clock size={14} style={{ color: 'var(--text-muted)' }} />;
    }
  };

  if (loading) return <div className="empty-state"><p>Loading history...</p></div>;

  return (
    <div>
      <div className="page-header">
        <div>
          <h2 className="page-title">Medication History</h2>
          <p className="page-description">Your complete medication intake record</p>
        </div>
      </div>

      {/* Adherence Summary Stats */}
      {adherence && (
        <div className="stat-grid" style={{ gridTemplateColumns: 'repeat(4, 1fr)' }}>
          <div className="stat-card">
            <div className="stat-icon success"><TrendingUp size={20} /></div>
            <div>
              <div className="stat-value">{adherence.overall_adherence?.toFixed(0) || adherence.adherence_percentage?.toFixed(0) || 0}%</div>
              <div className="stat-label">Overall Adherence</div>
            </div>
          </div>
          <div className="stat-card">
            <div className="stat-icon primary"><CheckCircle size={20} /></div>
            <div>
              <div className="stat-value">{adherence.total_taken || adherence.taken || 0}</div>
              <div className="stat-label">Total Taken</div>
            </div>
          </div>
          <div className="stat-card">
            <div className="stat-icon danger"><XCircle size={20} /></div>
            <div>
              <div className="stat-value">{adherence.total_missed || adherence.missed || 0}</div>
              <div className="stat-label">Total Missed</div>
            </div>
          </div>
          <div className="stat-card">
            <div className="stat-icon warning"><Calendar size={20} /></div>
            <div>
              <div className="stat-value">{adherence.days_tracked || 0}</div>
              <div className="stat-label">Days Tracked</div>
            </div>
          </div>
        </div>
      )}

      {/* Filter Bar */}
      <div style={{
        display: 'flex', gap: 8, marginBottom: 20, alignItems: 'center'
      }}>
        <Filter size={16} style={{ color: 'var(--text-muted)' }} />
        {['all', 'taken', 'missed', 'snoozed', 'needs_verification'].map(f => (
          <button
            key={f}
            onClick={() => setStatusFilter(f)}
            className="btn btn-sm"
            style={{
              background: statusFilter === f ? 'var(--primary)' : 'var(--surface)',
              color: statusFilter === f ? 'white' : 'var(--text-secondary)',
              border: statusFilter === f ? 'none' : '1px solid var(--border)',
              textTransform: 'capitalize',
            }}
          >
            {f === 'all' ? 'All' : f.replace('_', ' ')}
          </button>
        ))}
      </div>

      {/* History Grouped by Date */}
      {Object.keys(grouped).length === 0 ? (
        <div className="card">
          <div className="empty-state">
            <Clock size={48} />
            <h3>No history found</h3>
            <p>No medication logs match your filter.</p>
          </div>
        </div>
      ) : (
        Object.entries(grouped).map(([date, logs]) => (
          <div key={date} className="card" style={{ marginBottom: 16 }}>
            <div className="card-header">
              <div>
                <div className="card-title" style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                  <Calendar size={16} /> {date}
                </div>
                <div className="card-subtitle">{logs.length} entries</div>
              </div>
              <div style={{ display: 'flex', gap: 8 }}>
                <span className="badge badge-success">
                  {logs.filter(l => l.status === 'taken').length} taken
                </span>
                <span className="badge badge-danger">
                  {logs.filter(l => l.status === 'missed').length} missed
                </span>
              </div>
            </div>

            <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
              {logs.map((log, i) => (
                <div key={log.id || log._id || i} style={{
                  display: 'flex', alignItems: 'center', gap: 12,
                  padding: '10px 14px',
                  borderRadius: 'var(--radius-sm)',
                  background: log.status === 'taken' ? 'var(--success-light)' :
                              log.status === 'missed' ? 'var(--danger-light)' : 'var(--surface-hover)',
                }}>
                  <div style={{ minWidth: 70, fontWeight: 600, fontSize: '0.85rem' }}>
                    {log.scheduled_time ? new Date(log.scheduled_time).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : '-'}
                  </div>
                  <div style={{ flex: 1 }}>
                    <div style={{ fontWeight: 600, fontSize: '0.85rem' }}>{log.medication_name || 'Unknown'}</div>
                    <div style={{ fontSize: '0.75rem', color: 'var(--text-muted)' }}>
                      {log.dosage || ''}
                      {log.verification_method && (
                        <span style={{ marginLeft: 8 }}>
                          via {log.verification_method === 'visual' ? 'Camera AI' : log.verification_method}
                        </span>
                      )}
                    </div>
                  </div>
                  <span className={`badge ${
                    log.status === 'taken' ? 'badge-success' :
                    log.status === 'missed' ? 'badge-danger' :
                    log.status === 'needs_verification' ? 'badge-warning' : 'badge-neutral'
                  }`}>
                    {statusIcon(log.status)} {log.status}
                  </span>
                  {log.confidence_score != null && (
                    <span style={{
                      fontSize: '0.75rem', fontWeight: 700, color: 'var(--primary)',
                      background: 'var(--primary-light)', padding: '2px 8px',
                      borderRadius: 'var(--radius-full)',
                    }}>
                      {(log.confidence_score * 100).toFixed(0)}%
                    </span>
                  )}
                </div>
              ))}
            </div>
          </div>
        ))
      )}
    </div>
  );
}
