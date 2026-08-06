// Свободные слоты по дням (ТЗ v2, раздел D.1).
import { TYPE } from './model.js';
import { expandOccurrences } from './recurrence.js';
import {
  parseHM, startOfDay, addDays, dayAt, diffMinutes, maxDate, minDate, addMinutes,
} from './time.js';

/** Собрать занятые интервалы [{start,end}] в [from,to]: fixed-вхождения + чанки. */
export function busyIntervals(items, from, to) {
  const busy = [];
  for (const it of items) {
    if (it.type === TYPE.FIXED) {
      for (const occ of expandOccurrences(it, from, to)) {
        busy.push({ start: occ.start, end: new Date(occ.start.valueOf() + occ.durationMinutes * 60000) });
      }
    }
    for (const ch of (it.chunks || [])) {
      const s = new Date(ch.start);
      busy.push({ start: s, end: new Date(s.valueOf() + ch.durationMinutes * 60000) });
    }
  }
  return busy;
}

/**
 * Свободные слоты в [now .. horizonEnd] внутри рабочих часов.
 * Возвращает хронологический список [{start:Date, end:Date, minutes:number}].
 */
export function computeFreeSlots(items, config, now, horizonEnd) {
  const wStart = parseHM(config.workStart);
  const wEnd = parseHM(config.workEnd);
  const busy = busyIntervals(items, startOfDay(now), horizonEnd);

  const slots = [];
  let day = startOfDay(now);
  const lastDay = startOfDay(horizonEnd);

  for (; day <= lastDay; day = addDays(day, 1)) {
    let winStart = dayAt(day, wStart);
    const winEnd = dayAt(day, wEnd);
    // сегодня: не раньше «сейчас»
    winStart = maxDate(winStart, now);
    if (winStart >= winEnd) continue;

    // занятые интервалы, пересекающие окно дня, клиппованные к окну
    const dayBusy = busy
      .map((b) => ({ start: maxDate(b.start, winStart), end: minDate(b.end, winEnd) }))
      .filter((b) => b.end > b.start)
      .sort((a, b) => a.start - b.start);

    // вычитаем занятость -> свободные промежутки, оставляя буфер вокруг каждого дела (D.7):
    // 15 мин после предыдущего дела и 15 мин перед следующим. На краях дня буфер не нужен.
    const buffer = config.bufferMinutes || 0;
    let cursor = winStart;
    let cursorIsTask = false; // граница cursor — это конец дела, а не начало рабочего дня?
    for (const b of dayBusy) {
      if (b.start > cursor) {
        const gs = cursorIsTask ? addMinutes(cursor, buffer) : cursor;
        const ge = addMinutes(b.start, -buffer); // перед делом b
        pushSlot(slots, gs, ge);
      }
      if (b.end > cursor) { cursor = b.end; cursorIsTask = true; }
    }
    const gs = cursorIsTask ? addMinutes(cursor, buffer) : cursor;
    if (gs < winEnd) pushSlot(slots, gs, winEnd);
  }
  return slots;
}

function pushSlot(slots, start, end) {
  const minutes = diffMinutes(start, end);
  if (minutes > 0) slots.push({ start, end, minutes });
}
