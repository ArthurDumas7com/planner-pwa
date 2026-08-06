// Разворачивание повторяющихся fixed-событий в конкретные вхождения.
import { TYPE } from './model.js';
import { startOfDay, addDays, dayAt, minutesOfDay, fromDateKey } from './time.js';

/**
 * Вернуть вхождения fixed-события в интервале [from, to] как [{start:Date, durationMinutes}].
 * Для flexible-задач повторяемость в v1 в ядре не разворачивается (см. ТЗ, раздел D).
 */
export function expandOccurrences(item, from, to) {   // eslint-disable-line no-param-reassign
  if (item.type !== TYPE.FIXED || !item.start) return [];
  const base = new Date(item.start);
  const dur = item.durationMinutes || 0;
  const rec = item.recurrence;

  if (!rec) {
    return (base >= from && base <= to) ? [{ start: base, durationMinutes: dur }] : [];
  }

  const tod = minutesOfDay(base);           // время суток базового вхождения
  const out = [];
  // ограничение по дате окончания («с 4 по 6 авг» — повтор только внутри периода)
  if (rec.until) {
    const untilEnd = dayAt(fromDateKey(rec.until), 24 * 60 - 1);
    if (untilEnd < to) to = untilEnd;
  }

  if (rec.everyDays) {
    // Первое вхождение — не раньше дня base; шагаем по everyDays.
    let day = startOfDay(base);
    const fromDay = startOfDay(from);
    // сдвигаем к первому дню >= from, сохраняя фазу шага
    while (day < fromDay) day = addDays(day, rec.everyDays);
    for (; day <= to; day = addDays(day, rec.everyDays)) {
      const start = dayAt(day, tod);
      if (start >= from && start <= to) out.push({ start, durationMinutes: dur });
    }
  } else if (rec.weekdays && rec.weekdays.length) {
    const set = new Set(rec.weekdays);
    let day = startOfDay(from);
    const baseDay = startOfDay(base);
    for (; day <= to; day = addDays(day, 1)) {
      if (day < baseDay) continue;
      if (set.has(day.getDay())) {
        const start = dayAt(day, tod);
        if (start >= from && start <= to) out.push({ start, durationMinutes: dur });
      }
    }
  }
  return out;
}
