// Exchange calendar metadata, not price data. Sources: docs/equity-datasets.md.
// Restricted to the imported historical interval; early-close days remain sessions.
const closed = new Set(
  Object.entries({
    2012: [
      "01-02",
      "01-16",
      "02-20",
      "04-06",
      "05-28",
      "07-04",
      "09-03",
      "10-29",
      "10-30",
      "11-22",
      "12-25",
    ],
    2013: [
      "01-01",
      "01-21",
      "02-18",
      "03-29",
      "05-27",
      "07-04",
      "09-02",
      "11-28",
      "12-25",
    ],
    2014: [
      "01-01",
      "01-20",
      "02-17",
      "04-18",
      "05-26",
      "07-04",
      "09-01",
      "11-27",
      "12-25",
    ],
    2015: [
      "01-01",
      "01-19",
      "02-16",
      "04-03",
      "05-25",
      "07-03",
      "09-07",
      "11-26",
      "12-25",
    ],
    2016: [
      "01-01",
      "01-18",
      "02-15",
      "03-25",
      "05-30",
      "07-04",
      "09-05",
      "11-24",
      "12-26",
    ],
    2017: [
      "01-02",
      "01-16",
      "02-20",
      "04-14",
      "05-29",
      "07-04",
      "09-04",
      "11-23",
      "12-25",
    ],
  }).flatMap(([year, days]) => days.map((day) => year + "-" + day)),
);
export const EQUITY_AUDIT_VERSION = "wiki-calendar-2";
export function isEquitySession(date) {
  if (date < "2012-01-01" || date > "2017-12-31") return false;
  const weekday = new Date(date + "T12:00:00Z").getUTCDay();
  return weekday >= 1 && weekday <= 5 && !closed.has(date);
}
export const EQUITY_SESSIONS = [];
for (let t = Date.UTC(2012, 0, 1); t < Date.UTC(2018, 0, 1); t += 86400000) {
  const date = new Date(t).toISOString().slice(0, 10);
  if (isEquitySession(date)) EQUITY_SESSIONS.push(date);
}
