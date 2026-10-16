/**
 * Storage usage, device and cloud (Module 6 FE-4, Module 10 FE-5).
 *
 * Two halves that live in different places and had never been added up. The
 * FRAMES are files on the AI backend's disk, which is the only process that
 * can see them; the RECORDS are documents in Mongo, which the AI backend
 * cannot measure. Neither side could answer "how much is LOCUS using", so
 * nothing in either dashboard ever showed it.
 *
 * Suggestions are derived from what is actually reclaimable right now, not
 * from a fixed list of tips. A suggestion nobody can act on is worse than no
 * suggestion: it teaches people to ignore the panel.
 */
const express = require('express');
const router = express.Router();
const { protect: auth } = require('../middleware/auth');
const EventLog = require('../models/EventLog');
const Notification = require('../models/Notification');

const AI_BASE = process.env.AI_BACKEND_URL || 'http://127.0.0.1:8000';

// Mirrors eventLogRetention: high-volume rows go at 45 days, clinical ones are
// kept a year. Read here only to say WHEN things will go, never to delete.
const HIGH_VOLUME_DAYS = 45;
const HIGH_VOLUME_TYPES = ['activity', 'object'];
const CLINICAL_DAYS = 365;

const daysAgo = (n) => new Date(Date.now() - n * 86400000);

/**
 * A rough byte size for a set of documents.
 *
 * Mongo's collStats measures a whole COLLECTION, which on a shared database is
 * everybody's data and cannot be shown to one wearer. Sampling the user's own
 * documents and scaling is approximate, and it is labelled approximate in the
 * response rather than dressed up as exact.
 */
async function approxBytes(model, filter) {
  const count = await model.countDocuments(filter);
  if (!count) return { count: 0, bytes: 0 };
  const sample = await model.find(filter).limit(25).lean();
  const avg = sample.reduce((n, d) => n + Buffer.byteLength(JSON.stringify(d)), 0)
    / (sample.length || 1);
  return { count, bytes: Math.round(avg * count) };
}

// GET /api/storage/usage — this user's footprint, on the device and in the cloud
router.get('/usage', auth, async (req, res) => {
  try {
    const userId = req.user.id || req.user._id;

    // ── Device: frames on the AI backend's disk ──
    let device = null;
    try {
      const r = await fetch(
        `${AI_BASE}/api/keyframes/storage?user_id=${encodeURIComponent(String(userId))}`,
        { signal: AbortSignal.timeout(6000) });
      if (r.ok) device = await r.json();
    } catch (e) {
      // The panel is still useful with one half missing, and saying the
      // camera machine is unreachable is more honest than showing zero.
      device = { unavailable: String(e.message || e) };
    }

    // ── Cloud: this user's records ──
    const [events, notifications, transcripts] = await Promise.all([
      approxBytes(EventLog, { user_id: userId }),
      approxBytes(Notification, { recipient_id: userId }),
      approxBytes(EventLog, { user_id: userId, 'details.conversation': { $exists: true } }),
    ]);
    const cloudBytes = events.bytes + notifications.bytes;

    // ── What can actually be freed ──
    const [staleHighVolume, readNotifications] = await Promise.all([
      EventLog.countDocuments({
        user_id: userId, event_type: { $in: HIGH_VOLUME_TYPES },
        timestamp: { $lte: daysAgo(HIGH_VOLUME_DAYS) },
      }),
      Notification.countDocuments({ recipient_id: userId, read_at: { $ne: null } }),
    ]);

    const suggestions = [];
    if (device && device.total_files > 0 && device.oldest_hours > device.retention_hours) {
      suggestions.push({
        kind: 'frames_overdue',
        text: `Some frames are older than the ${device.retention_hours}-hour limit and have not been cleared yet.`,
        detail: `Oldest is ${Math.round(device.oldest_hours)} hours old.`,
      });
    }
    if (staleHighVolume > 0) {
      suggestions.push({
        kind: 'events_expiring',
        text: `${staleHighVolume} routine events are past ${HIGH_VOLUME_DAYS} days and will be cleared automatically.`,
        detail: 'Medication and social records are kept for a year and are not affected.',
      });
    }
    if (readNotifications > 50) {
      suggestions.push({
        kind: 'notifications',
        text: `${readNotifications} notifications have been read and can be cleared.`,
      });
    }
    if (device && device.disk && device.disk.free_bytes < 2 * 1024 ** 3) {
      suggestions.push({
        kind: 'disk_low',
        text: 'The camera machine has under 2 GB free.',
        detail: 'New frames may fail to save.',
      });
    }
    if (!suggestions.length) {
      suggestions.push({
        kind: 'healthy',
        text: 'Nothing needs clearing. Frames delete themselves on schedule.',
      });
    }

    res.json({
      device,
      cloud: {
        events, notifications,
        conversations: transcripts.count,
        bytes: cloudBytes,
        approximate: true,
        retention: { routine_days: HIGH_VOLUME_DAYS, clinical_days: CLINICAL_DAYS },
      },
      suggestions,
      generated_at: new Date(),
    });
  } catch (e) {
    console.error('[Storage] usage failed:', e);
    res.status(500).json({ error: 'Could not read storage usage' });
  }
});

module.exports = router;
