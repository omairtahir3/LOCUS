import { useState, useEffect } from 'react';
import { userAPI } from '../services/api';
import { Pill, Plus, Edit3, Trash2, CheckCircle, XCircle, Clock, AlertTriangle } from 'lucide-react';

const DAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];

export default function UserMedications() {
  const [medications, setMedications] = useState([]);
  const [history, setHistory] = useState([]);
  const [schedule, setSchedule] = useState([]);
  const [tab, setTab] = useState('schedule');
  const [loading, setLoading] = useState(true);

  // Form State
  const [showAddModal, setShowAddModal] = useState(false);
  const [newMed, setNewMed] = useState({ name: '', dosage: '', frequency: 'daily', times: ['08:00'], days_of_week: [0,1,2,3,4,5,6] });

  useEffect(() => { loadData(); }, []);

  const loadData = async () => {
    setLoading(true);
    try {
      const [medsRes, histRes, schRes] = await Promise.all([
        userAPI.getMedications(),
        userAPI.getHistory({ limit: 30 }),
        userAPI.getSchedule()
      ]);
      setMedications(medsRes.data || []);
      setHistory(histRes.data || []);
      // the Python API might return schedule directly as the list or inside data.data depending on structure
      setSchedule(Array.isArray(schRes.data) ? schRes.data : schRes.data.data || []);
    } catch (err) {
      console.error('Load error:', err);
    } finally {
      setLoading(false);
    }
  };

  const handleAddSubmit = async (e) => {
    e.preventDefault();
    try {
      await userAPI.createMedication({
        name: newMed.name,
        dosage: newMed.dosage,
        frequency: newMed.frequency,
        scheduled_times: newMed.times,
        days_of_week: newMed.frequency === 'daily' ? [0,1,2,3,4,5,6] : newMed.days_of_week,
        start_date: new Date().toISOString()
      });
      setShowAddModal(false);
      setNewMed({ name: '', dosage: '', frequency: 'daily', times: ['08:00'] });
      loadData();
    } catch (err) {
      alert('Failed to add medication');
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
        <button className="btn btn-primary" onClick={() => setShowAddModal(true)}>
          <Plus size={16} /> Add Medication
        </button>
      </div>

      {/* Tab Switcher */}
      <div style={{ display: 'flex', gap: 4, marginBottom: 20, background: 'var(--surface-hover)', borderRadius: 'var(--radius-md)', padding: 4, width: 'fit-content' }}>
        {[
          { key: 'schedule', label: 'Today\'s Schedule' },
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

      {/* Today's Schedule */}
      {tab === 'schedule' && (
        <div className="card mb-4">
          <div className="card-header">
            <div>
              <div className="card-title">Today's Schedule</div>
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
                    <th>Action</th>
                  </tr>
                </thead>
                <tbody>
                  {schedule.map((s, i) => (
                    <tr key={s._id || s.id || i}>
                      <td style={{ fontWeight: 600 }}>{s.scheduled_time}</td>
                      <td><strong>{s.medication_name}</strong></td>
                      <td className="text-muted">{s.dosage}</td>
                      <td>
                        <span className={`badge ${
                          s.status === 'taken' ? 'badge-success' :
                          s.status === 'missed' ? 'badge-danger' :
                          s.status === 'needs_verification' ? 'badge-warning' : 'badge-neutral'
                        }`}>
                          {statusIcon(s.status)} {s.status}
                        </span>
                        {s.status === 'taken' && s.verification_method && (
                          <div style={{ fontSize: '0.75rem', marginTop: 4, color: 'var(--text-muted)' }}>
                            Verified: {s.verification_method === 'visual' ? 'Camera' : 'Manual'}
                          </div>
                        )}
                      </td>
                      <td>
                        {s.status === 'needs_verification' && (
                          <div style={{ display: 'flex', gap: 6 }}>
                            <button 
                              className="btn btn-sm" 
                              style={{ background: 'var(--success-light)', color: 'var(--success)', border: '1px solid var(--success)' }}
                              onClick={async () => {
                                try {
                                  await userAPI.updateLog(s.id, { status: 'taken', verification_method: 'manual', notes: 'Manually verified after AI failure' });
                                  loadData();
                                } catch(e) { alert('Verification failed'); }
                              }}
                            >
                              <CheckCircle size={14} /> Yes
                            </button>
                            <button 
                              className="btn btn-sm" 
                              style={{ background: 'var(--danger-light)', color: 'var(--danger)', border: '1px solid var(--danger)' }}
                              onClick={async () => {
                                try {
                                  await userAPI.updateLog(s.id, { status: 'missed', verification_method: 'manual', notes: 'Manually marked as missed' });
                                  loadData();
                                } catch(e) { alert('Update failed'); }
                              }}
                            >
                              <XCircle size={14} /> No
                            </button>
                          </div>
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
                       <td>
                         <span className="badge badge-neutral">{med.frequency}</span>
                         {med.frequency === 'custom' && med.days_of_week && (
                           <div style={{ fontSize: '0.7rem', color: 'var(--text-muted)', marginTop: 4 }}>
                             {med.days_of_week.map(d => DAYS[d]).join(', ')}
                           </div>
                         )}
                       </td>
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
                        {(() => {
                           if (!log.scheduled_time) return '-';
                           const ds = log.scheduled_time.endsWith('Z') ? log.scheduled_time : log.scheduled_time + 'Z';
                           const d = new Date(ds);
                           return isNaN(d.getTime()) ? log.scheduled_time : d.toLocaleString();
                        })()}
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

      {/* Add Modal */}
      {showAddModal && (
        <div className="modal-overlay">
          <div className="modal-content" style={{ maxWidth: 450, padding: 24, border: '1px solid rgba(255,255,255,0.15)', borderRadius: 16 }}>
            <div className="modal-header" style={{ marginBottom: 20 }}>
              <h3 style={{ fontSize: '1.25rem', fontWeight: 700, color: '#fff' }}>Add New Medication</h3>
              <button 
                className="btn btn-sm btn-ghost" 
                onClick={() => setShowAddModal(false)}
                style={{ padding: 4 }}
              >
                <XCircle size={20} color="#fff" />
              </button>
            </div>
            
            <form onSubmit={handleAddSubmit}>
              <div className="form-group">
                <label className="form-label" style={{ color: '#ebebeb', marginBottom: 6 }}>Medication Name</label>
                <input 
                  type="text" 
                  className="form-input" 
                  value={newMed.name} 
                  onChange={e => setNewMed({ ...newMed, name: e.target.value })}
                  placeholder="e.g. Panadol" 
                  style={{ border: '1px solid rgba(255,255,255,0.3)', color: '#000', borderRadius: 12 }}
                  required 
                />
              </div>

              <div className="form-group" style={{ marginTop: 16 }}>
                <label className="form-label" style={{ color: '#ebebeb', marginBottom: 6 }}>Dosage</label>
                <input 
                  type="text" 
                  className="form-input" 
                  value={newMed.dosage} 
                  onChange={e => setNewMed({ ...newMed, dosage: e.target.value })}
                  placeholder="e.g. 500mg" 
                  style={{ border: '1px solid rgba(255,255,255,0.3)', color: '#000', borderRadius: 12 }}
                  required 
                />
              </div>

              <div className="form-group" style={{ marginTop: 16 }}>
                <label className="form-label" style={{ color: '#ebebeb', marginBottom: 6 }}>Frequency</label>
                <select 
                  className="form-select" 
                  value={newMed.frequency}
                  onChange={e => setNewMed({ ...newMed, frequency: e.target.value })}
                  style={{ border: '1px solid rgba(255,255,255,0.3)', color: '#000', background: 'var(--surface)', borderRadius: 12 }}
                >
                  <option value="daily">Daily</option>
                  <option value="weekly">Weekly</option>
                  <option value="custom">Custom</option>
                </select>
              </div>

              {newMed.frequency === 'custom' && (
                <div className="form-group" style={{ marginTop: 16 }}>
                  <label className="form-label" style={{ color: '#ebebeb', marginBottom: 8 }}>Select Days</label>
                  <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
                    {DAYS.map((day, idx) => (
                      <button
                        key={day}
                        type="button"
                        onClick={() => {
                          const current = [...newMed.days_of_week];
                          if (current.includes(idx)) {
                            setNewMed({ ...newMed, days_of_week: current.filter(d => d !== idx) });
                          } else {
                            setNewMed({ ...newMed, days_of_week: [...current, idx].sort() });
                          }
                        }}
                        style={{
                          padding: '6px 10px',
                          borderRadius: 8,
                          fontSize: '0.75rem',
                          border: '1px solid rgba(255,255,255,0.3)',
                          background: newMed.days_of_week.includes(idx) ? 'var(--primary)' : 'transparent',
                          color: '#fff',
                          cursor: 'pointer',
                          transition: 'all 0.2s'
                        }}
                      >
                        {day}
                      </button>
                    ))}
                  </div>
                </div>
              )}

              <div className="form-group" style={{ marginTop: 16 }}>
                <label className="form-label text-sm" style={{ color: '#ebebeb', marginBottom: 6 }}>Target Scheduled Time</label>
                <div style={{ display: 'flex', gap: 10 }}>
                  <input 
                    type="time" 
                    className="form-input" 
                    value={newMed.times[0]} 
                    onChange={e => setNewMed({ ...newMed, times: [e.target.value] })}
                    style={{ border: '1px solid rgba(255,255,255,0.3)', color: '#000', borderRadius: 12 }}
                    required 
                  />
                </div>
              </div>

              <div style={{ display: 'flex', gap: 12, marginTop: 28, justifyContent: 'flex-end' }}>
                <button type="button" className="btn btn-ghost" style={{ border: '1px solid rgba(255,255,255,0.3)', color: '#fff', borderRadius: 12 }} onClick={() => setShowAddModal(false)}>Cancel</button>
                <button type="submit" className="btn btn-primary" style={{ border: '1px solid #fff', color: '#fff', borderRadius: 12 }}>Save Medication</button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
}
