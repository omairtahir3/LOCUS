/**
 * DEPRECATED — replaced by llmAgent.js (transport in llmClient.js).
 *
 * The direct Gemini integration that lived here failed structurally: Gemini's
 * free tier is 10 requests/minute, dose reminders cluster inside the same
 * minute, and three 429s tripped a 12-hour circuit breaker, so every
 * notification fell back to the hardcoded vault for the rest of the day.
 * llmClient.js throttles before sending, backs off on 429 instead of tripping,
 * and fails over between OpenAI-compatible providers.
 *
 * Kept as a re-export so nothing that still imports this path breaks.
 */
module.exports = require('./llmAgent');
