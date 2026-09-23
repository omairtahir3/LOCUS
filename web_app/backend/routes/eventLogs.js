const express = require('express');
const router = express.Router();
const EventLog = require('../models/EventLog');
const { protect: auth } = require('../middleware/auth');

// GET /api/event-logs/memory-search
// Returns medication_intake, social_interaction and activity, excluding rejected
router.get('/memory-search', auth, async (req, res) => {
  try {
    let userId = req.user.id;
    // If caregiver, they view logs for their connected elderly user
    if (req.user.role === 'caregiver') {
      if (req.query.userId) {
        userId = req.query.userId;
      } else {
        const User = require('../models/User');
        const caregiver = await User.findById(req.user.id);
        if (caregiver?.monitoring_users && caregiver.monitoring_users.length > 0) {
          userId = caregiver.monitoring_users[0];
        }
      }
    }

    const { type, limit = 50, q } = req.query;

    const query = {
      user_id: userId,
      event_type: { $in: ['medication_intake', 'social_interaction', 'activity', 'object'] },
      // scene_change events share event_type 'activity' but are raw motion-burst
      // captures with no classification — they belong in Keyframe Audit, not a
      // memory timeline, where they render as meaningless "Activity detected".
      'details.action': { $ne: 'scene_change' },
      verification_status: { $ne: 'rejected' }
    };

    if (type && query.event_type.$in.includes(type)) {
      query.event_type = type; // override with specific filter
    }

    const events = await EventLog.find(query)
      .populate('person_id', 'person_name relationship_type face_embedding')
      .sort({ timestamp: -1 })
      .limit(Number(limit));

    res.json(events);
  } catch (error) {
    console.error('Error fetching memory search logs:', error);
    res.status(500).json({ error: 'Server error' });
  }
});

/**
 * GET /api/event-logs/timeline?date=YYYY-MM-DD&userId=
 *
 * One day of the Core Module's output, assembled for the Activity Feed:
 * environment sessions (FE-2), medication intakes (FE-4), social interactions
 * (FE-4), item sightings (FE-12/13) and routine findings as anomalies.
 *
 * Replaces the hard-coded mockActivities array the page used to render, which
 * showed a plausible-looking day ("Met with neighbor Mrs. Johnson", "~2,400
 * steps") that came from nowhere and never changed.
 */
router.get('/timeline', auth, async (req, res) => {
  try {
    let userId = req.user.id;
    if (req.user.role === 'caregiver') {
      if (req.query.userId) userId = req.query.userId;
      else {
        const User = require('../models/User');
        const cg = await User.findById(req.user.id);
        if (cg?.monitoring_users?.length) userId = cg.monitoring_users[0];
      }
    }

    const day = req.query.date ? new Date(req.query.date) : new Date();
    if (Number.isNaN(day.getTime())) return res.status(400).json({ error: 'invalid date' });
    const start = new Date(day); start.setHours(0, 0, 0, 0);
    const end = new Date(start); end.setDate(end.getDate() + 1);

    const mongoose = require('mongoose');
    // Events are written with a string user id by some paths and an ObjectId by
    // others; match both rather than silently returning an empty day.
    const idForms = [userId, String(userId)];
    if (mongoose.Types.ObjectId.isValid(userId)) idForms.push(new mongoose.Types.ObjectId(String(userId)));

    const events = await EventLog.find({
      user_id: { $in: idForms },
      timestamp: { $gte: start, $lt: end },
      verification_status: { $ne: 'rejected' },
      'details.action': { $ne: 'scene_change' },   // raw motion bursts, not activity
    }).sort({ timestamp: 1 }).lean();

    const RoutineFinding = require('../models/RoutineFinding');
    const findings = await RoutineFinding.find({
      user_id: { $in: idForms }, createdAt: { $gte: start, $lt: end },
    }).sort({ createdAt: 1 }).lean();

    const items = [];
    for (const e of events) {
      const d = e.details || {};
      if (e.event_type === 'activity' && d.action === 'scene_session') {
        const mins = Math.round((d.duration_seconds || 0) / 60);
        items.push({ at: e.timestamp, kind: 'routine',
          title: `${d.scene ? d.scene[0].toUpperCase() + d.scene.slice(1) : 'Room'} activity`,
          detail: mins ? `${mins} minute${mins === 1 ? '' : 's'}` : 'Brief visit',
          keyframe_id: e.keyframe_id || null });
      } else if (e.event_type === 'medication_intake') {
        items.push({ at: e.timestamp, kind: 'medication',
          title: d.medication_name ? `${d.medication_name} taken` : 'Medication taken',
          detail: e.verification_status === 'pending' ? 'Waiting for your confirmation' : 'Confirmed by the camera',
          confidence: e.confidence, keyframe_id: e.keyframe_id || null });
      } else if (e.event_type === 'social_interaction') {
        items.push({ at: e.timestamp, kind: 'social',
          title: d.person_name ? `Time with ${d.person_name}` : 'Someone familiar nearby',
          detail: d.relationship_type || 'Recognised face',
          keyframe_id: e.keyframe_id || null });
      } else if (e.event_type === 'unknown_face') {
        items.push({ at: e.timestamp, kind: 'social', title: 'An unfamiliar face',
          detail: 'Not matched to anyone you know', keyframe_id: e.keyframe_id || null });
      } else if (e.event_type === 'object' && d.action === 'item_seen') {
        const named = (d.items || []).filter(i => i.matched_item).map(i => i.matched_item);
        if (!named.length) continue;   // unenrolled clutter is not timeline-worthy
        items.push({ at: e.timestamp, kind: 'items',
          title: `Spotted ${[...new Set(named)].slice(0, 3).join(', ')}`,
          detail: e.location ? 'Seen while out' : 'Seen at home',
          keyframe_id: e.keyframe_id || null });
      }
    }
    for (const f of findings) {
      items.push({ at: f.createdAt, kind: 'anomaly', title: f.title, detail: f.message,
        severity: f.severity, finding_kind: f.kind });
    }
    items.sort((a, b) => new Date(a.at) - new Date(b.at));

    // Summary counts, all derived -- nothing invented.
    const minutesIndoors = events
      .filter(e => e.details?.action === 'scene_session')
      .reduce((n, e) => n + (e.details.duration_seconds || 0), 0) / 60;

    // Steps come from the phone's pedometer, not from the camera, so they are
    // read from their own collection rather than derived from events. null
    // (not 0) when the phone has not reported: "no data" and "did not move"
    // are different answers and must not look the same on the dashboard.
    const StepCount = require('../models/StepCount');
    const localDate = `${start.getFullYear()}-${String(start.getMonth() + 1).padStart(2, '0')}-${String(start.getDate()).padStart(2, '0')}`;
    const stepDoc = await StepCount.findOne({ user_id: { $in: idForms }, date: localDate }).lean();

    // The anomalies again on their own, so the page can list them rather than
    // only count them. Same objects as the timeline entries.
    const anomalies = items.filter(i => i.kind === 'anomaly');

    res.json({
      date: localDate,
      items,
      anomalies,
      summary: {
        medication: items.filter(i => i.kind === 'medication').length,
        social: items.filter(i => i.kind === 'social').length,
        items_seen: items.filter(i => i.kind === 'items').length,
        anomalies: anomalies.length,
        steps: stepDoc ? stepDoc.steps : null,
        tracked_minutes: Math.round(minutesIndoors),
        rooms: [...new Set(events.filter(e => e.details?.action === 'scene_session').map(e => e.details.scene).filter(Boolean))],
      },
    });
  } catch (error) {
    console.error('Error building activity timeline:', error);
    res.status(500).json({ error: 'Server error' });
  }
});

