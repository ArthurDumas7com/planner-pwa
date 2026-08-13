// Ядро планировщика (ТЗ v2, раздел D). Детерминированно от (items, config, now).
import {
  TYPE, NATURE, STATUS, DEFAULT_CONFIG, newId, targetDuration, minDuration,
} from './model.js';
import { computeFreeSlots } from './freeSlots.js';
import {
  priorityScore, deadlineCutoff, earliestFloor, placedMinutes,
} from './scoring.js';
import { startOfDay, addDays, fromDateKey, parseHM, dayAt } from './time.js';
import { detectFixedConflicts } from './conflicts.js';

/**
 * Расставить гибкие задачи по свободному времени. Мутирует и возвращает items.
 * @returns {{items:Array, placed:Array, atRisk:Array}}
 */
export function schedule(items, config = DEFAULT_CONFIG, now = new Date()) {
  const horizonEnd = computeHorizon(items, config, now);

  // Шаг 2 (D.5): замораживаем только вручную закреплённые (locked) чанки; остальное
  // пересобираем — незакреплённое всегда переливается вокруг событий, включая только что
  // добавленные fixed-события (иначе новое событие могло лечь поверх свежего авто-чанка).
  for (const t of items) {
    if (t.type !== TYPE.FLEXIBLE || t.status === STATUS.DONE) continue;
    t.chunks = (t.chunks || []).filter((c) => c.locked);
    t.atRisk = false;
    t.atRiskReason = null;
    t.shortfallMinutes = null;
  }

  const flexible = items.filter((t) => t.type === TYPE.FLEXIBLE && t.status !== STATUS.DONE);
  const pool = flexible.filter((t) => targetDuration(t) - placedMinutes(t) > 0);

  // Жадный цикл с пересчётом слотов и долей на каждой итерации (D.2, D.4).
  while (pool.length) {
    const freeSlots = computeFreeSlots(items, config, now, horizonEnd);
    const { strategic, total } = strategicShare(flexible);

    let best = null;
    let bestScore = -Infinity;
    for (const t of pool) {
      const s = priorityScore(t, freeSlots, config, strategic, total);
      if (s > bestScore || (s === bestScore && best && tieBreak(t, best) < 0)) {
        best = t;
        bestScore = s;
      }
    }

    // запасной набор слотов — без буферов вокруг дел; считаем только если понадобится
    placeTask(best, freeSlots, config,
      () => computeFreeSlots(items, config, now, horizonEnd, { buffer: 0 }));
    pool.splice(pool.indexOf(best), 1);
  }

  // Срастить фрагменты, если место освободилось (D.7: дробление — вынужденная мера).
  defragment(items, config, now, horizonEnd);

  // Жёсткие конфликты между событиями «ко времени» (случай A): пометить и предложить перенос.
  detectFixedConflicts(items, config, now, horizonEnd);

  const placed = flexible.filter((t) => !t.atRisk && placedMinutes(t) > 0);
  const atRisk = flexible.filter((t) => t.atRisk);
  const conflicts = items.filter((t) => t.conflict);
  return { items, placed, atRisk, conflicts };
}

function computeHorizon(items, config, now) {
  let end = addDays(startOfDay(now), config.horizonDays);
  for (const t of items) {
    const cutoff = deadlineCutoff(t, config);
    if (cutoff) {
      const ext = addDays(cutoff, 1);
      if (ext > end) end = ext;
    }
  }
  return end;
}

function strategicShare(flexible) {
  let strategic = 0;
  let total = 0;
  for (const t of flexible) {
    const m = placedMinutes(t);
    total += m;
    if (t.nature === NATURE.STRATEGIC) strategic += m;
  }
  return { strategic, total };
}

/** Порядок при равном score. Возвращает <0, если a приоритетнее b. */
function tieBreak(a, b) {
  const da = a.deadline || '9999-99-99';
  const db = b.deadline || '9999-99-99';
  if (da !== db) return da < db ? -1 : 1;
  const ma = minDuration(a);
  const mb = minDuration(b);
  if (ma !== mb) return ma - mb;
  if (a.createdAt !== b.createdAt) return a.createdAt < b.createdAt ? -1 : 1;
  return a.id < b.id ? -1 : 1;
}

