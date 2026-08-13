// Конфликты между «неподвижными» делами (fixed-события + вручную закреплённые чанки).
// Гибкие задачи сами обтекают события (см. scheduler), поэтому здесь — только жёсткие
// пересечения, которые нельзя разрулить автоматически (оба привязаны ко времени).
import { TYPE } from './model.js';
import { expandOccurrences } from './recurrence.js';
import { computeFreeSlots } from './freeSlots.js';
import { deadlineCutoff } from './scoring.js';
import { startOfDay } from './time.js';

/**
 * Что мешает встать в интервал [startMs, +dur].
 * @returns {{blocked:boolean, displaced:Array<{itemId,chunkId}>}}
 * - `blocked` — под интервалом есть дело с жёсткой привязкой ко времени (fixed) либо
 *   закреплённая гибкая задача, которую саму некуда переставить;
 * - `displaced` — подвижные закреплённые куски, которые нужно освободить (снять lock),
 *   чтобы планировщик расставил их заново.
 */
export function analyzeDrop(startMs, durationMinutes, items, excludeId, config, now, horizonEnd) {
  const endMs = startMs + durationMinutes * 60000;
  const from = new Date(startMs - 86400000);
  const to = new Date(endMs + 86400000);
  const displaced = [];
  const blockedBy = [];
  let blocked = false;

  for (const it of items) {
    if (excludeId && it.id === excludeId) continue;
    if (it.type === TYPE.FIXED) {
      for (const occ of expandOccurrences(it, from, to)) {
        const os = occ.start.valueOf();
        if (startMs < os + occ.durationMinutes * 60000 && endMs > os) {
          blocked = true;                                        // жёсткая привязка ко времени
          if (!blockedBy.some((b) => b.itemId === it.id)) blockedBy.push({ itemId: it.id, title: it.title });
        }
      }
      continue;
    }
    for (const c of (it.chunks || [])) {
      const cs = new Date(c.start).valueOf();
      const ce = cs + c.durationMinutes * 60000;
      if (!(startMs < ce && endMs > cs)) continue;
      if (!c.locked) continue;                       // авто-размещённое просто переедет при переплане
      // закреплённое: можно ли его самого куда-то переставить с учётом дедлайна?
      const busy = items.map((x) => (x.id === it.id
        ? { ...x, chunks: (x.chunks || []).filter((y) => y.id !== c.id) }
        : x));
      busy.push({ id: '__moving__', type: TYPE.FIXED, start: new Date(startMs).toISOString(), durationMinutes });
      const cutoff = deadlineCutoff(it, config);
      const alt = nearestFreeStart(cs, c.durationMinutes, busy, config, now, cutoff && cutoff < horizonEnd ? cutoff : horizonEnd, it.id);
      if (alt == null) {                             // переставить некуда — место действительно занято
        blocked = true;
        if (!blockedBy.some((b) => b.itemId === it.id)) blockedBy.push({ itemId: it.id, title: it.title });
      } else displaced.push({ itemId: it.id, chunkId: c.id });
    }
  }
  return { blocked, displaced, blockedBy };
}

/** Упрощённая проверка: место занято чем-то неподвижным (для подсветки красным). */
export function overlapsImmovable(startMs, durationMinutes, items, excludeId, config, now, horizonEnd) {
  return analyzeDrop(startMs, durationMinutes, items, excludeId,
    config || { workStart: '08:00', workEnd: '22:00', bufferMinutes: 15 },
    now || new Date(), horizonEnd || new Date(Date.now() + 21 * 86400000)).blocked;
}

/**
 * Слоты с буферами вокруг дел, а если ничего подходящего нет — впритык.
 * Отступы в 15 минут — предпочтение, а не запрет: с ними место, которое объективно
 * есть, иначе выглядело бы занятым.
 */
function slotsFitting(durationMinutes, items, config, now, horizonEnd) {
  const slots = computeFreeSlots(items, config, now, horizonEnd);
  if (slots.some((s) => s.minutes >= durationMinutes)) return slots;
  return computeFreeSlots(items, config, now, horizonEnd, { buffer: 0 });
}

/** Ближайший к желаемому времени свободный старт (ms), куда влезает dur (с учётом буфера). null — нет. */
export function nearestFreeStart(desiredMs, durationMinutes, items, config, now, horizonEnd, excludeId) {
  const blockers = items.filter((x) => x.id !== excludeId);   // все занятые интервалы, а не только locked
  const slots = slotsFitting(durationMinutes, blockers, config, now, horizonEnd);
  let best = null;
  for (const s of slots) {
    const latest = s.end.valueOf() - durationMinutes * 60000;
    if (latest < s.start.valueOf()) continue;
    const start = Math.min(Math.max(desiredMs, s.start.valueOf()), latest);
    const dist = Math.abs(start - desiredMs);
    if (!best || dist < best.dist) best = { start, dist };
  }
  return best ? best.start : null;
}

