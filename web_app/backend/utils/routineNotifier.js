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
const RoutineFinding = require('../models/RoutineFinding');

const KIND_TO_TYPE = {
  medication_gap: 'routine_medication_gap',
  inactivity:     'routine_inactivity',
  camera_off:     'routine_camera_off',
  left_behind:    'routine_left_behind',
  deviation:      'routine_deviation',
  habitual_item:  'routine_habitual_item',
};

async function recipientsFor(subject) {
  const User = require('../models/User');
  if (subject.role === 'elderly') {
    if (!subject.caregiver_ids || !subject.caregiver_ids.length) return [];
    return User.find({ _id: { $in: subject.caregiver_ids } }).lean();
  }
  return [subject];
}

async function deliverFinding(finding) {
  const User = require('../models/User');
  const subject = await User.findById(finding.user_id).lean();
  if (!subject) return;
  const recipients = await recipientsFor(subject);
  if (!recipients.length) {
    console.log(`[RoutineNotifier] ${finding.kind} for ${subject.name}: no recipients (no caregivers linked)`);
    return;
  }

  const urgent = finding.severity === 'urgent';
  const email = finding.severity !== 'info';
  const ids = [];
  for (const r of recipients) {
    const prefs = r.notification_prefs || {};
    const n = await createNotification({
      recipientId: r._id,
      subjectUserId: subject._id,
      type: KIND_TO_TYPE[finding.kind] || 'system',
      title: finding.title,
      message: finding.message,
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

module.exports = { deliverFinding, deliverFindings, KIND_TO_TYPE };
