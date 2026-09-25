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
async function phrase(instruction, facts, fallback, label, { direct = false, forbid = null, mustName = null, mustSay = null } = {}) {
  if (!isConfigured()) return fallback;
  const out = await completeJSON(`${BASE_RULES}\n${instruction}`, facts, SCHEMA);
  if (!out) return fallback;
  // The mirror of the `direct` guard. Writing to a caregiver, the model
  // collapsed the two people into one and told the caregiver they had lost
  // their own keys: "We told you 10 minutes ago that your car keys were left
  // behind and you were last seen at 11:40 PM. Please give them a call."
  // Second person cannot simply be banned here, because "Could you give Osaid a
  // call?" is correct and wanted. What the collapse always loses is the subject's
  // name, which every caregiver template carries, so that is what is checked.
  if (mustName && !new RegExp(`\\b${mustName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i').test(out.message)) {
    console.warn(`[LLMAgent] ${label}: wrote to the caregiver as if they were ${mustName}, using template`); return fallback;
  }
  // Some facts cannot be summarised away without changing what the reader will
  // do, and asking for shorter prose is exactly when the model drops one. An
  // escalation lost "and they haven't responded" and read like a first alert; on
  // another run it lost the item and read as "Osaid hasn't responded yet. They
  // were last seen at 11:43 PM", which tells a caregiver nothing. Each entry is
  // one such fact and all of them have to survive.
  const missing = (Array.isArray(mustSay) ? mustSay : mustSay ? [mustSay] : []).find(re => !re.test(out.message));
  if (missing) {
    console.warn(`[LLMAgent] ${label}: dropped a fact the reader needs (${missing}), using template`); return fallback;
  }
  if (forbid && forbid.test(out.message)) { console.warn(`[LLMAgent] ${label}: mentioned something that did not happen, using template`); return fallback; }
  if (GENDERED.test(out.message)) { console.warn(`[LLMAgent] ${label}: guessed a gender, using template`); return fallback; }
  if (CHATTY.test(out.message)) { console.warn(`[LLMAgent] ${label}: chatty, using template`); return fallback; }
  if (direct && !SECOND_PERSON.test(out.message)) { console.warn(`[LLMAgent] ${label}: not addressed to the recipient, using template`); return fallback; }
  const bad = inventedNumber(out.message, allowedNumbers(`${facts} ${fallback.title} ${fallback.message}`));
  if (bad) { console.warn(`[LLMAgent] ${label}: invented "${bad}", using template`); return fallback; }
  const message = undash(out.message).slice(0, 400);
  // Say so when the model handed the input straight back. It is not wrong and
  // not worth rejecting, but it is worth seeing: a notification that reads
  // exactly like the template usually means the prompt invited a copy, and
  // silence here is how that went unnoticed.
  if (message.trim() === fallback.message.trim()) {
    console.log(`[LLMAgent] ${label}: model returned the template unchanged`);
  } else {
    console.log(`[LLMAgent] ${label}: "${message}"`);
  }
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

/**
 * @param {boolean} caregiverNotified whether anyone was actually told. Only an
 *   elderly user has caregivers (see models/User.js); telling a normal user
 *   "we've let your caregiver know" describes something that did not happen.
 */
const generateAIUserMissedDoseAlert = async (user, medication, log, caregiverNotified = false) => {
  const isElderly = user.role === 'elderly';
  const who = firstName(user.name) || 'there', med = medication.name || 'your medication', dose = medication.dosage || '';
  const t = timeOf(log.scheduled_time) || 'the scheduled time';
  const cameraOff = log.status === 'camera_off';
  const told = caregiverNotified ? " We've let your caregiver know, just in case." : '';
  const toldSeen = caregiverNotified ? " We've let your caregiver know so they can check in." : ' If you have taken it, you can mark it as taken.';
  const fallback = cameraOff
    ? { title: `We couldn't see your ${med}`,
        message: `Your camera was off around ${t}, so we couldn't confirm your ${med}${dose ? ` (${dose})` : ''}.${told || ' If you have taken it, you can mark it as taken.'}` }
    : { title: `Did you take your ${med}?`,
        message: `We didn't see you take your ${med}${dose ? ` (${dose})` : ''} at ${t}.${toldSeen}` };
  return phrase(
    (isElderly ? `You are writing to ${who}, an older adult. Be warm and gentle, never scolding.` : `You are writing to ${who}. Be friendly and direct.`) +
    ' Do not tell them to take a dose now.' +
    (caregiverNotified ? ' Mention their caregiver has been told.' : ' They have NO caregiver: never mention a caregiver, or anyone else being told.'),
    `${who}'s ${med}${dose ? ` (${dose})` : ''} was due at ${t}. ` +
    (cameraOff ? 'The camera was off, so it could not be confirmed.' : 'The camera was on and did not see it taken.') +
    (caregiverNotified ? ' The caregiver has been notified.' : ' Nobody else has been notified; they can mark it as taken themselves.'),
    fallback, `user missed-dose alert for ${who}`,
    { direct: true, forbid: caregiverNotified ? null : /\b(caregiver|carer|family|next of kin|notified|informed|let .{0,12}know)\b/i });
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

/**
 * @param {string|null} subjectName set when the unanswered alert belongs to
 *   somebody ELSE (an elderly user) and is now being passed to their
 *   caregiver. The original message is written in the second person to that
 *   person ("your camera was off... we've let your caregiver know"), so
 *   quoting it at the caregiver addresses the wrong reader and turns "your
 *   caregiver" into the caregiver themselves. In that case the alert is
 *   restated in the third person instead of quoted.
 */
const generateAIEscalatedAlert = async (notification, caregiver, subjectName = null) => {
  const cg = firstName(caregiver?.name) || 'there';
  // The title keeps its own capitalisation: lower-casing the first letter
  // turned "Mohammad seems to have missed the Panadol" into "mohammad ...".
  // The escalation is already signalled by the badge in the app and the
  // "Still waiting" label on the email.
  const title0 = notification.title || 'an earlier alert', msg0 = notification.message || '';

  if (subjectName) {
    const who = firstName(subjectName);
    const fallback = {
      title: `${who} hasn't responded`.slice(0, 80),
      message: `${who} was alerted 15 minutes ago that we couldn't confirm their medication, and hasn't responded. Could you check in with them?`.slice(0, 400),
    };
    return phrase(
      `You are writing to ${cg}, who looks after ${who}. Write about ${who} in the third person, never as "you". Be calm and practical.`,
      `${who} was sent this alert 15 minutes ago and has not responded to it: "${title0}". Ask ${cg} to check in with ${who}.`,
      fallback, `escalation about ${who} for ${cg}`);
  }

  const fallback = {
    title: title0.slice(0, 80),
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
const phraseNotification = async (finding, recipient, subject, { forbid = null, mustSay = null, keep = null } = {}) => {
  const fallback = { title: finding.title.slice(0, 80), message: finding.message.slice(0, 400) };
  const toCaregiver = recipient._id?.toString() !== subject._id?.toString();
  const who = firstName(subject.name);
  // Two people, and the model has been caught merging them: told to write to a
  // caregiver about Osaid's keys, it wrote "your car keys were left behind, you
  // were last seen at 11:40 PM" to the caregiver. So the split is spelled out,
  // and phrase()'s mustName guard catches it when spelling it out is not enough.
  const audience = toCaregiver
    ? `You are writing to ${firstName(recipient.name)}, who looks after ${who}. The notes are about ${who}, NOT about ` +
      `${firstName(recipient.name)}. Name ${who} in the message. "You" and "your" may only ever mean ` +
      `${firstName(recipient.name)}, so never write "your" about anything belonging to ${who}.`
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
  // "Rewrite this in your own words, keeping every fact exactly as stated" was
  // tried first and the model simply copied the sentence back, every time:
  // preserving every fact exactly is trivially satisfied by not changing
  // anything. The notification then looked hand written because it was. Handing
  // the same content over as NOTES, with copying forbidden outright, produced a
  // genuine rewrite on every run while keeping the facts.
  // `keep` names the facts that cannot be summarised away, in words. mustSay
  // rejects a message that loses one, but rejection means the template ships,
  // and on the escalation that was happening 2 runs in 3: with four facts and a
  // "1-2 short sentences" rule, the model drops one to stay short. Telling it
  // which ones are not optional is what stops it choosing.
  const mustKeep = keep ? ` These must all appear in the message, even if it takes a third sentence: ${keep}.` : '';
  return phrase(`${audience} ${tone}${mustKeep}`,
    `Compose the notification from these notes, in your own sentences. ` +
    `Never copy a sentence from the notes. Change nothing factual.\n` +
    `Notes: ${finding.message}`,
    fallback, `${finding.kind} for ${recipient.name}`,
    { direct: !toCaregiver, forbid, mustSay, mustName: toCaregiver ? who : null });
};

// A dose the camera could not see is not a dose that was skipped. BASE_RULES
// says so and the model still wrote "You missed the window for your Panadol"
// (1 of 3 runs, measured) for facts that said only that it could not be
// confirmed. Callers phrasing an unconfirmed dose pass this, and the template
// ships instead.
const NOT_MISSED = /\b(missed|skipped|forgot|didn't take|did not take)\b/i;

// Every notification LOCUS composes itself goes through the line above, not
// just routine findings: the item-lost escalation, an SOS, a status check and a
// snooze receipt were all shipping their own hand-written strings, which is why
// they did not read like the medication alerts. The caller still writes the
// facts and the title; only the wording is the model's.
//
// Notifications carrying a HUMAN's words are deliberately not here: a caregiver
// chat message, a caregiver-composed alert and a quoted check-in reply all put
// somebody's actual sentence in the body, and rewriting that would put words in
// their mouth. Those stay verbatim.
const generateRoutineFindingMessage = phraseNotification;

module.exports = {
  generateAIDoseReminder,
  generateAIMissedDoseAlert,
  generateAITakenDoseAlert,
  generateAIUserTakenDoseAlert,
  generateAIUserMissedDoseAlert,
  generateAISkippedMedicineAlert,
  generateAIEscalatedAlert,
  generateRoutineFindingMessage,
  phraseNotification,
  NOT_MISSED,
};
