/**
 * Routine monitor: compares what is happening now against each user's profile
 * and raises findings. Runs every MONITOR_INTERVAL_MS.
 *
 * Role-gated. Elderly users are monitored on behalf of their caregivers;
 * normal users get reminders for themselves; caregivers are never monitored.
 *
 *   elderly  -> medication_gap, inactivity, camera_off, deviation   (to caregivers)
 *   user     -> left_behind, habitual_item                          (to the user)
 *
 * Every check is deterministic and every threshold below was set from the real
 * data in this database, not from taste. Findings are recorded in
 * routine_findings whether or not they are surfaced, and dedup_key prevents the
 * same finding being raised again on the next run.
 */

const RoutineProfile = require('../models/RoutineProfile');
const RoutineFinding = require('../models/RoutineFinding');
const EventLog = require('../models/EventLog');
const MedicationLog = require('../models/MedicationLog');
const { expectation } = require('./routineLearner');

const MONITOR_INTERVAL_MS = 15 * 60 * 1000;

// ── Medication gap (elderly) ────────────────────────────────────────────────
// Alert when this many consecutive days end with no verified dose. Re-alert only
// each time the gap grows by another MED_GAP_DAYS, so a 10-day gap produces
// alerts at 3, 6 and 9 -- not ten of them.
const MED_GAP_DAYS = 3;

// ── Inactivity (elderly) ────────────────────────────────────────────────────
// The keyframe extractor writes a scene_change event with motion_score for every
// keyframe it saves, so those events are a liveness heartbeat. Measured over 449
// of them: motion_score median 8.1, p25 4.4, p10 2.5. Sitting still is the
// bottom quartile, so a window whose PEAK stays under 5.0 is inactivity.
const INACTIVITY_HOURS = 3;
const MOTION_FLOOR = 5.0;
// Keyframe gaps while streaming: median 25s, p90 126s, p99 20min. A gap past 30
// minutes is not "sitting still", it is "no camera", which is a different alert.
const STREAM_ALIVE_MIN = 30;
const CAMERA_OFF_HOURS = 4;
// Only during waking hours. Asleep is not inactive.
const WAKING_START_HOUR = 7;
const WAKING_END_HOUR = 23;

// ── Left-behind item (user) ─────────────────────────────────────────────────
// When a scene session closes (the user left that room), any enrolled item last
// seen in that room during the session and not seen since is left behind.
const LEFT_BEHIND_WINDOW_MIN = 10;

// ── Routine deviation (elderly, gated on profile support) ──────────────────
// If a scene is expected at this hour and has not been seen since this many
// hours before, the routine has slipped. Two hours absorbs ordinary variation.
const DEVIATION_GRACE_HOURS = 2;

// Every check takes `now` as a parameter and does all time arithmetic against
// it, so behaviour is a pure function of (database, now). Production passes the
// real clock; tests pass a fixed one and get reproducible answers -- including
// for the waking-hours gate, which would otherwise make a 3 a.m. test run
// silently skip every inactivity case.
const hoursAgo = (h, now) => new Date(now.getTime() - h * 3600000);
const minutesAgo = (m, now) => new Date(now.getTime() - m * 60000);
const dayKey = d => d.toISOString().slice(0, 10);
const isWakingHours = d => d.getHours() >= WAKING_START_HOUR && d.getHours() < WAKING_END_HOUR;
const idForms = uid => [uid, String(uid)];

