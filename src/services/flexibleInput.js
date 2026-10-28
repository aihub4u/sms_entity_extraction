'use strict';

/**
 * Turns whatever the customer typed for date / time / amount into the
 * canonical values the rest of the API uses (YYYY-MM-DD, HH:MM, number).
 *
 * 1. A fast built-in parser handles common formats with no LLM call:
 *    27/10/2026, 27-10-26, 27.10.26, 2026-10-27, 27Oct26, 27 Oct, Oct 27 2026,
 *    27th October, today, yesterday · 7pm, 7:30 PM, 19:30, 19.30, 1930,
 *    around 10 am, noon · Rs.1,500.50, 500 rupees, INR 200
 * 2. Anything else ("last Monday", "evening around 7", "1.5k") goes to the
 *    LLM normaliser in one call.
 * 3. Values that still can't be understood are left as typed, so the
 *    existing INVALID_OVERRIDE warning + follow-up question kicks in.
 */

const { parseIsoDate } = require('./normalize');

const MONTH_LOOKUP = {
  jan: 1, january: 1, feb: 2, february: 2, mar: 3, march: 3, apr: 4, april: 4, may: 5,
  jun: 6, june: 6, jul: 7, july: 7, aug: 8, august: 8, sep: 9, sept: 9, september: 9,
  oct: 10, october: 10, nov: 11, november: 11, dec: 12, december: 12,
};
const ORDINALS = new Set(['st', 'nd', 'rd', 'th']);
const DATE_FILLERS = new Set(['on', 'of', 'the', 'date', 'dt', 'dated', 'around', 'approx', 'approximately', 'about', 'it', 'was', 'is', 'i', 'think']);
const TIME_FILLERS = new Set(['around', 'approx', 'approximately', 'about', 'at', 'by', 'hrs', 'hr', 'hours', 'h', 'ist', 'o', 'clock', 'in', 'the', 'it', 'was', 'is', 'time', 'i', 'think']);
const AMOUNT_WORDS = new Set(['rs', 'inr', 'rupee', 'rupees', 'only', 'amount', 'of', 'debited', 'is', 'was']);

/** Splits text into runs of digits ("n") and runs of letters ("a"); everything else separates. */
function tokenize(s) {
  const tokens = [];
  let cur = '';
  let kind = null;
  for (const ch of String(s).toLowerCase()) {
    const k = ch >= '0' && ch <= '9' ? 'n' : ch >= 'a' && ch <= 'z' ? 'a' : null;
    if (k !== kind && cur) { tokens.push({ kind, v: cur }); cur = ''; }
    kind = k;
    if (k) cur += ch;
  }
  if (cur) tokens.push({ kind, v: cur });
  return tokens;
}

const pad = (n) => String(n).padStart(2, '0');
const iso = (y, m, d) => `${y}-${pad(m)}-${pad(d)}`;

function addDays(isoDate, days) {
  const p = parseIsoDate(isoDate);
  const dt = new Date(p.dt.getTime() + days * 86400000);
  return iso(dt.getUTCFullYear(), dt.getUTCMonth() + 1, dt.getUTCDate());
}

function buildDate(y, m, d, today) {
  const t = parseIsoDate(today);
  let year = y;
  if (year === null) {
    // No year typed: assume the most recent such date that isn't in the future.
    year = t.y;
    if (parseIsoDate(iso(year, m, d)) && iso(year, m, d) > today) year -= 1;
  } else if (year < 100) {
    year += 2000;
  }
  const out = iso(year, m, d);
  return parseIsoDate(out) ? out : null;
}

/** Day-first unless that is impossible (e.g. 10/27/2026 -> 27 Oct). */
function dayMonth(a, b) {
  if (a > 12 && b <= 12) return [a, b];
  if (b > 12 && a <= 12) return [b, a];
  return [a, b];
}

