const express = require('express');
const router = express.Router();
const User = require('../models/User');
const { protect: auth } = require('../middleware/auth');
const { getIO } = require('../utils/socket');
const { createNotification } = require('../utils/notifications');
const { phraseNotification } = require('../utils/llmAgent');

/**
 * PUT /api/users/me/steps   { date: 'YYYY-MM-DD', steps: 4213, raw_device_total?: 998123 }
 *
 * The phone reports the day's step count. The pedometer counts from the last
 * reboot, so the device does the arithmetic and sends the daily figure; see
 * models/StepCount.js.
 *
 * Idempotent: the app re-sends a growing total for the same day, so this
 * upserts and takes the HIGHER value. Taking the newer value instead would
 * let a fresh install, whose baseline restarts at zero, wipe out a day that
 * was already counted.
 */
router.put('/me/steps', auth, async (req, res) => {
  try {
    const StepCount = require('../models/StepCount');
    const { date, steps, raw_device_total = null, source = 'pedometer' } = req.body;

    if (!/^\d{4}-\d{2}-\d{2}$/.test(String(date || ''))) {
      return res.status(400).json({ error: 'date must be YYYY-MM-DD' });
    }
    const n = Number(steps);
    if (!Number.isFinite(n) || n < 0) {
      return res.status(400).json({ error: 'steps must be a non-negative number' });
    }
    // A day has 86400 seconds; nobody takes a step every third of a second for
    // all of them. A figure above this is a sensor fault, not a walk.
    if (n > 200000) return res.status(400).json({ error: 'steps out of plausible range' });

    const existing = await StepCount.findOne({ user_id: req.user._id, date });
    const best = Math.max(Math.round(n), existing?.steps || 0);

    const doc = await StepCount.findOneAndUpdate(
      { user_id: req.user._id, date },
      { $set: { steps: best, source, raw_device_total } },
      { upsert: true, new: true, setDefaultsOnInsert: true },
    );
    res.json({ date: doc.date, steps: doc.steps });
  } catch (error) {
    console.error('[User] Error recording steps:', error);
    res.status(500).json({ error: 'Server error' });
  }
});

/** GET /api/users/me/steps?date=YYYY-MM-DD (caregivers may pass ?userId=). */
router.get('/me/steps', auth, async (req, res) => {
  try {
    const StepCount = require('../models/StepCount');
    let userId = req.user._id;
    if (req.user.role === 'caregiver' && req.query.userId) userId = req.query.userId;
    const date = req.query.date || new Date().toISOString().slice(0, 10);
    const doc = await StepCount.findOne({ user_id: userId, date }).lean();
    res.json({ date, steps: doc ? doc.steps : null });
  } catch (error) {
    console.error('[User] Error reading steps:', error);
    res.status(500).json({ error: 'Server error' });
  }
});

// POST /api/users/me/emergency
// Trigger SOS
router.post('/me/emergency', auth, async (req, res) => {
  try {
    if (req.user.role !== 'elderly') {
      return res.status(403).json({ error: 'Only elderly users can trigger emergency status' });
    }

    if (!req.user.caregiver_ids || req.user.caregiver_ids.length === 0) {
      return res.status(400).json({ error: 'No linked caregivers to notify' });
    }

    // Update user status
    req.user.emergency_status = true;
    req.user.last_emergency_time = new Date();
    await req.user.save();

    // Prepare payload
    const { lat, lng } = req.body;
    const payload = {
      user_id: req.user._id,
      user_name: req.user.name,
      timestamp: new Date(),
      location: { lat, lng }
    };

    // Broadcast to all linked caregivers. Every live socket event goes out
    // before the first notification is built: the notification text is written
    // by the agent, and one caregiver waiting on a model call must never hold
    // up the instant alert to the next one.
    const io = getIO();
    for (const caregiverId of req.user.caregiver_ids) {
      io.to(caregiverId.toString()).emit('sos_alert', payload);
    }

    // Persistent escalated notification (triggers push + email), phrased by the
    // agent like every other alert. The title stays exactly as written: an
    // emergency is the one case where the wording must not vary at a glance.
    const caregivers = await User.find({ _id: { $in: req.user.caregiver_ids } }).lean();
    const sos = {
      kind: 'emergency', severity: 'urgent',
      title: `EMERGENCY SOS: ${req.user.name}`,
      message: `${req.user.name} has triggered an SOS alert. Please check their location immediately.`,
    };
    for (const caregiver of caregivers) {
      const said = await phraseNotification(sos, caregiver, req.user);
      await createNotification({
        recipientId: caregiver._id,
        subjectUserId: req.user._id,
        type: 'emergency',
        title: said.title,
        message: said.message,
        requiresAck: true,
        sender: 'System'
      });
    }

    res.json({ message: 'Emergency triggered successfully', status: 'active' });
  } catch (error) {
    console.error('[Emergency] Error triggering SOS:', error);
    res.status(500).json({ error: 'Server error' });
  }
});