/** Record a finding once. Returns the new document, or null if already known. */
async function record(user, kind, dedup_key, severity, title, message, evidence = {}) {
  try {
    return await RoutineFinding.create({ user_id: user._id, kind, dedup_key, severity, title, message, evidence });
  } catch (e) {
    if (e.code === 11000) return null;   // dedup_key already recorded
    throw e;
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// Elderly checks
// ═══════════════════════════════════════════════════════════════════════════

async function checkMedicationGap(user, now = new Date()) {
  // Walk back from today counting consecutive days with no 'taken'. Stop at the
  // first day that had one. A day with no scheduled dose at all does not break
  // or extend the gap -- it simply is not evidence either way.
  const lookback = 60;
  const since = new Date(now.getTime() - lookback * 86400000);
  const logs = await MedicationLog.find({ user_id: { $in: idForms(user._id) }, scheduled_time: { $gte: since } })
    .sort({ scheduled_time: -1 }).lean();
  if (!logs.length) return null;

  const byDay = new Map();
  for (const l of logs) {
    const k = dayKey(new Date(l.scheduled_time));
    if (!byDay.has(k)) byDay.set(k, { taken: 0, missed: 0, camera_off: 0, scheduled: 0, other: 0 });
    const d = byDay.get(k);
    if (l.status === 'taken') d.taken++;
    else if (l.status === 'missed') d.missed++;
    else if (l.status === 'camera_off' || l.status === 'skipped') d.camera_off++;
    else if (l.status === 'scheduled') d.scheduled++;
    else d.other++;
  }

  const gapDays = [];
  let missedAny = false, cameraOffAll = true;
  for (let i = 0; i < lookback; i++) {
    const day = new Date(now.getTime() - i * 86400000);
    const k = dayKey(day);
    const d = byDay.get(k);
    if (!d) continue;                         // nothing scheduled: no evidence
    if (d.taken > 0) break;                   // gap ends here
    if (d.scheduled > 0 && d.missed + d.camera_off === 0) continue; // still pending today
    gapDays.push(k);
    if (d.missed > 0) missedAny = true;
    if (d.missed > 0 || d.other > 0) cameraOffAll = false;
  }
  if (gapDays.length < MED_GAP_DAYS) return null;

  const bucket = Math.floor(gapDays.length / MED_GAP_DAYS);       // 3->1, 6->2, ...
  const gapStart = gapDays[gapDays.length - 1], gapEnd = gapDays[0];
  const dedup_key = `${user._id}:medgap:${gapStart}:${bucket}`;

  // camera_off is not "missed" -- it needs a different response from the
  // caregiver (check the device) than a genuinely missed dose does (check the person).
  const verb = cameraOffAll ? 'no verified dose (camera was off at every dose time)'
             : missedAny   ? 'missed doses'
                           : 'no verified dose';
  const title = `${user.name}: ${gapDays.length} days without a verified dose`;
  const message = `${user.name} has had ${verb} from ${gapStart} to ${gapEnd} — ${gapDays.length} consecutive days. ` +
    (cameraOffAll ? 'Please check the camera is running at dose times, or confirm doses manually.'
                  : 'Please check in with them.');
  return record(user, 'medication_gap', dedup_key, cameraOffAll ? 'warning' : 'urgent', title, message,
    { gap_start: gapStart, gap_end: gapEnd, days: gapDays.length, camera_off_all: cameraOffAll, missed_any: missedAny });
}

async function checkInactivityAndCamera(user, now = new Date()) {
  if (!isWakingHours(now)) return null;

  const recent = await EventLog.find({
    user_id: { $in: idForms(user._id) }, 'details.action': 'scene_change',
    timestamp: { $gte: hoursAgo(Math.max(INACTIVITY_HOURS, CAMERA_OFF_HOURS), now), $lte: now },
  }).sort({ timestamp: -1 }).lean();

  const last = recent[0];
  const streamAlive = last && new Date(last.timestamp) >= minutesAgo(STREAM_ALIVE_MIN, now);

  if (!streamAlive) {
    // No keyframes at all: the camera is off, not the person.
    const lastSeen = last ? new Date(last.timestamp) : null;
    const offHours = lastSeen ? (now - lastSeen) / 3600000 : Infinity;
    if (offHours < CAMERA_OFF_HOURS) return null;
    const dedup_key = `${user._id}:cameraoff:${dayKey(now)}`;
    return record(user, 'camera_off', dedup_key, 'warning',
      `${user.name}: camera has been off for ${offHours === Infinity ? 'over 24' : Math.floor(offHours)} hours`,
      `No frames have been received from ${user.name}'s camera since ${lastSeen ? lastSeen.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : 'yesterday'}. ` +
      `Routine and inactivity monitoring are paused until it is back.`,
      { last_frame: lastSeen });
  }

  // Stream is alive: is there motion?
  const window = recent.filter(e => new Date(e.timestamp) >= hoursAgo(INACTIVITY_HOURS, now));
  if (window.length < 3) return null;   // too few frames to judge
  const peak = Math.max(...window.map(e => e.details?.motion_score ?? 0));
  if (peak >= MOTION_FLOOR) return null;

  const windowStart = new Date(Math.min(...window.map(e => +new Date(e.timestamp))));
  const dedup_key = `${user._id}:inactive:${dayKey(now)}:${windowStart.getHours()}`;
  return record(user, 'inactivity', dedup_key, 'urgent',
    `${user.name}: no movement for ${INACTIVITY_HOURS} hours`,
    `${user.name}'s camera has been running since ${windowStart.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })} ` +
    `with almost no movement (peak motion ${peak.toFixed(1)}, ${window.length} frames). Please check on them.`,
    { peak_motion: peak, frames: window.length, window_start: windowStart });
}

async function checkDeviation(user, profile, now = new Date()) {
  if (!isWakingHours(now)) return [];
  const out = [];
  for (const sig of profile.signals || []) {
    if (!sig.key.startsWith('scene:')) continue;
    const exp = expectation(profile, sig.key, now);
    if (exp.insufficient || !exp.expected) continue;
    const room = sig.key.slice('scene:'.length);
    const seen = await EventLog.exists({
      user_id: { $in: idForms(user._id) }, 'details.action': 'scene_session',
      'details.scene': room, timestamp: { $gte: hoursAgo(DEVIATION_GRACE_HOURS, now), $lte: now },
    });
    if (seen) continue;
    const dedup_key = `${user._id}:deviation:${sig.key}:${dayKey(now)}:${now.getHours()}`;
    const f = await record(user, 'deviation', dedup_key, 'info',
      `${user.name}: not in the ${room} at the usual time`,
      `${user.name} is usually in the ${room} around ${now.getHours()}:00 ` +
      `(${Math.round(exp.ratio * 100)}% of the last ${exp.support} days) but hasn't been seen there in the last ${DEVIATION_GRACE_HOURS} hours.`,
      { signal: sig.key, ratio: exp.ratio, support: exp.support });
    if (f) out.push(f);
  }
  return out;
}

// ═══════════════════════════════════════════════════════════════════════════
// Normal-user checks
// ═══════════════════════════════════════════════════════════════════════════

async function checkLeftBehind(user, sinceRun, now = new Date()) {
  // Sessions that closed since the last run = rooms the user just left.
  const closed = await EventLog.find({
    user_id: { $in: idForms(user._id) }, 'details.action': 'scene_session',
    createdAt: { $gte: sinceRun },
  }).lean();
  const out = [];
  for (const s of closed) {
    const room = s.details?.scene;
    const start = new Date(s.timestamp);
    const end = new Date(+start + (s.details?.duration_seconds || 0) * 1000);
    if (!room) continue;
    const sightings = await EventLog.find({
      user_id: { $in: idForms(user._id) }, event_type: 'object',
      timestamp: { $gte: new Date(+end - LEFT_BEHIND_WINDOW_MIN * 60000), $lte: end },
    }).lean();
    const items = new Map();
    for (const o of sightings) for (const it of (o.details?.items || []))
      if (it.enrolled_item_id && it.matched_item) items.set(it.enrolled_item_id, it.matched_item);
    for (const [itemId, name] of items) {
      const seenSince = await EventLog.exists({
        user_id: { $in: idForms(user._id) }, event_type: 'object',
        'details.items.enrolled_item_id': itemId, timestamp: { $gt: end },
      });
      if (seenSince) continue;
      const dedup_key = `${user._id}:leftbehind:${itemId}:${Math.floor(+end / 1000)}`;
      const f = await record(user, 'left_behind', dedup_key, 'info',
        `You left your ${name} in the ${room}`,
        `Your ${name} was last seen in the ${room} at ${end.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}, just before you left.`,
        { item_id: itemId, room, session_end: end });
      if (f) out.push(f);
    }
  }
  return out;
}

async function checkHabitualItems(user, profile, now = new Date()) {
  if (!isWakingHours(now)) return [];
  const out = [];
  for (const sig of profile.signals || []) {
    if (!sig.key.startsWith('item:')) continue;
    const exp = expectation(profile, sig.key, now);
    if (exp.insufficient || !exp.expected) continue;
    const itemId = sig.key.slice('item:'.length);
    const seen = await EventLog.exists({
      user_id: { $in: idForms(user._id) }, event_type: 'object',
      'details.items.enrolled_item_id': itemId, timestamp: { $gte: hoursAgo(DEVIATION_GRACE_HOURS, now), $lte: now },
    });
    if (seen) continue;
    const usualRoom = Object.entries(sig.rooms || {}).sort((a, b) => b[1] - a[1])[0]?.[0];
    const dedup_key = `${user._id}:habitual:${itemId}:${dayKey(now)}:${now.getHours()}`;
    const f = await record(user, 'habitual_item', dedup_key, 'info',
      `Do you have your ${sig.label}?`,
      `You usually have your ${sig.label} with you around this time` +
      (usualRoom ? ` — it's most often in the ${usualRoom}.` : '.'),
      { signal: sig.key, ratio: exp.ratio, usual_room: usualRoom });
    if (f) out.push(f);
  }
  return out;
}

// ═══════════════════════════════════════════════════════════════════════════

let lastRunAt = new Date(Date.now() - MONITOR_INTERVAL_MS);

async function runOnce(now = new Date()) {
  const User = require('../models/User');
  const sinceRun = lastRunAt;
  lastRunAt = now;
  const users = await User.find({ role: { $in: ['user', 'elderly'] } }).lean();
  const findings = [];
  for (const user of users) {
    try {
      const profile = await RoutineProfile.findOne({ user_id: user._id }).lean();
      if (user.role === 'elderly') {
        const a = await checkMedicationGap(user, now);           if (a) findings.push(a);
        const b = await checkInactivityAndCamera(user, now);     if (b) findings.push(b);
        if (profile) findings.push(...await checkDeviation(user, profile, now));
      } else {
        findings.push(...await checkLeftBehind(user, sinceRun, now));
        if (profile) findings.push(...await checkHabitualItems(user, profile, now));
      }
    } catch (e) {
      console.error(`[RoutineMonitor] ${user.name}: ${e.message}`);
    }
  }
  if (findings.length) {
    console.log(`[RoutineMonitor] ${findings.length} new finding(s): ` +
      findings.map(f => `${f.kind}(${f.severity})`).join(', '));
    const { deliverFindings } = require('./routineNotifier');
    await deliverFindings(findings).catch(e => console.error('[RoutineMonitor] delivery failed:', e.message));
  }
  return findings;
}

function init() {
  console.log(`[RoutineMonitor] active — every ${MONITOR_INTERVAL_MS / 60000} min; ` +
    `med gap ${MED_GAP_DAYS}d, inactivity ${INACTIVITY_HOURS}h @ motion<${MOTION_FLOOR}, camera-off ${CAMERA_OFF_HOURS}h`);
  setInterval(() => runOnce().catch(e => console.error('[RoutineMonitor]', e.message)), MONITOR_INTERVAL_MS);
}

module.exports = {
  init, runOnce,
  checkMedicationGap, checkInactivityAndCamera, checkDeviation, checkLeftBehind, checkHabitualItems,
  MED_GAP_DAYS, INACTIVITY_HOURS, MOTION_FLOOR, STREAM_ALIVE_MIN, CAMERA_OFF_HOURS, LEFT_BEHIND_WINDOW_MIN,
};
