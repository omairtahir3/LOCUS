/**
 * Small helpers for writing notifications a person would actually want to
 * read. Every monitor template and every LLM prompt goes through these, so the
 * facts arrive already in human form -- "16 August", "2:02 PM", "your car keys
 * were" -- and neither the template nor the model has to invent formatting.
 */

const MONTHS = ['January','February','March','April','May','June','July','August','September','October','November','December'];

/** "16 August" (adds the year only if it differs from now). */
function dateWords(d) {
  const x = new Date(d);
  const s = `${x.getDate()} ${MONTHS[x.getMonth()]}`;
  return x.getFullYear() === new Date().getFullYear() ? s : `${s} ${x.getFullYear()}`;
}

/** "2:02 PM" */
function timeWords(d) {
  return new Date(d).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
}

/** "8 AM" for a bare hour. */
function hourWords(h) {
  const d = new Date(); d.setHours(h, 0, 0, 0);
  return d.toLocaleTimeString([], { hour: 'numeric' });
}

/** "3 hours", "1 hour", "45 minutes" */
function durationWords(seconds) {
  const m = Math.round(seconds / 60);
  if (m < 60) return `${m} minute${m === 1 ? '' : 's'}`;
  const h = Math.round(m / 60);
  return `${h} hour${h === 1 ? '' : 's'}`;
}

/** "about 200 m" / "about 1.2 km" */
function distanceWords(metres) {
  return metres < 950 ? `about ${Math.round(metres / 10) * 10} m` : `about ${(metres / 1000).toFixed(1)} km`;
}

/**
 * Item names are entered by the user in any form ("Car Keys", "phone",
 * "Omair's Water Bottle"). Returns the name in lower case with the right verb:
 *   item("Car Keys")  -> { name: "car keys",  were: "were", they: "they", it: "them" }
 *   item("Phone")     -> { name: "phone",     were: "was",  they: "it",   it: "it" }
 * Possessives are left alone ("Omair's water bottle").
 */
function item(rawName) {
  const name = String(rawName || 'item').replace(/\b([A-Z][a-z]+)\b/g, w => w.toLowerCase());
  const plural = /(keys|glasses|scissors|headphones|earbuds|gloves|shoes|slippers)$/i.test(name.trim());
  return {
    name,
    were: plural ? 'were' : 'was',
    they: plural ? 'they' : 'it',
    it: plural ? 'them' : 'it',
    have: plural ? 'have' : 'has',
  };
}

/** First name only, for the warmer phrasings. */
function firstName(fullName) {
  return String(fullName || '').trim().split(/\s+/)[0] || 'they';
}

module.exports = { dateWords, timeWords, hourWords, durationWords, distanceWords, item, firstName };
