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
 *
 * Titles are never the model's: every template title is written for its exact
 * case and the model rewrites only the message body, which is then checked for
 * guessed pronouns and for actually addressing the recipient (see phrase()).
 */

const { completeJSON, isConfigured } = require('./llmClient');
const { timeWords, firstName } = require('./friendly');

const SCHEMA = { title: { type: 'string', max: 80 }, message: { type: 'string', max: 400 } };
const pick = arr => arr[Math.floor(Math.random() * arr.length)];
const timeOf = d => d ? timeWords(d) : null;

const BASE_RULES = `You write short notifications for LOCUS, an app that helps older adults and the people who care for them.
Return ONLY a JSON object: {"title": "...", "message": "..."}.

How to write:
- Plain, warm, everyday language, the way a thoughtful friend would text. Never clinical, never alarmist.
- Title under 60 characters, no colons, no "Alert:" / "Urgent:" prefixes. Message 1-2 short sentences.
- No dashes of any kind as punctuation (no "—", "–" or " - "). Use a comma or a full stop instead.
- Use first names. Do not guess anyone's gender: use their name or "they/them", never "he" or "she".
- Normal capitalisation: sentences start with a capital letter. Item names are lower case ("your car keys"); medicine names keep their own capitalisation ("Panadol").
- If the title you are given is a question, keep it a question.
- Say what happened and, if there is one, the single most useful thing to do next.
- You are an app, not a person: never offer to help, never ask them to reply or "let me know".
- Never include technical values: no confidence scores, motion scores, frame counts, percentages, coordinates or ISO dates. Dates and times are given to you already in words; use them as given.

What you must not change:
- Never invent medical advice, dosages, or anything not in the facts.
- Never change a time, date, count, or distance you are given.
- "not confirmed" / "camera was off" means the app could not SEE the dose. It does NOT mean the dose was missed. Never write "missed" unless the facts say the camera saw the dose being skipped.`;

// Guards the model cannot be trusted to keep on its own (seen with the 20b
// free-tier model even with the rule spelled out): guessing a gender from a
// name, and writing ABOUT the person it was told to write TO. Either one
// reads as a stranger's message, so the template ships instead.
const GENDERED = /\b(he|she|him|his|hers?|himself|herself)\b/i;
// The app cannot chat back and must not sound like it dispenses care.
const CHATTY = /\b(let me know|tell me|reply|write back|feel better|get well)\b/i;
// Dashes as punctuation read as machine-written. The model keeps using them
// whatever the prompt says, so they are rewritten: mid-sentence ones become
// a comma, ones before a capital letter become a full stop.
const undash = s => String(s)
  .replace(/\s*[—–]\s*(?=[A-Z])|\s+-\s+(?=[A-Z])/g, '. ')
  .replace(/\s*[—–]\s*|\s+-\s+/g, ', ');
const SECOND_PERSON = /\b(you|your|you're|you've|yourself)\b/i;
// Every number the model writes (a time, a count, a distance, a dose) must
// already be in the facts or the template. Seen: "at 3:00 pm" invented for a
// confirmation whose facts carried no time at all.
const numbersIn = s => new Set((String(s).match(/\d+(?:[:.]\d+)?/g) || []));
// "2:00 PM" may legitimately come back as "2 PM", so the parts count too.
const allowedNumbers = s => { const out = new Set(); for (const n of numbersIn(s)) { out.add(n); n.split(/[:.]/).forEach(p => out.add(p)); } return out; };
const inventedNumber = (text, allowed) => [...numbersIn(text)].find(n => !allowed.has(n) && !n.split(/[:.]/).every(p => allowed.has(p)));

/**
 * Ask the model to reword `facts` for the audience in `instruction`. The
 * TITLE is always the template's: it was written for that exact finding, and
 * the model's titles were consistently weaker ("Check Your Car Keys", or a
 * title that dropped the one number that mattered). The model rewrites the
 * message body only.
 *   direct: true when the recipient is the person the message is about.
 */
async function phrase(instruction, facts, fallback, label, { direct = false } = {}) {
  if (!isConfigured()) return fallback;
  const out = await completeJSON(`${BASE_RULES}\n${instruction}`, facts, SCHEMA);
  if (!out) return fallback;
  if (GENDERED.test(out.message)) { console.warn(`[LLMAgent] ${label}: guessed a gender, using template`); return fallback; }
  if (CHATTY.test(out.message)) { console.warn(`[LLMAgent] ${label}: chatty, using template`); return fallback; }
  if (direct && !SECOND_PERSON.test(out.message)) { console.warn(`[LLMAgent] ${label}: not addressed to the recipient, using template`); return fallback; }
  const bad = inventedNumber(out.message, allowedNumbers(`${facts} ${fallback.title} ${fallback.message}`));
  if (bad) { console.warn(`[LLMAgent] ${label}: invented "${bad}", using template`); return fallback; }
  const message = undash(out.message).slice(0, 400);
  console.log(`[LLMAgent] ${label}: "${message}"`);
  return { title: fallback.title, message };
}

