import { createContext, useContext, useState, useEffect } from 'react';
import { authAPI } from '../services/api';

const AuthContext = createContext(null);

export function AuthProvider({ children }) {
  const [user, setUser] = useState(() => {
    const saved = localStorage.getItem('locus_user');
    return saved ? JSON.parse(saved) : null;
  });
  const [token, setToken] = useState(() => localStorage.getItem('locus_token'));
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);

  useEffect(() => {
    if (token && !user) {
      authAPI.getMe()
        .then(res => {
          const u = res.data.user || res.data;
          setUser(u);
          localStorage.setItem('locus_user', JSON.stringify(u));
        })
        .catch(() => logout());
    }
  }, [token]);

  const login = async (email, password) => {
    setLoading(true);
    setError(null);
    try {
      const res = await authAPI.login({ email, password });
      const { user: u, token: t } = res.data;
      setUser(u);
      setToken(t);
      localStorage.setItem('locus_token', t);
      localStorage.setItem('locus_user', JSON.stringify(u));
      return true;
    } catch (err) {
      setError(err.response?.data?.error || 'Login failed');
      return false;
    } finally {
      setLoading(false);
    }
  };

  const register = async (name, email, password, role = 'caregiver') => {
    setLoading(true);
    setError(null);
    try {
      const res = await authAPI.register({ name, email, password, role });
      const { user: u, token: t } = res.data;
      setUser(u);
      setToken(t);
      localStorage.setItem('locus_token', t);
      localStorage.setItem('locus_user', JSON.stringify(u));
      return true;
    } catch (err) {
      setError(err.response?.data?.error || 'Registration failed');
      return false;
    } finally {
      setLoading(false);
    }
  };

  const logout = () => {
    setUser(null);
    setToken(null);
    localStorage.removeItem('locus_token');
    localStorage.removeItem('locus_user');
  };

  return (
    <AuthContext.Provider value={{ user, token, loading, error, login, register, logout, setError }}>
      {children}
    </AuthContext.Provider>
  );
}

export const useAuth = () => useContext(AuthContext);