// DELETE /api/users/me/emergency
// Self-cancel SOS by elderly user
router.delete('/me/emergency', auth, async (req, res) => {
  try {
    if (req.user.role !== 'elderly') {
      return res.status(403).json({ error: 'Only elderly users can manage emergency status' });
    }

    req.user.emergency_status = false;
    await req.user.save();

    // Broadcast resolution to caregivers, marked as resolved by user
    const io = getIO();
    req.user.caregiver_ids.forEach(caregiverId => {
      io.to(caregiverId.toString()).emit('sos_resolved', {
        user_id: req.user._id,
        user_name: req.user.name,
        resolved_by: 'user'
      });
    });

    res.json({ message: 'Emergency cancelled successfully', status: 'resolved' });
  } catch (error) {
    console.error('[Emergency] Error cancelling SOS:', error);
    res.status(500).json({ error: 'Server error' });
  }
});

// DELETE /api/users/:id/emergency
// Resolve SOS by caregiver
router.delete('/:id/emergency', auth, async (req, res) => {
  try {
    if (req.user.role !== 'caregiver') {
      return res.status(403).json({ error: 'Only caregivers can resolve emergencies for others' });
    }

    const elderlyUser = await User.findById(req.params.id);
    if (!elderlyUser) {
      return res.status(404).json({ error: 'User not found' });
    }

    // Ensure this caregiver is linked
    if (!elderlyUser.caregiver_ids.includes(req.user._id)) {
      return res.status(403).json({ error: 'Not authorized to resolve for this user' });
    }

    elderlyUser.emergency_status = false;
    await elderlyUser.save();

    // Broadcast resolution to ALL caregivers of this user, marked as resolved by caregiver
    const io = getIO();
    elderlyUser.caregiver_ids.forEach(caregiverId => {
      io.to(caregiverId.toString()).emit('sos_resolved', {
        user_id: elderlyUser._id,
        user_name: elderlyUser.name,
        resolved_by: 'caregiver',
        resolver_name: req.user.name
      });
    });

    // Also notify the elderly user themselves that it was resolved
    io.to(elderlyUser._id.toString()).emit('sos_resolved', {
        user_id: elderlyUser._id,
        resolved_by: 'caregiver',
        resolver_name: req.user.name
    });

    res.json({ message: 'Emergency resolved successfully', status: 'resolved' });
  } catch (error) {
    console.error('[Emergency] Error resolving SOS:', error);
    res.status(500).json({ error: 'Server error' });
  }
});

// PUT /api/users/me/home_location
// Set home location
router.put('/me/home_location', auth, async (req, res) => {
  try {
    const { lat, lng, address } = req.body;
    if (lat === undefined || lng === undefined) {
      return res.status(400).json({ error: 'lat and lng are required' });
    }

    // inferred: false -- setting it by hand supersedes any guess, and stops
    // resolveHome() overwriting it later.
    req.user.home_location = { lat, lng, address, inferred: false };
    await req.user.save();

    res.json({ message: 'Home location updated successfully', home_location: req.user.home_location });
  } catch (error) {
    console.error('[User] Error updating home location:', error);
    res.status(500).json({ error: 'Server error' });
  }
});

// ── Privacy ──────────────────────────────────────────────────────────────────
//
// The rooms the scene classifier can actually name. Offering a room it cannot
// recognise would be a switch that silently does nothing, which on a privacy
// control is worse than not offering it: see ai/scene.py SCENE_WEIGHTS.
const KNOWN_ROOMS = ['bathroom', 'bedroom', 'kitchen', 'living', 'dining', 'office'];
const PRIVACY_MODES = ['off', 'blur', 'paused'];

