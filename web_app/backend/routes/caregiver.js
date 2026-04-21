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

    // 7-day medication adherence
    const now = new Date();
    const weekAgo = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);

    const mongoose = require('mongoose');
    const userOid = new mongoose.Types.ObjectId(req.params.userId);
    const userIdStr = req.params.userId;

    const recentLogs = await MedicationLog.find({
      user_id: { $in: [userOid, userIdStr] },
      scheduled_time: { $gte: weekAgo }
    }).populate('medication_id', 'name dosage');

    const counts = { taken: 0, missed: 0, snoozed: 0, skipped: 0, scheduled: 0 };
    recentLogs.forEach(l => { if (counts[l.status] !== undefined) counts[l.status]++; });

    const totalValid = counts.taken + counts.missed;

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
        total: recentLogs.length,
        adherence_percentage: totalValid > 0
          ? parseFloat(((counts.taken / totalValid) * 100).toFixed(1))
          : 0,
        logs: recentLogs,
        period: '7_days',
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


// GET /api/caregiver/users/:userId/verification-events — AI verification logs
router.get('/users/:userId/verification-events', async (req, res) => {
  try {
    const hasAccess = req.user.monitoring_users.some(id => id.toString() === req.params.userId);
    if (!hasAccess && req.user.role !== 'admin')
      return res.status(403).json({ error: 'Access denied' });

    const limit = parseInt(req.query.limit) || 20;
    const logs = await MedicationLog.find({
      user_id: req.params.userId,
      verification_method: 'visual',
      confidence_score: { $ne: null }
    })
      .populate('medication_id', 'name dosage')
      .sort({ scheduled_time: -1 })
      .limit(limit);

    const events = logs.map(log => {
      const conf = log.confidence_score || 0;
      let classification = 'unverified';
      let action = 'discard';
      if (conf >= 0.845) { classification = 'auto_verified'; action = 'log_automatically'; }
      else if (conf >= 0.65) { classification = 'needs_confirmation'; action = 'request_user_confirmation'; }

      return {
        _id: log._id,
        medication_name: log.medication_id?.name || 'Unknown',
        dosage: log.medication_id?.dosage || '',
        scheduled_time: log.scheduled_time,
        taken_at: log.taken_at,
        status: log.status,
        confidence_score: conf,
        classification,
        action,
        keyframe_id: log.keyframe_id,
        created_at: log.createdAt,
      };
    });

    res.json(events);
  } catch (err) { res.status(500).json({ error: err.message }); }
});


// GET /api/caregiver/users/:userId/anomalies — behavioral anomaly detection
router.get('/users/:userId/anomalies', async (req, res) => {
  try {
    const hasAccess = req.user.monitoring_users.some(id => id.toString() === req.params.userId);
    if (!hasAccess && req.user.role !== 'admin')
      return res.status(403).json({ error: 'Access denied' });

    const anomalies = [];

    // Check 1: Consecutive misses in the last 7 days
    const weekAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
    const recentLogs = await MedicationLog.find({
      user_id: req.params.userId,
      scheduled_time: { $gte: weekAgo }
    }).sort({ scheduled_time: -1 });

    let consecutiveMisses = 0;
    let maxConsecutive = 0;
    for (const log of recentLogs) {
      if (log.status === 'missed' || log.status === 'skipped') {
        consecutiveMisses++;
        maxConsecutive = Math.max(maxConsecutive, consecutiveMisses);
      } else {
        consecutiveMisses = 0;
      }
    }

    if (maxConsecutive >= 3) {
      anomalies.push({
        type: 'consecutive_misses',
        severity: maxConsecutive >= 5 ? 'critical' : 'warning',
        title: `${maxConsecutive} consecutive missed doses`,
        message: `The user has missed ${maxConsecutive} doses in a row within the last 7 days.`,
        count: maxConsecutive,
      });
    }

    // Check 2: Declining adherence trend (compare last 3 days vs previous 3 days)
    const threeDaysAgo = new Date(Date.now() - 3 * 24 * 60 * 60 * 1000);
    const sixDaysAgo = new Date(Date.now() - 6 * 24 * 60 * 60 * 1000);

    const recentPeriod = recentLogs.filter(l => new Date(l.scheduled_time) >= threeDaysAgo);
    const previousPeriod = recentLogs.filter(l => {
      const t = new Date(l.scheduled_time);
      return t >= sixDaysAgo && t < threeDaysAgo;
    });

    const recentAdherence = recentPeriod.length > 0
      ? recentPeriod.filter(l => l.status === 'taken').length / recentPeriod.length
      : 0;
    const previousAdherence = previousPeriod.length > 0
      ? previousPeriod.filter(l => l.status === 'taken').length / previousPeriod.length
      : 0;

    if (previousAdherence > 0 && recentAdherence < previousAdherence * 0.6) {
      anomalies.push({
        type: 'declining_adherence',
        severity: 'warning',
        title: 'Declining adherence trend',
        message: `Adherence dropped from ${(previousAdherence * 100).toFixed(0)}% to ${(recentAdherence * 100).toFixed(0)}% in the last 3 days.`,
        recent_adherence: Math.round(recentAdherence * 100),
        previous_adherence: Math.round(previousAdherence * 100),
      });
    }

    // Check 3: Low AI confidence scores
    const lowConfLogs = recentLogs.filter(l =>
      l.verification_method === 'visual' && l.confidence_score !== null && l.confidence_score < 0.60
    );
    if (lowConfLogs.length >= 2) {
      anomalies.push({
        type: 'low_confidence_detections',
        severity: 'info',
        title: `${lowConfLogs.length} low-confidence AI detections`,
        message: 'Multiple medication intake events had low AI confidence. Camera angle or lighting may need adjustment.',
        count: lowConfLogs.length,
      });
    }

    res.json(anomalies);
  } catch (err) { res.status(500).json({ error: err.message }); }
});


module.exports = router;