/** Обрезать слоты до момента cutoff (Date|null). */
function clipSlots(freeSlots, cutoff, floor = null) {
  if (!cutoff && !floor) return freeSlots;
  const out = [];
  for (const s of freeSlots) {
    if (cutoff && s.start >= cutoff) continue;
    if (floor && s.end <= floor) continue;
    const start = floor && s.start < floor ? floor : s.start;
    const end = cutoff && s.end > cutoff ? cutoff : s.end;
    const minutes = (end.valueOf() - start.valueOf()) / 60000;
    if (minutes > 0) out.push({ start, end, minutes });
  }
  return out;
}

function addChunk(task, start, minutes) {
  task.chunks.push({
    id: newId('c'),
    start: new Date(start).toISOString(),
    durationMinutes: Math.round(minutes),
    locked: false,
    status: STATUS.SCHEDULED,
  });
}

function markAtRisk(task, reason, shortfall) {
  task.atRisk = true;
  task.atRiskReason = reason;
  if (shortfall != null) task.shortfallMinutes = Math.round(shortfall);
}

function finishStatus(task) {
  if (!task.atRisk && placedMinutes(task) > 0) task.status = STATUS.SCHEDULED;
}

/**
 * Разместить одну задачу (D.4, D.6).
 * Если с буферами вокруг дел места не нашлось, пробуем ещё раз впритык: 15-минутные
 * отступы — предпочтение, а не запрет. Иначе дело помечалось «не помещается» там,
 * где место для него объективно есть.
 * @param {Function} [tightSlots] ленивый расчёт слотов без буферов
 */
function placeTask(task, freeSlots, config, tightSlots) {
  const saved = (task.chunks || []).map((c) => ({ ...c }));
  const attempt = (slots) => {
    task.chunks = saved.map((c) => ({ ...c }));
    const r = tryPlace(task, slots, config);
    return { ...r, chunks: task.chunks };
  };

  let res = attempt(freeSlots);
  if (!res.ok && tightSlots) {
    const tight = attempt(tightSlots());
    if (tight.ok) res = tight;
  }
  task.chunks = res.chunks;
  if (!res.ok) markAtRisk(task, res.reason, res.shortfall);
  finishStatus(task);
}

/**
 * Одна попытка размещения по готовому списку слотов.
 * Ничего не помечает — только раскладывает чанки и сообщает, получилось ли.
 * @returns {{ok:boolean, reason?:string, shortfall?:number}}
 */
function tryPlace(task, freeSlots, config) {
  const already = placedMinutes(task);
  const toBookMax = targetDuration(task) - already;
  const needMin = Math.max(0, minDuration(task) - already);
  if (toBookMax <= 0) return { ok: true };

  const cutoff = deadlineCutoff(task, config);
  const usable = clipSlots(freeSlots, cutoff, earliestFloor(task, config));
  const availBefore = usable.reduce((s, x) => s + x.minutes, 0);

  // Анти-фрагментация (D.7): короткие задачи не дробим вообще; длинные — только вынужденно,
  // осколками не мельче minChunkFloorMinutes. Стараемся сохранять целостность.
  const target = targetDuration(task);
  const minChunk = Math.min(target, Math.max(task.minChunkMinutes, config.minChunkFloorMinutes || 0));
  const canSplit = task.splittable && target > (config.noSplitUnderMinutes || 0);

  // 1) Предпочитаем разместить одним куском (D.4.1): самый ранний слот, вмещающий хотя бы
  //    минимум. Кладём min(max, слот) — не дробим, если задача помещается целиком.
  const oneSlot = usable.find((s) => s.minutes >= needMin);
  if (oneSlot) {
    addChunk(task, oneSlot.start, Math.min(toBookMax, oneSlot.minutes));
    return { ok: true };
  }

  // Ни один слот не вмещает задачу целиком.
  if (!canSplit) {
    const why = target <= (config.noSplitUnderMinutes || 0)
      ? `задача ${target} мин — не дробится; нужен один слот ≥ ${needMin} мин до дедлайна`
      : `нужен один свободный блок ≥ ${needMin} мин до дедлайна`;
    return { ok: false, reason: why };
  }
  if (availBefore < needMin) {
    return {
      ok: false,
      reason: `нужно ${needMin} мин, свободно ${Math.round(availBefore)} мин до дедлайна`,
      shortfall: needMin - availBefore,
    };
  }

  // 2) Дробим крупными кусками ≥ minChunk, не оставляя неразмещаемый мелкий хвост (D.7).
  let booked = 0;
  for (const s of usable) {
    if (booked >= toBookMax) break;
    const remaining = toBookMax - booked;
    let want = Math.min(s.minutes, remaining);
    const leftover = remaining - want;
    if (leftover > 0 && leftover < minChunk && remaining >= 2 * minChunk) {
      want = remaining - minChunk; // хвост станет ровно minChunk (размещаемым), без мелочи
    }
    if (want < minChunk) {
      if (remaining < minChunk) break;  // остаток меньше куска — не крошим
      continue;                         // слот мал для валидного куска — пропускаем
    }
    addChunk(task, s.start, want);
    booked += want;
  }

  if (booked < needMin) {
    return {
      ok: false,
      reason: `свободное время дроблёное: не собрать ${needMin} мин кусками ≥ ${minChunk} мин`,
      shortfall: needMin - booked,
    };
  }
  return { ok: true };
}

