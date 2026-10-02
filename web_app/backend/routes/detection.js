const express = require('express');
const axios = require('axios');
const { protect } = require('../middleware/auth');

const router = express.Router();

const AI_BACKEND = process.env.PYTHON_SERVICE_URL || 'http://localhost:8000';

/**
 * Pipe a frame from the AI backend, preserving the headers that let a browser
 * keep it.
 *
 * These two routes used to copy Content-Type and nothing else. The AI backend
 * has been sending `Cache-Control: public, max-age=31536000, immutable` and an
 * ETag for some time, and both were dropped on the floor here, so the browser
 * was told nothing about caching and re-fetched every frame on every render.
 * Measured: twelve frames cost 186 ms the first time and 373 ms the second,
 * identical work repeated, and a gallery re-renders constantly while a stream
 * is running.
 *
 * A frame is immutable -- the id is a uuid and the bytes never change -- so
 * caching it for a year is safe, and the conditional request below makes even a
 * hard refresh cheap.
 */
async function pipeFrame(req, res, url, missing) {
  try {
    const response = await axios({
      method: 'get', url, responseType: 'stream', timeout: 10000,
      // Forward the browser's validators so the AI backend can answer 304 and
      // send no body at all.
      headers: req.headers['if-none-match'] ? { 'If-None-Match': req.headers['if-none-match'] } : {},
      // 304 is a success here, not an error to be turned into a 500.
      validateStatus: s => (s >= 200 && s < 300) || s === 304,
    });
    for (const h of ['content-type', 'cache-control', 'etag', 'last-modified', 'content-length']) {
      if (response.headers[h]) res.set(h, response.headers[h]);
    }
    if (!response.headers['content-type']) res.set('Content-Type', 'image/jpeg');
    if (response.status === 304) return res.status(304).end();
    response.data.pipe(res);
  } catch (err) {
    if (err.response?.status === 404) res.status(404).json({ error: `${missing} not found` });
    else res.status(500).json({ error: `Failed to fetch ${missing.toLowerCase()}` });
  }
}

// GET /api/detection/keyframes/:id/image — serve keyframe image (binary pipe)
// Unprotected because standard <img> tags cannot send Authorization headers
// ?w= asks the AI backend for a width-bounded copy. A list that draws these
// 100px wide was being sent the full 1280x720 capture: 196 frames is 16 MB and
// 19 s at a browser's six connections. Only the whitelisted widths over there
// are honoured, so this cannot be used to generate arbitrary files.
router.get('/keyframes/:id/image', (req, res) => {
  const w = /^\d+$/.test(String(req.query.w || '')) ? `?w=${req.query.w}` : '';
  return pipeFrame(req, res, `${AI_BACKEND}/api/keyframes/${req.params.id}/image${w}`, 'Keyframe');
});

// GET /api/detection/medication_frames/:id/image — serve medication frame image (binary pipe)
// Unprotected because <img> tags cannot send Authorization headers
router.get('/medication_frames/:id/image', (req, res) =>
  pipeFrame(req, res, `${AI_BACKEND}/api/keyframes/medication_frames/${req.params.id}/image`,
    'Medication frame'));

router.use(protect);

// Helper: forward request to FastAPI AI backend
async function proxy(req, res, method, path) {
  try {
    const url = `${AI_BACKEND}${path}`;
    const headers = { 'Content-Type': 'application/json' };
    // Note: no Authorization forwarded — FastAPI detection routes are unprotected
    //       (Node.js protect middleware already authenticated the user)

    const config = { method, url, headers, timeout: 60000 };
    if (method !== 'get' && req.body) config.data = req.body;

    const response = await axios(config);
    res.status(response.status).json(response.data);
  } catch (err) {
    console.error(`[Detection Proxy] ${method.toUpperCase()} ${path} ERROR:`, err.message);
    if (err.response) {
      console.error(`[Detection Proxy] FastAPI responded ${err.response.status}:`, err.response.data);
      res.status(err.response.status).json(err.response.data);
    } else if (err.code === 'ECONNREFUSED') {
      res.status(503).json({
        error: 'AI backend is not running',
        detail: `Could not connect to ${AI_BACKEND}. Start the FastAPI server on port 8000.`,
      });
    } else {
      res.status(500).json({ error: 'Proxy error', detail: err.message });
    }
  }
}

// POST /api/detection/start
router.post('/start', async (req, res) => {
  if (!req.body) req.body = {};
  req.body.user_id = req.user._id.toString();

  // Mark camera_used = true for this specific scheduled dose
  if (req.body.medication_id && req.body.scheduled_time) {
    try {
      const MedicationLog = require('../models/MedicationLog');
      // scheduled_time passed from frontend is ISO string, parse it to ensure match or match date loosely if needed.
      // But standard exact match works if they pass the exact ISO string.
      await MedicationLog.findOneAndUpdate(
        { 
          user_id: req.user._id, 
          medication_id: req.body.medication_id,
          scheduled_time: new Date(req.body.scheduled_time)
        },
        { $set: { camera_used: true } }
      );
    } catch (e) {
      console.error('[Detection Proxy] Failed to update camera_used flag', e.message);
    }
  }

  return proxy(req, res, 'post', '/api/detection/start');
});