// ── Hardcoded vault (unchanged from the original agent) ─────────────────────
const vault = {
  taken_patient: [
    "Nicely done, that one's taken care of.",
    "All done, thank you. Keep it up!",
    "Got it, your dose is confirmed.",
  ],
};

// ═══════════════════════════════════════════════════════════════════════════
// Medication
// ═══════════════════════════════════════════════════════════════════════════

const generateAIDoseReminder = async (user, medication, log) => {
  const isElderly = user.role === 'elderly';
  const who = firstName(user.name) || 'there', med = medication.name || 'your medication', dose = medication.dosage || '';
  const t = timeOf(log.scheduled_time);
  const nth = log.reminder_count || 1;
  const fallback = {
    title: nth > 1 ? `Still time for your ${med}` : `Time for your ${med}`,
    message: t ? `Hi ${who}, it's ${t}, time for your ${med}${dose ? ` (${dose})` : ''}.` : `Hi ${who}, time for your ${med}${dose ? ` (${dose})` : ''}.`,
  };
  return phrase(
    isElderly ? `You are writing to ${who}, an older adult. Be warm, gentle and encouraging.`
              : `You are writing to ${who}. Be friendly and brief.`,
    `It is time for ${who} to take ${med}${dose ? ` (${dose})` : ''}${t ? `, due at ${t}` : ''}.` +
    (nth > 1 ? ` They have already been reminded ${nth - 1 === 1 ? 'once' : `${nth - 1} times`} and have not confirmed it yet; nudge again kindly, but do not mention counts or say "reminder number".` : ''),
    fallback, `dose reminder for ${who}`, { direct: true });
};

const generateAIMissedDoseAlert = async (user, medication, log, caregiver) => {
  const who = firstName(user.name) || 'they', cg = firstName(caregiver?.name) || 'there';
  const med = medication.name || 'medication', dose = medication.dosage || '';
  const t = timeOf(log.scheduled_time) || 'the scheduled time', n = log.reminder_count || 3;
  const reminders = `${n} reminder${n === 1 ? '' : 's'}`;
  const cameraOff = log.status === 'camera_off';
  const fallback = cameraOff
    ? { title: `Couldn't confirm ${who}'s ${med}`,
        message: `The camera was off around ${t}, so we couldn't see whether ${who} took the ${med}${dose ? ` (${dose})` : ''} after ${reminders}. Could you check in, or mark it taken if you know it was?` }
    : { title: `${who} seems to have missed the ${med}`,
        message: `The camera was on at ${t} but didn't see ${who} take the ${med}${dose ? ` (${dose})` : ''}, even after ${reminders}. It would be worth checking in.` };
  return phrase(
    `You are writing to ${cg}, who looks after ${who}. Be calm and practical.`,
    cameraOff
      ? `${who}'s ${med}${dose ? ` (${dose})` : ''} was due at ${t}. The camera was off the whole time, so the dose is NOT CONFIRMED. We do not know whether it was taken. ${reminders} ${n === 1 ? 'was' : 'were'} sent. Suggest checking in or confirming it by hand.`
      : `${who}'s ${med}${dose ? ` (${dose})` : ''} was due at ${t}. The camera was on and did not see it taken after ${reminders}, so it appears MISSED. Suggest checking in.`,
    fallback, `missed-dose alert for ${cg}`);
};

const generateAITakenDoseAlert = async (user, medication, log, caregiver) => {
  const who = firstName(user?.name) || 'they', cg = firstName(caregiver?.name) || 'there';
  const med = medication?.name || 'their medication', t = timeOf(log?.scheduled_time);
  const fallback = {
    title: `${who} took the ${med}`,
    message: `Good news, ${who} took the ${med}${t ? ` due at ${t}` : ''} and the camera confirmed it. Nothing to do.`,
  };
  return phrase(`You are writing to ${cg}, who looks after ${who}. Be reassuring; make clear nothing needs doing.`,
    `${who} took the ${med}${t ? ` due at ${t}` : ''}; the camera confirmed it.`, fallback, `taken-dose notice for ${cg}`);
};

