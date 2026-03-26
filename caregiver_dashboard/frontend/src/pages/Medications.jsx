import { useState, useEffect } from 'react';
import { medicationAPI, caregiverAPI } from '../services/api';
import { Pill, Plus, Edit, Trash2, CheckCircle, XCircle, Clock } from 'lucide-react';

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

  const statusBadge = (status) => {
    const map = {
      taken: { cls: 'badge-success', icon: <CheckCircle size={12} /> },
      missed: { cls: 'badge-danger', icon: <XCircle size={12} /> },
      snoozed: { cls: 'badge-warning', icon: <Clock size={12} /> },
      scheduled: { cls: 'badge-neutral', icon: <Clock size={12} /> },
    };
    const s = map[status] || map.scheduled;
    return <span className={`badge ${s.cls}`}>{s.icon} {status}</span>;
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
          style={{ width: 240 }}
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
                    </tr>
                  </thead>
                  <tbody>
                    {schedule.map((s, i) => (
                      <tr key={i}>
                        <td style={{ fontWeight: 600, fontVariantNumeric: 'tabular-nums' }}>{s.scheduled_time}</td>
                        <td><strong>{s.medication_name}</strong></td>
                        <td className="text-muted">{s.dosage}</td>
                        <td>{statusBadge(s.status)}</td>
                        <td className="text-muted text-sm">{s.verification_method || '—'}</td>
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
                    </tr>
                  </thead>
                  <tbody>
                    {historyData.map((h, i) => (
                      <tr key={h._id || i}>
                        <td style={{ fontVariantNumeric: 'tabular-nums' }}>
                          {new Date(h.scheduled_time || h.createdAt).toLocaleString()}
                        </td>
                        <td>{h.medication_id?.name || h.medication_name || '—'}</td>
                        <td>{statusBadge(h.status)}</td>
                        <td className="text-muted">
                          {h.confidence_score ? `${(h.confidence_score * 100).toFixed(0)}%` : '—'}
                        </td>
                        <td className="text-muted text-sm">{h.notes || '—'}</td>
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
