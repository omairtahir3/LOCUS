/**
 * LOCUS memory-search agent: answers a question in the wearer's own words
 * ("where did I last put my keys?", "when did I last talk to Omair?").
 *
 * The split that matters: the MODEL understands the question and phrases the
 * answer. MONGODB finds the facts. The model is never given the database and
 * never decides what happened, which is what keeps an invented location out of
 * an answer a person with dementia is going to act on.
 *
 * Two LLM calls per question, both through llmClient so they inherit the Groq
 * primary, the OpenRouter fallback and the circuit breaker:
 *   1. parse()  question + this user's OWN item and people names -> an intent
 *   2. phrase() the retrieved rows -> one or two plain sentences
 * Either call returning null is survivable: parse falls back to a title
 * substring match (what the page did before), phrase falls back to a template.
 *
 * NO PLACE NAMES. 0 of 98 object events in this database carry a room, scene
 * or scene_type, and location is set on 4. The honest answer to "where" is the
 * time plus the photograph of the spot, so PLACE_WORDS below rejects any answer
 * that names a room: without that guard the model writes "on the kitchen
 * counter" from nothing but the item's name.
 */

const mongoose = require('mongoose');
const EventLog = require('../models/EventLog');
const { completeJSON, isConfigured } = require('./llmClient');
const { timeWords, dateWords, firstName } = require('./friendly');
// The same guard the medication notifier uses. A dose the camera could not
// see is not a dose that was skipped, and the model writes "missed" anyway.
const { NOT_MISSED } = require('./llmAgent');

const INTENTS = [
  'item_last_location',
  'item_history',
  'person_last_interaction',
  'medication_check',
  'activity_recall',
  'unknown',
];

// validate() in llmClient supports 'string' and 'enum' only, and rejects an
// empty string. So every field is required and "none" is the sentinel for
// "not applicable" rather than modelling optional fields, which would need a
// validator change for no gain.
// ponytail: no JSON-schema library (ajv/zod). The existing validate() already
// enforces these four fields; a schema package would duplicate it.
const PARSE_SCHEMA = {
  intent: { type: 'enum', values: INTENTS },
  item: { type: 'string', max: 80 },
  person: { type: 'string', max: 80 },
  // An enum, not a date. Asked for ISO dates the model invents them, and a
  // wrong range silently returns the wrong memory. Five buckets cover every
  // phrasing seen and are resolved to real timestamps in resolveRange().
  range: { type: 'enum', values: ['today', 'yesterday', 'last_7_days', 'last_30_days', 'all'] },
};

const ANSWER_SCHEMA = { answer: { type: 'string', max: 400 } };

