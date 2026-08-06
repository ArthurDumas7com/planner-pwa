// Ядро планировщика (ТЗ v2, раздел D). Детерминированно от (items, config, now).
import {
  TYPE, NATURE, STATUS, DEFAULT_CONFIG, newId, targetDuration, minDuration,
} from './model.js';
import { computeFreeSlots } from './freeSlots.js';
import {
  priorityScore, deadlineCutoff, placedMinutes,
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

    placeTask(best, freeSlots, config);
    pool.splice(pool.indexOf(best), 1);
  }

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
function clipSlots(freeSlots, cutoff) {
  if (!cutoff) return freeSlots;
  const out = [];
  for (const s of freeSlots) {
    if (s.start >= cutoff) continue;
    const end = s.end <= cutoff ? s.end : cutoff;
    const minutes = (end.valueOf() - s.start.valueOf()) / 60000;
    if (minutes > 0) out.push({ start: s.start, end, minutes });
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

/** Разместить одну задачу (D.4, D.6). */
function placeTask(task, freeSlots, config) {
  const already = placedMinutes(task);
  const toBookMax = targetDuration(task) - already;
  const needMin = Math.max(0, minDuration(task) - already);
  if (toBookMax <= 0) return;

  const cutoff = deadlineCutoff(task, config);
  const usable = clipSlots(freeSlots, cutoff);
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
    finishStatus(task);
    return;
  }

  // Ни один слот не вмещает задачу целиком.
  if (!canSplit) {
    const why = target <= (config.noSplitUnderMinutes || 0)
      ? `задача ${target} мин — не дробится; нужен один слот ≥ ${needMin} мин до дедлайна`
      : `нужен один свободный блок ≥ ${needMin} мин до дедлайна`;
    markAtRisk(task, why);
    return;
  }
  if (availBefore < needMin) {
    markAtRisk(task, `нужно ${needMin} мин, свободно ${Math.round(availBefore)} мин до дедлайна`, needMin - availBefore);
    return;
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
    markAtRisk(task, `свободное время дроблёное: не собрать ${needMin} мин кусками ≥ ${minChunk} мин`, needMin - booked);
  }
  finishStatus(task);
}
