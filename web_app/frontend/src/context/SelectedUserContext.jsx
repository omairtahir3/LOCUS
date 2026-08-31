import React, { createContext, useContext, useState, useEffect } from 'react';
import { useAuth } from './AuthContext';
import { caregiverAPI } from '../services/api';

const SelectedUserContext = createContext(null);

export function SelectedUserProvider({ children }) {
  const { user } = useAuth();
  const [selectedUser, setSelectedUser] = useState(null); // { _id, name, ... }
  const [monitoringUsers, setMonitoringUsers] = useState([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (user?.role === 'caregiver') {
      const fetchUsers = async () => {
        try {
          const res = await caregiverAPI.getUsers();
          const list = res.data || [];
          setMonitoringUsers(list);
          if (list.length > 0) {
            // Check if there's a previously stored ID or default to first
            const storedId = localStorage.getItem('locus_selected_user_id');
            const found = list.find(u => u._id === storedId);
            if (found) {
              setSelectedUser(found);
            } else {
              setSelectedUser(list[0]);
              localStorage.setItem('locus_selected_user_id', list[0]._id);
            }
          }
        } catch (err) {
          console.error("Failed to fetch monitoring users", err);
        } finally {
          setLoading(false);
        }
      };
      fetchUsers();
    } else {
      setLoading(false);
    }
  }, [user]);

  const selectUser = (userId) => {
    const found = monitoringUsers.find(u => u._id === userId);
    if (found) {
      setSelectedUser(found);
      localStorage.setItem('locus_selected_user_id', userId);
    }
  };

  return (
    <SelectedUserContext.Provider value={{ selectedUser, monitoringUsers, selectUser, loading }}>
      {children}
    </SelectedUserContext.Provider>
  );
}

export const useSelectedUser = () => useContext(SelectedUserContext);