// Rooms and surfaces the model must not name, because nothing in the data says
// which one it was. Checked against the finished answer, not just forbidden in
// the prompt, because the 20b model names a room anyway when the question asks
// "where".
// Denials. The model must not claim there is nothing on a question that
// returned rows; phrase() checks this against the row count, not the prompt.
const NO_RECORD = /\b(no record|no information|nothing (?:was )?found|don't have|do not have|not have any|no data)\b/i;

const PLACE_WORDS = /\b(kitchen|bedroom|bathroom|living room|lounge|hallway|hall|garage|office|desk|table|counter|countertop|nightstand|drawer|shelf|sofa|couch|bed|sink|wardrobe|cupboard|upstairs|downstairs)\b/i;

const PARSE_RULES = `You turn a question about someone's own day into a lookup request for the LOCUS memory app.

Return ONLY a JSON object with exactly these four fields:
{"intent": "...", "item": "...", "person": "...", "range": "..."}

intent is one of:
- item_last_location: where a belonging is now, or where it was put down last. "Where are my keys?", "Where did I leave my phone?"
- item_history: everywhere a belonging has been over a period. "Where has my phone been today?"
- person_last_interaction: when they last saw or spoke to someone. "When did I last see Omair?"
- medication_check: whether they took medicine. "Did I take my tablets?"
- activity_recall: what they were doing. "What did I do this morning?"
- unknown: anything else, or anything you are unsure about.

item must be copied EXACTLY from the belongings list you are given, or "none".
person must be copied EXACTLY from the people list you are given, or "none".
Never put a name in these fields that is not on the lists. If the question is about something
not on the list, use "none" and intent "unknown".

range is one of today, yesterday, last_7_days, last_30_days, all.
"last", "latest", "now" and questions with no time at all mean "all", because the most recent
record is wanted whenever it happened. Only use today/yesterday when the question says so.

Use "none" for fields the intent does not need. Return nothing but the JSON.`;

const ANSWER_RULES = `You answer one question about someone's own day in the LOCUS memory app, for the person themselves.

Return ONLY a JSON object: {"answer": "..."}

How to write:
- One or two short sentences, plain and warm, the way a thoughtful friend would say it. Never clinical.
- Normal capitalisation and punctuation. Address the reader as the instruction above says.
- No dashes of any kind as punctuation. Use a comma or a full stop.
- Belonging names in lower case ("your car keys").
- Do not guess anyone's gender: use their name or "they/them", never "he" or "she".
- You are an app, not a person: never offer to help, never ask them to reply.

What you must not do:
- Never state WHERE something is. You are not told the room, the surface or the furniture, so naming
  one would be a guess. Give the TIME it was put down and nothing more about the place. A photograph
  is shown next to your answer, so say they can see the spot in the photo.
- Never change or invent a time, a date or a count. Use only the notes given, in the words given.
- Never mention a belonging, a person, a room or an event that is not in the notes.
- If the notes say nothing was found, say plainly that there is no record of it. Never fill the gap.
- "the camera was off" means the app could not SEE the dose. It does NOT mean the dose was missed.
  Never write "missed", "skipped" or "forgot" unless the notes say so in those words.
- When a dose was taken, give the time it was TAKEN, which the notes state, not the time it was due.`;

const idForms = userId => {
  const forms = [userId, String(userId)];
  if (mongoose.Types.ObjectId.isValid(userId)) forms.push(new mongoose.Types.ObjectId(String(userId)));
  return forms;
};

/** Phase 1: what this user can be asked ABOUT. A closed list, so the parser
 *  links a name to a real record instead of extracting free text. */
async function vocabulary(userId) {
  const ids = idForms(userId);
  const db = mongoose.connection.db;
  const [items, people] = await Promise.all([
    db.collection('useritems').find({ user_id: { $in: ids }, is_active: { $ne: false } }).toArray(),
    db.collection('relationships').find({ user_id: { $in: ids } }).toArray(),
  ]);
  return {
    items: items.map(i => ({ id: String(i._id), name: i.item_name })).filter(i => i.name),
    people: people.map(p => ({ id: String(p._id), name: p.person_name, rel: p.relationship_type }))
      .filter(p => p.name),
  };
}

function resolveRange(range) {
  const now = new Date();
  const start = d => { const x = new Date(d); x.setHours(0, 0, 0, 0); return x; };
  switch (range) {
    case 'today': return { from: start(now), to: now };
    case 'yesterday': {
      const y = start(new Date(now.getTime() - 864e5));
      return { from: y, to: new Date(y.getTime() + 864e5) };
    }
    case 'last_7_days': return { from: start(new Date(now.getTime() - 6 * 864e5)), to: now };
    case 'last_30_days': return { from: start(new Date(now.getTime() - 29 * 864e5)), to: now };
    default: return null; // 'all' puts no bound on the query
  }
}

/** Phase 2: question -> intent. Returns null when no LLM is reachable. */
async function parse(question, vocab) {
  if (!isConfigured()) return null;
  const itemList = vocab.items.length ? vocab.items.map(i => i.name).join(', ') : '(none enrolled)';
  const peopleList = vocab.people.length
    ? vocab.people.map(p => `${p.name}${p.rel ? ` (${p.rel})` : ''}`).join(', ')
    : '(none enrolled)';
  const prompt = `Belongings this person has enrolled: ${itemList}
People this person has enrolled: ${peopleList}

Question: ${question}`;
  // temperature 0: the same question must always resolve to the same intent.
  // reasoning_effort is NOT passed here, it belongs to the provider config in
  // llmClient; complete() only reads maxTokens and temperature from opts.
  return completeJSON(PARSE_RULES, prompt, PARSE_SCHEMA, { temperature: 0 });
}

/** The parse that does not need a model. Two of seven live questions came
 *  back failing schema validation on both providers, and going dark on the
 *  headline feature is worse than a keyword match: the belongings and people
 *  are a short closed list, so finding one in the sentence is reliable.
 *  ponytail: no NLP or intent-classification package. The whole vocabulary is
 *  a handful of names and the intents are distinguished by one verb each.
 */
function localParse(question, vocab) {
  const q = String(question).toLowerCase();
  const hit = list => list.find(e => q.includes(e.name.toLowerCase()))
    || list.find(e => e.name.toLowerCase().split(/\s+/).some(w => w.length > 2 && q.includes(w)));
  const item = hit(vocab.items);
  const person = hit(vocab.people);
  let intent = 'unknown';
  if (/\b(tablet|tablets|pill|pills|medicine|medication|dose|doses)\b/.test(q)) intent = 'medication_check';
  else if (person && /\b(see|saw|seen|talk|talked|spoke|speak|conversation|met|meet)\b/.test(q)) intent = 'person_last_interaction';
  else if (item && /\b(been|everywhere|history|all day)\b/.test(q)) intent = 'item_history';
  else if (item) intent = 'item_last_location';
  else if (/\bdo(ing)?\b|\bwhat did i\b/.test(q)) intent = 'activity_recall';
  return {
    intent,
    item: item ? item.name : 'none',
    person: person ? person.name : 'none',
    range: /\btoday\b/.test(q) ? 'today' : /\byesterday\b/.test(q) ? 'yesterday' : 'all',
  };
}

/** Phase 3: an intent the model produced is still untrusted input. A name that
 *  is not on the vocabulary list resolves to null and the caller asks rather
 *  than guessing which belonging was meant. */
function resolve(parsed, vocab) {
  const pick = (list, raw) => {
    if (!raw || raw.toLowerCase() === 'none') return null;
    const want = raw.trim().toLowerCase();
    return list.find(e => e.name.toLowerCase() === want)
      || list.find(e => e.name.toLowerCase().includes(want) || want.includes(e.name.toLowerCase()))
      || null;
  };
  return {
    intent: INTENTS.includes(parsed.intent) ? parsed.intent : 'unknown',
    item: pick(vocab.items, parsed.item),
    person: pick(vocab.people, parsed.person),
    window: resolveRange(parsed.range),
  };
}

const timeFilter = w => (w ? { timestamp: { $gte: w.from, $lte: w.to } } : {});

/** Phase 3 (cont): one deterministic query per intent. Every one is bounded by
 *  user_id and event_type, which the {user_id, event_type, timestamp} index
 *  covers, and sorted newest first. */
async function execute(r, userId) {
  const ids = idForms(userId);
  const base = { user_id: { $in: ids }, ...timeFilter(r.window) };

  if (r.intent === 'item_last_location' || r.intent === 'item_history') {
    if (!r.item) return { rows: [], need: 'item' };
    // $elemMatch, not two dotted paths: without it a frame holding the keys in
    // hand AND something else put down would match as "keys were put down".
    //
    // $nin rather than placement:'placed', for the reason /memory-search gives
    // at length: most historical sightings predate the placement field, and
    // requiring it erases them. All 7 of this user's Car Keys sightings have no
    // placement at all, so "where did I last put my keys" answered "no record"
    // while holding seven keyframes of the keys. $nin also matches documents
    // where the field is absent, which is what makes those rows reachable.
    const q = {
      ...base,
      event_type: 'object',
      verification_status: { $ne: 'rejected' },
      'details.items': {
        $elemMatch: {
          enrolled_item_id: { $in: [r.item.id, String(r.item.id)] },
          placement: { $nin: ['in_hand', 'unknown'] },
        },
      },
    };
    const rows = await EventLog.find(q).sort({ timestamp: -1 })
      .limit(r.intent === 'item_last_location' ? 1 : 10).lean();
    return { rows: rows.map(e => ({ at: e.timestamp, keyframe_id: e.keyframe_id, item: r.item.name })) };
  }

  if (r.intent === 'person_last_interaction') {
    if (!r.person) return { rows: [], need: 'person' };
    const rows = await EventLog.find({
      ...base,
      event_type: 'social_interaction',
      person_id: { $in: [r.person.id, String(r.person.id), ...(mongoose.Types.ObjectId.isValid(r.person.id) ? [new mongoose.Types.ObjectId(r.person.id)] : [])] },
    }).sort({ timestamp: -1 }).limit(1).lean();
    return { rows: rows.map(e => ({ at: e.timestamp, keyframe_id: e.keyframe_id, person: r.person.name })) };
  }

  if (r.intent === 'medication_check') {
    const db = mongoose.connection.db;
    const w = r.window || resolveRange('today');
    const logs = await db.collection('medication_logs')
      .find({ user_id: { $in: ids }, scheduled_time: { $gte: w.from, $lte: w.to } })
      .sort({ scheduled_time: -1 }).limit(10).toArray();
    const meds = await db.collection('medications').find({ user_id: { $in: ids } }).toArray();
    const nameOf = id => (meds.find(m => String(m._id) === String(id)) || {}).name || 'your medicine';
    // `at` is when it actually happened, not when it was due: a dose scheduled
    // for 1:30 and taken at 1:36 was reported back as 1:30. keyframe_id is on
    // the log and was being dropped, so the answer had no picture to show even
    // though the intake was verified visually at 0.97 confidence.
    return {
      rows: logs.map(l => ({
        at: l.taken_at || l.scheduled_time,
        scheduled_at: l.scheduled_time,
        taken_at: l.taken_at || null,
        status: l.status,
        medicine: nameOf(l.medication_id),
        keyframe_id: l.keyframe_id || null,
      })),
    };
  }

  if (r.intent === 'activity_recall') {
    // scene_change, camera_heartbeat and coverage are capture bookkeeping, not
    // things the person did, and they outnumber real activities 860 to 10.
    // Reporting them back would answer "what did I do" with "a scene changed".
    const rows = await EventLog.find({
      ...base,
      event_type: 'activity',
      'details.action': { $nin: ['scene_change', 'camera_heartbeat', 'coverage', 'scene_session', 'activity_session', null] },
    }).sort({ timestamp: -1 }).limit(10).lean();
    return { rows: rows.map(e => ({ at: e.timestamp, keyframe_id: e.keyframe_id, action: e.details && e.details.action })) };
  }

  return { rows: [], need: 'intent' };
}

/** The answer that ships when the model is unreachable or writes something
 *  that fails a guard. Stating the time and pointing at the photo is the whole
 *  useful content, so this is a real answer and not a degraded one. */
function template(r, rows, need, subject) {
  if (need === 'item') return "I'm not sure which belonging you mean. You can ask about the things you have enrolled.";
  if (need === 'person') return "I'm not sure who you mean. You can ask about the people you have enrolled.";
  if (need === 'intent') return "I can't answer that one yet. Try asking where you left something, or when you last saw someone.";
  if (!rows.length) return "I don't have a record of that.";
  const when = d => `${dateWords(d)} at ${timeWords(d)}`;
  // Addressed to whoever is reading. A caregiver asking about a patient was
  // told "You put your keys down", which they did not do.
  const they = subject || 'You';
  const their = subject ? 'their' : 'your';
  if (r.intent === 'item_last_location') {
    return `${they} put ${their} ${rows[0].item.toLowerCase()} down on ${when(rows[0].at)}. The photo shows the spot.`;
  }
  if (r.intent === 'item_history') {
    // Phrased to avoid subject-verb agreement: "your car keys was put down" is
    // what the obvious wording produces, and half of these names are plural.
    return `I have ${rows.length} record${rows.length === 1 ? '' : 's'} of ${their} ${rows[0].item.toLowerCase()} being put down, most recently on ${when(rows[0].at)}.`;
  }
  if (r.intent === 'person_last_interaction') return `${they} last saw ${rows[0].person} on ${when(rows[0].at)}.`;
  if (r.intent === 'medication_check') {
    const taken = rows.filter(x => x.status === 'taken').length;
    // "so far today": the window ends at now, so a dose due this evening is
    // deliberately NOT counted as outstanding.
    // One dose needs no ratio: "0 of your 1 dose so far today are recorded as
    // taken" is both awkward and ungrammatical. Say what happened instead.
    if (rows.length === 1) {
      const x = rows[0];
      if (x.status === 'taken') return `You took ${x.medicine} at ${timeWords(x.taken_at || x.at)}.`;
      if (x.status === 'camera_off') {
        return `Your ${x.medicine} dose at ${timeWords(x.scheduled_at)} was not seen by the camera, so there is no record either way.`;
      }
      if (x.status === 'scheduled') return `Your ${x.medicine} dose at ${timeWords(x.scheduled_at)} is not recorded as taken yet.`;
      return `Your ${x.medicine} dose at ${timeWords(x.scheduled_at)} is recorded as ${x.status}.`;
    }
    const head = `${taken} of your ${rows.length} dose${rows.length === 1 ? '' : 's'} so far today ${taken === 1 ? 'is' : 'are'} recorded as taken.`;
    // The time it was TAKEN, which is what someone asking actually wants, and
    // which is minutes off the time it was due.
    const one = rows.find(x => x.status === 'taken' && x.taken_at);
    return one ? `${head} You took ${one.medicine} at ${timeWords(one.taken_at)}.` : head;
  }
  return `I found ${rows.length} thing${rows.length === 1 ? '' : 's'} in that period, most recently on ${when(rows[0].at)}.`;
}

/** Phase 4: the model phrases the rows. The notes are deliberately pre-worded
 *  (times already in words, no ISO dates, no ids) so there is nothing in them
 *  the model could copy out that a person should not read. */
async function phrase(question, r, rows, need, subject) {
  const fallback = template(r, rows, need, subject);
  if (!isConfigured() || need) return fallback;

  const when = d => `${dateWords(d)} at ${timeWords(d)}`;
  let notes;
  if (!rows.length) {
    notes = 'Nothing was found for this question.';
  } else if (r.intent === 'medication_check') {
    // The count goes FIRST. Given only a list, the model read "one taken,
    // three scheduled" and wrote "you took your tablets today", asserting
    // three doses that were never recorded.
    const takenNotes = rows.filter(x => x.status === 'taken').length;
    notes = `${takenNotes} of ${rows.length} doses due so far today are recorded as taken, and ${rows.length - takenNotes} are not. `
      + rows.map(x => {
        // Only the time it was TAKEN. Carrying the due time as well let the
        // model offer 1:30 for a dose taken at 1:36 and still pass the
        // invented-time check, because both numbers were in the notes.
        if (x.status === 'taken') return `${x.medicine} taken at ${timeWords(x.taken_at || x.at)}`;
        // No 'not missed' wording here: NOT_MISSED would then match the notes
        // and disarm the guard below. That rule lives in ANSWER_RULES instead.
        if (x.status === 'camera_off') {
          return `${x.medicine}, due ${when(x.scheduled_at)}, the camera was off and could not see it`;
        }
        if (x.status === 'scheduled') return `${x.medicine}, due ${when(x.scheduled_at)}, not yet recorded`;
        return `${x.medicine}, due ${when(x.scheduled_at)}, recorded as ${x.status}`;
      }).join('. ');
  } else if (r.intent === 'person_last_interaction') {
    notes = `Last seen with ${rows[0].person} on ${when(rows[0].at)}.`;
  } else if (r.intent === 'activity_recall') {
    notes = rows.map(x => `${x.action} on ${when(x.at)}`).join('. ');
  } else {
    notes = rows.map(x => `${x.item} put down on ${when(x.at)}`).join('. ')
      + '. A photograph of each spot is shown beside your answer. The room is NOT known.';
  }

  // A caregiver asking about someone else was told "You put the keys down",
  // which is both wrong and confusing: they did not put them anywhere. The
  // subject's own name is the only safe way to say it, since guessing a
  // gender is forbidden and "they" reads oddly when a name is available.
  const who = subject
    ? `Write to the person asking ABOUT ${subject}. Call them ${subject}, never "you", and never guess their gender.`
    : 'Write to the person it happened to. Address them as "you".';
  const out = await completeJSON(ANSWER_RULES,
    `${who}

Question: ${question}

Notes (facts already established, write from these only):
${notes}`,
    ANSWER_SCHEMA, { temperature: 0.3 });
  if (!out) return fallback;

  // The guards the prompt cannot enforce on its own.
  if (PLACE_WORDS.test(out.answer)) {
    console.warn('[memoryAgent] model named a place that is not in the data, using template');
    return fallback;
  }
  if (/\b(he|she|him|his|hers?|himself|herself)\b/i.test(out.answer)) return fallback;
  // Writing ABOUT someone but addressing the reader as the one it happened to
  // is the same error in reverse, and it reads as if the caregiver did it.
  if (subject && /\byou(r|rs)?\b/i.test(out.answer)) {
    console.warn('[memoryAgent] model wrote "you" about a third party, using template');
    return fallback;
  }
  // A medicine answer that does not carry the count cannot be trusted to have
  // kept it: "you took your tablets today" came back from a day with one dose
  // taken and three not. Same shape as the mustSay guard in llmAgent.
  if (r.intent === 'medication_check' && rows.length) {
    const takenN = rows.filter(x => x.status === 'taken').length;
    // A single-quoted string, NOT a template literal: in a template literal
    // `\b` is the backspace escape, so this built a regex around U+0008 and
    // rejected every answer instead of checking for the number.
    // A regex literal, not a constructed one: both `\b` in a template literal
    // and '\b' in a quoted string are the BACKSPACE escape, so the built
    // regex matched U+0008 and rejected every answer, correct ones included.
    const numbers = out.answer.match(/\d+/g) || [];
    // Only on a day with more than one dose. With a single dose there is no
    // ratio to collapse, and demanding the number rejected the clearer answer.
    if (rows.length > 1 && takenN < rows.length && !numbers.includes(String(takenN))) {
      console.warn('[memoryAgent] medicine answer dropped the count on a partial day, using template');
      return fallback;
    }
  }
  // The mirror of the no-rows rule. Asked where the phone had been today the
  // model answered "there is no record" while holding ten put-downs, which
  // would have the person stop looking for something the app had found.
  if (rows.length && NO_RECORD.test(out.answer)) {
    console.warn('[memoryAgent] model denied records it was given, using template');
    return fallback;
  }
  // A dose the camera could not see is not a dose that was skipped.
  // Checked against the row statuses, not the notes text: the notes used to
  // explain that camera_off is not a miss, which made NOT_MISSED match them
  // and let the guard pass anything. Only these two statuses mean it.
  const reallyMissed = rows.some(x => x.status === 'missed' || x.status === 'skipped');
  if (r.intent === 'medication_check' && NOT_MISSED.test(out.answer) && !reallyMissed) {
    console.warn('[memoryAgent] model called a dose missed when the notes did not, using template');
    return fallback;
  }
  // A time the notes never mentioned is an invented one.
  for (const t of out.answer.match(/\b\d{1,2}:\d{2}\b/g) || []) {
    if (!notes.includes(t)) {
      console.warn(`[memoryAgent] model invented the time ${t}, using template`);
      return fallback;
    }
  }
  // The model lower-cases the first word now and then whatever the prompt
  // says ("you took your tablets today"). Cheaper to fix than to re-ask.
  return out.answer.charAt(0).toUpperCase() + out.answer.slice(1);
}

/**
 * Answer one question. Never throws and always returns an answer string.
 * `parsed: null` tells the caller the LLM was unreachable, so the page can
 * fall back to the substring filter it used before.
 */
async function ask(question, userId, { subjectName = null } = {}) {
  const q = String(question || '').trim();
  if (!q) return { answer: 'Ask me about something you have put down, or someone you have seen.', intent: 'unknown', rows: [], parsed: null };

  const vocab = await vocabulary(userId);
  // The model first, keywords when its JSON does not validate. Both produce the
  // same shape, so resolve() still rejects anything not on the vocabulary list.
  const fromModel = await parse(q, vocab);
  const parsed = fromModel || localParse(q, vocab);
  const r = resolve(parsed, vocab);
  const { rows, need } = await execute(r, userId);
  // Only a first name reaches the model: it is what a person is called, and a
  // full name in a one-line answer reads like a medical record.
  const subject = subjectName ? firstName(subjectName) : null;
  const answer = await phrase(q, r, rows, need, subject);
  return {
    answer,
    intent: r.intent,
    item: r.item ? r.item.name : null,
    person: r.person ? r.person.name : null,
    rows,
    // The newest row is not always the one with a picture: today's latest dose
    // was a camera_off with no frame, while the one actually taken had one.
    keyframe_id: (rows.find(x => x.keyframe_id) || {}).keyframe_id || null,
    // The page shows the same answer either way; this is for diagnosing a bad
    // answer later, and for the eval suite to report model vs keyword coverage.
    parsed_by: fromModel ? 'llm' : 'keywords',
    parsed,
  };
}

module.exports = { ask, vocabulary, parse, localParse, resolve, execute, phrase, template, resolveRange, INTENTS, PLACE_WORDS };
