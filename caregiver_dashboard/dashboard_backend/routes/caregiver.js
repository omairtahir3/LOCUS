const express = require('express');
const User = require('../models/User');
const MedicationLog = require('../models/MedicationLog');
const Notification = require('../models/Notification');
const { protect, authorize } = require('../middleware/auth');
const { createNotification } = require('../utils/notifications');

const router = express.Router();
router.use(protect, authorize('caregiver', 'admin'));


// GET /api/caregiver/users  — list all users this caregiver monitors
router.get('/users', async (req, res) => {
  try {
    const caregiver = await User.findById(req.user._id).populate('monitoring_users', 'name email phone');
    res.json(caregiver.monitoring_users);
  } catch (err) { res.status(500).json({ error: err.message }); }
});


// GET /api/caregiver/users/:userId/summary  — full dashboard summary for one user
router.get('/users/:userId/summary', async (req, res) => {
  try {
    const user = await User.findById(req.params.userId).select('-password');
    if (!user) return res.status(404).json({ error: 'User not found' });

    // Verify caregiver has access
    const hasAccess = req.user.monitoring_users.some(id => id.toString() === req.params.userId);
    if (!hasAccess && req.user.role !== 'admin')
      return res.status(403).json({ error: 'Access denied' });

    // Today's medication adherence
    const today = new Date();
    const dayStart = new Date(today.setHours(0, 0, 0, 0));
    const dayEnd   = new Date(today.setHours(23, 59, 59, 999));

    const todayLogs = await MedicationLog.find({
      user_id: req.params.userId,
      scheduled_time: { $gte: dayStart, $lte: dayEnd }
    }).populate('medication_id', 'name dosage');

    const counts = { taken: 0, missed: 0, snoozed: 0, skipped: 0, scheduled: 0 };
    todayLogs.forEach(l => { if (counts[l.status] !== undefined) counts[l.status]++; });

    // Unread notifications about this user
    const pendingAlerts = await Notification.find({
      recipient_id: req.user._id,
      subject_user_id: req.params.userId,
      is_read: false,
    }).sort({ createdAt: -1 }).limit(10);

    res.json({
      user,
      today_adherence: {
        ...counts,
        total: todayLogs.length,
        adherence_percentage: todayLogs.length > 0
          ? parseFloat(((counts.taken / todayLogs.length) * 100).toFixed(1))
          : 0,
        logs: todayLogs,
      },
      pending_alerts: pendingAlerts,
    });
  } catch (err) { res.status(500).json({ error: err.message }); }
});


// POST /api/caregiver/users/:userId/message  — send a message/notification to user
router.post('/users/:userId/message', async (req, res) => {
  try {
    const { title, message } = req.body;
    if (!title || !message) return res.status(400).json({ error: 'Title and message are required' });

    const notification = await createNotification({
      recipientId: req.params.userId,
      subjectUserId: req.params.userId,
      type: 'caregiver_message',
      title,
      message,
    });

    res.status(201).json({ message: 'Notification sent', notification });
  } catch (err) { res.status(500).json({ error: err.message }); }
});


// POST /api/caregiver/users/:userId/status-check  — request a status check from user
router.post('/users/:userId/status-check', async (req, res) => {
  try {
    const caregiver = await User.findById(req.user._id);

    const notification = await createNotification({
      recipientId: req.params.userId,
      subjectUserId: req.params.userId,
      type: 'status_check',
      title: 'Status Check Request',
      message: `${caregiver.name} is checking in on you. Please respond when you can.`,
      requiresAcknowledgement: true,
    });

    res.status(201).json({ message: 'Status check sent', notification });
  } catch (err) { res.status(500).json({ error: err.message }); }
});


module.exports = router;