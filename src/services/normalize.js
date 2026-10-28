'use strict';

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** Parses a strict YYYY-MM-DD string into {y,m,d} or null. */
function parseIsoDate(iso) {
  if (typeof iso !== 'string') return null;
  const parts = iso.trim().split('-');
  if (parts.length !== 3 || parts[0].length !== 4) return null;
  const [y, m, d] = parts.map(Number);
  if (![y, m, d].every(Number.isInteger)) return null;
  const dt = new Date(Date.UTC(y, m - 1, d));
  if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== m - 1 || dt.getUTCDate() !== d) return null;
  return { y, m, d, dt };
}

/** "2026-08-10" -> "10-Aug-2026" (format in SBI's sample request). */
function toSbiDate(iso) {
  const p = parseIsoDate(iso);
  if (!p) return null;
  return `${String(p.d).padStart(2, '0')}-${MONTHS[p.m - 1]}-${p.y}`;
}

/** Accepts "HH:MM" (24h); returns normalised "HH:MM" or null. */
function normalizeTime(t) {
  if (typeof t !== 'string') return null;
  const parts = t.trim().split(':');
  if (parts.length < 2) return null;
  const h = Number(parts[0]);
  const m = Number(parts[1]);
  if (!Number.isInteger(h) || !Number.isInteger(m) || h < 0 || h > 23 || m < 0 || m > 59) return null;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
}

function formatAmount(n) {
  if (typeof n !== 'number' || !Number.isFinite(n) || n < 0) return null;
  return n.toFixed(2);
}

/** Today's date (YYYY-MM-DD) in the given IANA zone. */
function todayIn(timeZone) {
  return new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
}

/** Days between two ISO dates (b - a). */
function daysBetween(aIso, bIso) {
  const a = parseIsoDate(aIso);
  const b = parseIsoDate(bIso);
  if (!a || !b) return null;
  return Math.round((b.dt - a.dt) / 86400000);
}

module.exports = { parseIsoDate, toSbiDate, normalizeTime, formatAmount, todayIn, daysBetween };
