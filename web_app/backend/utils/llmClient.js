/**
 * LLM transport for LOCUS notifications and routine phrasing.
 *
 * Replaces the direct Gemini call. That one failed for a reason that had
 * nothing to do with the model: Gemini's free tier is 10 requests/minute, the
 * medication scheduler fires several reminders inside the same minute at
 * common dose times, three 429s in a row tripped a circuit breaker for TWELVE
 * HOURS, and every notification for the rest of the day silently fell back to
 * the hardcoded vault. It then re-tripped the next morning. So "Gemini had no
 * part in generating notifications" -- the breaker guaranteed it.
 *
 * This client is built so that cannot recur, on any provider:
 *
 *   1. TOKEN BUCKET. Calls are throttled to the provider's RPM before they are
 *      sent, so a 429 is the exception rather than the steady state.
 *   2. BACKOFF, NOT A BREAKER, ON 429. A rate limit means "wait a minute", so
 *      the call waits (Retry-After if given, else exponential) and retries.
 *   3. A SHORT BREAKER ONLY ON REAL OUTAGES. 5xx / network / timeout count
 *      toward a breaker that trips for 5 minutes, not 12 hours.
 *   4. PROVIDER FALLBACK. Primary and fallback are both OpenAI-compatible, so
 *      switching is an env var, and if the primary is out the fallback is tried
 *      on the same call.
 *   5. STRUCTURED OUTPUT, VALIDATED. Every response is parsed as JSON and
 *      checked against the caller's schema before it is trusted. A model that
 *      can only fill in {title, message} for a finding the monitor already
 *      produced cannot invent a finding.
 *
 * Providers (all OpenAI-compatible chat/completions). Free-tier status checked
 * September 2026 -- it changed in August and will change again:
 *   groq       FREE, no card. 30 RPM, 6K TPM, 14.4K req/day. Llama 3.x left
 *              the free tier on 16 Aug 2026 (enterprise-only now); the free
 *              tier runs OpenAI gpt-oss and Qwen. Default is gpt-oss-20b:
 *              production-grade, ~1000 tok/s, JSON mode. Groq's Qwen
 *              (qwen/qwen3.8-27b) is PREVIEW, "evaluation only", so it is not
 *              the default despite being the better model.
 *              https://console.groq.com/docs/models
 *   openrouter FREE, no card. The free router picks an available free model.
 *              https://openrouter.ai/docs/guides/routing/routers/free-router
 *   cerebras   NO LONGER card-free. Since Aug 2026 new accounts get $5 of
 *              credit after adding a payment method, expiring in 30 days.
 *              Kept as an option, not a default.
 *              https://inference-docs.cerebras.ai/support/rate-limits
 *
 * Env:
 *   LLM_PROVIDER, LLM_API_KEY, LLM_MODEL              primary
 *   LLM_FALLBACK_PROVIDER, LLM_FALLBACK_API_KEY, LLM_FALLBACK_MODEL
 * Unset LLM_PROVIDER (or 'none') disables the LLM entirely; every caller then
 * uses its template fallback, exactly as before, with no latency.
 */

const axios = require('axios');

// The one place HTTP happens. Injectable so tests can script 429s, 5xx and
// malformed bodies without touching the network.
let transport = (url, body, config) => axios.post(url, body, config);
const _setTransportForTests = fn => { transport = fn || ((u, b, c) => axios.post(u, b, c)); };

const PROVIDERS = {
  groq: {
    url: 'https://api.groq.com/openai/v1/chat/completions',
    defaultModel: 'openai/gpt-oss-20b',   // on the free tier; llama-3.3-70b-versatile is enterprise-only since Aug 2026
    rpm: 30,
    jsonMode: true,
  },
  openrouter: {
    url: 'https://openrouter.ai/api/v1/chat/completions',
    defaultModel: 'openrouter/free',
    rpm: 20,
    jsonMode: false,      // not guaranteed across upstreams; we parse defensively anyway
  },
  cerebras: {
    url: 'https://api.cerebras.ai/v1/chat/completions',
    defaultModel: 'llama3.1-8b',
    rpm: 30,
    jsonMode: true,
  },
};

