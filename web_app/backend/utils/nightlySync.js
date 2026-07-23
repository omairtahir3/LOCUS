const MedicationLog = require('../models/MedicationLog');
const Medication = require('../models/Medication');
const { 
  generateAIDoseReminder, 
  generateAIMissedDoseAlert, 
  generateAIUserMissedDoseAlert 
} = require('./geminiAgent');

const runNightlyBatchSync = async () => {
  console.log('[NightlySync] Starting Batch-and-Store AI Generation...');
  try {
    const now = new Date();
    // Look ahead for the next 24 hours
    const activeMeds = await Medication.find({ is_active: true }).populate('user_id');
    const tomorrow = new Date(now.getTime() + 24 * 3600000);
    const jsDay = tomorrow.getDay();
    const pythonDay = (jsDay + 6) % 7; 

    for (const med of activeMeds) {
      if (!med.user_id) continue;
      if (med.frequency === 'weekly' && Array.isArray(med.days_of_week) && med.days_of_week.length > 0) {
        if (!med.days_of_week.includes(pythonDay)) continue;
      }

      for (const timeStr of (med.scheduled_times || [])) {
        const parts = timeStr.split(':');
        if (parts.length !== 2) continue;
        const schedTime = new Date(tomorrow.getFullYear(), tomorrow.getMonth(), tomorrow.getDate(), parseInt(parts[0], 10), parseInt(parts[1], 10), 0, 0);
        
        let log = await MedicationLog.findOne({
          user_id: med.user_id._id || med.user_id,
          medication_id: med._id,
          scheduled_time: schedTime
        });

        if (!log) {
          log = await MedicationLog.create({
            user_id: med.user_id._id || med.user_id,
            medication_id: med._id,
            scheduled_time: schedTime,
            status: 'scheduled',
            max_reminders: med.max_reminders || 8
          });
        }

        if (!log.pre_generated_reminder_title) {
          const reminderAi = await generateAIDoseReminder(med.user_id, med, log);
          if (reminderAi) {
            log.pre_generated_reminder_title = reminderAi.title;
            log.pre_generated_reminder_message = reminderAi.message;
          }
          
          // Generate missed dose alerts
          // For caregiver
          let mockCaregiver = { name: "Caregiver", notification_prefs: {} };
          const missedCaregiverAi = await generateAIMissedDoseAlert(med.user_id, med, log, mockCaregiver);
          if (missedCaregiverAi) {
             log.pre_generated_missed_title = missedCaregiverAi.title;
             log.pre_generated_missed_message = missedCaregiverAi.message;
          }

          await log.save();
          console.log(`[NightlySync] Pre-generated AI messages for ${med.name} at ${timeStr}`);
        }
      }
    }
  } catch (err) {
    console.error('[NightlySync] Error during batch sync:', err.message);
  }
};

module.exports = { runNightlyBatchSync };
