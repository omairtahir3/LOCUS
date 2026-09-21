/**
 * EventLog retention.
 *
 * Before this existed, nothing deleted EventLog records at all: there was no TTL
 * index on the collection, `retention_until` had been `default: null` since the
 * first commit with nothing reading it, and the keyframe cleanup only ever
 * called os.remove on files. Records accumulated indefinitely — 1076 of them
 * going back 68 days when this was written.
 *
 * Retention is TIERED, not uniform, because the volume and the value are not in
 * the same records:
 *
 *   activity / object   high volume, low individual value. These are the
 *                       routine-learning inputs and essentially all of the
 *                       growth (~35 MB per user per year at the observed peak
 *                       of 141 events/day). Deleted after HIGH_VOLUME_DAYS.
 *   medication_intake   clinically meaningful and tiny — 11 records in 68 days.
 *   social_interaction  who visited, and when. Same reasoning.
 *                       Both kept for CLINICAL_DAYS.
 *   is_flagged: true    never deleted, at any age. The keyframe cleanup already
 *                       honours this flag for files; this honours it for records.
 *
 * On disk an EventLog record averages 729 bytes against 120 KB for a keyframe
 * image, so one image costs as much as 168 records. Retention here is about
 * bounding unbounded growth and keeping the user_id+timestamp index small, not
 * about reclaiming space today — deleting everything past 30 days when this was
 * written would have freed 204 KB.
 */

const EventLog = require('../models/EventLog');

// The routine-learning baseline the app trains on.
const ROUTINE_BASELINE_DAYS = 30;

// High-volume types are kept for the baseline PLUS headroom. Retention equal to
// the baseline would mean the learner is permanently working against a window
// that is partly empty — the oldest day it wants is the day being deleted.
const HIGH_VOLUME_DAYS = ROUTINE_BASELINE_DAYS + 15;   // 45
const HIGH_VOLUME_TYPES = ['activity', 'object'];

// Low-volume, high-value types.
const CLINICAL_DAYS = 365;
const CLINICAL_TYPES = ['medication_intake', 'social_interaction', 'unknown_face'];

const CLEANUP_INTERVAL_MS = 24 * 60 * 60 * 1000;   // daily

function cutoff(days) {
  return new Date(Date.now() - days * 24 * 60 * 60 * 1000);
}

/**
 * Delete expired EventLog records, scoped per event_type.
 *
 * Scoping by event_type matters beyond tiering: 38 keyframe_id values in this
 * database are shared between an `object` event and an `activity` event from the
 * same moment. Any future cleanup keyed on keyframe_id alone would take both.
 * This deletes on (event_type, timestamp) and never on keyframe_id.
 *
 * @param {object} opts
 * @param {boolean} opts.dryRun  count what would go without deleting
 * @returns {Promise<{deleted: object, total: number, dryRun: boolean}>}
 */
async function cleanupExpiredEventLogs({ dryRun = false } = {}) {
  const tiers = [
    { types: HIGH_VOLUME_TYPES, days: HIGH_VOLUME_DAYS },
    { types: CLINICAL_TYPES, days: CLINICAL_DAYS },
  ];

  const deleted = {};
  let total = 0;

  for (const tier of tiers) {
    for (const type of tier.types) {
      const query = {
        event_type: type,
        timestamp: { $lt: cutoff(tier.days) },
        // Flagged records are retained regardless of age. $ne:true also matches
        // documents where the field is absent, which older records may be.
        is_flagged: { $ne: true },
      };
      const n = dryRun
        ? await EventLog.countDocuments(query)
        : (await EventLog.deleteMany(query)).deletedCount;
      if (n > 0) {
        deleted[type] = n;
        total += n;
      }
    }
  }

  if (total > 0) {
    const verb = dryRun ? 'would delete' : 'deleted';
    console.log(`[EventLogRetention] ${verb} ${total} expired record(s): ${JSON.stringify(deleted)}`);
  }
  return { deleted, total, dryRun };
}

function init() {
  console.log(
    `[EventLogRetention] active — ${HIGH_VOLUME_TYPES.join('/')} kept ${HIGH_VOLUME_DAYS}d, ` +
    `${CLINICAL_TYPES.join('/')} kept ${CLINICAL_DAYS}d, flagged records kept indefinitely`
  );
  // Deliberately not run at startup: a restart loop would repeatedly sweep the
  // collection. First sweep happens one interval in.
  setInterval(() => {
    cleanupExpiredEventLogs().catch(e =>
      console.error('[EventLogRetention] cleanup failed:', e.message));
  }, CLEANUP_INTERVAL_MS);
}

module.exports = {
  init,
  cleanupExpiredEventLogs,
  ROUTINE_BASELINE_DAYS,
  HIGH_VOLUME_DAYS,
  HIGH_VOLUME_TYPES,
  CLINICAL_DAYS,
  CLINICAL_TYPES,
};
