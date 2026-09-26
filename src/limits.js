// Detects usage limits, rate limits and auth failures in Claude Code output,
// and works out when a limited account becomes usable again.

const LIMIT_PATTERNS = [
  /usage limit reached/i,
  /you'?ve hit your (usage |weekly |session |opus |sonnet )?limit/i,
  /\b(opus|sonnet) limit\b/i,
  /(5|five)[- ]hour limit/i,
  /weekly limit/i,
  /limit (will )?resets?/i,
  /rate[_ ]limit(ed|_error)?/i,
  /too many requests/i,
  /\b429\b/,
];
const OVERLOAD_PATTERNS = [/overloaded/i, /\b529\b/, /\b503\b/, /temporarily unavailable/i];
const AUTH_PATTERNS = [
  /invalid (x-)?api[- ]key/i,
  /authentication[_ ]error/i,
  /invalid bearer token/i,
  /oauth token (has )?(expired|revoked)/i,
  /please run \/login/i,
  /not logged in/i,
  /\b401\b/,
];
const BILLING_PATTERNS = [/credit balance is too low/i, /billing/i, /insufficient (credit|quota|funds)/i];

const any = (patterns, text) => patterns.some((re) => re.test(text));

/**
 * Parse a reset time out of a limit message. Returns epoch ms or null.
 * Handles: "limit reached|1790388000", "resets 3pm", "resets at 3:30 pm",
 * "try again in 15 minutes", "retry after 30 seconds", "resets in 2h 5m".
 */
