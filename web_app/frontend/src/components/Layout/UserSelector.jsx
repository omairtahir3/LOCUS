import React from 'react';
import { useAuth } from '../../context/AuthContext';
import { useSelectedUser } from '../../context/SelectedUserContext';

export default function UserSelector({ style = {} }) {
  const { user } = useAuth();
  const selectedUserContext = useSelectedUser();
  const { selectedUser, monitoringUsers, selectUser } = selectedUserContext || {};

  if (user?.role !== 'caregiver' || !monitoringUsers || monitoringUsers.length === 0) {
    return null;
  }

  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: '8px', ...style }}>
      <span style={{ fontSize: '0.85rem', color: 'var(--text-secondary)', fontWeight: 600 }}>Viewing:</span>
      <select 
        value={selectedUser?._id || ''}
        onChange={(e) => selectUser(e.target.value)}
        className="form-input"
        style={{ padding: '6px 12px', fontSize: '0.9rem', height: '32px', borderRadius: '8px', cursor: 'pointer', fontWeight: 600, color: 'var(--text-primary)', backgroundColor: 'var(--surface)', border: '1px solid var(--border)' }}
      >
        {monitoringUsers.map(u => (
          <option key={u._id} value={u._id}>{u.name}</option>
        ))}
      </select>
    </div>
  );
}
