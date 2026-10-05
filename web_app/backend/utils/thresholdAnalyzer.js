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
    // ── Which event types may have their thresholds learned ─────────────────
    //
    // The bar is not "has a confidence score" -- every detection has one. It is
    // that BOTH answers are reachable: the person can confirm the detection and
    // can reject it, through a surface that exists. Only then does
    // rejectionRate measure accuracy rather than measuring nothing.
    //
    // medication_intake qualifies (routes/medication.js: 'taken' confirms,
    // 'missed'/'skipped' reject) and so does unknown_face (routes/
    // relationships.js: confirm and dismiss).
    //
    // object and activity do NOT, and adding them would have been actively
    // harmful. The pipeline stamps them verification_status: 'confirmed' itself
    // (item_indexer.py and pipeline.py), there is no route by which anyone can
    // reject one, and the database holds 138 'confirmed' object events and 28
    // activity events against zero rejections. Feeding those in gives
    // rejectionRate 0.00 on every run, which is read as "this person never
    // disagrees" and loosens the thresholds by 0.05 a night until they hit the
    // floor -- on the strength of a review nobody performed.
    //
    // social_interaction fails the bar for a subtler reason: it is what an
    // unknown_face BECOMES when confirmed, so it can only ever be confirmed.
    // Its rejections are recorded against the unknown_face row, which is
    // already counted.
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
            // Loosening needs evidence that this person ever says no.
            //
            // "Confirmed ten, rejected none" reads as a detector that can be
            // trusted further, and it is not, if the person has never rejected
            // anything at all: the ones they disagreed with were left sitting
            // as 'pending' rather than rejected, so the sample is every case
            // they agreed with and none of the cases they did not. This account
            // is exactly that shape -- 19 confirmed medication intakes, zero
            // rejections, while false positives it never confirmed sat in
            // needs_verification -- and loosening on that evidence would have
            // let MORE of them through, which is backwards.
            //
            // One lifetime rejection of this type is enough: it establishes
            // that disagreement reaches the record at all. The tightening
            // branch above needs no such guard, because it only ever acts ON
            // rejections.
            const everRejected = await EventLog.countDocuments({
              user_id: user._id, event_type: eventType, verification_status: 'rejected',
            });
            if (!everRejected) {
              console.log(`[ThresholdAnalyzer] User ${user._id} (${eventType}): ${totalAnalyzed} confirmed, ` +
                `none rejected EVER. Holding thresholds: silence is not agreement.`);
            } else {
              autoVerify -= 0.05;
              confirm -= 0.05;
              changed = true;
              console.log(`[ThresholdAnalyzer] User ${user._id} (${eventType}): Low rejection rate (${(rejectionRate*100).toFixed(1)}%). Shifting thresholds DOWN.`);
            }
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
