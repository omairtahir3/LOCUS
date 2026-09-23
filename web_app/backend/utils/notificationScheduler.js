const cron = require('node-cron');
const MedicationLog = require('../models/MedicationLog');
const Notification = require('../models/Notification');
const User = require('../models/User');
const Medication = require('../models/Medication');
const { notifyUserDoseReminder, notifyCaregiversMissedDose, notifyUserMissedDose, escalateAlert } = require('./notifications');
const { runNightlyBatchSync } = require('./nightlySync');
const axios = require('axios');

const AI_BACKEND = process.env.PYTHON_SERVICE_URL || 'http://localhost:8000';

// Every notification makes an LLM call, so a pass over a dozen due doses takes
// minutes, not seconds. node-cron does not wait for the previous run, so the
// 06:04 pass was still working when 06:05 and 06:06 started, all three read
// the same still-unclaimed rows, and users got the same reminder two and three
// times (27 duplicated recipient/type/log groups on 23 Sep 2026).
//
// Two independent guards, because either alone is not enough:
//   withLease   stops this process from overlapping itself.
//   claim...()  compare-and-set on the row itself, so a second process (a
//               stray `node server.js` beside nodemon, or a restart mid-pass)
//               still cannot send the same notification twice.
const leases = {};
const withLease = (name, fn) => async (...args) => {
  if (leases[name]) {
    console.warn(`[Scheduler] ${name} is still running from the last tick, skipping this one`);
    return;
  }
  leases[name] = true;
  const startedAt = Date.now();
  try {
    return await fn(...args);
  } finally {
    leases[name] = false;
    const took = Date.now() - startedAt;
    if (took > 60000) console.warn(`[Scheduler] ${name} took ${Math.round(took / 1000)}s, longer than the 60s tick`);
  }
};

const autoStartPipeline = async (userId, medicationId, scheduledTime) => {
  try {
    const user = await User.findById(userId);
    const payload = {
      user_id: userId.toString(),
      medication_id: medicationId.toString(),
      scheduled_time: scheduledTime.toISOString(),
      confidence_thresholds: user?.confidence_thresholds || {}
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

    // Claim the row BEFORE notifying. The old order was notify-then-save, and
    // the notify step takes seconds, so an overlapping pass read the row while
    // it still looked unreminded and sent the same reminder again.
    for (const log of dueLogs) {
      if (!log.user_id || !log.medication_id) continue;
      const maxRem = log.max_reminders || 8;
      const isFollowUp = !!log.last_reminded_at;
      const when = isFollowUp
        ? { last_reminded_at: { $lte: new Date(now.getTime() - 15 * 60000) } }   // due a follow-up
        : { last_reminded_at: null };                                            // never reminded
      const claimed = await MedicationLog.findOneAndUpdate(
        { _id: log._id, status: 'scheduled', reminder_count: { $lt: maxRem }, ...when },
        { $set: { last_reminded_at: now }, $inc: { reminder_count: 1 } },
        { new: true },
      );
      if (!claimed) continue;   // another pass claimed it, or it is not due yet

      await notifyUserDoseReminder(log.user_id, log.medication_id, claimed);
      console.log(`[Scheduler] Sent ${isFollowUp ? `follow-up dose reminder (#${claimed.reminder_count})` : 'initial dose reminder'} for ${log.medication_id.name} to ${log.user_id.name}`);
    }

    // 2. Snooze Expiry: snoozed doses where snoozed_until <= now
    const expiredSnoozed = await MedicationLog.find({
      status: 'snoozed',
      snoozed_until: { $lte: now, $ne: null }
    }).populate('user_id').populate('medication_id');

    for (const log of expiredSnoozed) {
      if (!log.user_id || !log.medication_id) continue;

      // If they snoozed it, always send a reminder when snooze expires, even if max reminders was reached
      const claimed = await MedicationLog.findOneAndUpdate(
        { _id: log._id, status: 'snoozed' },
        { $set: { status: 'scheduled', snoozed_until: null, last_reminded_at: now }, $inc: { reminder_count: 1 } },
        { new: true },
      );
      if (!claimed) continue;
      await notifyUserDoseReminder(log.user_id, log.medication_id, claimed);
      console.log(`[Scheduler] Snooze expired, re-sent reminder for ${log.medication_id.name} to ${log.user_id.name}`);
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

      // Flip the status atomically. Whoever wins sends; everyone else moves on.
      const claimed = await MedicationLog.findOneAndUpdate(
        { _id: log._id, status: { $in: ['scheduled', 'snoozed'] } },
        { $set: { status: log.camera_used ? 'missed' : 'camera_off', caregiver_notified: true } },
        { new: true },
      );
      if (!claimed) continue;
      await notifyCaregiversMissedDose(log.user_id, log.medication_id, log._id);
      await notifyUserMissedDose(log.user_id, log.medication_id, log._id);
      console.log(`[Scheduler] 2-hour window expired, marked ${claimed.status} for ${log.medication_id.name} (${log.user_id.name})`);
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

      const claimed = await MedicationLog.findOneAndUpdate(
        { _id: log._id, caregiver_notified: { $ne: true } },
        { $set: { caregiver_notified: true } },
        { new: true },
      );
      if (!claimed) continue;
      await notifyCaregiversMissedDose(log.user_id, log.medication_id, log._id);
      await notifyUserMissedDose(log.user_id, log.medication_id, log._id);
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
      // escalateAlert marks escalated at the END, after sending, so an
      // overlapping pass used to escalate the same alert again.
      const claimed = await Notification.findOneAndUpdate(
        { _id: notif._id, escalated: false },
        { $set: { escalated: true, escalated_at: new Date() } },
        { new: true },
      );
      if (!claimed) continue;
      await escalateAlert(notif);
    }
  } catch (err) {
    console.error('[Scheduler] Error checking escalations:', err.message);
  }
};

const init = () => {
  console.log('[NotificationScheduler] Starting cron tasks (every 60s)...');

  // One lease for the whole tick: the three checks read each other's writes,
  // so they must not interleave with a second tick either.
  const tick = withLease('tick', async () => {
    await checkRemindersAndSnooze();
    await checkReminderExhaustion();
    await checkEscalations();
  });
  cron.schedule('* * * * *', tick);

  // Run Nightly Batch Sync at 2:00 AM
  cron.schedule('0 2 * * *', async () => {
    await runNightlyBatchSync();
  });
};

module.exports = {
  init, checkRemindersAndSnooze, checkReminderExhaustion, checkEscalations, runNightlyBatchSync,
  _withLeaseForTests: withLease,
};
