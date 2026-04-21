import { useState } from 'react';
import { useAuth } from '../context/AuthContext';
import { User, Bell, Shield, Save, Link as LinkIcon } from 'lucide-react';
import { authAPI } from '../services/api';

export default function SettingsPage() {
  const { user } = useAuth();
  const [linkEmail, setLinkEmail] = useState('');
  const [linkMsg, setLinkMsg] = useState(null);
  const [saving, setSaving] = useState(false);

  const handleLinkUser = async () => {
    if (!linkEmail) return;
    setSaving(true);
    try {
      // Note: This endpoint lets a USER link a caregiver, not the other way around
      // For the caregiver dashboard, users must link from their app
      setLinkMsg({ type: 'info', text: 'Users must link you as their caregiver from the LOCUS mobile app. Share your email with them.' });
    } catch {
      setLinkMsg({ type: 'error', text: 'Failed to link user' });
    } finally {
      setSaving(false);
    }
  };

  return (
    <div style={{ maxWidth: 700 }}>
      <div className="page-header">
        <h2 className="page-title">Settings</h2>
      </div>

      {/* Profile */}
      <div className="card mb-4">
        <div className="card-header">
          <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
            <User size={18} />
            <div className="card-title">Profile Information</div>
          </div>
        </div>
        <div className="grid-2">
          <div className="form-group">
            <label className="form-label">Full Name</label>
            <input className="form-input" value={user?.name || ''} readOnly style={{ background: 'var(--bg)' }} />
          </div>
          <div className="form-group">
            <label className="form-label">Email</label>
            <input className="form-input" value={user?.email || ''} readOnly style={{ background: 'var(--bg)' }} />
          </div>
          <div className="form-group">
            <label className="form-label">Role</label>
            <input className="form-input" value={user?.role || 'caregiver'} readOnly style={{ background: 'var(--bg)', textTransform: 'capitalize' }} />
          </div>
          <div className="form-group">
            <label className="form-label">Phone</label>
            <input className="form-input" value={user?.phone || 'Not set'} readOnly style={{ background: 'var(--bg)' }} />
          </div>
        </div>
      </div>

      {/* Link a User */}
      <div className="card mb-4">
        <div className="card-header">
          <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
            <LinkIcon size={18} />
            <div className="card-title">Link a Family Member</div>
          </div>
        </div>
        <p className="text-sm text-muted mb-4">
          To monitor a family member, they need to add your email as a caregiver from their LOCUS mobile app.
          Your registered email: <strong>{user?.email}</strong>
        </p>
        {linkMsg && (
          <div className={`auth-error`} style={{
            background: linkMsg.type === 'info' ? 'var(--info-light)' : 'var(--danger-light)',
            color: linkMsg.type === 'info' ? '#1E40AF' : '#991B1B',
          }}>
            {linkMsg.text}
          </div>
        )}
      </div>

      {/* Notification Preferences */}
      <div className="card mb-4">
        <div className="card-header">
          <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
            <Bell size={18} />
            <div className="card-title">Notification Preferences</div>
          </div>
        </div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
          {[
            { label: 'Push Notifications', desc: 'Get push notifications for all alerts', key: 'push', checked: user?.notification_prefs?.push ?? true },
            { label: 'Email Notifications', desc: 'Receive email alerts for critical events', key: 'email', checked: user?.notification_prefs?.email ?? true },
            { label: 'SMS Alerts', desc: 'Text message alerts for emergencies', key: 'sms', checked: user?.notification_prefs?.sms ?? false },
            { label: 'Missed Dose Alerts', desc: 'Get notified when a family member misses a dose', key: 'missed_dose', checked: user?.notification_prefs?.missed_dose ?? true },
            { label: 'Emergency Alerts', desc: '"I\'m Lost" and panic button notifications', key: 'emergency', checked: user?.notification_prefs?.emergency ?? true },
          ].map(pref => (
            <div key={pref.key} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
              <div>
                <div className="text-sm font-bold">{pref.label}</div>
                <div className="text-xs text-muted">{pref.desc}</div>
              </div>
              <label style={{ position: 'relative', width: 44, height: 24, cursor: 'pointer' }}>
                <input type="checkbox" defaultChecked={pref.checked} style={{ opacity: 0, width: 0, height: 0 }} />
                <span style={{
                  position: 'absolute', inset: 0, borderRadius: 12,
                  background: pref.checked ? 'var(--primary)' : 'var(--border)',
                  transition: 'background 0.2s',
                }}>
                  <span style={{
                    position: 'absolute', top: 2, left: pref.checked ? 22 : 2,
                    width: 20, height: 20, borderRadius: '50%', background: 'white',
                    transition: 'left 0.2s', boxShadow: 'var(--shadow-sm)',
                  }} />
                </span>
              </label>
            </div>
          ))}
        </div>
      </div>

      {/* Security */}
      <div className="card">
        <div className="card-header">
          <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
            <Shield size={18} />
            <div className="card-title">Security</div>
          </div>
        </div>
        <button className="btn btn-secondary btn-sm">Change Password</button>
      </div>
    </div>
  );
}