/** Куски идут встык (или почти) — их можно склеить без изменения времени. */
const TOUCH_GAP_MIN = 1;

/**
 * Срастить фрагменты одной задачи.
 * Дробление — вынужденная мера: если место освободилось (удалили или перенесли дело),
 * задача должна вернуться одним куском, а не остаться разрезанной навсегда.
 * Закреплённые вручную куски тоже сращиваем, но стараемся оставить на прежнем месте.
 */
export function defragment(items, config, now, horizonEnd) {
  for (const t of items) {
    if (t.type !== TYPE.FLEXIBLE || t.status === STATUS.DONE) continue;
    if ((t.chunks || []).length < 2) continue;
    mergeTouching(t);
    if (t.chunks.length < 2) continue;

    // прошедшие и текущие куски уже прожиты — их не двигаем
    const chunks = [...t.chunks].sort((a, b) => new Date(a.start) - new Date(b.start));
    if (new Date(chunks[0].start).valueOf() < now.valueOf()) continue;

    const total = placedMinutes(t);
    const others = items.map((x) => (x.id === t.id ? { ...x, chunks: [] } : x));
    const usable = clipSlots(
      computeFreeSlots(others, config, now, horizonEnd),
      deadlineCutoff(t, config), earliestFloor(t, config),
    );
    const pinned = chunks.find((c) => c.locked);
    const anchorMs = new Date((pinned || chunks[0]).start).valueOf();
    // Первый фрагмент задаёт место: срослось — значит освободилось время следом за ним.
    // Место, выбранное пользователем вручную, при этом не уезжает.
    const atAnchor = usable.find((s) => s.start.valueOf() <= anchorMs
      && anchorMs + total * 60000 <= s.end.valueOf());
    // фрагменты, расставленные алгоритмом, можно собрать и в другом окне
    const slot = atAnchor || (pinned ? null : usable.find((s) => s.minutes >= total));
    if (!slot) continue;

    t.chunks = [{
      id: newId('c'),
      start: (atAnchor ? new Date(anchorMs) : slot.start).toISOString(),
      durationMinutes: total,
      locked: !!pinned,
      status: STATUS.SCHEDULED,
    }];
  }
  return items;
}

/** Склеить соседние куски, идущие встык. */
function mergeTouching(task) {
  const chunks = [...task.chunks].sort((a, b) => new Date(a.start) - new Date(b.start));
  const out = [];
  for (const c of chunks) {
    const prev = out[out.length - 1];
    const prevEnd = prev ? new Date(prev.start).valueOf() + prev.durationMinutes * 60000 : 0;
    const gap = prev ? (new Date(c.start).valueOf() - prevEnd) / 60000 : Infinity;
    if (prev && gap <= TOUCH_GAP_MIN && prev.locked === c.locked) {
      prev.durationMinutes += c.durationMinutes + Math.max(0, gap);
    } else out.push({ ...c });
  }
  task.chunks = out;
}