const REQUEST_TIMEOUT_MS = 10000;
const MAX_RETRIES_ON_429 = 3;
const BREAKER_FAILURES = 5;
const BREAKER_OPEN_MS = 5 * 60 * 1000;
// Keep a margin under the published RPM so bursts from other processes (the
// nightly pre-generation, a manual test) do not push us over.
const RPM_SAFETY = 0.8;

// ── Token bucket ────────────────────────────────────────────────────────────
class TokenBucket {
  constructor(rpm) {
    this.capacity = Math.max(1, Math.floor(rpm * RPM_SAFETY));
    this.tokens = this.capacity;
    this.refillPerMs = this.capacity / 60000;
    this.last = Date.now();
    this.queue = [];
  }
  _refill() {
    const now = Date.now();
    this.tokens = Math.min(this.capacity, this.tokens + (now - this.last) * this.refillPerMs);
    this.last = now;
  }
  /** Resolves when a token is available. Callers are served in order. */
  take() {
    return new Promise(resolve => {
      this.queue.push(resolve);
      this._drain();
    });
  }
  _drain() {
    this._refill();
    while (this.queue.length && this.tokens >= 1) {
      this.tokens -= 1;
      this.queue.shift()();
    }
    if (this.queue.length) {
      const waitMs = Math.ceil((1 - this.tokens) / this.refillPerMs);
      setTimeout(() => this._drain(), Math.max(50, waitMs));
    }
  }
}

// ── Per-provider state ──────────────────────────────────────────────────────
class ProviderClient {
  constructor(name, apiKey, model) {
    const cfg = PROVIDERS[name];
    if (!cfg) throw new Error(`unknown LLM provider "${name}"`);
    this.name = name;
    this.cfg = cfg;
    this.apiKey = apiKey;
    this.model = model || cfg.defaultModel;
    this.bucket = new TokenBucket(cfg.rpm);
    this.consecutiveFailures = 0;
    this.breakerOpenUntil = 0;
    this.stats = { calls: 0, ok: 0, rate_limited: 0, failed: 0, breaker_trips: 0 };
  }

  get available() {
    return !!this.apiKey && Date.now() >= this.breakerOpenUntil;
  }

  async complete(systemInstruction, prompt, { maxTokens = 250, temperature = 0.5 } = {}) {
    if (!this.available) return { ok: false, reason: 'unavailable' };
    this.stats.calls++;

    const body = {
      model: this.model,
      messages: [
        { role: 'system', content: systemInstruction },
        { role: 'user', content: prompt },
      ],
      max_tokens: maxTokens,
      temperature,
    };
    if (this.cfg.jsonMode) body.response_format = { type: 'json_object' };

    for (let attempt = 0; attempt <= MAX_RETRIES_ON_429; attempt++) {
      await this.bucket.take();
      try {
        const res = await transport(this.cfg.url, body, {
          timeout: REQUEST_TIMEOUT_MS,
          headers: { Authorization: `Bearer ${this.apiKey}`, 'Content-Type': 'application/json' },
        });
        const text = res.data?.choices?.[0]?.message?.content;
        this.consecutiveFailures = 0;
        this.stats.ok++;
        return { ok: true, text };
      } catch (err) {
        const status = err.response?.status;
        if (status === 429) {
          this.stats.rate_limited++;
          if (attempt === MAX_RETRIES_ON_429) return { ok: false, reason: 'rate_limited' };
          const retryAfter = Number(err.response?.headers?.['retry-after']);
          const waitMs = Number.isFinite(retryAfter) && retryAfter > 0
            ? retryAfter * 1000
            : Math.min(60000, 2000 * 2 ** attempt);
          console.warn(`[LLM:${this.name}] 429, retrying in ${Math.round(waitMs / 1000)}s (attempt ${attempt + 1}/${MAX_RETRIES_ON_429})`);
          await new Promise(r => setTimeout(r, waitMs));
          continue;
        }
        // 4xx other than 429 is our bug (bad key, bad model): do not hammer, do not trip.
        if (status && status < 500) {
          this.stats.failed++;
          console.error(`[LLM:${this.name}] ${status}: ${err.response?.data?.error?.message || err.message}`);
          return { ok: false, reason: `http_${status}` };
        }
        // 5xx / network / timeout: genuine outage signal.
        this.stats.failed++;
        this.consecutiveFailures++;
        if (this.consecutiveFailures >= BREAKER_FAILURES) {
          this.breakerOpenUntil = Date.now() + BREAKER_OPEN_MS;
          this.consecutiveFailures = 0;
          this.stats.breaker_trips++;
          console.error(`[LLM:${this.name}] breaker open for ${BREAKER_OPEN_MS / 60000} min after ${BREAKER_FAILURES} consecutive failures`);
        }
        return { ok: false, reason: status ? `http_${status}` : (err.code || 'network') };
      }
    }
    return { ok: false, reason: 'exhausted' };
  }
}

