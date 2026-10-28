'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { parseFlexibleDate, parseFlexibleTime, parseFlexibleAmount, parseDateTimeText, resolveOverrides } = require('../src/services/flexibleInput');

const TODAY = '2026-10-29';

test('dates: common formats parse without LLM', () => {
  const cases = {
    '2026-10-27': '2026-10-27',
    '27/10/2026': '2026-10-27',
    '27-10-2026': '2026-10-27',
    '27.10.2026': '2026-10-27',
    '27/10/26': '2026-10-27',
    '27-10-26': '2026-10-27',
    '7/6/26': '2026-06-07',            // day-first
    '10/27/2026': '2026-10-27',        // US order detected because 27 > 12
    '27/10': '2026-10-27',
    '27 Oct': '2026-10-27',
    '27 oct 2026': '2026-10-27',
    '27th October 2026': '2026-10-27',
    'October 27, 2026': '2026-10-27',
    'Oct 27': '2026-10-27',
    '23Jun26': '2026-06-23',
    '23-Jun-2026': '2026-06-23',
    'on 3rd of june': '2026-06-03',
    '27102026': '2026-10-27',
    '20261027': '2026-10-27',
    '271026': '2026-10-27',
    'today': TODAY,
    'Yesterday': '2026-10-28',
    '15 Dec': '2025-12-15',            // no year + would be future -> last year
    '  27 / 10 / 2026 ': '2026-10-27',
  };
  for (const [input, expected] of Object.entries(cases)) {
    assert.equal(parseFlexibleDate(input, TODAY), expected, `date "${input}"`);
  }
});

test('dates: conversational / invalid input is left for the LLM (null)', () => {
  for (const input of ['last Monday', 'day before yesterday', '2 days back', '31/02/2026', '45/10/2026', 'sometime last week', '']) {
    assert.equal(parseFlexibleDate(input, TODAY), null, `date "${input}"`);
  }
});

test('times: common formats parse without LLM', () => {
  const cases = {
    '10:00': '10:00', '9:05': '09:05', '19:30': '19:30', '19.30': '19:30',
    '1930': '19:30', '930': '09:30', '7pm': '19:00', '7 PM': '19:00', '7:30 pm': '19:30',
    '7.30PM': '19:30', '10 am': '10:00', '12 am': '00:00', '12 pm': '12:00', '7 p.m.': '19:00',
    'around 10:30 AM': '10:30', 'at 4 pm': '16:00', '7 in the evening': '19:00', 'morning 9': '09:00',
    'noon': '12:00', 'midnight': '00:00', '14:20:59': '14:20', '10': '10:00', "8 o'clock at night": '20:00',
  };
  for (const [input, expected] of Object.entries(cases)) {
    assert.equal(parseFlexibleTime(input), expected, `time "${input}"`);
  }
});

test('times: vague or invalid input is left for the LLM (null)', () => {
  for (const input of ['evening', 'after lunch', '25:00', '10:75', 'sometime', '']) {
    assert.equal(parseFlexibleTime(input), null, `time "${input}"`);
  }
});

test('amounts', () => {
  assert.equal(parseFlexibleAmount('Rs.1,500.50'), 1500.5);
  assert.equal(parseFlexibleAmount('₹ 200'), 200);
  assert.equal(parseFlexibleAmount('INR 10,000.00'), 10000);
  assert.equal(parseFlexibleAmount('500 rupees only'), 500);
  assert.equal(parseFlexibleAmount(106), 106);
  assert.equal(parseFlexibleAmount('1.5k'), null);
  assert.equal(parseFlexibleAmount('2 lakh'), null);
});

test('parseDateTimeText: date, time or both', () => {
  const cases = {
    '7pm': { date: null, time: '19:00' },
    '7.30': { date: null, time: '07:30' },
    '24 June': { date: '2026-06-24', time: null },
    '24/06': { date: '2026-06-24', time: null },
    'yesterday': { date: '2026-10-28', time: null },
    'yesterday 7pm': { date: '2026-10-28', time: '19:00' },
    '24/06/2026 18:40': { date: '2026-06-24', time: '18:40' },
    '24th June 6:40 pm': { date: '2026-06-24', time: '18:40' },
    '6:40 pm on 24th June': { date: '2026-06-24', time: '18:40' },
    'last Monday evening': { date: null, time: null },
  };
  for (const [input, expected] of Object.entries(cases)) {
    assert.deepEqual(parseDateTimeText(input, TODAY), expected, input);
  }
});

test('resolveOverrides: LLM only called for what the parser cannot read', async () => {
  const calls = [];
  const llmNormalize = async (p) => { calls.push(p); return { date_iso: '2026-10-26', time_24h: '19:00', amount: 1500, model: 'stub' }; };

  const a = await resolveOverrides({ time: '27/10/2026 7pm' }, { today: TODAY, timeZone: 'Asia/Kolkata', llmNormalize });
  assert.deepEqual(a.overrides, { date: '2026-10-27', time: '19:00' });
  assert.equal(calls.length, 0);

  const b = await resolveOverrides({ time: 'last Monday evening around 7', amount: '1.5k', txnNo: 'ABC' }, { today: TODAY, timeZone: 'Asia/Kolkata', llmNormalize });
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0], { text: 'last Monday evening around 7', amount: '1.5k', today: TODAY, timeZone: 'Asia/Kolkata' });
  assert.deepEqual(b.overrides, { time: '19:00', date: '2026-10-26', amount: 1500, txnNo: 'ABC' });
});

test('resolveOverrides: LLM failure never throws; unreadable left as typed', async () => {
  const r = await resolveOverrides({ time: 'last Monday' }, { today: TODAY, timeZone: 'Asia/Kolkata', llmNormalize: async () => { throw new Error('down'); } });
  assert.equal(r.overrides.time, 'last Monday');
});
