const cron = require('node-cron');
const MedicationLog = require('../models/MedicationLog');
const Notification = require('../models/Notification');
const User = require('../models/User');
const Medication = require('../models/Medication');
const { notifyUserDoseReminder, notifyCaregiversMissedDose, notifyUserMissedDose, escalateAlert } = require('./notifications');
const { runNightlyBatchSync } = require('./nightlySync');
const axios = require('axios');

const AI_BACKEND = process.env.PYTHON_SERVICE_URL || 'http://localhost:8000';

const autoStartPipeline = async (userId, medicationId, scheduledTime) => {
  try {
    const payload = {
      user_id: userId.toString(),
      medication_id: medicationId.toString(),
      scheduled_time: scheduledTime.toISOString()
    };
    await axios.post(`${AI_BACKEND}/api/detection/start`, payload, { timeout: 10000 });
    console.log(`[Scheduler] Auto-started AI detection pipeline for user ${userId}`);
  } catch (err) {
    console.error('[Scheduler] Failed to auto-start AI detection pipeline:', err.message);
  }
};

const checkRemindersAndSnooze = async () => {
  try {
    const now = new Date();
    const fiveMinsFromNow = new Date(now.getTime() + 5 * 60000);
    const fifteenMinsAgo = new Date(now.getTime() - 15 * 60000);

    // 0. Discover upcoming medications directly from active Medication definitions!
    // Since MedicationLog entries are not created in advance, scan active medications.
    const activeMeds = await Medication.find({ is_active: true }).populate('user_id');
    const jsDay = now.getDay();
    const pythonDay = (jsDay + 6) % 7; // JS: 0=Sun -> Python: 0=Mon

    for (const med of activeMeds) {
      if (!med.user_id) continue;
      // Check weekly frequency
      if (med.frequency === 'weekly' && Array.isArray(med.days_of_week) && med.days_of_week.length > 0) {
        if (!med.days_of_week.includes(pythonDay)) continue;
      }

      for (const timeStr of (med.scheduled_times || [])) {
        const parts = timeStr.split(':');
        if (parts.length !== 2) continue;
        const schedTime = new Date(now.getFullYear(), now.getMonth(), now.getDate(), parseInt(parts[0], 10), parseInt(parts[1], 10), 0, 0);

        // Check if this scheduled time falls within our reminder window (15 mins ago to 5 mins from now)
        if (schedTime >= fifteenMinsAgo && schedTime <= fiveMinsFromNow) {
          // Check if a MedicationLog already exists for today at this scheduled time
          const startWin = new Date(schedTime.getTime() - 30 * 60000);
          const endWin = new Date(schedTime.getTime() + 30 * 60000);
          let log = await MedicationLog.findOne({
            user_id: med.user_id._id || med.user_id,
            medication_id: med._id,
            scheduled_time: { $gte: startWin, $lte: endWin }
          });

          if (!log) {
            // No log exists yet! Create the pending log and send the initial reminder!
            log = await MedicationLog.create({
              user_id: med.user_id._id || med.user_id,
              medication_id: med._id,
              scheduled_time: schedTime,
              status: 'scheduled',
              reminder_count: 1,
              last_reminded_at: now,
              max_reminders: med.max_reminders || 8
            });
            await notifyUserDoseReminder(med.user_id, med, log);
            console.log(`[Scheduler] Created pending log & sent initial 5-min reminder for ${med.name} (${timeStr}) to ${med.user_id.name || med.user_id}`);
            
            // Automatically start the detection pipeline!
            await autoStartPipeline(med.user_id._id || med.user_id, med._id, schedTime);
          }
        }
      }
    }

    // 1. Initial Reminders / Repeat Reminders for existing scheduled logs
    const dueLogs = await MedicationLog.find({
      status: 'scheduled',
      scheduled_time: { $lte: fiveMinsFromNow, $gte: new Date(now.getTime() - 24 * 3600000) }
    }).populate('user_id').populate('medication_id');

    for (const log of dueLogs) {
      if (!log.user_id || !log.medication_id) continue;
      const maxRem = log.max_reminders || 8;
      if (!log.last_reminded_at && (log.reminder_count || 0) < maxRem) {
        await notifyUserDoseReminder(log.user_id, log.medication_id, log);
        log.last_reminded_at = now;
        log.reminder_count = (log.reminder_count || 0) + 1;
        await log.save();
        console.log(`[Scheduler] Sent initial dose reminder for ${log.medication_id.name} to ${log.user_id.name}`);
      } else if (log.last_reminded_at) {
        // If 15 minutes have passed since last reminder and still scheduled -> send follow-up reminder
        const timeSinceRem = now.getTime() - new Date(log.last_reminded_at).getTime();
        if (timeSinceRem >= 15 * 60000 && (log.reminder_count || 0) < maxRem) {
          await notifyUserDoseReminder(log.user_id, log.medication_id, log);
          log.last_reminded_at = now;
          log.reminder_count = (log.reminder_count || 0) + 1;
          await log.save();
          console.log(`[Scheduler] Sent follow-up dose reminder (#${log.reminder_count}) for ${log.medication_id.name} to ${log.user_id.name}`);
        }
      }
    }

    // 2. Snooze Expiry: snoozed doses where snoozed_until <= now
    const expiredSnoozed = await MedicationLog.find({
      status: 'snoozed',
      snoozed_until: { $lte: now, $ne: null }
    }).populate('user_id').populate('medication_id');

    for (const log of expiredSnoozed) {
      if (!log.user_id || !log.medication_id) continue;
      
      // If they snoozed it, always send a reminder when snooze expires, even if max reminders was reached
      await notifyUserDoseReminder(log.user_id, log.medication_id, log);
      log.status = 'scheduled';
      log.snoozed_until = null;
      log.last_reminded_at = now;
      log.reminder_count = (log.reminder_count || 0) + 1;
      await log.save();
      console.log(`[Scheduler] Snooze expired — re-sent reminder for ${log.medication_id.name} to ${log.user_id.name}`);
    }
  } catch (err) {
    console.error('[Scheduler] Error checking reminders:', err.message);
  }
};

