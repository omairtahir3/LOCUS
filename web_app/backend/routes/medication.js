const express = require('express');
const mongoose = require('mongoose');
const Medication = require('../models/Medication');
const MedicationLog = require('../models/MedicationLog');
const { protect, caregiverAccessCheck } = require('../middleware/auth');
const { notifyCaregiversMissedDose } = require('../utils/notifications');

const router = express.Router();
router.use(protect);


// ── Medications CRUD ──────────────────────────────────────────────────────────

// GET /api/medications
router.get('/', async (req, res) => {
  try {
    const rawId = req.query.userId || req.user._id;
    const idStr = rawId.toString();
    const idOid = mongoose.Types.ObjectId.isValid(idStr) ? new mongoose.Types.ObjectId(idStr) : rawId;
    const meds = await Medication.find({ user_id: { $in: [idStr, idOid] }, is_active: true }).sort({ createdAt: -1 });
    res.json(meds);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// POST /api/medications
router.post('/', async (req, res) => {
  try {
    const med = await Medication.create({ ...req.body, user_id: req.user._id });
    res.status(201).json(med);
  } catch (err) { res.status(400).json({ error: err.message }); }
});

// PUT /api/medications/:id
router.put('/:id', async (req, res) => {
  try {
    const med = await Medication.findOneAndUpdate(
      { _id: req.params.id, user_id: req.user._id },
      req.body,
      { new: true, runValidators: true }
    );
    if (!med) return res.status(404).json({ error: 'Medication not found' });
    res.json(med);
  } catch (err) { res.status(400).json({ error: err.message }); }
});

// DELETE /api/medications/:id  (soft delete)
router.delete('/:id', async (req, res) => {
  try {
    const med = await Medication.findOneAndUpdate(
      { _id: req.params.id, user_id: req.user._id },
      { is_active: false },
      { new: true }
    );
    if (!med) return res.status(404).json({ error: 'Medication not found' });
    res.json({ message: 'Medication deactivated' });
  } catch (err) { res.status(500).json({ error: err.message }); }
});


// ── Today's Schedule ──────────────────────────────────────────────────────────

// GET /api/medications/schedule/today  — optionally ?userId= for caregiver access
router.get('/schedule/today', async (req, res) => {
  try {
    const rawId = req.query.userId || req.user._id;
    const idStr = rawId.toString();
    const idOid = mongoose.Types.ObjectId.isValid(idStr) ? new mongoose.Types.ObjectId(idStr) : rawId;

    const today = new Date();
    const dayStart = new Date(today.setHours(0, 0, 0, 0));
    const dayEnd   = new Date(today.setHours(23, 59, 59, 999));

    const meds = await Medication.find({
      user_id: { $in: [idStr, idOid] },
      is_active: true
    });

    const logs = await MedicationLog.find({
      user_id: { $in: [idStr, idOid] },
      scheduled_time: { $gte: dayStart, $lte: dayEnd }
    });

    const logMap = {};
    logs.forEach(l => { 
      const d = new Date(l.scheduled_time);
      const hh = d.getHours().toString().padStart(2, '0');
      const mm = d.getMinutes().toString().padStart(2, '0');
      logMap[`${l.medication_id}_${hh}:${mm}`] = l; 
    });

    // Filter weekly medications — match Python convention: 0=Mon, 6=Sun
    const jsDay = new Date().getDay();
    const pythonDay = (jsDay + 6) % 7; // JS: 0=Sun → Python: 0=Mon

    const schedule = [];
    for (const med of meds) {
      // Skip weekly meds not scheduled for today
      if (med.frequency === 'weekly' && Array.isArray(med.days_of_week) && med.days_of_week.length > 0) {
        if (!med.days_of_week.includes(pythonDay)) continue;
      }

      for (const time of med.scheduled_times) {
        const key = `${med._id}_${time}`;
        const log = logMap[key];
        schedule.push({
          id:                      log?._id || null,
          medication_id:           med._id,
          medication_name:         med.name,
          dosage:                  med.dosage,
          scheduled_time:          time,
          status:                  log?.status || 'scheduled',
          notes:                   log?.notes || null,
          instructions:            med.instructions,
          snooze_duration_minutes: med.snooze_duration_minutes,
          log_id:                  log?._id || null,
          confidence_score:        log?.confidence_score || null,
          verification_method:     log?.verification_method || null,
        });
      }
    }

    schedule.sort((a, b) => a.scheduled_time.localeCompare(b.scheduled_time));
    res.json(schedule);
  } catch (err) { res.status(500).json({ error: err.message }); }
});


// ── Medication Logs ───────────────────────────────────────────────────────────

// POST /api/medications/logs  — log a dose event
router.post('/logs', async (req, res) => {
  try {
    const { medication_id, scheduled_time, status, verification_method, notes, confidence_score, keyframe_id } = req.body;

    const targetUserId = req.query.userId || req.body.user_id || req.user._id;

    // Must have medication_id and status
    if (!medication_id || !status) {
      return res.status(400).json({ error: 'medication_id and status are required' });
    }

    let parsedScheduledTime = new Date(scheduled_time);
    if (isNaN(parsedScheduledTime.getTime()) && typeof scheduled_time === 'string' && scheduled_time.includes(':')) {
      const parts = scheduled_time.split(':');
      if (parts.length >= 2) {
        parsedScheduledTime = new Date();
        parsedScheduledTime.setHours(parseInt(parts[0], 10), parseInt(parts[1], 10), 0, 0);
      }
    }

    const Medication = require('../models/Medication');
    const MedicationLog = require('../models/MedicationLog');

    let med = null;
    if (req.user.role === 'internal_ai' || req.user.role === 'system') {
      med = await Medication.findById(medication_id);
    } else {
      med = await Medication.findOne({ _id: medication_id, user_id: targetUserId });
      // If not the med owner, check if caller is a caregiver monitoring that user
      if (!med) {
        const User = require('../models/User');
        const caller = await User.findById(req.user._id);
        if (caller && (caller.role === 'caregiver' || caller.role === 'admin')) {
          const monitoredIds = (caller.monitoring_users || []).map(id => id.toString());
          const candidateMed = await Medication.findById(medication_id);
          if (candidateMed && monitoredIds.includes(candidateMed.user_id.toString())) {
            med = candidateMed;
          }
        }
      }
    }
    if (!med) return res.status(404).json({ error: 'Medication not found' });

    // Handle race conditions where UI is out of sync and AI pipeline just created a log
    const existing = await MedicationLog.findOne({ medication_id, user_id: targetUserId, scheduled_time: parsedScheduledTime });
    if (existing) {
      // If it exists, gracefully update it instead of throwing a 409 error
      existing.status = status;
      if (verification_method) existing.verification_method = verification_method;
      if (notes) existing.notes = notes;
      if (confidence_score !== undefined) existing.confidence_score = confidence_score;
      if (keyframe_id) existing.keyframe_id = keyframe_id;
      if (status === 'taken' && !existing.taken_at) existing.taken_at = new Date();
      await existing.save();

      if (status === 'taken' || status === 'missed' || status === 'skipped') {
        const Notification = require('../models/Notification');
        await Notification.updateMany(
          { medication_log_id: existing._id, type: 'dose_reminder', is_dismissed: false },
          { $set: { is_dismissed: true, is_read: true } }
        );
      }

      // Notify caregivers if updated to missed or skipped
      if ((status === 'missed' || status === 'skipped') && med.caregiver_notify_on_miss) {
        const User = require('../models/User');
        const patient = await User.findById(targetUserId);
        if (patient) {
          const { notifyCaregiversMissedDose } = require('../utils/notifications');
          await notifyCaregiversMissedDose(patient, med, existing._id);
        }
      } else if (status === 'taken') {
        const User = require('../models/User');
        const patient = await User.findById(targetUserId);
        if (patient) {
          const { notifyCaregiversTakenDose, notifyUserTakenDose } = require('../utils/notifications');
          await notifyCaregiversTakenDose(patient, med, existing._id);
          await notifyUserTakenDose(patient, med, existing._id);
        }
      }

      return res.status(200).json({ ...existing.toObject(), medication_name: med.name, dosage: med.dosage });
    }

    const logData = {
      user_id: targetUserId,
      medication_id,
      scheduled_time: parsedScheduledTime,
      status,
      verification_method: verification_method || null,
      notes: notes || null,
      confidence_score: confidence_score || null,
      keyframe_id: keyframe_id || null,
      taken_at: status === 'taken' ? new Date() : null,
    };

    const log = await MedicationLog.create(logData);

    // Notify caregivers if dose was missed or skipped and medication has notify flag
    if ((status === 'missed' || status === 'skipped') && med.caregiver_notify_on_miss) {
      const User = require('../models/User');
      const patient = await User.findById(targetUserId);
      if (patient) {
        const { notifyCaregiversMissedDose } = require('../utils/notifications');
        await notifyCaregiversMissedDose(patient, med, log._id);
      }
    } else if (status === 'taken') {
      const User = require('../models/User');
      const patient = await User.findById(targetUserId);
      if (patient) {
        const { notifyCaregiversTakenDose, notifyUserTakenDose } = require('../utils/notifications');
        await notifyCaregiversTakenDose(patient, med, log._id);
        await notifyUserTakenDose(patient, med, log._id);
      }
    }

    res.status(201).json({ ...log.toObject(), medication_name: med.name, dosage: med.dosage });
  } catch (err) { res.status(400).json({ error: err.message }); }
});

// PATCH /api/medications/logs/:logId — update an existing log (e.g. manual confirm)
router.patch('/logs/:logId', async (req, res) => {
  try {
    const update = { ...req.body };
    if (req.body.status === 'taken' && !req.body.taken_at) update.taken_at = new Date();

    // Try to find the log — allow the log owner OR a caregiver monitoring that user
    let log = await MedicationLog.findOneAndUpdate(
      { _id: req.params.logId, user_id: req.user._id },
      update,
      { new: true }
    ).populate('medication_id', 'name dosage');

    // If not found as the log owner, check if the caller is a caregiver for the log's user
    if (!log) {
      const User = require('../models/User');
      const caller = await User.findById(req.user._id);
      if (caller && (caller.role === 'caregiver' || caller.role === 'admin')) {
        const monitoredIds = (caller.monitoring_users || []).map(id => id.toString());
        // Find the log regardless of user_id, then verify the caregiver monitors that user
        const targetLog = await MedicationLog.findById(req.params.logId);
        if (targetLog && monitoredIds.includes(targetLog.user_id.toString())) {
          log = await MedicationLog.findOneAndUpdate(
            { _id: req.params.logId },
            update,
            { new: true }
          ).populate('medication_id', 'name dosage');
        }
      }
    }

    if (!log) return res.status(404).json({ error: 'Log not found or not authorized' });

    // If manually marked as "not taken" (missed/scheduled), tell the AI pipeline
    // to re-watch for this medication with a new 3-hour verification window
    if (req.body.status === 'missed' || req.body.status === 'scheduled') {
      try {
        const axios = require('axios');
        // Use the ORIGINAL scheduled time from the log, not current time.
        // This ensures the rewatch session matches the correct time slot
        // so the pipeline logs to the right schedule entry.
        const origTime = new Date(log.scheduled_time);
        const schedTime = String(origTime.getHours()).padStart(2, '0') + ':' + String(origTime.getMinutes()).padStart(2, '0');
        if (log.medication_id) {
          await axios.post('http://localhost:8000/api/detection/rewatch', {
            medication_id: log.medication_id._id.toString(),
            user_id: log.user_id.toString(),  // always the elderly user, even if caregiver triggered
            scheduled_time: schedTime,
          }, { timeout: 5000 });
          console.log(`[Medications] Triggered rewatch for ${log.medication_id.name} at ${schedTime}`);
        }
      } catch (rewatchErr) {
        // Non-fatal — pipeline might be offline
        console.warn('[Medications] Rewatch trigger failed:', rewatchErr.message);
      }

      // If rescheduling, delete the log — the rewatch session will produce
      // a fresh log (taken/missed) when it completes or the window expires.
      // Keeping a 'scheduled' log causes duplicates and stale entries.
      if (req.body.status === 'scheduled') {
        await MedicationLog.deleteOne({ _id: log._id });
        return res.json({ message: 'Medicine rescheduled, log removed', deleted: true });
      }
    }

    if (req.body.status === 'taken' || req.body.status === 'missed' || req.body.status === 'skipped') {
      const Notification = require('../models/Notification');
      await Notification.updateMany(
        { medication_log_id: log._id, type: 'dose_reminder', is_dismissed: false },
        { $set: { is_dismissed: true, is_read: true } }
      );
    }

    if (req.body.status === 'missed' || req.body.status === 'skipped') {
      const Medication = require('../models/Medication');
      const med = await Medication.findById(log.medication_id._id || log.medication_id);
      if (med && med.caregiver_notify_on_miss) {
        const User = require('../models/User');
        const patient = await User.findById(log.user_id);
        if (patient) {
          const { notifyCaregiversMissedDose } = require('../utils/notifications');
          await notifyCaregiversMissedDose(patient, med, log._id);
        }
      }
    } else if (req.body.status === 'taken') {
      const Medication = require('../models/Medication');
      const med = await Medication.findById(log.medication_id._id || log.medication_id);
      if (med) {
        const User = require('../models/User');
        const patient = await User.findById(log.user_id);
        if (patient) {
          const { notifyCaregiversTakenDose, notifyUserTakenDose } = require('../utils/notifications');
          await notifyCaregiversTakenDose(patient, med, log._id);
          await notifyUserTakenDose(patient, med, log._id);
        }
      }
    }

    res.json(log);
  } catch (err) { res.status(400).json({ error: err.message }); }
});

// POST /api/medications/logs/:logId/snooze — snooze a dose
router.post('/logs/:logId/snooze', async (req, res) => {
  try {
    const durationMinutes = parseInt(req.body.snooze_duration_minutes) || 10;
    const snoozedUntil = new Date(Date.now() + durationMinutes * 60000);

    let log = await MedicationLog.findOneAndUpdate(
      { _id: req.params.logId, user_id: req.user._id },
      {
        $set: {
          status: 'snoozed',
          snoozed_until: snoozedUntil,
          last_reminded_at: new Date()
        },
        $inc: { reminder_count: 1 }
      },
      { new: true }
    ).populate('medication_id', 'name dosage');

    if (!log) {
      const User = require('../models/User');
      const caller = await User.findById(req.user._id);
      if (caller && (caller.role === 'caregiver' || caller.role === 'admin')) {
        const monitoredIds = (caller.monitoring_users || []).map(id => id.toString());
        const targetLog = await MedicationLog.findById(req.params.logId);
        if (targetLog && monitoredIds.includes(targetLog.user_id.toString())) {
          log = await MedicationLog.findOneAndUpdate(
            { _id: req.params.logId },
            {
              $set: {
                status: 'snoozed',
                snoozed_until: snoozedUntil,
                last_reminded_at: new Date()
              },
              $inc: { reminder_count: 1 }
            },
            { new: true }
          ).populate('medication_id', 'name dosage');
        }
      }
    }

    if (!log) return res.status(404).json({ error: 'Log not found or not authorized' });

    const { createNotification } = require('../utils/notifications');
    await createNotification({
      recipientId: log.user_id,
      subjectUserId: log.user_id,
      type: 'dose_reminder',
      title: `⏰ Dose Snoozed (${durationMinutes}m)`,
      message: `Reminder for ${log.medication_id?.name || 'medication'} snoozed until ${snoozedUntil.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}.`,
      medicationId: log.medication_id?._id,
      medicationLogId: log._id,
      sendPush: false
    });

    res.json(log);
  } catch (err) { res.status(400).json({ error: err.message }); }
});

// GET /api/medications/logs/history — with filters
router.get('/logs/history', async (req, res) => {
  try {
    const { userId, medication_id, status, start_date, end_date, limit = 50 } = req.query;
    const rawId = userId || req.user._id;
    const idStr = rawId.toString();
    const idOid = mongoose.Types.ObjectId.isValid(idStr) ? new mongoose.Types.ObjectId(idStr) : rawId;

    const query = { user_id: { $in: [idStr, idOid] } };
    if (medication_id) query.medication_id = medication_id;
    if (status) {
      query.status = status;
    } else {
      // By default, hide 'scheduled' logs — they're pending and will be retaken
      query.status = { $ne: 'scheduled' };
    }
    if (start_date || end_date) {
      query.scheduled_time = {};
      if (start_date) query.scheduled_time.$gte = new Date(start_date);
      if (end_date)   query.scheduled_time.$lte = new Date(new Date(end_date).setHours(23,59,59));
    }

    const logs = await MedicationLog.find(query)
      .populate('medication_id', 'name dosage')
      .sort({ scheduled_time: -1 })
      .limit(parseInt(limit));

    res.json(logs);
  } catch (err) { res.status(500).json({ error: err.message }); }
});


// ── Daily Adherence Summary ───────────────────────────────────────────────────

// GET /api/medications/summary/daily?date=YYYY-MM-DD&userId=
router.get('/summary/daily', async (req, res) => {
  try {
    const rawId = req.query.userId || req.user._id;
    const idStr = rawId.toString();
    const idOid = mongoose.Types.ObjectId.isValid(idStr) ? new mongoose.Types.ObjectId(idStr) : rawId;
    const now = new Date();
    const targetDate = req.query.date ? new Date(req.query.date) : new Date();
    const dayStart   = new Date(new Date(targetDate).setHours(0, 0, 0, 0));
    const dayEnd     = new Date(new Date(targetDate).setHours(23, 59, 59, 999));

    // ── Today's logs (kept for the medication list) ──
    const logs = await MedicationLog.find({
      user_id: { $in: [idStr, idOid] },
      scheduled_time: { $gte: dayStart, $lte: dayEnd }
    }).populate('medication_id', 'name dosage');

    // ── 7-day overall adherence ──
    const weekStart = new Date(now);
    weekStart.setDate(weekStart.getDate() - 7);
    weekStart.setHours(0, 0, 0, 0);

    const weekLogs = await MedicationLog.find({
      user_id: { $in: [idStr, idOid] },
      scheduled_time: { $gte: weekStart, $lte: now }  // only past doses
    });

    const counts = { taken: 0, missed: 0, snoozed: 0, skipped: 0, scheduled: 0 };
    weekLogs.forEach(l => { if (counts[l.status] !== undefined) counts[l.status]++; });

    // Handle legacy camera_off as skipped for counting purposes
    const cameraOffCount = weekLogs.filter(l => l.status === 'camera_off').length;
    counts.skipped += cameraOffCount;

    const weekTaken = counts.taken;
    const weekMissed = counts.missed;
    const weekValid = weekTaken + weekMissed;
    const overallAdherence = weekValid > 0
      ? parseFloat(((weekTaken / weekValid) * 100).toFixed(1))
      : 0;

    res.json({
      date: req.query.date || now.toISOString().split('T')[0],
      total_scheduled: weekLogs.length,
      taken: counts.taken,
      missed: counts.missed,
      skipped: counts.skipped,
      snoozed: counts.snoozed,
      scheduled: counts.scheduled,
      adherence_percentage: overallAdherence,
      overall_adherence: overallAdherence,
      total_taken: weekTaken,
      total_missed: weekMissed,
      days_tracked: 7,
      medications: logs, // keep returning today's logs for UI list
    });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// GET /api/medications/adherence/summary — 7-day adherence for Flutter app
router.get('/adherence/summary', async (req, res) => {
  try {
    const rawId = req.query.userId || req.user._id;
    const idStr = rawId.toString();
    const idOid = mongoose.Types.ObjectId.isValid(idStr) ? new mongoose.Types.ObjectId(idStr) : rawId;

    const now = new Date();
    const weekAgo = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);

    const logs = await MedicationLog.find({
      user_id: { $in: [idStr, idOid] },
      scheduled_time: { $gte: weekAgo, $lte: now }
    });

    const taken = logs.filter(l => l.status === 'taken').length;
    const missed = logs.filter(l => l.status === 'missed').length;
    const skipped = logs.filter(l => l.status === 'skipped' || l.status === 'camera_off').length;
    
    const totalValid = taken + missed;
    const adherence = totalValid > 0
      ? parseFloat(((taken / totalValid) * 100).toFixed(1))
      : 0;

    res.json({
      total_scheduled: logs.length,
      taken,
      missed,
      skipped,
      adherence_percentage: adherence,
      period: '7_days',
    });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

module.exports = router;