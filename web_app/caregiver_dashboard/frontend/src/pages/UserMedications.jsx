import { useState, useEffect } from 'react';
import { userAPI } from '../services/api';
import { Pill, Plus, Edit3, Trash2, CheckCircle, XCircle, Clock, AlertTriangle } from 'lucide-react';

export default function UserMedications() {
  const [medications, setMedications] = useState([]);
  const [history, setHistory] = useState([]);
  const [tab, setTab] = useState('list');
  const [loading, setLoading] = useState(true);

  useEffect(() => { loadData(); }, []);

  const loadData = async () => {
    setLoading(true);
    try {
      const [medsRes, histRes] = await Promise.all([
        userAPI.getMedications(),
        userAPI.getHistory({ limit: 30 }),
      ]);
      setMedications(medsRes.data || []);
      setHistory(histRes.data || []);
    } catch (err) {
      console.error('Load error:', err);
    } finally {
      setLoading(false);
    }
  };

  const deleteMed = async (id) => {
    if (!confirm('Delete this medication?')) return;
    try {
      await userAPI.deleteMedication(id);
      loadData();
    } catch (err) {
      alert('Failed to delete medication');
    }
  };

  const statusIcon = (s) => {
    switch (s) {
      case 'taken': return <CheckCircle size={14} style={{ color: 'var(--success)' }} />;
      case 'missed': return <XCircle size={14} style={{ color: 'var(--danger)' }} />;
      case 'snoozed': return <Clock size={14} style={{ color: 'var(--warning)' }} />;
      case 'needs_verification': return <AlertTriangle size={14} style={{ color: 'var(--warning)' }} />;
      default: return <Clock size={14} style={{ color: 'var(--text-muted)' }} />;
    }
  };

  if (loading) return <div className="empty-state"><p>Loading medications...</p></div>;

  return (
    <div>
      <div className="page-header">
        <div>
          <h2 className="page-title">My Medications</h2>
          <p className="page-description">Manage your medications and view history</p>
        </div>
      </div>

      {/* Tab Switcher */}
      <div style={{ display: 'flex', gap: 4, marginBottom: 20, background: 'var(--surface-hover)', borderRadius: 'var(--radius-md)', padding: 4, width: 'fit-content' }}>
        {[
          { key: 'list', label: 'Active Medications' },
          { key: 'history', label: 'History' },
        ].map(t => (
          <button
            key={t.key}
            onClick={() => setTab(t.key)}
            className="btn btn-sm"
            style={{
              background: tab === t.key ? 'var(--surface)' : 'transparent',
              color: tab === t.key ? 'var(--text-primary)' : 'var(--text-secondary)',
              boxShadow: tab === t.key ? 'var(--shadow-xs)' : 'none',
              border: 'none',
              fontWeight: tab === t.key ? 600 : 400,
            }}
          >
            {t.label}
          </button>
        ))}
      </div>

      {/* Active Medications List */}
      {tab === 'list' && (
        <div className="card">
          <div className="card-header">
            <div>
              <div className="card-title">{medications.length} active medication{medications.length !== 1 ? 's' : ''}</div>
            </div>
          </div>

          {medications.length === 0 ? (
            <div className="empty-state">
              <Pill size={48} />
              <h3>No medications yet</h3>
              <p>Your medications will appear here once added from the mobile app or by your caregiver.</p>
            </div>
          ) : (
            <div className="table-wrapper">
              <table className="table">
                <thead>
                  <tr>
                    <th>Medication</th>
                    <th>Dosage</th>
                    <th>Frequency</th>
                    <th>Scheduled Times</th>
                    <th>Status</th>
                  </tr>
                </thead>
                <tbody>
                  {medications.map(med => (
                    <tr key={med.id || med._id}>
                      <td style={{ fontWeight: 600 }}>{med.name}</td>
                      <td>{med.dosage}</td>
                      <td><span className="badge badge-neutral">{med.frequency}</span></td>
                      <td>
                        <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap' }}>
                          {(med.scheduled_times || []).map((t, i) => (
                            <span key={i} className="badge badge-primary">{t}</span>
                          ))}
                        </div>
                      </td>
                      <td>
                        <span className={`badge ${med.is_active ? 'badge-success' : 'badge-neutral'}`}>
                          {med.is_active ? 'Active' : 'Inactive'}
                        </span>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}

      {/* History Tab */}
      {tab === 'history' && (
        <div className="card">
          <div className="card-header">
            <div>
              <div className="card-title">Medication History</div>
              <div className="card-subtitle">Last 30 entries</div>
            </div>
          </div>

          {history.length === 0 ? (
            <div className="empty-state">
              <Clock size={48} />
              <h3>No history yet</h3>
              <p>Your medication intake history will appear here.</p>
            </div>
          ) : (
            <div className="table-wrapper">
              <table className="table">
                <thead>
                  <tr>
                    <th>Date & Time</th>
                    <th>Medication</th>
                    <th>Dosage</th>
                    <th>Status</th>
                    <th>Verification</th>
                  </tr>
                </thead>
                <tbody>
                  {history.map((log, i) => (
                    <tr key={log.id || log._id || i}>
                      <td style={{ fontSize: '0.85rem' }}>
                        {log.scheduled_time ? new Date(log.scheduled_time).toLocaleString() : '-'}
                      </td>
                      <td style={{ fontWeight: 600 }}>{log.medication_name || 'Unknown'}</td>
                      <td className="text-muted">{log.dosage || '-'}</td>
                      <td>
                        <span className={`badge ${
                          log.status === 'taken' ? 'badge-success' :
                          log.status === 'missed' ? 'badge-danger' :
                          log.status === 'needs_verification' ? 'badge-warning' : 'badge-neutral'
                        }`}>
                          {statusIcon(log.status)} {log.status}
                        </span>
                      </td>
                      <td className="text-muted text-sm">
                        {log.verification_method === 'visual' ? 'Camera AI' :
                         log.verification_method === 'manual' ? 'Manual' :
                         log.verification_method || '-'}
                        {log.confidence_score != null && (
                          <span style={{ marginLeft: 6, fontWeight: 600, color: 'var(--primary)' }}>
                            {(log.confidence_score * 100).toFixed(0)}%
                          </span>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