/** Returns YYYY-MM-DD or null if the text isn't a plain date. */
function parseFlexibleDate(input, today) {
  if (input === null || input === undefined) return null;
  const tokens = tokenize(input).filter((t) => !(t.kind === 'a' && (DATE_FILLERS.has(t.v) || ORDINALS.has(t.v))));
  if (!tokens.length) return null;

  const words = tokens.filter((t) => t.kind === 'a').map((t) => t.v);
  const nums = tokens.filter((t) => t.kind === 'n').map((t) => t.v);

  if (words.length === 1 && nums.length === 0) {
    if (words[0] === 'today') return today;
    if (words[0] === 'yesterday') return addDays(today, -1);
  }

  const monthWords = words.filter((w) => MONTH_LOOKUP[w]);
  if (words.length !== monthWords.length || monthWords.length > 1) return null; // unknown words -> LLM

  if (monthWords.length === 1) {
    const m = MONTH_LOOKUP[monthWords[0]];
    if (nums.length === 1 && nums[0].length <= 2) return buildDate(null, m, Number(nums[0]), today);
    if (nums.length === 2) {
      // "27 Oct 2026", "Oct 27 2026", "23Jun26": the first number up to 31 is the day.
      const [a, b] = nums;
      if (a.length <= 2 && Number(a) <= 31) return buildDate(Number(b), m, Number(a), today);
      if (b.length <= 2 && Number(b) <= 31) return buildDate(Number(a), m, Number(b), today);
    }
    return null;
  }

  if (nums.length === 3) {
    const [a, b, c] = nums;
    if (a.length === 4) return buildDate(Number(a), Number(b), Number(c), today); // 2026-10-27
    if (c.length === 4 || c.length === 2) {
      const [d, m] = dayMonth(Number(a), Number(b));
      return buildDate(Number(c), m, d, today);
    }
    return null;
  }

  if (nums.length === 2 && nums.every((n) => n.length <= 2)) {
    const [d, m] = dayMonth(Number(nums[0]), Number(nums[1]));
    return buildDate(null, m, d, today);
  }

  if (nums.length === 1) {
    const n = nums[0];
    if (n.length === 8) {
      const first4 = Number(n.slice(0, 4));
      if (first4 >= 1990 && first4 <= 2100) return buildDate(first4, Number(n.slice(4, 6)), Number(n.slice(6)), today);
      return buildDate(Number(n.slice(4)), Number(n.slice(2, 4)), Number(n.slice(0, 2)), today);
    }
    if (n.length === 6) return buildDate(Number(n.slice(4)), Number(n.slice(2, 4)), Number(n.slice(0, 2)), today);
  }
  return null;
}

/** Returns HH:MM (24h) or null if the text isn't a plain time. */
function parseFlexibleTime(input) {
  if (input === null || input === undefined) return null;
  const tokens = tokenize(input);
  let ampm = null;
  const nums = [];

  for (let i = 0; i < tokens.length; i += 1) {
    const t = tokens[i];
    if (t.kind === 'n') { nums.push(t.v); continue; }
    const v = t.v;
    const next = tokens[i + 1];
    if (v === 'am' || v === 'pm') { ampm = v; continue; }
    if ((v === 'a' || v === 'p') && next && next.v === 'm') { ampm = `${v}m`; i += 1; continue; } // a.m. / p.m.
    if (v === 'noon' && nums.length === 0) return '12:00';
    if (v === 'midnight' && nums.length === 0) return '00:00';
    if (v === 'morning') { ampm = ampm || 'am'; continue; }
    if (v === 'afternoon' || v === 'evening' || v === 'night') { ampm = ampm || 'pm'; continue; }
    if (TIME_FILLERS.has(v)) continue;
    return null; // unknown word -> LLM
  }

  let h; let m;
  if (nums.length === 1) {
    const n = nums[0];
    if ((n.length === 3 || n.length === 4) && !ampm) { h = Number(n.slice(0, -2)); m = Number(n.slice(-2)); } // 1930, 930
    else if (n.length <= 2) { h = Number(n); m = 0; }
    else return null;
  } else if (nums.length === 2 || nums.length === 3) {
    h = Number(nums[0]); m = Number(nums[1]);
  } else return null;

  if (ampm === 'pm' && h < 12) h += 12;
  if (ampm === 'am' && h === 12) h = 0;
  if (h < 0 || h > 23 || m < 0 || m > 59) return null;
  return `${pad(h)}:${pad(m)}`;
}

