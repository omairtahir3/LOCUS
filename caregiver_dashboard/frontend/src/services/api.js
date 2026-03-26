import axios from 'axios';

const API_BASE = 'http://localhost:5000/api';

const api = axios.create({
  baseURL: API_BASE,
  headers: { 'Content-Type': 'application/json' },
});

// Attach token to every request
api.interceptors.request.use((config) => {
  const token = localStorage.getItem('locus_token');
  if (token) config.headers.Authorization = `Bearer ${token}`;
  return config;
});

// Handle 401 globally
api.interceptors.response.use(
  (res) => res,
  (err) => {
    if (err.response?.status === 401) {
      localStorage.removeItem('locus_token');
      localStorage.removeItem('locus_user');
      window.location.href = '/login';
    }
    return Promise.reject(err);
  }
);

// ── Auth ─────────────────────────────────────────────────────────────────────
export const authAPI = {
  login:    (data) => api.post('/auth/login', data),
  register: (data) => api.post('/auth/register', data),
  getMe:    ()     => api.get('/auth/me'),
  linkCaregiver: (email) => api.post('/auth/link-caregiver', { caregiver_email: email }),
};

// ── Medications ──────────────────────────────────────────────────────────────
export const medicationAPI = {
  getAll:     (params) => api.get('/medications', { params }),
  create:     (data)   => api.post('/medications', data),
  update:     (id, data) => api.put(`/medications/${id}`, data),
  delete:     (id)     => api.delete(`/medications/${id}`),
  getSchedule: (userId) => api.get('/medications/schedule/today', { params: { userId } }),
  // Logs
  createLog:   (data)   => api.post('/medications/logs', data),
  updateLog:   (id, data) => api.patch(`/medications/logs/${id}`, data),
  getHistory:  (params) => api.get('/medications/logs/history', { params }),
  getDailySummary: (params) => api.get('/medications/summary/daily', { params }),
};

// ── Caregiver ────────────────────────────────────────────────────────────────
export const caregiverAPI = {
  getUsers:      ()   => api.get('/caregiver/users'),
  getUserSummary: (id) => api.get(`/caregiver/users/${id}/summary`),
  sendMessage:   (id, data) => api.post(`/caregiver/users/${id}/message`, data),
  statusCheck:   (id) => api.post(`/caregiver/users/${id}/status-check`),
};

// ── Notifications ────────────────────────────────────────────────────────────
export const notificationAPI = {
  getAll:       (params) => api.get('/notifications', { params }),
  markRead:     (id)     => api.patch(`/notifications/${id}/read`),
  markAllRead:  ()       => api.patch('/notifications/read-all'),
  acknowledge:  (id)     => api.patch(`/notifications/${id}/acknowledge`),
  dismiss:      (id)     => api.delete(`/notifications/${id}`),
};

// ── AI Detection (proxied to FastAPI) ────────────────────────────────────────
export const detectionAPI = {
  start:     (data) => api.post('/detection/start', data),
  stop:      ()     => api.post('/detection/stop'),
  analyze:   (data) => api.post('/detection/analyze', data),
  getStatus: ()     => api.get('/detection/status'),
};

export default api;
