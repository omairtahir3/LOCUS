const express = require('express');
const Notification = require('../models/Notification');
const { protect } = require('../middleware/auth');
const User = require('../models/User');
const { generateAISkippedMedicineAlert } = require('../utils/geminiAgent');

const router = express.Router();

// ─── Internal endpoints (no auth required, called by Python AI pipeline) ─────

// POST /api/notifications/skip  — create a skip notification
router.post('/skip', async (req, res) => {
  try {
    const {
      user_id,
      scheduled_time,
      expected_count,
      taken_count,
      skipped_count,
      detection_events = []
    } = req.body;

    // Resolve the user — use provided user_id or find default
    let recipientId = user_id;
    if (!recipientId) {
      const defaultUser = await User.findOne({ role: { $ne: 'caregiver' } });
      if (defaultUser) recipientId = defaultUser._id;
    }

    if (!recipientId) {
      return res.status(400).json({ error: 'No user_id provided and no default user found' });
    }

    // Notify the user (patient) using Gemini
    const recipientUser = await User.findById(recipientId);
    const patientName = recipientUser?.name || 'Patient';
    
    const userAlert = await generateAISkippedMedicineAlert(
      patientName, null, scheduled_time, expected_count, taken_count, skipped_count, false
    );

    const notification = await Notification.create({
      recipient_id: recipientId,
      subject_user_id: recipientId,
      type: 'skipped_medicine',
      title: userAlert.title,
      message: userAlert.message,
      requires_acknowledgement: true,
    });

    console.log(`[Notifications] Skip notification created: ${userAlert.title}`);

    // Notify caregivers using Gemini
    if (recipientUser && recipientUser.caregiver_ids && recipientUser.caregiver_ids.length > 0) {
      const caregivers = await User.find({ _id: { $in: recipientUser.caregiver_ids } });
      for (const caregiver of caregivers) {
        if (!caregiver.notification_prefs?.missed_dose) continue;
        
        const cgAlert = await generateAISkippedMedicineAlert(
          patientName, caregiver.name, scheduled_time, expected_count, taken_count, skipped_count, true
        );

        await Notification.create({
          recipient_id: caregiver._id,
          subject_user_id: recipientId,
          type: 'missed_dose',
          title: cgAlert.title,
          message: cgAlert.message,
          requires_acknowledgement: true,
        });
        console.log(`[Notifications] Caregiver ${caregiver.name} notified of skipped medicine via Gemini.`);
      }
    }

    res.status(201).json(notification);
  } catch (err) {
    console.error('[Notifications] Error creating skip notification:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ─── Protected endpoints (require user authentication) ───────────────────────
router.use(protect);
// GET /api/notifications  — get all notifications for current user
router.get('/', async (req, res) => {
  try {
    const { unread_only, limit = 30 } = req.query;
    const query = { recipient_id: req.user._id, is_dismissed: { $ne: true } };
    if (unread_only === 'true') query.is_read = false;

    const notifications = await Notification.find(query)
      .sort({ createdAt: -1 })
      .limit(parseInt(limit));

    const unread_count = await Notification.countDocuments({ recipient_id: req.user._id, is_read: false, is_dismissed: { $ne: true } });
    res.json({ notifications, unread_count });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// PATCH /api/notifications/:id/read  — mark as read
router.patch('/:id/read', async (req, res) => {
  try {
    const notification = await Notification.findOneAndUpdate(
      { _id: req.params.id, recipient_id: req.user._id },
      { is_read: true, read_at: new Date() },
      { new: true }
    );
    if (!notification) return res.status(404).json({ error: 'Notification not found' });
    res.json(notification);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// PATCH /api/notifications/read-all  — mark all as read
router.patch('/read-all', async (req, res) => {
  try {
    await Notification.updateMany(
      { recipient_id: req.user._id, is_read: false },
      { is_read: true, read_at: new Date() }
    );
    res.json({ message: 'All notifications marked as read' });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// PATCH /api/notifications/:id/acknowledge  — acknowledge an alert
router.patch('/:id/acknowledge', async (req, res) => {
  try {
    const notification = await Notification.findOneAndUpdate(
      { _id: req.params.id, recipient_id: req.user._id },
      { acknowledged_at: new Date(), is_read: true, read_at: new Date() },
      { new: true }
    );
    if (!notification) return res.status(404).json({ error: 'Notification not found' });
    res.json(notification);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// DELETE /api/notifications/:id  — dismiss
router.delete('/:id', async (req, res) => {
  try {
    const notification = await Notification.findOneAndUpdate(
      { _id: req.params.id, recipient_id: req.user._id },
      { is_dismissed: true },
      { new: true }
    );
    if (!notification) return res.status(404).json({ error: 'Notification not found' });
    res.json({ message: 'Notification dismissed' });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// POST /api/notifications/:id/respond — respond to a status check or message
router.post('/:id/respond', async (req, res) => {
  try {
    const { message } = req.body;
    if (!message) return res.status(400).json({ error: 'Response message is required' });

    const notification = await Notification.findOneAndUpdate(
      { _id: req.params.id, recipient_id: req.user._id },
      { acknowledged_at: new Date(), is_read: true, read_at: new Date() },
      { new: true }
    );
    if (!notification) return res.status(404).json({ error: 'Notification not found' });

    const senderUser = await User.findById(req.user._id);
    const caregivers = await User.find({ _id: { $in: senderUser?.caregiver_ids || [] } });

    const { createNotification } = require('../utils/notifications');
    for (const cg of caregivers) {
      await createNotification({
        recipientId: cg._id,
        subjectUserId: req.user._id,
        type: 'caregiver_message',
        title: `💬 Response from ${senderUser.name}`,
        message: `${senderUser.name} responded to your check-in: "${message}"`,
        sendEmailTo: cg.notification_prefs?.email ? cg.email : null,
      });
    }

    res.json({ message: 'Response sent to caregivers', notification });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// POST /api/notifications/:id/snooze — snooze a dose reminder from the notification card
router.post('/:id/snooze', async (req, res) => {
  try {
    const durationMinutes = parseInt(req.body.snooze_duration_minutes) || 10;
    const notification = await Notification.findOneAndUpdate(
      { _id: req.params.id, recipient_id: req.user._id },
      { is_dismissed: true, is_read: true },
      { new: true }
    );
    if (!notification) return res.status(404).json({ error: 'Notification not found' });

    if (notification.medication_log_id) {
      const MedicationLog = require('../models/MedicationLog');
      const snoozedUntil = new Date(Date.now() + durationMinutes * 60000);
      await MedicationLog.findByIdAndUpdate(notification.medication_log_id, {
        $set: { status: 'snoozed', snoozed_until: snoozedUntil, last_reminded_at: new Date() },
        $inc: { reminder_count: 1 }
      });
    }

    res.json({ message: `Reminder snoozed for ${durationMinutes} minutes`, notification });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

module.exports = router;