/** Неподвижные интервалы: вхождения fixed-событий + locked-чанки. */
function immovableIntervals(items, from, to) {
  const out = [];
  for (const it of items) {
    if (it.type === TYPE.FIXED) {
      for (const occ of expandOccurrences(it, from, to)) {
        out.push({ id: it.id, title: it.title, createdAt: it.createdAt || '', start: occ.start, end: new Date(occ.start.valueOf() + occ.durationMinutes * 60000) });
      }
    } else {
      for (const c of (it.chunks || [])) {
        if (!c.locked) continue;
        const s = new Date(c.start);
        out.push({ id: it.id, title: it.title, createdAt: it.createdAt || '', start: s, end: new Date(s.valueOf() + c.durationMinutes * 60000) });
      }
    }
  }
  return out.sort((a, b) => a.start - b.start);
}

/**
 * Пометить жёсткие конфликты. У «проигравшего» (более позднего по createdAt) события
 * ставим it.conflict = { withTitle, suggestions:[{start,durationMinutes}] }.
 * Мутирует items.
 */
export function detectFixedConflicts(items, config, now, horizonEnd) {
  for (const it of items) it.conflict = null;

  const intervals = immovableIntervals(items, startOfDay(now), horizonEnd);
  for (let i = 0; i < intervals.length; i += 1) {
    for (let j = i + 1; j < intervals.length; j += 1) {
      if (intervals[j].start >= intervals[i].end) break;   // отсортировано — дальше пересечений с i нет
      if (intervals[i].id === intervals[j].id) continue;   // разные вхождения одного события
      const a = intervals[i];
      const b = intervals[j];
      const loser = a.createdAt >= b.createdAt ? a : b;    // новое (позже добавленное) — переносим
      const other = loser === a ? b : a;
      const li = items.find((x) => x.id === loser.id);
      if (li && !li.conflict) li.conflict = { withTitle: other.title, suggestions: [] };
    }
  }

  for (const it of items) {
    // варианты переноса: 3 ближайших свободных окна (дедлайн не ограничивает — это «куда можно»)
    if (it.conflict) {
      const dur = it.durationMinutes || 0;
      it.conflict.suggestions = suggestFreeSlots(dur, items, config, now, horizonEnd, 3, it.id);
    }
  }
  return items;
}

/**
 * Ближайшие свободные слоты (>= длительности события), куда его можно перенести.
 * Считаем по «неподвижным» блокерам (другие fixed-события) — гибкие потом сами обтекут.
 */
/**
 * Ближайшие свободные окна, куда целиком влезает дело заданной длительности.
 * Дедлайн НЕ ограничивает — это варианты «куда вообще можно поставить».
 */
export function suggestFreeSlots(durationMinutes, items, config, now, horizonEnd, count = 3, excludeId) {
  if (!durationMinutes) return [];
  // занятыми считаем ВСЕ размещённые дела, а не только закреплённые: иначе предложим
  // место поверх существующего. Места, которые освободятся при сдвиге, подбираются отдельно.
  const blockers = items.filter((x) => x.id !== excludeId);
  const slots = slotsFitting(durationMinutes, blockers, config, now, horizonEnd);
  const out = [];
  for (const s of slots) {
    if (s.minutes >= durationMinutes) {
      out.push({ start: s.start.toISOString(), durationMinutes });
      if (out.length >= count) break;
    }
  }
  return out;
}

export function suggestSlots(item, items, config, now, horizonEnd, count = 3) {
  const dur = item.durationMinutes || 0;
  if (dur <= 0) return [];
  const blockers = items.filter((x) => x.id !== item.id && x.type === TYPE.FIXED);
  const slots = computeFreeSlots(blockers, config, now, horizonEnd);
  const cutoff = deadlineCutoff(item, config);
  const desired = item.start ? new Date(item.start).valueOf() : now.valueOf();

  // В каждом подходящем слоте берём старт, ближайший к желаемому времени; сортируем по близости.
  const cands = [];
  for (const s of slots) {
    let endLimit = s.end.valueOf();
    if (cutoff && endLimit > cutoff.valueOf()) endLimit = cutoff.valueOf();
    const latestStart = endLimit - dur * 60000;
    if (latestStart < s.start.valueOf()) continue; // событие не влезает в слот
    const start = Math.min(Math.max(desired, s.start.valueOf()), latestStart);
    cands.push({ start, dist: Math.abs(start - desired) });
  }
  cands.sort((a, b) => a.dist - b.dist);
  return cands.slice(0, count).map((c) => ({ start: new Date(c.start).toISOString(), durationMinutes: dur }));
}
