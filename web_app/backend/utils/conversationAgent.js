/**
 * Summarises what was said during a social interaction.
 *
 * A verbatim transcript is a poor memory aid: nobody re-reads 25 seconds of
 * speech to remember who came round. What helps is one or two sentences saying
 * who it was, what was talked about, and anything that was agreed. That is what
 * this produces, and it is what lasts: the transcript expires on the keyframe
 * clock, the summary stays on the event.
 *
 * It runs here rather than in Python on purpose. llmClient already owns the Groq
 * primary, the OpenRouter fallback, the rate limiter and the circuit breaker, and
 * llmAgent already owns the guards that stop this model inventing things. A
 * second LLM integration on the Python side would have duplicated all of it and
 * drifted from it.
 *
 * The model is given ONLY the transcript and, when known, the person's first
 * name. It is not told what the conversation meant, and it is never asked to
 * guess who someone was: an unrecognised face stays unrecognised in the summary.
 */

const { completeJSON, isConfigured } = require('./llmClient');

// `topics` is a short comma list rather than an array because llmClient's
// validate() handles strings and enums only, and a list of two or three things
// does not justify changing the validator.
const SCHEMA = {
  summary: { type: 'string', max: 400 },
  topics: { type: 'string', max: 120 },
};

const RULES = `You summarise one short conversation for LOCUS, an app that helps older adults remember their day.

Return ONLY a JSON object: {"summary": "...", "topics": "..."}

The summary:
- One or two short sentences, plain and warm, the way a thoughtful friend would recall it. Never clinical.
- Say who it was with and what was talked about. If something was agreed or arranged, say that too, because it is the part most worth remembering.
- Write about the wearer as "you".
- Normal capitalisation and punctuation. No dashes of any kind as punctuation; use a comma or a full stop.
- Do not guess anyone's gender: use their name or "they/them", never "he" or "she".
- You are an app, not a person: never offer to help and never ask them to reply.

topics: two or three words or short phrases, comma separated, naming what was discussed. Nothing else.

What you must not do:
- Never invent a name, a place, a time, a date or an arrangement that is not in the transcript.
- Never state who an unrecognised person was. If the notes say the person was not recognised, write "someone" and leave it there.
- A transcript is imperfect machine transcription of a noisy room. If it is too garbled to say anything honest about, set BOTH summary and topics to exactly "none".
- Never include anything about the transcription itself: no confidence, no "the audio said", no apologising for quality.`;

// The model guesses a gender from a name, as it does for notifications. Unlike
// a notification, a conversation can legitimately CONTAIN one: if the wearer
// said "he said he would come back", repeating it is faithful rather than a
// guess. So the check is against the transcript, not against the words alone.
const GENDERED = /\b(he|she|him|his|hers?|himself|herself)\b/gi;
// A summary that talks about the transcript rather than the conversation.
const META = /\b(transcript|transcription|audio|recording|inaudible|garbled|unclear|the text)\b/i;
const CHATTY = /\b(let me know|tell me|reply|write back)\b/i;
// "none", not "": validate() rejects an empty string, so instructing the model
// to answer "" for a garbled transcript meant doing as it was told FAILED
// validation and came back as a hard error instead of an honest "nothing here".
const NO_SUMMARY = /^\s*(none|n\/a|nothing)\.?\s*$/i;
// Capitalised words that are not somebody's name: sentence openers, days and
// months. "Every capitalised word is a name" flagged "You" and "Sunday" and
// threw away a perfectly good summary.
const NOT_A_NAME = new Set([
  'you', 'your', 'yours', 'they', 'their', 'there', 'this', 'that', 'these',
  'those', 'the', 'and', 'but', 'someone', 'somebody', 'nobody', 'today',
  'tomorrow', 'yesterday', 'morning', 'afternoon', 'evening', 'tonight',
  'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday',
  'january', 'february', 'march', 'april', 'may', 'june', 'july', 'august',
  'september', 'october', 'november', 'december',
]);
const undash = s => String(s)
  .replace(/\s*[—–]\s*(?=[A-Z])|\s+-\s+(?=[A-Z])/g, '. ')
  .replace(/\s*[—–]\s*|\s+-\s+/g, ', ');

/** Words too short or too repetitive to be a conversation at all. */
function tooThin(transcript) {
  const words = String(transcript || '').trim().split(/\s+/).filter(Boolean);
  if (words.length < 5) return true;
  // "yeah yeah yeah" and the like: machine transcription of a noisy room.
  const distinct = new Set(words.map(w => w.toLowerCase().replace(/[^a-z']/g, '')));
  return distinct.size < 4;
}

/**
 * Summarise one conversation.
 *
 * `personName` is the first name when the face was recognised, or null for a
 * face nobody has named yet. Returns {summary, topics, status} and never throws.
 * status is one of: done, skipped_thin, skipped_unconfigured, failed.
 */
async function summariseConversation(transcript, personName = null) {
  if (tooThin(transcript)) {
    return { summary: null, topics: null, status: 'skipped_thin' };
  }
  if (!isConfigured()) {
    return { summary: null, topics: null, status: 'skipped_unconfigured' };
  }

  const who = personName
    ? `The wearer was with ${personName}, whose face the app recognised.`
    : 'The app did NOT recognise this person. You must not name them or guess who they were.';

  const prompt = `${who}

Transcript of what was heard (imperfect machine transcription, write only from this):
${String(transcript).trim()}`;

  let out;
  try {
    out = await completeJSON(RULES, prompt, SCHEMA, { temperature: 0.3 });
  } catch (e) {
    return { summary: null, topics: null, status: 'failed', reason: `llm threw: ${e.message}` };
  }
  if (!out) {
    return { summary: null, topics: null, status: 'failed',
      reason: 'no provider returned valid JSON' };
  }

  let summary = undash(out.summary).trim();
  const topics = undash(out.topics).trim();

  // The model answering "too garbled" is a valid outcome, not a failure.
  if (!summary || NO_SUMMARY.test(summary)) {
    return { summary: null, topics: null, status: 'skipped_thin' };
  }

  // Guards the prompt cannot enforce. Each gives a reason, because a bare
  // 'failed' says nothing about which guard fired, as I found out testing this.
  const spoken = String(transcript).toLowerCase();
  const invented = (summary.match(GENDERED) || [])
    .filter(w => !new RegExp('\\b' + w.toLowerCase() + '\\b').test(spoken));
  if (invented.length) {
    return { summary: null, topics: null, status: 'failed',
      reason: `gendered pronoun not in the transcript: ${invented.join(', ')}` };
  }
  if (CHATTY.test(summary)) {
    return { summary: null, topics: null, status: 'failed', reason: 'offered to help' };
  }
  if (META.test(summary)) {
    return { summary: null, topics: null, status: 'failed', reason: 'described the transcript' };
  }
  // A name in the summary that the app never recognised is the worst failure
  // available here: it tells someone with dementia that a stranger was a friend.
  if (!personName) {
    const candidates = (summary.match(/\b[A-Z][a-z]{2,}\b/g) || [])
      .filter(w => !NOT_A_NAME.has(w.toLowerCase()));
    const capitalised = candidates;
    const inTranscript = candidates.every(w =>
      new RegExp('\\b' + w + '\\b', 'i').test(String(transcript)));
    if (!inTranscript) {
      return { summary: null, topics: null, status: 'failed',
        reason: `named someone the app did not recognise: ${capitalised.join(', ')}` };
    }
  }

  summary = summary.charAt(0).toUpperCase() + summary.slice(1);
  return { summary, topics: topics || null, status: 'done' };
}

module.exports = { summariseConversation, tooThin, SCHEMA };