/** Returns a number or null. Handles Rs./INR/₹ prefixes and thousands separators. */
function parseFlexibleAmount(input) {
  if (typeof input === 'number') return Number.isFinite(input) && input >= 0 ? input : null;
  if (input === null || input === undefined) return null;
  const s = String(input);
  if (tokenize(s).some((t) => t.kind === 'a' && !AMOUNT_WORDS.has(t.v))) return null; // "1.5k", "2 lakh" -> LLM
  let kept = '';
  for (const ch of s) if ((ch >= '0' && ch <= '9') || ch === '.') kept += ch;
  while (kept.startsWith('.')) kept = kept.slice(1); // "Rs.500" -> "500"
  if (!kept || kept.split('.').length > 2) return null;
  const n = Number(kept);
  return Number.isFinite(n) && n >= 0 ? n : null;
}

/**
 * Resolves free-text overrides into canonical values.
 * @returns {Promise<{ overrides, llm: { used, latency_ms, model } }>}
 */
/**
 * Reads the customer's free-text answer given in `overrides.time`, which may hold
 * a time ("7 pm"), a date ("24 June", "yesterday") or both ("24/06/2026 6:40 pm").
 * Returns { date, time } in canonical form, either may be null.
 */
function parseDateTimeText(text, today) {
  const t = parseFlexibleTime(text);
  const d = parseFlexibleDate(text, today);
  if (t && d) {
    // Both readings possible, e.g. "7.30" or "10/11". '/' or '-' means a date; otherwise a time.
    return text.includes('/') || text.includes('-') ? { date: d, time: null } : { date: null, time: t };
  }
  if (t || d) return { date: d, time: t };

  // Date and time together: try every split point between words.
  const words = text.trim().split(' ').filter(Boolean);
  for (let i = 1; i < words.length; i += 1) {
    const left = words.slice(0, i).join(' ');
    const right = words.slice(i).join(' ');
    const ld = parseFlexibleDate(left, today); const rt = parseFlexibleTime(right);
    if (ld && rt) return { date: ld, time: rt };
    const lt = parseFlexibleTime(left); const rd = parseFlexibleDate(right, today);
    if (lt && rd) return { date: rd, time: lt };
  }
  return { date: null, time: null };
}

/**
 * Resolves free-text overrides into canonical values.
 * `time` carries whatever the customer typed for date and/or time; a date found
 * in it is returned internally as `date` (used only if the SMS has no date).
 * @returns {Promise<{ overrides, llm: { used, latency_ms, model } }>}
 */
async function resolveOverrides(overrides, { today, timeZone, llmNormalize }) {
  const llm = { used: false, latency_ms: 0, model: null };
  if (!overrides) return { overrides, llm };
  const out = { ...overrides };
  delete out.date;
  const pending = {};

  if (out.time !== undefined && out.time !== null && out.time !== '') {
    const raw = String(out.time);
    const p = parseDateTimeText(raw, today);
    if (p.date || p.time) {
      if (p.date) out.date = p.date;
      if (p.time) out.time = p.time; else delete out.time; // date-only answer: time still missing
    } else {
      pending.text = raw;
    }
  }
  if (out.amount !== undefined && out.amount !== null && out.amount !== '') {
    const a = parseFlexibleAmount(out.amount);
    if (a !== null) out.amount = a; else pending.amount = String(out.amount);
  }

  if (Object.keys(pending).length && llmNormalize) {
    const t0 = Date.now();
    try {
      const r = await llmNormalize({ ...pending, today, timeZone });
      llm.used = true;
      llm.model = r.model || null;
      if (pending.text) {
        const d = r.date_iso && parseIsoDate(r.date_iso) && r.date_iso <= today ? r.date_iso : null;
        const t = r.time_24h ? parseFlexibleTime(r.time_24h) : null;
        if (d) out.date = d;
        if (t) out.time = t;
        else if (d) delete out.time; // date-only answer
        // neither: left as typed -> INVALID_OVERRIDE downstream
      }
      if (pending.amount && typeof r.amount === 'number' && r.amount >= 0) out.amount = r.amount;
    } catch (err) {
      // Never fail the request because of this; unresolved values surface as INVALID_OVERRIDE.
      console.error(JSON.stringify({ error: 'OVERRIDE_NORMALIZE_FAILED', message: err.message }));
    }
    llm.latency_ms = Date.now() - t0;
  }
  return { overrides: out, llm };
}

module.exports = { parseFlexibleDate, parseFlexibleTime, parseFlexibleAmount, parseDateTimeText, resolveOverrides, tokenize };
