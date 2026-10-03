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
    localStorage.removeItem(FRAME_TOKEN_KEY);
    window.location.href = '/login';
  }
  return Promise.reject(err);
};

api.interceptors.response.use((res) => res, handle401);

/**
 * Frame images are authorised, and an <img> tag cannot send a header, so the
 * URL carries a short-lived FRAME-SCOPE token instead. Never the session token:
 * a URL reaches browser history, Referer headers and server logs, so what sits
 * there has to be close to worthless if it leaks.
 *
 * Kept in localStorage so the URL is stable for the token's hour, which is what
 * lets the browser's cache and the backend's ETags keep working. Refreshed in
 * the background once there are under five minutes left.
 */
const FRAME_TOKEN_KEY = 'locus_frame_token';
let frameTokenInFlight = null;

const readFrameToken = () => {
  try {
    const raw = localStorage.getItem(FRAME_TOKEN_KEY);
    if (!raw) return null;
    const { token, expiresAt } = JSON.parse(raw);
    return token && expiresAt > Date.now() ? { token, expiresAt } : null;
  } catch {
    return null;   // malformed or storage unavailable: fetch a new one
  }
};

export const ensureFrameToken = async () => {
  const held = readFrameToken();
  if (held && held.expiresAt - Date.now() > 5 * 60 * 1000) return held.token;
  if (!localStorage.getItem('locus_token')) return null;   // not logged in
  // One request even if several images ask at once.
  if (!frameTokenInFlight) {
    frameTokenInFlight = api.get('/detection/image-token')
      .then(({ data }) => {
        const entry = { token: data.token, expiresAt: Date.now() + data.expires_in * 1000 };
        try { localStorage.setItem(FRAME_TOKEN_KEY, JSON.stringify(entry)); } catch { /* private mode */ }
        return entry.token;
      })
      .catch(() => null)
      .finally(() => { frameTokenInFlight = null; });
  }
  return frameTokenInFlight;
};

/** Appends the held token. Synchronous, because it is called from render. */
const withFrameToken = (url) => {
  const held = readFrameToken();
  // Fire and forget: a miss here shows the page's existing no-image fallback and
  // the next render has the token. Called on every frame URL, so this is also
  // what keeps the token fresh without a timer.
  if (!held || held.expiresAt - Date.now() < 5 * 60 * 1000) ensureFrameToken();
  if (!held) return url;
  return `${url}${url.includes('?') ? '&' : '?'}t=${encodeURIComponent(held.token)}`;
};

// Fetched up front so the first page of images has it, rather than on the first
// miss. Harmless when nobody is logged in: ensureFrameToken returns null.
ensureFrameToken();

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
  setHomeLocation: (data) => api.put('/users/me/home_location', data),
  getChatHistory: (userId) => api.get(`/users/chat/${userId}`),
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
  // `width` asks for a thumbnail. Lists draw these around 100px and were being
  // sent the full capture, which is most of what made the memory page slow.
  // Omit it for the full-size viewer. Supported: 160, 240, 480.
  getKeyframeImage:  (id, width) => withFrameToken(`${API_BASE}/detection/keyframes/${id}/image${width ? `?w=${width}` : ''}`),
  getMedicationFrames:       (params) => api.get('/detection/medication_frames', { params }),
  getMedicationFrameImage:  (id) => withFrameToken(`${API_BASE}/detection/medication_frames/${id}/image`),
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
  toggleFlag: (id, is_flagged) => api.patch(`/event-logs/${id}/flag`, { is_flagged }),
  // One day of the Core Module's output for the Activity Feed.
  timeline: (params) => api.get('/event-logs/timeline', { params }),
  // A question in the wearer's own words. Answered by utils/memoryAgent.
  ask: (question, params) => api.post('/event-logs/ask', { question }, { params })
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
