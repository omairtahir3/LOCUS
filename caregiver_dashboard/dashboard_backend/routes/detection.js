const express = require('express');
const axios = require('axios');
const { protect } = require('../middleware/auth');

const router = express.Router();
router.use(protect);

const AI_BACKEND = process.env.AI_BACKEND_URL || 'http://localhost:8001';

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
router.post('/start', (req, res) => proxy(req, res, 'post', '/api/detection/start'));

// POST /api/detection/stop
router.post('/stop', (req, res) => proxy(req, res, 'post', '/api/detection/stop'));

// POST /api/detection/analyze
router.post('/analyze', (req, res) => proxy(req, res, 'post', '/api/detection/analyze'));

// GET /api/detection/status
router.get('/status', (req, res) => proxy(req, res, 'get', '/api/detection/status'));

module.exports = router;
