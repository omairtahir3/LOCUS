const express = require('express');
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
    const meds = await Medication.find({ user_id: req.user._id, is_active: true }).sort({ createdAt: -1 });
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
    const userId = req.query.userId || req.user._id;
    const today = new Date();
    const dayStart = new Date(today.setHours(0, 0, 0, 0));
    const dayEnd   = new Date(today.setHours(23, 59, 59, 999));

    // Query with both string and ObjectId since Flutter stores as string
    const userIdStr = userId.toString();
    const meds = await Medication.find({
      user_id: { $in: [userIdStr, userId] },
      is_active: true
    });

    const logs = await MedicationLog.find({
      user_id: { $in: [userIdStr, userId] },
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
          medication_id:           med._id,
          medication_name:         med.name,
          dosage:                  med.dosage,
          scheduled_time:          time,
          status:                  log?.status || 'scheduled',
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

    const med = await Medication.findOne({ _id: medication_id, user_id: req.user._id });
    if (!med) return res.status(404).json({ error: 'Medication not found' });

    // Prevent duplicate logs for same slot
    const existing = await MedicationLog.findOne({ medication_id, user_id: req.user._id, scheduled_time: new Date(scheduled_time) });
    if (existing) return res.status(409).json({ error: 'Log already exists for this dose. Use PATCH to update.' });

    const logData = {
      user_id: req.user._id,
      medication_id,
      scheduled_time: new Date(scheduled_time),
      status,
      verification_method: verification_method || null,
      notes: notes || null,
      confidence_score: confidence_score || null,
      keyframe_id: keyframe_id || null,
      taken_at: status === 'taken' ? new Date() : null,
    };

    const log = await MedicationLog.create(logData);

    // Notify caregivers if dose was missed and medication has notify flag
    if (status === 'missed' && med.caregiver_notify_on_miss) {
      await notifyCaregiversMissedDose(req.user, med, log._id);
    }

    res.status(201).json({ ...log.toObject(), medication_name: med.name, dosage: med.dosage });
  } catch (err) { res.status(400).json({ error: err.message }); }
});

// PATCH /api/medications/logs/:logId — update an existing log (e.g. manual confirm)
router.patch('/logs/:logId', async (req, res) => {
  try {
    const update = { ...req.body };
    if (req.body.status === 'taken' && !req.body.taken_at) update.taken_at = new Date();

    const log = await MedicationLog.findOneAndUpdate(
      { _id: req.params.logId, user_id: req.user._id },
      update,
      { new: true }
    ).populate('medication_id', 'name dosage');

    if (!log) return res.status(404).json({ error: 'Log not found' });
    res.json(log);
  } catch (err) { res.status(400).json({ error: err.message }); }
});

// GET /api/medications/logs/history — with filters
router.get('/logs/history', async (req, res) => {
  try {
    const { userId, medication_id, status, start_date, end_date, limit = 50 } = req.query;
    const targetUser = userId || req.user._id;

    const query = { user_id: targetUser };
    if (medication_id) query.medication_id = medication_id;
    if (status)        query.status = status;
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
    const targetUser = req.query.userId || req.user._id;
    const targetDate = req.query.date ? new Date(req.query.date) : new Date();
    const dayStart   = new Date(targetDate.setHours(0, 0, 0, 0));
    const dayEnd     = new Date(targetDate.setHours(23, 59, 59, 999));

    const logs = await MedicationLog.find({
      user_id: targetUser,
      scheduled_time: { $gte: dayStart, $lte: dayEnd }
    }).populate('medication_id', 'name dosage');

    const counts = { taken: 0, missed: 0, snoozed: 0, skipped: 0, scheduled: 0 };
    logs.forEach(l => { if (counts[l.status] !== undefined) counts[l.status]++; });

    const total = logs.length;
    const adherence = total > 0 ? parseFloat(((counts.taken / total) * 100).toFixed(1)) : 0;

    res.json({
      date: req.query.date || new Date().toISOString().split('T')[0],
      total_scheduled: total,
      ...counts,
      adherence_percentage: adherence,
      medications: logs,
    });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

module.exports = router;