// GET /api/event-logs/keyframes
// For Keyframe Audit screen (includes unknown_face and medication_intake)
router.get('/keyframes', auth, async (req, res) => {
  try {
    let userId = req.user.id;
    if (req.user.role === 'caregiver') {
      const User = require('../models/User');
      const caregiver = await User.findById(req.user.id);
      if (caregiver.monitoring_users && caregiver.monitoring_users.length > 0) {
        userId = caregiver.monitoring_users[0];
      }
    }

    const { type, limit = 50 } = req.query;

    const query = {
      user_id: userId,
      event_type: { $in: ['medication_intake', 'unknown_face'] },
      verification_status: { $ne: 'rejected' }
    };

    if (type && query.event_type.$in.includes(type)) {
      query.event_type = type;
    }

    const events = await EventLog.find(query)
      .sort({ timestamp: -1 })
      .limit(Number(limit));

    res.json(events);
  } catch (error) {
    console.error('Error fetching keyframe logs:', error);
    res.status(500).json({ error: 'Server error' });
  }
});
// PATCH /api/event-logs/:id/flag
// Universal endpoint to toggle the is_flagged state of any event (e.g. medication or social)
router.patch('/:id/flag', auth, async (req, res) => {
  try {
    const { is_flagged } = req.body;
    
    if (typeof is_flagged !== 'boolean') {
      return res.status(400).json({ error: 'is_flagged boolean is required' });
    }

    const eventId = req.params.id;
    const event = await EventLog.findById(eventId);

    if (!event) {
      return res.status(404).json({ error: 'Event not found' });
    }

    // Role check: caregiver can only flag events for their connected user
    if (req.user.role === 'caregiver') {
      const User = require('../models/User');
      const caregiver = await User.findById(req.user.id);
      if (!caregiver.monitoring_users || !caregiver.monitoring_users.map(id => String(id)).includes(String(event.user_id))) {
        return res.status(403).json({ error: 'Unauthorized to flag this event' });
      }
    } else {
      if (String(event.user_id) !== String(req.user.id)) {
        return res.status(403).json({ error: 'Unauthorized to flag this event' });
      }
    }

    event.is_flagged = is_flagged;

    if (!is_flagged) {
      // If unflagging, and the frame is past 72 hours, remove it from the event
      // so the UI hides it immediately, and the Python backend deletes the orphaned file.
      const eventAgeHours = (Date.now() - new Date(event.timestamp).getTime()) / (1000 * 60 * 60);
      if (eventAgeHours > 72) {
        event.keyframe_id = null;
        if (event.keyframe_ref) {
          event.keyframe_ref = null;
        }
      }
    }

    await event.save();

    res.json(event);
  } catch (error) {
    console.error('Error toggling flag:', error);
    res.status(500).json({ error: 'Server error' });
  }
});

module.exports = router;
