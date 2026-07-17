import { useState, useEffect } from 'react';
import { medicationAPI, caregiverAPI } from '../services/api';
import { Pill, Plus, Edit, Trash2, CheckCircle, XCircle, Clock, SkipForward } from 'lucide-react';
import { formatSmartDate } from '../utils/dateUtils';

export default function Medications() {
  const [users, setUsers] = useState([]);
  const [selectedUser, setSelectedUser] = useState('');
  const [medications, setMedications] = useState([]);
  const [schedule, setSchedule] = useState([]);
  const [loading, setLoading] = useState(true);
  const [historyData, setHistoryData] = useState([]);

  useEffect(() => {
    caregiverAPI.getUsers().then(res => {
      const list = res.data || [];
      setUsers(list);
      if (list.length > 0) setSelectedUser(list[0]._id);
    }).catch(() => {}).finally(() => setLoading(false));
  }, []);

  useEffect(() => {
    if (!selectedUser) return;
    loadMedData();

    // Refresh every 30s — skip when tab is hidden
    const interval = setInterval(() => {
      if (!document.hidden) loadMedData();
    }, 30000);

    return () => clearInterval(interval);
  }, [selectedUser]);

  const loadMedData = async () => {
    try {
      const [schRes, histRes] = await Promise.all([
        medicationAPI.getSchedule(selectedUser),
        medicationAPI.getHistory({ userId: selectedUser, limit: 20 }),
      ]);
      setSchedule(schRes.data || []);
      setHistoryData(histRes.data || []);
    } catch {}
  };

  const markAsTaken = async (item, isHistory = false) => {
    try {
      if (item.log_id || item.id || item._id) {
        const logId = item.log_id || item.id || item._id;
        await medicationAPI.updateLog(logId, {
          status: 'taken',
          verification_method: 'manual',
          notes: 'Marked as taken by caregiver',
        });
      } else {
        // No log exists yet — create one
        const [hh, mm] = (item.scheduled_time || '00:00').split(':');
        const dt = new Date();
        dt.setHours(parseInt(hh), parseInt(mm), 0, 0);
        await medicationAPI.createLog({
          medication_id: item.medication_id,
          scheduled_time: dt.toISOString(),
          status: 'taken',
          verification_method: 'manual',
          notes: 'Marked as taken by caregiver',
        });
      }
      loadMedData();
    } catch (err) {
      console.error('Failed to mark as taken:', err);
      alert('Failed to update. Please try again.');
    }
  };

  const statusIcon = (s) => {
    switch (s) {
      case 'taken': return <CheckCircle size={14} style={{ color: 'var(--success)' }} />;
      case 'missed': return <XCircle size={14} style={{ color: 'var(--danger)' }} />;
      case 'snoozed': return <Clock size={14} style={{ color: 'var(--warning)' }} />;
      case 'camera_off': return <SkipForward size={14} style={{ color: 'var(--text-muted)' }} />;
      default: return <Clock size={14} style={{ color: 'var(--text-muted)' }} />;
    }
  };

  const renderStatus = (status, notes) => {
    const displayStatus = (status === 'camera_off' && notes === 'pending_camera_verification')
      ? 'scheduled' : (status === 'skipped' ? 'camera_off' : status);
    return (
      <span className={`badge ${
        displayStatus === 'taken' ? 'badge-success' :
        displayStatus === 'needs_verification' ? 'badge-warning' :
        displayStatus === 'missed' ? 'badge-danger' :
        displayStatus === 'camera_off' ? 'badge-neutral' :
        displayStatus === 'snoozed' ? 'badge-secondary' : 'badge-neutral'
      }`}>
        {statusIcon(displayStatus)} {(displayStatus || '').toUpperCase().replace('_', ' ')}
      </span>
    );
  };

  return (
    <div>
      <div className="page-header">
        <div>
          <h2 className="page-title">Medication Management</h2>
          <p className="page-description">Track medication schedules and adherence</p>
        </div>
        <select
          className="form-select"
          value={selectedUser}
          onChange={e => setSelectedUser(e.target.value)}
          style={{ width: '100%', maxWidth: 240 }}
        >
          <option value="">Select Family Member</option>
          {users.map(u => (
            <option key={u._id} value={u._id}>{u.name}</option>
          ))}
        </select>
      </div>

      {!selectedUser ? (
        <div className="card">
          <div className="empty-state">
            <Pill size={48} />
            <h3>Select a family member</h3>
            <p>Choose a family member from the dropdown to view their medication schedule.</p>
          </div>
        </div>
      ) : (
        <>
          {/* Today's Schedule */}
          <div className="card mb-4">
            <div className="card-header">
              <div>
                <div className="card-title">Today's Schedule</div>
                <div className="card-subtitle">{schedule.length} doses</div>
              </div>
            </div>
            {schedule.length === 0 ? (
              <div className="empty-state">
                <Pill size={36} />
                <p>No medications scheduled for today</p>
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
                      <th>Verified By</th>
                      <th>Actions</th>
                    </tr>
                  </thead>
                  <tbody>
                    {schedule.map((s, i) => (
                      <tr key={i}>
                        <td style={{ fontWeight: 600 }}>{s.scheduled_time}</td>
                        <td><strong>{s.medication_name}</strong></td>
                        <td className="text-muted">{s.dosage}</td>
                        <td>
                          {renderStatus(s.status, s.notes)}
                          {s.status === 'taken' && s.verification_method && (
                            <div style={{ fontSize: '0.75rem', marginTop: 4, color: 'var(--text-muted)' }}>
                              Verified: {['visual', 'Camera', 'ai_visual'].includes(s.verification_method) ? 'Camera' : ['manual', 'manual_caregiver'].includes(s.verification_method) ? 'Caregiver' : s.verification_method}
                            </div>
                          )}
                        </td>
                        <td className="text-muted text-sm">{s.verification_method ? (['visual', 'Camera', 'ai_visual'].includes(s.verification_method) ? 'Camera' : ['manual', 'manual_caregiver'].includes(s.verification_method) ? 'Caregiver' : s.verification_method) : '—'}</td>
                        <td>
                          {['camera_off', 'skipped', 'missed', 'scheduled', 'needs_verification'].includes(s.status) && (
                            <button
                              className="btn btn-sm"
                              style={{
                                background: 'var(--success-light, #D1FAE5)', color: 'var(--success, #059669)',
                                border: '1px solid var(--success, #059669)', borderRadius: 8,
                                fontSize: '0.75rem', padding: '4px 10px',
                              }}
                              onClick={() => markAsTaken(s)}
                            >
                              <CheckCircle size={12} /> Taken
                            </button>
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>

          {/* History */}
          <div className="card">
            <div className="card-header">
              <div>
                <div className="card-title">Recent History</div>
                <div className="card-subtitle">Last {historyData.length} dose events</div>
              </div>
            </div>
            {historyData.length === 0 ? (
              <div className="empty-state">
                <Clock size={36} />
                <p>No medication history available</p>
              </div>
            ) : (
              <div className="table-wrapper">
                <table className="table">
                  <thead>
                    <tr>
                      <th>Date & Time</th>
                      <th>Medication</th>
                      <th>Status</th>
                      <th>Confidence</th>
                      <th>Notes</th>
                      <th>Actions</th>
                    </tr>
                  </thead>
                  <tbody>
                    {historyData.map((h, i) => (
                      <tr key={h._id || i}>
                        <td style={{ fontVariantNumeric: 'tabular-nums' }}>
                          {formatSmartDate(h.scheduled_time || h.createdAt)}
                        </td>
                        <td>{h.medication_id?.name || h.medication_name || '—'}</td>
                        <td>{renderStatus(h.status, h.notes)}</td>
                        <td className="text-muted">
                          {h.confidence_score ? `${(h.confidence_score * 100).toFixed(0)}%` : '—'}
                        </td>
                        <td className="text-muted text-sm">{h.notes || '—'}</td>
                        <td>
                          {['camera_off', 'skipped', 'missed'].includes(h.status) && (
                            <button
                              className="btn btn-sm"
                              style={{
                                background: 'var(--success-light, #D1FAE5)', color: 'var(--success, #059669)',
                                border: '1px solid var(--success, #059669)', borderRadius: 8,
                                fontSize: '0.75rem', padding: '4px 10px',
                              }}
                              onClick={() => markAsTaken(h, true)}
                            >
                              <CheckCircle size={12} /> Mark Taken
                            </button>
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        </>
      )}
    </div>
  );
}