// ── Public client with fallback ─────────────────────────────────────────────
function buildClients() {
  const out = [];
  const p = (process.env.LLM_PROVIDER || 'none').toLowerCase();
  if (p !== 'none' && PROVIDERS[p]) out.push(new ProviderClient(p, process.env.LLM_API_KEY, process.env.LLM_MODEL));
  const f = (process.env.LLM_FALLBACK_PROVIDER || 'none').toLowerCase();
  if (f !== 'none' && PROVIDERS[f] && f !== p) out.push(new ProviderClient(f, process.env.LLM_FALLBACK_API_KEY, process.env.LLM_FALLBACK_MODEL));
  return out;
}

let clients = null;
const getClients = () => (clients ??= buildClients());

function extractJSON(text) {
  if (!text) return null;
  const cleaned = String(text).replace(/```json/gi, '').replace(/```/g, '').trim();
  const start = cleaned.indexOf('{'), end = cleaned.lastIndexOf('}');
  if (start === -1 || end === -1) return null;
  try { return JSON.parse(cleaned.slice(start, end + 1)); } catch { return null; }
}

/**
 * Validate a parsed object against {field: {type, max}}. Returns the trimmed
 * object or null. Strict on purpose: a malformed response falls back to the
 * template rather than shipping garbage to a caregiver.
 */
function validate(obj, schema) {
  if (!obj || typeof obj !== 'object') return null;
  const out = {};
  for (const [field, rule] of Object.entries(schema)) {
    const v = obj[field];
    if (rule.type === 'string') {
      if (typeof v !== 'string' || !v.trim()) return null;
      const s = v.trim();
      if (rule.max && s.length > rule.max) return null;
      out[field] = s;
    } else if (rule.type === 'enum') {
      if (!rule.values.includes(v)) return null;
      out[field] = v;
    }
  }
  return out;
}

/**
 * Ask for a JSON object matching `schema`. Tries primary then fallback.
 * Returns the validated object, or null -- never throws.
 */
async function completeJSON(systemInstruction, prompt, schema, opts = {}) {
  for (const c of getClients()) {
    if (!c.available) continue;
    const r = await c.complete(systemInstruction, prompt, opts);
    if (!r.ok) continue;
    const parsed = validate(extractJSON(r.text), schema);
    if (parsed) return parsed;
    console.warn(`[LLM:${c.name}] response failed schema validation, trying next / falling back`);
  }
  return null;
}

function isConfigured() {
  return getClients().some(c => !!c.apiKey);
}

function status() {
  return getClients().map(c => ({
    provider: c.name, model: c.model, configured: !!c.apiKey, available: c.available,
    breaker_open_for_s: Math.max(0, Math.round((c.breakerOpenUntil - Date.now()) / 1000)),
    ...c.stats,
  }));
}

module.exports = {
  completeJSON, isConfigured, status, validate, extractJSON, TokenBucket, ProviderClient, PROVIDERS,
  _resetForTests: () => { clients = null; },
  _setTransportForTests,
};
