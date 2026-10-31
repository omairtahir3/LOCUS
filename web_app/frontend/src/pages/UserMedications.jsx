import { useState, useEffect } from 'react';
import { userAPI } from '../services/api';
import { useAuth } from '../context/AuthContext';
import { Pill, Plus, Edit3, Trash2, CheckCircle, XCircle, Clock, AlertTriangle } from 'lucide-react';
import { formatSmartDate, formatTime12Hour } from '../utils/dateUtils';
import PageHeader from '../components/Layout/PageHeader';
import Loading from '../components/Feedback/Loading';
import { DOSE_LOOK, doseLabel } from '../utils/doseStatus';

const DAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];

export default function UserMedications() {
  const { user } = useAuth();
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
    } catch {
      alert('Failed to add medication');
    }
  };

  const deleteMed = async (id) => {
    if (!confirm('Delete this medication?')) return;
    try {
      await userAPI.deleteMedication(id);
      loadData();
    } catch {
      alert('Failed to delete medication');
    }
  };

  const statusIcon = (s) => {
    switch (s) {
      case 'taken': return <CheckCircle size={14} style={{ color: 'var(--success-text)' }} />;
      case 'missed': return <XCircle size={14} style={{ color: 'var(--danger-text)' }} />;
      case 'snoozed': return <Clock size={14} style={{ color: 'var(--warning-text)' }} />;
      case 'needs_verification': return <AlertTriangle size={14} style={{ color: 'var(--warning-text)' }} />;
      default: return <Clock size={14} style={{ color: 'var(--text-muted)' }} />;
    }
  };

  if (loading) return <Loading rows={4} label="Loading medications" />;

  return (
    <div>
      <PageHeader
        title="My Medications"
        description="Manage your medications and view history"
        actions={
          <button className="btn btn-primary" onClick={() => setShowAddModal(true)}>
            <Plus size={16} /> Add Medication
          </button>
        }
      />

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
            <ul className="dose-list">
              {schedule.map((s, i) => {
                const st = s.status || 'scheduled';
                const look = DOSE_LOOK[st] || DOSE_LOOK.scheduled;
                return (
                  <li key={s._id || s.id || i} className={`dose is-${look.tone}`}>
                    <time className="dose-time">{formatTime12Hour(s.scheduled_time)}</time>

                    <div className="dose-body">
                      <p className="dose-name">
                        {s.medication_name}
                        {s.dosage && <span className="dose-dosage">{s.dosage}</span>}
                      </p>

                      {/* Icon plus the words, never the tint alone. */}
                      <p className={`dose-chip is-${look.tone}`}>
                        {statusIcon(st)} {look.label}
                      </p>

                      {st === 'taken' && s.verification_method && (
                        <p className="dose-verified">
                          Verified by {['visual', 'Camera', 'ai_visual'].includes(s.verification_method)
                            ? 'camera'
                            : s.verification_method === 'manual_caregiver' ? 'a caregiver'
                            : s.verification_method === 'manual' ? 'hand'
                            : s.verification_method}
                        </p>
                      )}
                    </div>

                    <div className="dose-actions">
                      {st === 'needs_verification' && user?.role === 'elderly' && (
                        <span className="dose-waiting">
                          <Clock size={12} aria-hidden="true" /> Awaiting caregiver review
                        </span>
                      )}

                      {st === 'needs_verification' && user?.role !== 'elderly' && (
                        <>
                          <button
                            className="btn btn-sm dose-yes"
                            onClick={async () => {
                              try {
                                await userAPI.updateLog(s.id || s._id, { status: 'taken', verification_method: 'manual', notes: 'Manually verified' });
                                loadData();
                              } catch { alert('Verification failed'); }
                            }}
                          >
                            <CheckCircle size={14} /> Yes, taken
                          </button>
                          <button
                            className="btn btn-sm dose-no"
                            onClick={async () => {
                              try {
                                await userAPI.updateLog(s.id || s._id, { status: 'scheduled', verification_method: 'manual', notes: 'Returned to scheduled' });
                                loadData();
                              } catch { alert('Update failed'); }
                            }}
                          >
                            <XCircle size={14} /> No
                          </button>
                        </>
                      )}

                      {['camera_off', 'skipped'].includes(st) && user?.role !== 'elderly' && (
                        <button
                          className="btn btn-sm dose-yes"
                          onClick={async () => {
                            try {
                              if (s.id || s._id) {
                                await userAPI.updateLog(s.id || s._id, { status: 'taken', verification_method: 'manual', notes: 'Manually confirmed' });
                              } else {
                                const timeParts = s.scheduled_time.split(':');
                                const dt = new Date();
                                dt.setHours(parseInt(timeParts[0], 10), parseInt(timeParts[1], 10), 0, 0);
                                await userAPI.createLog({
                                  medication_id: s.medication_id,
                                  scheduled_time: dt.toISOString(),
                                  status: 'taken',
                                  verification_method: 'manual',
                                });
                              }
                              loadData();
                            } catch { alert('Update failed'); }
                          }}
                        >
                          <CheckCircle size={14} /> Mark as taken
                        </button>
                      )}

                      {['scheduled', 'pending', 'snoozed'].includes(st) && (
                        <button
                          className="btn btn-sm btn-secondary"
                          onClick={async () => {
                            try {
                              await userAPI.snoozeLog(s.id || s._id, { snooze_duration_minutes: 10 });
                              loadData();
                            } catch { alert('Snooze failed'); }
                          }}
                        >
                          <Clock size={14} /> Snooze 10m
                        </button>
                      )}
                    </div>
                  </li>
                );
              })}
            </ul>
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
                    <th><span className="sr-only">Actions</span></th>
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
                            <span key={i} className="badge badge-primary">{formatTime12Hour(t)}</span>
                          ))}
                        </div>
                      </td>
                      <td>
                        <span className={`badge ${med.is_active ? 'badge-success' : 'badge-neutral'}`}>
                          {med.is_active ? 'Active' : 'Inactive'}
                        </span>
                      </td>
                      <td>
                        {/* deleteMed keeps its confirm() step. */}
                        <button
                          className="btn btn-ghost btn-sm med-delete"
                          onClick={() => deleteMed(med.id || med._id)}
                          aria-label={`Delete ${med.name}`}
                        >
                          <Trash2 size={14} aria-hidden="true" />
                        </button>
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
                           return formatSmartDate(ds);
                        })()}
                      </td>
                      <td style={{ fontWeight: 600 }}>{log.medication_name || 'Unknown'}</td>
                      <td className="text-muted">{log.dosage || '-'}</td>
                      <td>
                        {(() => {
                          const ds = (log.status === 'skipped' || log.status === 'camera_off') ? 'camera_off' : log.status;
                          return (
                            <span className={`badge ${
                              ds === 'taken' ? 'badge-success' :
                              ds === 'missed' ? 'badge-danger' :
                              ds === 'needs_verification' ? 'badge-warning' : 'badge-neutral'
                            }`}>
                              {statusIcon(ds)} {doseLabel(ds)}
                            </span>
                          );
                        })()}
                      </td>
                      <td className="text-muted text-sm">
                        {['visual', 'Camera', 'ai_visual'].includes(log.verification_method) ? 'Camera' :
                         log.verification_method === 'manual_caregiver' ? 'Caregiver' :
                         log.verification_method === 'manual' ? 'Manual' :
                         log.verification_method || '-'}
                        {log.confidence_score != null && (
                          <span style={{ marginLeft: 6, fontWeight: 600, color: 'var(--primary-text)' }}>
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
          <div className="modal-content" style={{ maxWidth: 450, padding: 24, border: '1px solid rgba(0,0,0,0.1)', borderRadius: 16, backgroundColor: '#ffffff' }}>
            <div className="modal-header" style={{ marginBottom: 20 }}>
              <h3 style={{ fontSize: '1.25rem', fontWeight: 700, color: '#0F172A' }}>Add New Medication</h3>
              <button 
                className="btn btn-sm btn-ghost" 
                onClick={() => setShowAddModal(false)}
                style={{ padding: 4 }}
              >
                <XCircle size={20} color="#64748B" />
              </button>
            </div>
            
            <form onSubmit={handleAddSubmit}>
              <div className="form-group">
                <label className="form-label" style={{ color: '#475569', marginBottom: 6 }}>Medication Name</label>
                <input 
                  type="text" 
                  className="form-input" 
                  value={newMed.name} 
                  onChange={e => setNewMed({ ...newMed, name: e.target.value })}
                  placeholder="e.g. Panadol" 
                  style={{ border: '1px solid rgba(0,0,0,0.15)', color: '#000', borderRadius: 12 }}
                  required 
                />
              </div>

              <div className="form-group" style={{ marginTop: 16 }}>
                <label className="form-label" style={{ color: '#475569', marginBottom: 6 }}>Dosage</label>
                <input 
                  type="text" 
                  className="form-input" 
                  value={newMed.dosage} 
                  onChange={e => setNewMed({ ...newMed, dosage: e.target.value })}
                  placeholder="e.g. 500mg" 
                  style={{ border: '1px solid rgba(0,0,0,0.15)', color: '#000', borderRadius: 12 }}
                  required 
                />
              </div>

              <div className="form-group" style={{ marginTop: 16 }}>
                <label className="form-label" style={{ color: '#475569', marginBottom: 6 }}>Frequency</label>
                <select 
                  className="form-select" 
                  value={newMed.frequency}
                  onChange={e => setNewMed({ ...newMed, frequency: e.target.value })}
                  style={{ border: '1px solid rgba(0,0,0,0.15)', color: '#000', background: '#fff', borderRadius: 12 }}
                >
                  <option value="daily">Daily</option>
                  <option value="weekly">Weekly</option>
                  <option value="custom">Custom</option>
                </select>
              </div>

              {newMed.frequency === 'custom' && (
                <div className="form-group" style={{ marginTop: 16 }}>
                  <label className="form-label" style={{ color: '#475569', marginBottom: 8 }}>Select Days</label>
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
                          border: '1px solid rgba(0,0,0,0.1)',
                          background: newMed.days_of_week.includes(idx) ? 'var(--primary)' : 'transparent',
                          color: newMed.days_of_week.includes(idx) ? '#fff' : '#475569',
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
                <label className="form-label text-sm" style={{ color: '#475569', marginBottom: 6 }}>Target Scheduled Time</label>
                <div style={{ display: 'flex', gap: 10 }}>
                  <input 
                    type="time" 
                    className="form-input" 
                    value={newMed.times[0]} 
                    onChange={e => setNewMed({ ...newMed, times: [e.target.value] })}
                    style={{ border: '1px solid rgba(0,0,0,0.15)', color: '#000', borderRadius: 12 }}
                    required 
                  />
                </div>
              </div>

              <div style={{ display: 'flex', gap: 12, marginTop: 28, justifyContent: 'flex-end' }}>
                <button type="button" className="btn btn-ghost" style={{ border: '1px solid rgba(0,0,0,0.15)', color: '#475569', borderRadius: 12, backgroundColor: '#fff' }} onClick={() => setShowAddModal(false)}>Cancel</button>
                <button type="submit" className="btn btn-primary" style={{ border: '1px solid transparent', color: '#fff', borderRadius: 12, backgroundColor: 'var(--primary)' }}>Save Medication</button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
}
