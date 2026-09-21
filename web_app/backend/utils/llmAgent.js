/**
 * LOCUS notification agent: persona-tailored titles and messages for every
 * notification the system sends, with a deterministic template behind each one.
 *
 * Every generate* function returns {title, message} and NEVER throws. If the
 * LLM is unconfigured, rate-limited, down, or returns something that fails the
 * schema, the template ships instead. Transport, throttling and fallback live
 * in llmClient.js.
 *
 * The model is only ever asked to phrase facts the caller already established
 * (which medication, which time, how many days, which room). It is not asked
 * what happened. That is what keeps hallucination out of a caregiver alert.
 */

const { completeJSON, isConfigured } = require('./llmClient');

const SCHEMA = { title: { type: 'string', max: 80 }, message: { type: 'string', max: 400 } };
const pick = arr => arr[Math.floor(Math.random() * arr.length)];
const timeOf = d => d ? new Date(d).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : null;

const BASE_RULES = `You write short in-app and email notifications for LOCUS, an assistive-care app.
Return ONLY a JSON object: {"title": "...", "message": "..."}.
Rules: title under 60 characters; message 1-2 sentences; never invent medical advice, dosages, or facts not given; never change the times or counts you are given.`;

async function phrase(instruction, facts, fallback, label) {
  if (!isConfigured()) return fallback;
  const out = await completeJSON(`${BASE_RULES}\n${instruction}`, facts, SCHEMA);
  if (out) { console.log(`[LLMAgent] ${label}: "${out.title}"`); return out; }
  return fallback;
}

// ── Hardcoded vault (unchanged from the original agent) ─────────────────────
const vault = {
  dose_reminder: [
    "It's time for your scheduled medication.",
    "Please take your medication now.",
    "Time for your daily medication routine.",
    "Your health is important! It's time for your medication.",
    "Friendly reminder: your medicine is due.",
  ],
  taken_patient: [
    "Great job taking your medication on time!",
    "Dose confirmed. Keep up the good work!",
    "Medication verified successfully.",
  ],
};

// ═══════════════════════════════════════════════════════════════════════════
// Medication
// ═══════════════════════════════════════════════════════════════════════════

const generateAIDoseReminder = async (user, medication, log) => {
  const isElderly = user.role === 'elderly';
  const name = user.name || 'Friend', med = medication.name || 'Medication', dose = medication.dosage || '';
  const t = timeOf(log.scheduled_time) || 'scheduled window';
  const fallback = {
    title: isElderly ? `Hello ${name} — Medication Reminder` : `[Reminder] ${med} ${dose}`,
    message: pick(vault.dose_reminder),
  };
  return phrase(
    isElderly ? 'Tone: warm, respectful, gentle, encouraging — for an elderly patient.'
              : 'Tone: clean, supportive, motivational — for a self-managing adult.',
    `Reminder for ${name}: ${med} ${dose}, scheduled ${t}. Reminder attempt ${log.reminder_count || 1}.`,
    fallback, `dose reminder for ${name}`);
};

const generateAIMissedDoseAlert = async (user, medication, log, caregiver) => {
  const patient = user.name || 'Patient', cg = caregiver?.name || 'Caregiver';
  const med = medication.name || 'Medication', dose = medication.dosage || '';
  const t = timeOf(log.scheduled_time) || 'scheduled time', n = log.reminder_count || 3;
  const cameraOff = log.status === 'camera_off';
  const fallback = {
    title: cameraOff ? `[Camera Off Alert] ${patient} did not verify ${med}` : `[Missed Dose Alert] ${patient} missed ${med}`,
    message: cameraOff
      ? `${patient} did not turn on their camera to verify the ${med} (${dose}) dose scheduled for ${t} after ${n} reminders. Please check in with them or mark it manually if you can verify it.`
      : `${patient} has missed their ${med} (${dose}) dose scheduled for ${t} after ${n} reminders. Please check in with them.`,
  };
  return phrase(
    'Audience: a caregiver. Tone: professional, urgent, concise, actionable.',
    `Patient ${patient}, medication ${med} ${dose}, scheduled ${t}, ${n} reminders sent. ` +
    (cameraOff ? 'The camera was OFF for the whole window, so the dose is UNVERIFIED (not confirmed missed) — say the caregiver should check the device or confirm manually.'
               : 'The camera was on and the dose was NOT detected — it is MISSED; say the caregiver should check on the patient.'),
    fallback, `missed-dose alert for ${cg}`);
};

const generateAITakenDoseAlert = async (user, medication, log, caregiver) => {
  const patient = user?.name || 'Your patient', cg = caregiver?.name || 'Caregiver';
  const med = medication?.name || 'their medication', dose = medication?.dosage || '';
  const t = timeOf(log?.scheduled_time) || 'their scheduled time';
  const fallback = {
    title: `[Dose Taken] ${patient} took ${med}`,
    message: `${patient} has taken their ${med} (${dose}) scheduled for ${t}. No action needed.`,
  };
  return phrase('Audience: a caregiver. Tone: positive, reassuring; make clear no action is required.',
    `Patient ${patient} took ${med} ${dose} scheduled ${t}; verified by camera.`, fallback, `taken-dose notice for ${cg}`);
};

