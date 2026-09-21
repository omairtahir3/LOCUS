const express = require('express');
const Notification = require('../models/Notification');
const { protect } = require('../middleware/auth');
const User = require('../models/User');
const { generateAISkippedMedicineAlert } = require('../utils/llmAgent');
const { createNotification } = require('../utils/notifications');

const router = express.Router();

// â”€â”€â”€ Internal endpoints (no auth required, called by Python AI pipeline) â”€â”€â”€â”€â”€

// POST /api/notifications/system-alert (Internal Python API endpoint)
router.post('/system-alert', async (req, res) => {
  try {
    const { user_id, medication_id, status, notes } = req.body;
    if (!user_id || !medication_id || !status) {
      return res.status(400).json({ error: 'Missing required fields' });
    }

    const User = require('../models/User');
    const Medication = require('../models/Medication');
    
    const user = await User.findById(user_id);
    const med = await Medication.findById(medication_id);
    
    if (!user || !med) {
      return res.status(404).json({ error: 'User or Medication not found' });
    }

    let title, message, type;
    if (status === 'camera_off') {
      title = `Camera Offline for ${med.name}`;
      message = `${user.name}'s camera was disconnected during their scheduled window. We couldn't verify if they took their medication.`;
      type = 'camera_off_alert';
    } else if (status === 'missed') {
      title = `Missed Medication: ${med.name}`;
      message = `No intake detected for ${user.name}'s scheduled dose of ${med.name} within the window.`;
      type = 'missed_alert';
    } else if (status === 'skipped') {
      title = `Skipped Medication: ${med.name}`;
      message = `${user.name}'s medication window elapsed without verification.`;
      type = 'missed_alert';
    } else {
      return res.json({ success: true, message: 'Status ignored' }); // Ignore taken/scheduled
    }

    // Call the core helper to handle the email/push dispatch
    await createNotification({
      recipientId: user._id, // Will also route to caregivers
      title,
      message,
      type,
      medicationId: med._id,
      patientId: user._id,
      requiresAck: true,
      sender: 'System'
    });

    res.json({ success: true });
  } catch (err) {
    console.error('[System Alert] Error:', err);
    res.status(500).json({ error: err.message });
  }
});

// POST /api/notifications/skip  â€” create a skip notification
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

    // Resolve the user â€” use provided user_id or find default
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

    const notification = await createNotification({
      recipientId: recipientId,
      subjectUserId: recipientId,
      type: 'skipped_medicine',
      title: userAlert.title,
      message: userAlert.message,
      requiresAcknowledgement: true,
      sendEmailTo: recipientUser?.notification_prefs?.email ? recipientUser.email : null,
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

        await createNotification({
          recipientId: caregiver._id,
          subjectUserId: recipientId,
          type: 'missed_dose',
          title: cgAlert.title,
          message: cgAlert.message,
          requiresAcknowledgement: true,
          sendEmailTo: caregiver.notification_prefs?.email ? caregiver.email : null,
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

// â”€â”€â”€ Protected endpoints (require user authentication) â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
router.use(protect);
// GET /api/notifications  â€” get all notifications for current user
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

// PATCH /api/notifications/:id/read  â€” mark as read
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

// PATCH /api/notifications/read-all  â€” mark all as read
router.patch('/read-all', async (req, res) => {
  try {
    await Notification.updateMany(
      { recipient_id: req.user._id, is_read: false },
      { is_read: true, read_at: new Date() }
    );
    res.json({ message: 'All notifications marked as read' });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// PATCH /api/notifications/:id/acknowledge  â€” acknowledge an alert
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

// DELETE /api/notifications/clear-all  â€” dismiss all notifications for current user
router.delete('/clear-all', async (req, res) => {
  try {
    await Notification.updateMany(
      { recipient_id: req.user._id, is_dismissed: { $ne: true } },
      { $set: { is_dismissed: true, is_read: true } }
    );
    res.json({ message: 'All notifications cleared' });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// DELETE /api/notifications/:id  â€” dismiss
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

// POST /api/notifications/:id/respond â€” respond to a status check or message
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
        title: `ðŸ’¬ Response from ${senderUser.name}`,
        message: `${senderUser.name} responded to your check-in: "${message}"`,
        sendEmailTo: cg.notification_prefs?.email ? cg.email : null,
      });
    }

    res.json({ message: 'Response sent to caregivers', notification });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// POST /api/notifications/:id/snooze â€” snooze a dose reminder from the notification card
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