const checkReminderExhaustion = async () => {
  try {
    const now = new Date();
    const twoHoursAgo = new Date(now.getTime() - 120 * 60000);

    // 1. Overdue doses (>2 hours past scheduled time)
    // The 2-hour window is a hard limit. If not taken by then, it's missed regardless of how many reminders were sent.
    const overdueLogs = await MedicationLog.find({
      status: { $in: ['scheduled', 'snoozed'] },
      scheduled_time: { $lte: twoHoursAgo, $gte: new Date(now.getTime() - 24 * 3600000) },
    }).populate('user_id').populate('medication_id');

    for (const log of overdueLogs) {
      if (!log.user_id || !log.medication_id) continue;
      
      log.status = log.camera_used ? 'missed' : 'camera_off';
      log.caregiver_notified = true;
      await log.save();
      await notifyCaregiversMissedDose(log.user_id, log.medication_id, log._id);
      await notifyUserMissedDose(log.user_id, log.medication_id, log._id);
      console.log(`[Scheduler] 2-hour window expired — marked ${log.status} for ${log.medication_id.name} (${log.user_id.name})`);
    }

    // 2. Catch missed/skipped doses that were set by the AI pipeline directly
    //    (these bypass the reminder flow and never triggered caregiver alerts)
    const recentMissedOrSkipped = await MedicationLog.find({
      status: { $in: ['missed', 'camera_off', 'skipped'] },
      scheduled_time: { $gte: new Date(now.getTime() - 48 * 3600000) },  // last 48 hours
      caregiver_notified: { $ne: true },
    }).populate('user_id').populate('medication_id');

    for (const log of recentMissedOrSkipped) {
      if (!log.user_id || !log.medication_id) continue;
      if (!log.user_id.caregiver_ids || log.user_id.caregiver_ids.length === 0) continue;

      await notifyCaregiversMissedDose(log.user_id, log.medication_id, log._id);
      await notifyUserMissedDose(log.user_id, log.medication_id, log._id);
      log.caregiver_notified = true;
      await log.save();
      console.log(`[Scheduler] Sent user and caregiver alerts for ${log.status} dose: ${log.medication_id.name} (${log.user_id.name})`);
    }
  } catch (err) {
    console.error('[Scheduler] Error checking exhaustion:', err.message);
  }
};

const checkEscalations = async () => {
  try {
    const now = new Date();
    const fifteenMinsAgo = new Date(now.getTime() - 15 * 60000);

    const unacknowledged = await Notification.find({
      requires_acknowledgement: true,
      is_dismissed: false,
      acknowledged_at: null,
      escalated: false,
      createdAt: { $lte: fifteenMinsAgo }
    });

    for (const notif of unacknowledged) {
      await escalateAlert(notif);
    }
  } catch (err) {
    console.error('[Scheduler] Error checking escalations:', err.message);
  }
};

const init = () => {
  console.log('[NotificationScheduler] Starting cron tasks (every 60s)...');
  
  // Run every minute
  cron.schedule('* * * * *', async () => {
    await checkRemindersAndSnooze();
    await checkReminderExhaustion();
    await checkEscalations();
  });

  // Run Nightly Batch Sync at 2:00 AM
  cron.schedule('0 2 * * *', async () => {
    await runNightlyBatchSync();
  });
};

module.exports = { init, checkRemindersAndSnooze, checkReminderExhaustion, checkEscalations, runNightlyBatchSync };
