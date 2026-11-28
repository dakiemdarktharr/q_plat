// NYSE sessions used by the pinned Yahoo Finance snapshot (2015-01-02–2020-04-01).
// Calendar rules are generated from exchange-observed US market holidays; the
// 2018 national day of mourning is included explicitly.
const START = "2015-01-02";
const END = "2020-04-01";

function nthWeekday(year, month, weekday, nth) {
  const first = new Date(Date.UTC(year, month - 1, 1)).getUTCDay();
  return 1 + ((weekday - first + 7) % 7) + (nth - 1) * 7;
}

function lastWeekday(year, month, weekday) {
  const last = new Date(Date.UTC(year, month, 0));
  return last.getUTCDate() - ((last.getUTCDay() - weekday + 7) % 7);
}

function easterSunday(year) {
  const a = year % 19,
    b = Math.floor(year / 100),
    c = year % 100,
    d = Math.floor(b / 4),
    e = b % 4,
    f = Math.floor((b + 8) / 25),
    g = Math.floor((b - f + 1) / 3),
    h = (19 * a + b - d - g + 15) % 30,
    i = Math.floor(c / 4),
    k = c % 4,
    l = (32 + 2 * e + 2 * i - h - k) % 7,
    m = Math.floor((a + 11 * h + 22 * l) / 451),
    month = Math.floor((h + l - 7 * m + 114) / 31),
    day = ((h + l - 7 * m + 114) % 31) + 1;
  return new Date(Date.UTC(year, month - 1, day));
}

function observedFixedHoliday(year, month, day) {
  const date = new Date(Date.UTC(year, month - 1, day));
  if (date.getUTCDay() === 6) date.setUTCDate(date.getUTCDate() - 1);
  else if (date.getUTCDay() === 0) date.setUTCDate(date.getUTCDate() + 1);
  return date.toISOString().slice(0, 10);
}

function marketHolidays(year) {
  const holidays = new Set([
    observedFixedHoliday(year, 1, 1),
    observedFixedHoliday(year, 7, 4),
    observedFixedHoliday(year, 12, 25),
  ]);
  for (const [month, day] of [
    [1, nthWeekday(year, 1, 1, 3)], // Martin Luther King Jr. Day
    [2, nthWeekday(year, 2, 1, 3)], // Washington's Birthday
    [5, lastWeekday(year, 5, 1)], // Memorial Day
    [9, nthWeekday(year, 9, 1, 1)], // Labor Day
    [11, nthWeekday(year, 11, 4, 4)], // Thanksgiving
  ])
    holidays.add(
      new Date(Date.UTC(year, month - 1, day)).toISOString().slice(0, 10),
    );
  const goodFriday = easterSunday(year);
  goodFriday.setUTCDate(goodFriday.getUTCDate() - 2);
  holidays.add(goodFriday.toISOString().slice(0, 10));
  if (year === 2018) holidays.add("2018-12-05");
  return holidays;
}

const holidays = new Set(
  Array.from({ length: 6 }, (_, index) => 2015 + index).flatMap((year) => [
    ...marketHolidays(year),
  ]),
);

export function isKaggleEtfSession(date) {
  if (date < START || date > END || !/^\d{4}-\d{2}-\d{2}$/.test(date))
    return false;
  const weekday = new Date(`${date}T12:00:00Z`).getUTCDay();
  return weekday >= 1 && weekday <= 5 && !holidays.has(date);
}

export const KAGGLE_ETF_SESSIONS = [];
for (
  let time = Date.parse(`${START}T00:00:00Z`);
  time <= Date.parse(`${END}T00:00:00Z`);
  time += 86400000
) {
  const date = new Date(time).toISOString().slice(0, 10);
  if (isKaggleEtfSession(date)) KAGGLE_ETF_SESSIONS.push(date);
}