const generateAIUserTakenDoseAlert = async (user, medication) => {
  const who = firstName(user?.name) || 'there', med = medication?.name || 'your medication';
  const fallback = { title: `${med} taken`, message: pick(vault.taken_patient) };
  return phrase(`You are writing to ${who} directly. Be short, warm and encouraging.`,
    `${who} just took ${med} and the camera confirmed it.`, fallback, `taken confirmation for ${who}`, { direct: true });
};

const generateAIUserMissedDoseAlert = async (user, medication, log) => {
  const isElderly = user.role === 'elderly';
  const who = firstName(user.name) || 'there', med = medication.name || 'your medication', dose = medication.dosage || '';
  const t = timeOf(log.scheduled_time) || 'the scheduled time';
  const cameraOff = log.status === 'camera_off';
  const fallback = cameraOff
    ? { title: `We couldn't see your ${med}`,
        message: `Your camera was off around ${t}, so we couldn't confirm your ${med}${dose ? ` (${dose})` : ''}. We've let your caregiver know, just in case.` }
    : { title: `Did you take your ${med}?`,
        message: `We didn't see you take your ${med}${dose ? ` (${dose})` : ''} at ${t}. We've let your caregiver know so they can check in.` };
  return phrase(
    (isElderly ? `You are writing to ${who}, an older adult. Be warm and gentle, never scolding.` : `You are writing to ${who}. Be friendly and direct.`) +
    ' Do not tell them to take a dose now. Mention their caregiver has been told.',
    `${who}'s ${med}${dose ? ` (${dose})` : ''} was due at ${t}. ` + (cameraOff ? 'The camera was off, so it could not be confirmed.' : 'The camera was on and did not see it taken.') + ' The caregiver has been notified.',
    fallback, `user missed-dose alert for ${who}`, { direct: true });
};

const generateAISkippedMedicineAlert = async (patientName, caregiverName, scheduledTime, expected, taken, skipped, isCaregiver) => {
  const who = firstName(patientName) || 'they';
  const fallback = isCaregiver
    ? { title: `${who} may have skipped ${skipped} medicine${skipped > 1 ? 's' : ''}`,
        message: `At ${scheduledTime} ${who} was due ${expected} medicine${expected > 1 ? 's' : ''}, but the camera only saw ${taken} taken. Worth a quick check.` }
    : { title: `Did you get all your medicines?`,
        message: `You were due ${expected} at ${scheduledTime}, but we only saw ${taken} taken. Please check you haven't missed one.` };
  return phrase(`You are writing to ${isCaregiver ? `${firstName(caregiverName)}, who looks after ${who}` : `${who} directly`}. Be calm and clear.`,
    `At ${scheduledTime}, ${expected} medicines were due; the camera saw ${taken} taken and ${skipped} not taken.`,
    fallback, `skipped-medicine alert`, { direct: !isCaregiver });
};

const generateAIEscalatedAlert = async (notification, caregiver) => {
  const cg = firstName(caregiver?.name) || 'there';
  const title0 = notification.title || 'an earlier alert', msg0 = notification.message || '';
  const fallback = {
    title: `Still waiting, ${title0.charAt(0).toLowerCase()}${title0.slice(1)}`.slice(0, 80),
    message: `Hi ${cg}, this one has been waiting 15 minutes. ${msg0} Could you take a look now?`.slice(0, 400),
  };
  return phrase(`You are writing to ${cg}. An earlier alert has gone unanswered for 15 minutes; ask them to look at it now, firmly but kindly. Keep the original facts.`,
    `Earlier alert, still unanswered after 15 minutes: "${title0}". ${msg0}`, fallback, `escalation for ${cg}`);
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
  const who = firstName(subject.name);
  const audience = toCaregiver
    ? `You are writing to ${firstName(recipient.name)}, who looks after ${who}. Refer to ${who} by first name.`
    : `You are writing to ${who} directly. Address them as "you".`;
  const tone = {
    urgent: 'This matters now: be clear and direct about what to do, without being frightening.',
    warning: 'Something is worth checking; be calm and practical.',
    info: 'This is a gentle heads-up, not an alarm; keep it light.',
  }[finding.severity] || 'Be calm and clear.';
  // The finding's message was already composed from real counts in plain
  // words by the monitor. It IS the fact sheet. Raw evidence (motion scores,
  // frame counts, ratios) is deliberately not passed: the model can only
  // parrot numbers it is shown, and a caregiver should never see them.
  return phrase(`${audience} ${tone}`,
    `Rewrite this in your own words, keeping every fact exactly as stated:\n${finding.message}`,
    fallback, `${finding.kind} for ${recipient.name}`, { direct: !toCaregiver });
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