// POST /api/detection/stop
router.post('/stop', (req, res) => proxy(req, res, 'post', '/api/detection/stop'));

// POST /api/detection/analyze
router.post('/analyze', (req, res) => proxy(req, res, 'post', '/api/detection/analyze'));

// GET /api/detection/status
router.get('/status', (req, res) => proxy(req, res, 'get', '/api/detection/status'));

// GET /api/detection/medicine-count
router.get('/medicine-count', (req, res) => proxy(req, res, 'get', '/api/detection/medicine-count'));

// GET /api/detection/scheduler — get medication scheduler state
router.get('/scheduler', (req, res) => proxy(req, res, 'get', '/api/scheduler/status'));

// Configure AI pipeline camera
router.post('/configure', (req, res) => proxy(req, res, 'post', '/api/configure'));

// GET /api/detection/keyframes — list stored keyframes
router.get('/keyframes', async (req, res) => {
  try {
    // Forward query params to FastAPI (medication_only, user_id, limit)
    const params = new URLSearchParams();
    if (req.query.limit) params.set('limit', req.query.limit);
    if (req.query.medication_only) params.set('medication_only', req.query.medication_only);

    // For normal users, only show their own keyframes
    // For caregivers, show keyframes of their monitored users
    const isCaregiverLike = req.user.role === 'admin' || req.user.role === 'caregiver' || req.user.role === 'family_member';
    if (!isCaregiverLike) {
      params.set('user_id', req.user._id.toString());
    } else if (req.query.user_id) {
      params.set('user_id', req.query.user_id);
    }

    const url = `${AI_BACKEND}/api/keyframes?${params.toString()}`;
    const response = await axios.get(url, { timeout: 60000 });
    let keyframes = response.data;

    // Additional access control: caregivers can only see their monitored users (or their own frames)
    if (isCaregiverLike && req.user.role !== 'admin') {
      const allowedUserIds = [req.user._id.toString()];
      if (req.user.monitoring_users && Array.isArray(req.user.monitoring_users)) {
        req.user.monitoring_users.forEach(id => allowedUserIds.push(id.toString()));
      }
      keyframes = keyframes.filter(kf => kf && kf.user_id && allowedUserIds.includes(kf.user_id.toString()));
    }

    res.json(keyframes);
  } catch (err) {
    console.error('[Detection Proxy] GET /api/detection/keyframes ERROR:', err.message);
    res.status(500).json({ error: 'Failed to fetch keyframes' });
  }
});

// GET /api/detection/keyframes/sync — fetch keyframes and base64 for local offloading
router.get('/keyframes/sync', async (req, res) => {
  try {
    const params = new URLSearchParams();
    if (req.query.user_id) params.set('user_id', req.query.user_id);
    else params.set('user_id', req.user._id.toString());
    
    const url = `${AI_BACKEND}/api/keyframes/sync?${params.toString()}`;
    const response = await axios.get(url, { timeout: 60000 });
    res.json(response.data);
  } catch (err) {
    console.error('[Detection Proxy] GET /api/detection/keyframes/sync ERROR:', err.message);
    res.status(500).json({ error: 'Failed to sync keyframes' });
  }
});

// POST /api/detection/keyframes/sync/confirm — confirm local storage to delete from backend
router.post('/keyframes/sync/confirm', async (req, res) => {
  try {
    const url = `${AI_BACKEND}/api/keyframes/sync/confirm`;
    const response = await axios.post(url, req.body, { timeout: 60000 });
    res.json(response.data);
  } catch (err) {
    console.error('[Detection Proxy] POST /api/detection/keyframes/sync/confirm ERROR:', err.message);
    res.status(500).json({ error: 'Failed to confirm sync' });
  }
});

// GET /api/detection/medication_frames — list medication frames
router.get('/medication_frames', async (req, res) => {
  try {
    const params = new URLSearchParams(req.query);

    // For normal users, only show their own medication frames
    const isCaregiverLike = req.user.role === 'admin' || req.user.role === 'caregiver' || req.user.role === 'family_member';
    if (!isCaregiverLike) {
      params.set('user_id', req.user._id.toString());
    } else if (req.query.user_id) {
      params.set('user_id', req.query.user_id);
    }

    const url = `${AI_BACKEND}/api/keyframes/medication_frames?${params.toString()}`;
    const response = await axios.get(url, { timeout: 60000 });
    let evidence = response.data || [];

    // Additional access control: caregivers can only see medication frames of their monitored users (or their own)
    if (isCaregiverLike && req.user.role !== 'admin') {
      const allowedUserIds = [req.user._id.toString()];
      if (req.user.monitoring_users && Array.isArray(req.user.monitoring_users)) {
        req.user.monitoring_users.forEach(id => allowedUserIds.push(id.toString()));
      }
      evidence = evidence.filter(ev => ev && ev.user_id && allowedUserIds.includes(ev.user_id.toString()));
    }

    res.json(evidence);
  } catch (err) {
    console.error('[Detection Proxy] GET /api/detection/medication_frames ERROR:', err.message);
    res.status(500).json({ error: 'Failed to fetch medication frames' });
  }
});

module.exports = router;