const generateAIUserTakenDoseAlert = async (user, medication) => {
  const name = user?.name || 'there', med = medication?.name || 'your medication';
  const fallback = { title: `[Confirmed] ${med} Taken`, message: pick(vault.taken_patient) };
  return phrase('Audience: the patient themself. Tone: short, warm, congratulatory.',
    `${name} just took ${med}, verified by camera.`, fallback, `taken confirmation for ${name}`);
};

const generateAIUserMissedDoseAlert = async (user, medication, log) => {
  const isElderly = user.role === 'elderly';
  const name = user.name || 'Friend', med = medication.name || 'Medication', dose = medication.dosage || '';
  const t = timeOf(log.scheduled_time) || 'scheduled time';
  const cameraOff = log.status === 'camera_off';
  const fallback = {
    title: cameraOff ? `Camera Off: ${med} Verification Incomplete` : `Missed Dose: ${med}`,
    message: cameraOff
      ? `Your camera was not on during the window for ${med} (${dose}) at ${t}. This is marked 'Camera Off' and your caregiver has been notified.`
      : `We could not detect your ${med} (${dose}) dose at ${t}. This is marked 'Missed' and your caregiver has been notified.`,
  };
  return phrase(
    (isElderly ? 'Audience: an elderly patient. Tone: warm, gentle, respectful.' : 'Audience: a self-managing adult. Tone: direct, motivational.') +
    ' Do not tell them to take a dose now; say their caregiver has been notified.',
    `${name}, ${med} ${dose} at ${t}. ` + (cameraOff ? 'Camera was off for the whole window; marked Camera Off.' : 'Camera was on, dose not detected; marked Missed.'),
    fallback, `user missed-dose alert for ${name}`);
};

const generateAISkippedMedicineAlert = async (patientName, caregiverName, scheduledTime, expected, taken, skipped, isCaregiver) => {
  const fallback = {
    title: `⚠ Skipped ${skipped} Medicine${skipped > 1 ? 's' : ''}`,
    message: isCaregiver
      ? `${patientName} was scheduled to take ${expected} medicine(s) at ${scheduledTime}, but only ${taken} were detected. ${skipped} skipped.`
      : `You were scheduled to take ${expected} medicine(s) at ${scheduledTime}, but only ${taken} were detected. ${skipped} skipped.`,
  };
  return phrase(`Audience: ${isCaregiver ? 'a caregiver' : 'the patient'}. Tone: urgent, concise, actionable.`,
    `Patient ${patientName}, ${scheduledTime}: ${expected} medicines scheduled, ${taken} detected taken, ${skipped} skipped.`,
    fallback, `skipped-medicine alert`);
};

const generateAIEscalatedAlert = async (notification, caregiver) => {
  const cg = caregiver?.name || 'Caregiver';
  const title0 = notification.title || 'Safety Alert', msg0 = notification.message || 'An alert requires your attention.';
  const fallback = {
    title: `[ESCALATED] ${title0}`.slice(0, 80),
    message: `Unacknowledged for over 15 minutes: "${msg0}". Please act now.`.slice(0, 400),
  };
  return phrase('Audience: a caregiver. Tone: urgent. The earlier alert has gone unacknowledged for 15+ minutes; say intervention is needed now.',
    `Original alert: "${title0}" — "${msg0}".`, fallback, `escalation for ${cg}`);
};

// ═══════════════════════════════════════════════════════════════════════════
// Routine findings (see routineMonitor.js)
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Rephrase a routine finding for a specific recipient. The finding's own
 * title/message (built from real counts by the monitor) is the fallback, so
 * the LLM can only improve tone -- never the facts.
 */
const generateRoutineFindingMessage = async (finding, recipient, subject) => {
  const fallback = { title: finding.title.slice(0, 80), message: finding.message.slice(0, 400) };
  const toCaregiver = recipient._id?.toString() !== subject._id?.toString();
  const audience = toCaregiver
    ? `Audience: ${recipient.name}, a caregiver for ${subject.name}.`
    : `Audience: ${subject.name} themself, a ${subject.role === 'elderly' ? 'elderly patient' : 'self-managing adult'}.`;
  const tone = {
    urgent: 'Tone: urgent and clear; say what to do now.',
    warning: 'Tone: concerned but calm; say what to check.',
    info: 'Tone: light, friendly, helpful; this is a gentle reminder, not an alarm.',
  }[finding.severity] || 'Tone: calm and clear.';
  const ev = finding.evidence || {};
  return phrase(`${audience} ${tone}`,
    `Finding type: ${finding.kind}. Facts: ${finding.message} Evidence: ${JSON.stringify(ev)}.`,
    fallback, `${finding.kind} for ${recipient.name}`);
};

module.exports = {
  generateAIDoseReminder,
  generateAIMissedDoseAlert,
  generateAITakenDoseAlert,
  generateAIUserTakenDoseAlert,
  generateAIUserMissedDoseAlert,
  generateAISkippedMedicineAlert,
  generateAIEscalatedAlert,
  generateRoutineFindingMessage,
};
