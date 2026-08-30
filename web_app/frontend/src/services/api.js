import axios from 'axios';

const API_BASE = 'http://localhost:5000/api';
const PYTHON_API_BASE = 'http://localhost:8000/api';

const api = axios.create({
  baseURL: API_BASE,
  headers: { 'Content-Type': 'application/json' },
});


// Attach token to every request
const attachToken = (config) => {
  const token = localStorage.getItem('locus_token');
  if (token) config.headers.Authorization = `Bearer ${token}`;
  return config;
};

api.interceptors.request.use(attachToken);

// Handle 401 globally
const handle401 = (err) => {
  if (err.response?.status === 401) {
    localStorage.removeItem('locus_token');
    localStorage.removeItem('locus_user');
    window.location.href = '/login';
  }
  return Promise.reject(err);
};

api.interceptors.response.use((res) => res, handle401);

// ── Auth ─────────────────────────────────────────────────────────────────────
export const authAPI = {
  login:    (data) => api.post('/auth/login', data),
  register: (data) => api.post('/auth/register', data),
  getMe:    ()     => api.get('/auth/me'),
  linkCaregiver: (email) => api.post('/auth/link-caregiver', { caregiver_email: email }),
  forgotPassword: (email) => api.post('/auth/forgot-password', { email }),
  resetPassword: (data) => api.post('/auth/reset-password', data),
  googleLogin: (token, role, confirmRole = false) => api.post('/auth/google', { token, role, confirmRole }),
  getRtmpHost: () => api.get('/auth/rtmp-host'),
  updatePreferences: (data) => api.put('/auth/preferences', data),
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
  snoozeLog:   (id, data) => api.post(`/medications/logs/${id}/snooze`, data),
  getHistory:  (params) => api.get('/medications/logs/history', { params }),
  getDailySummary: (params) => api.get('/medications/summary/daily', { params }),
};

// ── Caregiver ────────────────────────────────────────────────────────────────
export const caregiverAPI = {
  getUsers:      ()   => api.get('/caregiver/users'),
  getUserSummary: (id) => api.get(`/caregiver/users/${id}/summary`),
  sendMessage:   (id, data) => api.post(`/caregiver/users/${id}/message`, data),
  statusCheck:   (id) => api.post(`/caregiver/users/${id}/status-check`),
  getVerificationEvents: (id, params) => api.get(`/caregiver/users/${id}/verification-events`, { params }),
  getAnomalies:  (id) => api.get(`/caregiver/users/${id}/anomalies`),
};

// ── Notifications ────────────────────────────────────────────────────────────
export const notificationAPI = {
  getAll:       (params) => api.get('/notifications', { params }),
  markRead:     (id)     => api.patch(`/notifications/${id}/read`),
  markAllRead:  ()       => api.patch('/notifications/read-all'),
  acknowledge:  (id)     => api.patch(`/notifications/${id}/acknowledge`),
  dismiss:      (id)     => api.delete(`/notifications/${id}`),
  respond:      (id, data) => api.post(`/notifications/${id}/respond`, data),
  snooze:       (id, data) => api.post(`/notifications/${id}/snooze`, data),
};

// ── AI Detection (proxied to FastAPI) ────────────────────────────────────────
export const detectionAPI = {
  start:     (data) => api.post('/detection/start', data),
  stop:      ()     => api.post('/detection/stop'),
  analyze:   (data) => api.post('/detection/analyze', data),
  getStatus: ()     => api.get('/detection/status'),
  getSchedulerStatus: () => api.get('/detection/scheduler'),
  configure: (data) => api.post('/detection/configure', data),
  getKeyframes:      (params) => api.get('/detection/keyframes', { params }),
  syncKeyframes:     (userId) => api.get('/detection/keyframes/sync', { params: { user_id: userId } }),
  confirmSync:       (keyframeIds) => api.post('/detection/keyframes/sync/confirm', { keyframe_ids: keyframeIds }),
  getKeyframeImage:  (id) => `${API_BASE}/detection/keyframes/${id}/image`,
  getMedicationFrames:       (params) => api.get('/detection/medication_frames', { params }),
  getMedicationFrameImage:  (id) => `${API_BASE}/detection/medication_frames/${id}/image`,
};

// ── Normal User API (Node.js backend) ─────────────────────────────────────────
export const userAPI = {
  getSchedule:    () => api.get('/medications/schedule/today'),
  getMedications: () => api.get('/medications'),
  getHistory:     (params) => api.get('/medications/logs/history', { params }),
  getDailySummary:(params) => api.get('/medications/summary/daily', { params }),
  getAdherence:   () => api.get('/medications/summary/daily'), // Use Node.js daily summary
  createLog:      (data) => api.post('/medications/logs/', data),
  updateLog:      (id, data) => api.patch(`/medications/logs/${id}`, data),
  snoozeLog:      (id, data) => api.post(`/medications/logs/${id}/snooze`, data),
  createMedication: (data) => api.post('/medications', data),
  updateMedication: (id, data) => api.put(`/medications/${id}`, data),
  deleteMedication: (id) => api.delete(`/medications/${id}`),
  // Auth via Node.js
  login:    (data) => api.post('/auth/login', data),
};

export default api;

// ── Event Logs ───────────────────────────────────────────────────────────────
export const eventLogsAPI = {
  getMemorySearch: (params) => api.get('/event-logs/memory-search', { params }),
  getKeyframes: (params) => api.get('/event-logs/keyframes', { params }),
  toggleFlag: (id, is_flagged) => api.patch(`/event-logs/${id}/flag`, { is_flagged })
};

// ── Relationships ────────────────────────────────────────────────────────────
export const relationshipsAPI = {
  getAll: () => api.get('/relationships'),
  getInteractions: (id) => api.get(`/relationships/${id}/interactions`),
  merge: (data) => api.post('/relationships/merge', data),
  confirmFace: (data) => api.post('/relationships/confirm', data),
  dismissFace: (data) => api.post('/relationships/dismiss', data),
  acknowledgeAction: (data) => api.post('/relationships/acknowledge', data)
};

export { api };