// GET /api/users/me/privacy
// What is switched on, and whether the pipeline has gone dead by itself.
router.get('/me/privacy', auth, async (req, res) => {
  try {
    const p = req.user.privacy || {};
    const now = new Date();
    res.json({
      mode: p.mode || 'off',
      mode_set_at: p.mode_set_at || null,
      sensitive_rooms: p.sensitive_rooms || [],
      sensitive_places: p.sensitive_places || [],
      // Reported as live/not-live rather than as a raw timestamp, so a stale
      // auto_dead_until cannot read as "still dead" on the page.
      auto_dead: !!(p.auto_dead_until && new Date(p.auto_dead_until) > now),
      auto_dead_until: p.auto_dead_until || null,
      auto_dead_reason: p.auto_dead_reason || null,
      known_rooms: KNOWN_ROOMS,
    });
  } catch (error) {
    console.error('[Privacy] Error reading settings:', error);
    res.status(500).json({ error: 'Server error' });
  }
});

// PUT /api/users/me/privacy
// Set the mode, the sensitive rooms, or the sensitive places. Each field is
// optional, so the one-tap toggle can send {mode} alone.
router.put('/me/privacy', auth, async (req, res) => {
  try {
    const { mode, sensitive_rooms, sensitive_places } = req.body;
    if (!req.user.privacy) req.user.privacy = {};

    if (mode !== undefined) {
      if (!PRIVACY_MODES.includes(mode)) {
        return res.status(400).json({ error: `mode must be one of ${PRIVACY_MODES.join(', ')}` });
      }
      req.user.privacy.mode = mode;
      // The moment it was set, which is what makes "privacy mode has been on
      // for three hours" sayable. A wearer who switches it on and forgets is
      // the likeliest way this feature causes harm.
      req.user.privacy.mode_set_at = mode === 'off' ? null : new Date();
    }

    if (sensitive_rooms !== undefined) {
      if (!Array.isArray(sensitive_rooms)) {
        return res.status(400).json({ error: 'sensitive_rooms must be an array' });
      }
      const unknown = sensitive_rooms.filter(r => !KNOWN_ROOMS.includes(r));
      if (unknown.length) {
        return res.status(400).json({
          error: `not rooms the camera can recognise: ${unknown.join(', ')}`,
          known_rooms: KNOWN_ROOMS,
        });
      }
      req.user.privacy.sensitive_rooms = [...new Set(sensitive_rooms)];
    }

    if (sensitive_places !== undefined) {
      if (!Array.isArray(sensitive_places)) {
        return res.status(400).json({ error: 'sensitive_places must be an array' });
      }
      const clean = [];
      for (const pl of sensitive_places) {
        const lat = Number(pl?.lat), lng = Number(pl?.lng);
        if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
          return res.status(400).json({ error: 'every place needs a numeric lat and lng' });
        }
        if (Math.abs(lat) > 90 || Math.abs(lng) > 180) {
          return res.status(400).json({ error: 'lat/lng out of range' });
        }
        // Floored at 20 m rather than accepted as given: GPS on a phone is not
        // accurate enough for a 5 m circle, and a radius the fix can never fall
        // inside is a switch that does nothing.
        const radius = Math.min(2000, Math.max(20, Number(pl?.radius_m) || 50));
        clean.push({ label: String(pl?.label || '').slice(0, 60), lat, lng, radius_m: radius });
      }
      req.user.privacy.sensitive_places = clean;
    }

    req.user.markModified('privacy');
    await req.user.save();
    res.json({ message: 'Privacy settings updated', privacy: req.user.privacy });
  } catch (error) {
    console.error('[Privacy] Error updating settings:', error);
    res.status(500).json({ error: 'Server error' });
  }
});

// GET /api/users/chat/:userId
// Get chat history with a specific user
router.get('/chat/:userId', auth, async (req, res) => {
  try {
    const Message = require('../models/Message');
    const otherUserId = req.params.userId;
    const myId = req.user._id;

    const messages = await Message.find({
      $or: [
        { sender_id: myId, recipient_id: otherUserId },
        { sender_id: otherUserId, recipient_id: myId }
      ]
    }).sort({ timestamp: 1 }).limit(100);

    res.json(messages);
  } catch (error) {
    console.error('[Chat] Error fetching history:', error);
    res.status(500).json({ error: 'Server error' });
  }
});

module.exports = router;
