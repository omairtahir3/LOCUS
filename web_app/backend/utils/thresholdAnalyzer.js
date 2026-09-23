const EventLog = require('../models/EventLog');
const User = require('../models/User');

const MIN_SAMPLE_SIZE = 10;
const HIGH_REJECTION_RATE = 0.30;
const LOW_REJECTION_RATE = 0.05;

// Global defaults and bounds
const DEFAULT_AUTO_VERIFY = 0.85;
const DEFAULT_CONFIRM = 0.70;

const MAX_AUTO_VERIFY = 0.95;
const MIN_AUTO_VERIFY = 0.75;
const MAX_CONFIRM = 0.80;
const MIN_CONFIRM = 0.60;

const clamp = (val, min, max) => Math.min(Math.max(val, min), max);

const analyzeUserThresholds = async () => {
  console.log('[ThresholdAnalyzer] Starting adaptive confidence threshold analysis...');
  try {
    const users = await User.find({ is_active: true });
    const eventTypes = ['medication_intake', 'unknown_face'];

    for (const user of users) {
      if (!user.confidence_thresholds) {
        user.confidence_thresholds = {
          medication_intake: { auto_verify: DEFAULT_AUTO_VERIFY, confirm: DEFAULT_CONFIRM, analyzed_events_count: 0 },
          unknown_face: { auto_verify: DEFAULT_AUTO_VERIFY, confirm: DEFAULT_CONFIRM, analyzed_events_count: 0 }
        };
      }

      for (const eventType of eventTypes) {
        let currentThresholds = user.confidence_thresholds[eventType];
        if (!currentThresholds) {
           currentThresholds = { auto_verify: DEFAULT_AUTO_VERIFY, confirm: DEFAULT_CONFIRM, analyzed_events_count: 0 };
           user.confidence_thresholds[eventType] = currentThresholds;
        }

        const lastAdjustedAt = currentThresholds.last_adjusted_at || new Date(0);

        // Fetch events in the "needs confirmation" band (0.70 - 0.84 initially, but we use the current thresholds)
        // Wait, the band should be based on the *current* thresholds:
        const lowerBound = currentThresholds.confirm;
        const upperBound = currentThresholds.auto_verify;

        // Count total borderline events since last adjustment
        const borderlineEvents = await EventLog.find({
          user_id: user._id,
          event_type: eventType,
          confidence: { $gte: lowerBound, $lt: upperBound },
          timestamp: { $gt: lastAdjustedAt },
          // 'confirmed', not 'verified'. EventLog's enum is
          // ['pending','confirmed','rejected'] -- 'verified' is not a value it
          // can ever hold, so this filter matched only rejected events. With
          // 114 confirmed and 47 rejected in the database, every user still
          // read analysed=0, lastAdjusted=never: FE-11 had never once run. And
          // had it ever reached MIN_SAMPLE_SIZE, rejectionRate would have been
          // rejected/rejected = 1.0, ratcheting thresholds up for ever.
          verification_status: { $in: ['confirmed', 'rejected'] } // Only events the user actually reviewed
        });

        const totalAnalyzed = borderlineEvents.length;

        if (totalAnalyzed >= MIN_SAMPLE_SIZE) {
          const rejectedEvents = borderlineEvents.filter(e => e.verification_status === 'rejected');
          const rejectionRate = rejectedEvents.length / totalAnalyzed;

          let autoVerify = currentThresholds.auto_verify;
          let confirm = currentThresholds.confirm;
          let changed = false;

          if (rejectionRate >= HIGH_REJECTION_RATE) {
            // User rejects many borderline events -> Make stricter (shift up by 0.05)
            autoVerify += 0.05;
            confirm += 0.05;
            changed = true;
            console.log(`[ThresholdAnalyzer] User ${user._id} (${eventType}): High rejection rate (${(rejectionRate*100).toFixed(1)}%). Shifting thresholds UP.`);
          } else if (rejectionRate <= LOW_REJECTION_RATE) {
            // User almost always confirms borderline events -> Make lenient (shift down by 0.05)
            autoVerify -= 0.05;
            confirm -= 0.05;
            changed = true;
            console.log(`[ThresholdAnalyzer] User ${user._id} (${eventType}): Low rejection rate (${(rejectionRate*100).toFixed(1)}%). Shifting thresholds DOWN.`);
          }

          if (changed) {
            // Apply hard bounds
            autoVerify = clamp(autoVerify, MIN_AUTO_VERIFY, MAX_AUTO_VERIFY);
            confirm = clamp(confirm, MIN_CONFIRM, MAX_CONFIRM);

            // Ensure confirm is strictly less than auto_verify (should naturally happen, but guarantee it)
            if (confirm >= autoVerify) {
              confirm = autoVerify - 0.05;
            }

            // Update user document
            currentThresholds.auto_verify = Number(autoVerify.toFixed(2));
            currentThresholds.confirm = Number(confirm.toFixed(2));
            currentThresholds.analyzed_events_count += totalAnalyzed;
            currentThresholds.last_adjusted_at = new Date();
          }
        }
      }
      
      // Save changes if any
      if (user.isModified('confidence_thresholds')) {
         await user.save();
      }
    }
    console.log('[ThresholdAnalyzer] Completed threshold analysis.');
  } catch (err) {
    console.error('[ThresholdAnalyzer] Error during analysis:', err.message);
  }
};

module.exports = { analyzeUserThresholds };
