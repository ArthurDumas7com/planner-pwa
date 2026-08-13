// Разворачивание повторяющихся fixed-событий в конкретные вхождения.
import { TYPE } from './model.js';
import { startOfDay, addDays, dayAt, minutesOfDay, fromDateKey, toDateKey } from './time.js';

const MAX_STEPS = 4000;   // защита от бесконечного цикла на «повторять вечно»

/**
 * Привести правило к единому виду. Понимает старые формы ({everyDays}, {weekdays}),
 * которые пишет парсер, и новую — с частотой, интервалом и концом повтора.
 * @returns {{freq, interval, weekdays, monthMode, until, count}|null}
 */
export function normalizeRecurrence(rec) {
  if (!rec) return null;
  const base = {
    interval: Math.max(1, rec.interval || 1),
    weekdays: rec.weekdays ? [...rec.weekdays] : [],
    monthMode: rec.monthMode || 'dayOfMonth',   // 'dayOfMonth' | 'nthWeekday'
    until: rec.until || null,
    count: rec.count || null,
  };
  if (rec.freq) return { ...base, freq: rec.freq };
  if (rec.everyDays) return { ...base, freq: 'day', interval: Math.max(1, rec.everyDays) };
  if (base.weekdays.length) return { ...base, freq: 'week' };
  return null;
}

/** Какая по счёту неделя месяца у даты (1..5). */
function weekOfMonth(d) {
  return Math.floor((d.getDate() - 1) / 7) + 1;
}

/** Дата k-го дня недели месяца (k с 1); null, если такого в месяце нет. */
function nthWeekdayOfMonth(year, month, weekday, k) {
  const first = new Date(year, month, 1);
  const shift = (weekday - first.getDay() + 7) % 7;
  const day = 1 + shift + (k - 1) * 7;
  const d = new Date(year, month, day);
  return d.getMonth() === month ? d : null;
}

/** Даты повторов начиная с базового дня (по возрастанию), не позже limit. */
function* occurrenceDays(rec, baseDay, limit) {
  const { freq, interval } = rec;
  if (freq === 'week') {
    const days = rec.weekdays.length ? [...rec.weekdays].sort((a, b) => a - b) : [baseDay.getDay()];
    // начало недели базового дня (неделя считается с воскресенья, как getDay)
    let weekStart = addDays(baseDay, -baseDay.getDay());
    for (let step = 0; step < MAX_STEPS; step += 1) {
      for (const wd of days) {
        const d = addDays(weekStart, wd);
        if (d >= baseDay && d <= limit) yield d;
      }
      weekStart = addDays(weekStart, 7 * interval);
      if (weekStart > limit) return;
    }
    return;
  }
  if (freq === 'month' || freq === 'year') {
    const stepMonths = freq === 'year' ? 12 * interval : interval;
    const dayNum = baseDay.getDate();
    const wd = baseDay.getDay();
    const k = weekOfMonth(baseDay);
    for (let i = 0; i < MAX_STEPS; i += 1) {
      const m = new Date(baseDay.getFullYear(), baseDay.getMonth() + i * stepMonths, 1);
      let d;
      if (freq === 'month' && rec.monthMode === 'nthWeekday') {
        d = nthWeekdayOfMonth(m.getFullYear(), m.getMonth(), wd, k);
      } else {
        d = new Date(m.getFullYear(), m.getMonth(), dayNum);
        // 31-е в коротком месяце и 29 февраля — вхождение пропускается, как в Google
        if (d.getMonth() !== m.getMonth()) d = null;
      }
      if (d && d >= baseDay && d <= limit) yield d;
      if (m > limit) return;
    }
    return;
  }
  // day
  for (let d = baseDay, step = 0; d <= limit && step < MAX_STEPS; d = addDays(d, interval), step += 1) {
    yield d;
  }
}

/**
 * Вернуть вхождения fixed-события в интервале [from, to] как [{start:Date, durationMinutes}].
 * Дни из item.exdates пропускаются — это вхождения, вырванные из цикла (стали отдельным
 * событием) или удалённые поштучно.
 * Для flexible-задач повторяемость в v1 в ядре не разворачивается (см. ТЗ, раздел D).
 */
export function expandOccurrences(item, from, to) {
  if (item.type !== TYPE.FIXED || !item.start) return [];
  const base = new Date(item.start);
  const dur = item.durationMinutes || 0;
  const rec = normalizeRecurrence(item.recurrence);
  const skip = new Set(item.exdates || []);

  if (!rec) {
    return (base >= from && base <= to && !skip.has(toDateKey(base)))
      ? [{ start: base, durationMinutes: dur }] : [];
  }

  const tod = minutesOfDay(base);           // время суток базового вхождения
  let limit = to;
  // дата окончания повтора («с 4 по 6 авг», «заканчивается 5 ноября»)
  if (rec.until) {
    const untilEnd = dayAt(fromDateKey(rec.until), 24 * 60 - 1);
    if (untilEnd < limit) limit = untilEnd;
  }

  const out = [];
  let seen = 0;                              // сколько вхождений уже было, считая от базы
  for (const day of occurrenceDays(rec, startOfDay(base), limit)) {
    seen += 1;
    if (rec.count && seen > rec.count) break;   // «после N повторений»
    if (skip.has(toDateKey(day))) continue;     // день вырван из цикла
    const start = dayAt(day, tod);
    if (start >= from && start <= to) out.push({ start, durationMinutes: dur });
  }
  return out;
}
