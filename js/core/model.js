// Модель данных и константы (ТЗ v2, разделы A и E).

export const TYPE = { FIXED: 'fixed', FLEXIBLE: 'flexible' };
export const NATURE = { STRATEGIC: 'strategic', TACTICAL: 'tactical' };
export const STATUS = {
  UNSCHEDULED: 'unscheduled',
  SCHEDULED: 'scheduled',
  IN_PROGRESS: 'in_progress',
  DONE: 'done',
};

export const CATEGORIES = ['work', 'own_business', 'personal_brand', 'personal'];

export const DEFAULT_CONFIG = {
  workStart: '08:00',
  workEnd: '22:00',
  horizonDays: 14,          // минимальный горизонт планирования
  targetStrategic: 0.33,    // целевая доля стратегии (раздел D.2)
  balanceK: 2,              // коэффициент отыгрыша квоты (раздел F)
  daysVisible: 1,             // 1 — экран одного дня (начальный), 3 или 5 — календарь
  dayWindows: {},             // окно планирования отдельного дня: 'YYYY-MM-DD' -> {start,end}
  configVersion: 2,           // версия настроек (для миграций при обновлении приложения)
  bufferMinutes: 15,          // обязательный разрыв вокруг каждого дела (D.7)
  moveBoostStrategic: 0.25,   // компенсация за перенос: стратегическим возвращаем время быстрее
  moveBoostTactical: 0.1,     // тактическим — слабее (D.20)
  noSplitUnderMinutes: 90,    // задачи не длиннее этого не дробим вообще (D.7)
  minChunkFloorMinutes: 45,   // минимальный осколок при вынужденном дроблении (D.7)
  spreadFromDays: 3,          // дедлайн дальше этого — не уплотняем, ищем спокойный день
  busyDayMinutes: 240,        // день считается загруженным начиная с этого времени
};

let counter = 0;
export function newId(prefix = 'id') {
  counter += 1;
  return `${prefix}_${Date.now().toString(36)}_${counter}`;
}

/**
 * Создать задачу. Поля `confidence` помечают неуверенно/пусто заполненные
 * поля для подсветки красным на экране подтверждения (раздел B.4).
 */
export function makeTask(p = {}) {
  return {
    id: p.id || newId('t'),
    title: p.title || '',
    type: p.type || TYPE.FLEXIBLE,
    nature: p.nature || NATURE.TACTICAL,
    category: p.category || 'personal',
    createdAt: p.createdAt || new Date().toISOString(),
    status: p.status || STATUS.UNSCHEDULED,

    // здоровье (ортогонально status)
    atRisk: p.atRisk || false,
    atRiskReason: p.atRiskReason || null,
    shortfallMinutes: p.shortfallMinutes ?? null,
    // где дело стояло до вытеснения — показываем его там, пока конфликт не разрешён
    displacedFrom: p.displacedFrom || null,

    // fixed
    start: p.start || null,                 // ISO-строка
    durationMinutes: p.durationMinutes ?? null,

    // flexible
    durationMinMinutes: p.durationMinMinutes ?? null,
    durationMaxMinutes: p.durationMaxMinutes ?? null,
    importance: p.importance ?? null,       // 1..5
    earliest: p.earliest || null,           // 'YYYY-MM-DD' — не раньше этой даты («с 10 по 12 авг»)
    deadline: p.deadline || null,           // 'YYYY-MM-DD'
    splittable: p.splittable ?? true,
    minChunkMinutes: p.minChunkMinutes ?? 30,

    // повторяемость: null | {everyDays:n} | {weekdays:[0..6]}; необязательное поле until —
    // дата окончания повтора (многодневные периоды: отпуск, поездка)
    recurrence: p.recurrence || null,
    exdates: p.exdates || [],      // дни, вырванные из цикла повторения ('YYYY-MM-DD')
    doneDates: p.doneDates || [],  // дни, отмеченные сделанными поштучно (весь цикл — status)
    allDay: p.allDay || false,     // занимает день целиком

    // вывод планировщика: [{id,start(ISO),durationMinutes,locked,status}]
    // status у куска — своя отметка «сделано» (дробная задача закрывается по частям)
    chunks: p.chunks || [],

    // сколько раз дело уже переносили (для маркера «переносилось»)
    movedCount: p.movedCount ?? 0,

    // мета для подсветки: {field: 'ok'|'low'|'missing'}
    confidence: p.confidence || {},
  };
}

/** Целевая длительность (максимум диапазона). Для fixed — durationMinutes. */
export function targetDuration(task) {
  if (task.type === TYPE.FIXED) return task.durationMinutes || 0;
  return task.durationMaxMinutes ?? task.durationMinMinutes ?? 0;
}

export function minDuration(task) {
  return task.durationMinMinutes ?? task.durationMaxMinutes ?? 0;
}

/**
 * Кусок отмечен сделанным. Задачу, разбитую алгоритмом на части, закрывают
 * по частям: галочка на одном фрагменте не трогает остальные (D.27).
 */
export function isChunkDone(chunk) {
  return !!chunk && chunk.status === STATUS.DONE;
}

/** Сколько минут задачи уже прожито — сумма отмеченных частей. */
export function doneMinutes(task) {
  return (task.chunks || []).reduce((s, c) => s + (isChunkDone(c) ? c.durationMinutes : 0), 0);
}

/**
 * Ручное изменение длины куска меняет и длительность самой задачи (D.7).
 * Руками задают, сколько дело длится, а не «сколько от него влезло сюда»: иначе
 * разница повисала бы неразмещённым хвостом, и укороченное дело тут же помечалось
 * «не помещается» — там, где до укорачивания всё было в порядке.
 * Двигаем диапазон на ту же дельту: у дела с вилкой min…max она сохраняется.
 */
export function resizeChunk(task, chunk, minutes) {
  const next = Math.max(1, Math.round(minutes));
  const delta = next - chunk.durationMinutes;
  chunk.durationMinutes = next;
  if (!delta || task.type !== TYPE.FLEXIBLE) return task;
  const base = targetDuration(task) || (next - delta);
  const max = Math.max(1, base + delta);
  task.durationMaxMinutes = max;
  task.durationMinMinutes = Math.max(1, Math.min(max, (task.durationMinMinutes ?? base) + delta));
  return task;
}
