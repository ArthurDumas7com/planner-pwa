// Скоринг задач (ТЗ v2, раздел D.2): priority = importance × urgency × balanceFactor.
import { NATURE, targetDuration } from './model.js';
import { parseHM, fromDateKey, dayAt } from './time.js';

export function workingMinutesPerDay(config) {
  return parseHM(config.workEnd) - parseHM(config.workStart);
}

/** Момент, до которого задача должна завершиться (конец дня дедлайна). null — нет дедлайна. */
export function deadlineCutoff(task, config) {
  if (!task.deadline) return null;
  return dayAt(fromDateKey(task.deadline), parseHM(config.workEnd));
}

/** Момент, раньше которого задачу ставить нельзя («с 10 по 12 авг»). null — ограничения нет. */
export function earliestFloor(task, config) {
  if (!task.earliest) return null;
  return dayAt(fromDateKey(task.earliest), parseHM(config.workStart));
}

/** Сколько минут уже размещено (по чанкам). */
export function placedMinutes(task) {
  return (task.chunks || []).reduce((s, c) => s + c.durationMinutes, 0);
}

/** Сумма свободных минут в окне [floor, cutoff) (оба Date|null -> без границы). */
export function freeMinutesBefore(freeSlots, cutoff, floor = null) {
  let sum = 0;
  for (const s of freeSlots) {
    if (cutoff && s.start >= cutoff) continue;
    if (floor && s.end <= floor) continue;
    const start = floor && s.start < floor ? floor : s.start;
    const end = cutoff && s.end > cutoff ? cutoff : s.end;
    if (end > start) sum += (end.valueOf() - start.valueOf()) / 60000;
  }
  return sum;
}

/** Ургентность по «слаку» (раздел D.2). */
export function urgency(task, freeSlots, config) {
  if (!task.deadline) return 1;
  const remaining = Math.max(0, targetDuration(task) - placedMinutes(task));
  const cutoff = deadlineCutoff(task, config);
  const freeBefore = freeMinutesBefore(freeSlots, cutoff, earliestFloor(task, config));
  const slackMinutes = freeBefore - remaining;
  const slackDays = slackMinutes / workingMinutesPerDay(config);
  return 1 + 1 / Math.max(slackDays, 0.5);
}

/** Балансирующий множитель: защищает стратегию (раздел D.2). */
export function balanceFactor(task, placedStrategic, placedTotal, config) {
  if (task.nature !== NATURE.STRATEGIC) return 1;
  const share = placedTotal > 0 ? placedStrategic / placedTotal : 0;
  return 1 + config.balanceK * Math.max(0, config.targetStrategic - share);
}

/**
 * Компенсация за переносы: задача, которую уже двигали, при освободившемся времени
 * возвращается раньше других. Стратегическим компенсация выше — их вытесняют чаще.
 */
export function moveBoost(task, config) {
  const moved = Math.min(task.movedCount || 0, 3);
  if (!moved) return 1;
  const per = task.nature === NATURE.STRATEGIC
    ? (config.moveBoostStrategic ?? 0.25)
    : (config.moveBoostTactical ?? 0.1);
  return 1 + moved * per;
}

export function priorityScore(task, freeSlots, config, placedStrategic, placedTotal) {
  const imp = task.importance || 1;
  return imp
    * urgency(task, freeSlots, config)
    * balanceFactor(task, placedStrategic, placedTotal, config)
    * moveBoost(task, config);
}
