const mongoose = require('mongoose');

/**
 * Every deviation the routine monitor detects, whether or not it was surfaced.
 *
 * Two jobs: (1) deduplication -- the monitor runs every 15 minutes and must not
 * re-alert a caregiver about the same medication gap on every run; (2) an audit
 * trail, so "why did it alert / why didn't it" is answerable from the record
 * rather than from logs.
 *
 * `dedup_key` is what makes a finding "the same" as an earlier one:
 *   medication_gap   -> user:YYYY-MM-DD(gap start):N(gap length bucket)
 *   inactivity       -> user:YYYY-MM-DD:HH(window start)
 *   camera_off       -> user:YYYY-MM-DD
 *   left_behind      -> user:item_id:session_end_ts
 *   deviation        -> user:signal:YYYY-MM-DD
 */
const routineFindingSchema = new mongoose.Schema({
  user_id:    { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  kind: {
    type: String,
    enum: ['medication_gap', 'inactivity', 'camera_off', 'left_behind', 'deviation', 'habitual_item',
           'item_lost'],   // enrolled item left behind OUTDOORS (Core FE-12); escalates to caregivers (FE-15)
    required: true,
  },
  // FE-15: set once caregivers have been told because the user did not
  // acknowledge the alert in time.
  escalated:    { type: Boolean, default: false },
  escalated_at: { type: Date, default: null },
  dedup_key:  { type: String, required: true, unique: true },
  severity:   { type: String, enum: ['info', 'warning', 'urgent'], default: 'info' },
  title:      { type: String, required: true },
  message:    { type: String, required: true },
  evidence:   { type: mongoose.Schema.Types.Mixed, default: {} },
  // who was told, and how
  notified:   { type: Boolean, default: false },
  recipients: [{ type: mongoose.Schema.Types.ObjectId, ref: 'User' }],
  notification_ids: [{ type: mongoose.Schema.Types.ObjectId, ref: 'Notification' }],
}, { timestamps: true });

routineFindingSchema.index({ user_id: 1, kind: 1, createdAt: -1 });

module.exports = mongoose.model('RoutineFinding', routineFindingSchema, 'routine_findings');
