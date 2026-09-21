/**
 * Delivers routine findings through the existing notification path.
 *
 * Routing is by the subject's role: findings about an ELDERLY user go to each
 * of their caregivers (caregiver_ids); findings for a normal USER go to that
 * user. Caregivers are never the subject of a finding.
 *
 * Delivery is templated. This is deliberately the last deterministic step: the
 * finding's title and message were composed from real counts by the monitor,
 * and they ship as-is. The LLM layer -- rephrasing for tone, deciding whether
 * an 'info' finding is worth a push or belongs in a digest -- plugs in here
 * later, in front of createNotification, and can only reword what the monitor
 * found. It cannot invent a finding.
 *
 * Severity decides the channel:
 *   urgent  -> push + email, requires acknowledgement   (inactivity, missed doses)
 *   warning -> push + email                             (camera off, unverified gap)
 *   info    -> push only                                (deviations, left-behind, habits)
 */

const { createNotification } = require('./notifications');
const { generateRoutineFindingMessage } = require('./llmAgent');
const RoutineFinding = require('../models/RoutineFinding');

const KIND_TO_TYPE = {
  medication_gap: 'routine_medication_gap',
  inactivity:     'routine_inactivity',
  camera_off:     'routine_camera_off',
  left_behind:    'routine_left_behind',
  deviation:      'routine_deviation',
  habitual_item:  'routine_habitual_item',
  item_lost:      'routine_item_lost',
};

// item_lost is the one finding whose FIRST recipient is the user even when the
// user is elderly: the person who can walk back and pick it up is the person
// holding the phone. Caregivers come in via deliverEscalation if the user does
// not acknowledge within ITEM_LOST_ESCALATE_MIN.
const USER_FIRST_KINDS = new Set(['item_lost']);

async function recipientsFor(subject, kind) {
  const User = require('../models/User');
  if (USER_FIRST_KINDS.has(kind)) return [subject];
  if (subject.role === 'elderly') {
    if (!subject.caregiver_ids || !subject.caregiver_ids.length) return [];
    return User.find({ _id: { $in: subject.caregiver_ids } }).lean();
  }
  return [subject];
}

/**
 * FE-15: caregivers get the lost-item alert with everything they need to act
 * on it -- where it was last seen, when, and the frame that saw it. The
 * keyframe id resolves through the existing /api/detection/keyframes/:id/image
 * route, so the caregiver app can show the picture.
 */
async function deliverEscalation(finding, subject, now = new Date()) {
  const User = require('../models/User');
  const caregivers = await User.find({ _id: { $in: subject.caregiver_ids || [] } }).lean();
  if (!caregivers.length) return [];
  const ev = finding.evidence || {};
  const when = ev.last_seen_at ? new Date(ev.last_seen_at) : null;
  const loc = ev.last_seen_location;
  const mapLink = loc ? `https://maps.google.com/?q=${loc.lat},${loc.lng}` : null;
  const title = `${subject.name} may have lost their ${ev.item_name || 'item'}`;
  const message =
    `${subject.name} was alerted ${ITEM_LOST_ESCALATE_LABEL} ago that their ${ev.item_name || 'item'} was left behind and has not responded. ` +
    (when ? `Last seen ${when.toLocaleString([], { hour: '2-digit', minute: '2-digit', day: 'numeric', month: 'short' })}` : 'Last seen time unknown') +
    (loc ? ` at ${loc.lat.toFixed(5)}, ${loc.lng.toFixed(5)} (${mapLink}).` : '.') +
    (ev.keyframe_id ? ` Keyframe: ${ev.keyframe_id}.` : '');
  const ids = [];
  for (const cg of caregivers) {
    const prefs = cg.notification_prefs || {};
    const n = await createNotification({
      recipientId: cg._id,
      subjectUserId: subject._id,
      type: 'routine_item_lost_escalated',
      title, message,
      requiresAcknowledgement: true,
      sendEmailTo: (prefs.email !== false && cg.email) ? cg.email : null,
      sendPush: prefs.push !== false,
    });
    ids.push(n._id);
  }
  await RoutineFinding.findByIdAndUpdate(finding._id, { $addToSet: { notification_ids: { $each: ids }, recipients: { $each: caregivers.map(c => c._id) } } });
  console.log(`[RoutineNotifier] item_lost ESCALATED for ${subject.name} -> ${caregivers.map(c => c.name).join(', ')}`);
  return ids;
}
const ITEM_LOST_ESCALATE_LABEL = '10 minutes';

async function deliverFinding(finding) {
  const User = require('../models/User');
  const subject = await User.findById(finding.user_id).lean();
  if (!subject) return;
  const recipients = await recipientsFor(subject, finding.kind);
  if (!recipients.length) {
    console.log(`[RoutineNotifier] ${finding.kind} for ${subject.name}: no recipients (no caregivers linked)`);
    return;
  }

  const urgent = finding.severity === 'urgent';
  const email = finding.severity !== 'info';
  const ids = [];
  for (const r of recipients) {
    const prefs = r.notification_prefs || {};
    // Phrase for THIS recipient: a caregiver reading about their patient and
    // the patient reading about themself get different wording. Falls back to
    // the monitor's own text if the LLM is unavailable.
    const { title, message } = await generateRoutineFindingMessage(finding, r, subject);
    const n = await createNotification({
      recipientId: r._id,
      subjectUserId: subject._id,
      type: KIND_TO_TYPE[finding.kind] || 'system',
      title,
      message,
      requiresAcknowledgement: urgent,
      sendEmailTo: (email && prefs.email !== false && r.email) ? r.email : null,
      sendPush: prefs.push !== false,
    });
    ids.push(n._id);
  }
  await RoutineFinding.findByIdAndUpdate(finding._id, {
    $set: { notified: true, recipients: recipients.map(r => r._id), notification_ids: ids },
  });
  console.log(`[RoutineNotifier] ${finding.kind} (${finding.severity}) -> ${recipients.map(r => r.name).join(', ')}`);
}

async function deliverFindings(findings) {
  for (const f of findings) {
    try { await deliverFinding(f); }
    catch (e) { console.error(`[RoutineNotifier] ${f.kind}: ${e.message}`); }
  }
}

module.exports = { deliverFinding, deliverFindings, deliverEscalation, KIND_TO_TYPE };