export function parseResetTime(text, now = Date.now()) {
  if (!text) return null;

  const epoch = text.match(/\|\s*(\d{10,13})\b/) || text.match(/resets?(?:At|_at)?["':\s]+(\d{10,13})\b/i);
  if (epoch) {
    const n = Number(epoch[1]);
    return n < 1e12 ? n * 1000 : n;
  }

  const rel = text.match(/(?:in|after)\s+((?:\d+\s*(?:d|h|m|s|days?|hours?|hrs?|minutes?|mins?|seconds?|secs?)\s*,?\s*(?:and\s+)?)+)/i);
  if (rel) {
    let ms = 0;
    for (const [, n, unit] of rel[1].matchAll(/(\d+)\s*([a-z]+)/gi)) {
      const u = unit.toLowerCase();
      const mult = u.startsWith('d') ? 864e5 : u.startsWith('h') ? 36e5 : u.startsWith('m') ? 6e4 : 1e3;
      ms += Number(n) * mult;
    }
    if (ms > 0) return now + ms;
  }

  const clock = text.match(/resets?\s+(?:at\s+)?(\d{1,2})(?::(\d{2}))?\s*(am|pm)?/i);
  if (clock) {
    let hour = Number(clock[1]);
    const minute = Number(clock[2] || 0);
    const ampm = clock[3]?.toLowerCase();
    if (ampm === 'pm' && hour < 12) hour += 12;
    if (ampm === 'am' && hour === 12) hour = 0;
    if (hour > 23 || minute > 59) return null;
    const d = new Date(now);
    d.setHours(hour, minute, 0, 0);
    if (d.getTime() <= now) d.setDate(d.getDate() + 1);
    return d.getTime();
  }
  return null;
}

// Claude Code reports these limits per model family; the account still works on other models.
export const MODEL_WINDOWS = { seven_day_opus: 'opus', seven_day_sonnet: 'sonnet' };

/** The model family a `--model` value belongs to ('opus', 'sonnet', ...), or null for the default. */
export function modelFamily(model) {
  const m = String(model || '').toLowerCase();
  return ['opus', 'sonnet', 'haiku', 'fable'].find((f) => m.includes(f)) || null;
}

// Utilization is a 0-1 fraction; tolerate a percentage just in case.
const fraction = (u) => (typeof u === 'number' ? (u > 1.5 ? u / 100 : u) : null);

/**
 * Normalise Claude Code's `rate_limit_event` payload. Claude Code sends one window per event
 * (`rateLimitType` + `utilization`); some builds also send every window in `unifiedWindows`.
 */
export function readRateLimitEvent(info) {
  if (!info || typeof info !== 'object') return null;
  const toMs = (s) => (typeof s === 'number' ? (s < 1e12 ? s * 1000 : s) : null);
  const windows = {};
  for (const [name, w] of Object.entries(info.unifiedWindows || {})) {
    windows[name] = { utilization: fraction(w?.utilization) ?? null, resetsAt: toMs(w?.resetsAt), at: Date.now() };
  }
  const type = info.rateLimitType || null;
  if (type && type !== 'overage' && info.utilization != null && !windows[type]) {
    windows[type] = { utilization: fraction(info.utilization), resetsAt: toMs(info.resetsAt), at: Date.now() };
  }
  // With extra usage (overage) turned on, requests keep working after the plan limit.
  const onOverage = info.isUsingOverage === true || info.overageStatus === 'allowed' || info.overageStatus === 'allowed_warning';
  return {
    rejected: info.status === 'rejected' && !onOverage,
    status: info.status || null,
    type,
    // A rejection of a model-specific window only blocks that model family, not the account.
    modelScope: MODEL_WINDOWS[type] || null,
    resetsAt: toMs(info.resetsAt),
    windows,
  };
}

/** Fold a newer rate-limit event into the one seen earlier in the same turn. */
export function mergeRateLimit(prev, next) {
  if (!next) return prev;
  if (!prev) return next;
  return { ...next, windows: { ...prev.windows, ...next.windows } };
}

/**
 * Classify the outcome of one `claude -p` run.
 * @returns {{kind: 'ok'|'rate_limited'|'overloaded'|'auth'|'billing'|'error', resetsAt: number|null, message: string}}
 */
export function classifyOutcome({ result, rateLimit, stderr = '', exitCode = 0, now = Date.now() }) {
  const resultText = typeof result?.result === 'string' ? result.result : '';
  const errors = Array.isArray(result?.errors) ? result.errors.join('\n') : '';
  const isError = Boolean(result?.is_error) || exitCode !== 0 || !result;
  const text = [resultText, errors, stderr].filter(Boolean).join('\n');

  // A turn can still complete while the limit event says "rejected" (e.g. the last request
  // squeezed in); the caller retires the account for the next turn in that case.
  if (!isError) return { kind: 'ok', resetsAt: null, message: resultText };
  if (rateLimit?.rejected) {
    return { kind: 'rate_limited', resetsAt: rateLimit.resetsAt ?? parseResetTime(text, now), modelScope: rateLimit.modelScope, window: rateLimit.type || limitWindow(text), message: text || limitLabel(rateLimit) };
  }

  if (any(BILLING_PATTERNS, text)) return { kind: 'billing', resetsAt: null, message: text };
  if (any(LIMIT_PATTERNS, text)) {
    const scope = text.match(/\b(opus|sonnet) limit\b/i)?.[1].toLowerCase() || null;
    return { kind: 'rate_limited', resetsAt: parseResetTime(text, now), modelScope: scope, window: limitWindow(text), message: text };
  }
  if (any(OVERLOAD_PATTERNS, text)) return { kind: 'overloaded', resetsAt: null, message: text };
  if (any(AUTH_PATTERNS, text)) return { kind: 'auth', resetsAt: null, message: text };
  return { kind: 'error', resetsAt: null, message: text || `claude exited with code ${exitCode}` };
}

/** Which usage window a limit message is about, from Claude Code's wording. */
export function limitWindow(text) {
  if (/\bopus limit/i.test(text)) return 'seven_day_opus';
  if (/\bsonnet limit/i.test(text)) return 'seven_day_sonnet';
  if (/session limit|(5|five)[- ]hour/i.test(text)) return 'five_hour';
  if (/weekly limit/i.test(text)) return 'seven_day';
  return null;
}

/** Human wording for a rejected limit event. */
export function limitLabel(rateLimit) {
  if (rateLimit?.modelScope) return `${rateLimit.modelScope[0].toUpperCase()}${rateLimit.modelScope.slice(1)} weekly limit reached (other models still work)`;
  if (rateLimit?.type === 'seven_day') return 'weekly limit reached';
  if (rateLimit?.type === 'five_hour') return '5-hour limit reached';
  return 'usage limit reached';
}

/** True when a transcript line (from an interactive session) reports a usage limit. */
export function lineShowsLimit(text) {
  return any(LIMIT_PATTERNS, text) && !any(BILLING_PATTERNS, text);
}
