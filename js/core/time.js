// Время: локальные даты/минуты. Всё детерминированно — `now` всегда передаётся явно.

export function pad2(n) { return String(n).padStart(2, '0'); }

/** Date -> 'YYYY-MM-DD' (локальная зона). */
export function toDateKey(d) {
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}

/** 'YYYY-MM-DD' -> Date на локальной полуночи. */
export function fromDateKey(key) {
  const [y, m, d] = key.split('-').map(Number);
  return new Date(y, m - 1, d, 0, 0, 0, 0);
}

/** 'HH:MM' -> минуты от полуночи. */
export function parseHM(str) {
  const [h, m] = str.split(':').map(Number);
  return h * 60 + (m || 0);
}

/** минуты от полуночи -> 'HH:MM'. */
export function formatHM(minutes) {
  const m = ((Math.round(minutes) % 1440) + 1440) % 1440;
  return `${pad2(Math.floor(m / 60))}:${pad2(m % 60)}`;
}

/** Локальные минуты от полуночи для Date. */
export function minutesOfDay(d) { return d.getHours() * 60 + d.getMinutes(); }

/** Начало локального дня. */
export function startOfDay(d) {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate(), 0, 0, 0, 0);
}

/** Прибавить n календарных дней (сохраняя время суток). */
export function addDays(d, n) {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate() + n, d.getHours(), d.getMinutes(), 0, 0);
}

export function addMinutes(d, n) { return new Date(d.valueOf() + n * 60000); }

/** (b - a) в минутах. */
export function diffMinutes(a, b) { return (b.valueOf() - a.valueOf()) / 60000; }

/** Date на дне `dayBase` в момент `minutes` от полуночи (возвращает Date). */
export function dayAtMinutes(dayBase, minutes) {
  return new Date(dayBase.getFullYear(), dayBase.getMonth(), dayBase.getDate(), 0, 0, 0, 0)
    .valueOf() + minutes * 60000;
}

/** То же, но возвращает Date-объект. */
export function dayAt(dayBase, minutes) { return new Date(dayAtMinutes(dayBase, minutes)); }

export function maxDate(a, b) { return a.valueOf() >= b.valueOf() ? a : b; }
export function minDate(a, b) { return a.valueOf() <= b.valueOf() ? a : b; }
