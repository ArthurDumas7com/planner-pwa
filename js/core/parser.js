// Русский keyword-парсер (ТЗ v2, раздел B). Детерминированный: правила + словари, без ИИ.
// Всегда возвращает частичную задачу + карту confidence для подсветки на экране подтверждения.
import { TYPE, NATURE, makeTask } from './model.js';
import {
  COMMAND_WORDS, DAYPARTS, DURATION_UNITS, RU_NUMERALS, DEFAULT_DURATIONS, DEFAULT_DURATION_MINUTES,
  RELATIVE_START, RELATIVE_START_WORDS, RECURRENCE_RULES,
  IMPORTANCE_WORDS, NATURE_WORDS, CATEGORY_WORDS, REL_DATES, WEEKDAYS, WEEKDAY_ABBR, MONTHS,
  TITLE_STOPWORDS, IMPORTANCE_STRIP, SPLIT_NO, SPLIT_YES, WINDOW_TASK_MARKERS,
} from './dict.js';
import { toDateKey, fromDateKey } from './time.js';

const ALL_DAY_START_H = 8;      // многодневные периоды показываем с начала рабочего дня
const ALL_DAY_MINUTES = 14 * 60; // и на всю его длину

/**
 * Разобрать текст в черновик задачи.
 * @returns {{task, confidence, blocking: string[]}}
 */
export function parseTask(text, now = new Date()) {
  let residual = ` ${text.toLowerCase()} `;
  const conf = {};
  const fields = {};

  // 1. Повторяемость
  for (const rule of RECURRENCE_RULES) {
    const m = residual.match(rule.re);
    if (m) {
      fields.recurrence = typeof rule.rec === 'function' ? rule.rec(m) : rule.rec;
      conf.recurrence = 'ok';
      residual = blank(residual, m.index, m[0].length);
      break;
    }
  }

  // 1.5. «через 10 минут» / «через час» — это время начала, а не длительность.
  //      Снимаем до разбора длительности, иначе «10 минут» уедет в длительность.
  const relWord = RELATIVE_START_WORDS.map((w) => ({ w, m: residual.match(w.re) })).find((x) => x.m);
  const rel = residual.match(RELATIVE_START);
  const relOffset = relWord ? relWord.w.minutes : (rel ? Number(rel[1]) * (/^(час|ч)/.test(rel[2]) ? 60 : 1) : null);
  if (relOffset != null) {
    const startAt = new Date(now.valueOf() + relOffset * 60000);
    fields.time = { h: startAt.getHours(), min: startAt.getMinutes() };
    conf.time = 'ok';
    const hit = relWord ? relWord.m : rel;
    residual = blank(residual, hit.index, hit[0].length);
  }

  // 2. Длительность — оба порядка слов и диапазоны: «3 часа», «часа 3», «часа 4-5».
  const dur = parseDurations(residual);
  if (dur.found) {
    fields.durationMin = dur.min; fields.durationMax = dur.max;
    fields.durationExplicit = true;                  // длительность названа в тексте
    conf.duration = 'ok'; residual = dur.residual;
  }

  // 2.4. Период: «следующие два дня», «ближайшие 3 дня», «с 4 по 6 авг»
  const dr = parseRelativeSpan(residual, now) || parseDateRange(residual, now);
  if (dr) {
    fields.dateRange = dr;
    conf.dateRange = 'ok';
    residual = blank(residual, dr.index, dr.length);
    // «с 10 по 12 авг нужно сделать отчёт» — это не занятые дни целиком, а окно,
    // внутри которого алгоритм сам выберет время: не раньше «от», не позже «до».
    fields.dateWindow = WINDOW_TASK_MARKERS.test(text.toLowerCase());
  }

  // 2.5. Диапазон времени «с 10 до 17» -> начало + длительность (fixed-событие)
  const range = parseTimeRange(residual);
  if (range) {
    fields.time = { h: Math.floor(range.startMin / 60), min: range.startMin % 60 };
    conf.time = 'ok';
    if (fields.durationMax == null && range.endMin > range.startMin) {
      fields.durationMin = range.endMin - range.startMin;
      fields.durationMax = range.endMin - range.startMin;
      fields.durationExplicit = true;
      conf.duration = 'ok';
    }
    residual = blank(residual, range.index, range.length);
  }

  // 2.45. Дата события без предлога: «25 августа», «25.08» (с предлогом это дедлайн — шаг 3)
  const ed = parseEventDate(residual, now);
  if (ed) { fields.eventDate = ed.date; conf.eventDate = 'ok'; residual = blank(residual, ed.index, ed.length); }

  // 2.6. Длительность не указана — ставим дефолт (1,5 часа; по типу дела может отличаться).
  //      Помечаем 'low' (жёлтое): подставлено по умолчанию, легко поменять.
  //      Многодневный период — исключение: он занимает дни целиком, дефолт тут не нужен
  //      (но окну «с 10 по 12 нужно…» длительность как раз нужна — его планирует алгоритм).
  if (fields.durationMax == null && !(fields.dateRange && !fields.dateWindow)
      && !(fields.eventDate && !fields.time)) {
    const norm0 = ` ${text.toLowerCase()} `;
    const byType = DEFAULT_DURATIONS.find((d) => d.re.test(norm0));
    const mins = byType ? byType.minutes : DEFAULT_DURATION_MINUTES;
    fields.durationMin = mins;
    fields.durationMax = mins;
    conf.duration = 'low';
  }

  // 3. Дедлайн (снимает «до пятницы» и т.п. — что останется из дней недели, будет днём события)
  const dl = parseDeadline(residual, now);
  if (dl) { fields.deadline = dl.date; fields.deadlineRelative = !!dl.relative; conf.deadline = 'ok'; residual = blank(residual, dl.index, dl.length); }

  // 4. Время «в 7 утра» (если диапазон не задан)
  if (!fields.time) {
    const tm = parseTime(residual);
    if (tm) { fields.time = tm; conf.time = 'ok'; residual = blank(residual, tm.index, tm.length); }
  }

  // 4.4. «Завтра в 20:00» — это дата события, а не дедлайн (со временем всегда так)
  if (fields.time && fields.deadlineRelative && !fields.eventDate && !fields.dateRange) {
    fields.eventDate = fields.deadline;
    fields.deadline = null;
    delete conf.deadline;
  }

  // 4.5. День недели события («Пт …») — оставшийся день недели трактуем как дату события
  if (fields.time) {
    const wd = parseEventWeekday(residual);
    if (wd) { fields.eventWeekday = wd.weekday; residual = blank(residual, wd.index, wd.length); }
  }

  // 5. Важность / характер / категория — по ключевым словам (всегда низкая уверенность)
  const norm = ` ${text.toLowerCase()} `;
  fields.importance = scanImportance(norm);
  fields.nature = scanNature(norm);
  fields.category = scanCategory(norm);
  fields.splittable = scanSplittable(norm);

  // 6. Заголовок из остатка (сначала убираем распознанные сигналы и вводные слова)
  // служебные слова про время и длительность в названии не нужны
  residual = residual.replace(SPLIT_NO, ' ').replace(SPLIT_YES, ' ')
    .replace(/думаю|думается|полагаю|наверн[а-яё]*|займ[её]т[а-яё]*|куда-?нибудь/g, ' ')
    .replace(/продл(?:ит|ят)ся|продолжится|начн[её]тся|начина[ею]тся|начало|стартует|длится|идёт\s+часа?/g, ' ');
  fields.title = cleanTitle(residual);

  return assemble(fields, conf, now);
}

function assemble(f, conf, now) {
  // окно «с 10 по 12 нужно…» ко времени не привязано: место внутри окна выбирает алгоритм
  const isWindow = !!f.dateRange && !!f.dateWindow && !f.time;
  const isFixed = !isWindow && (!!f.time || !!f.dateRange || !!f.eventDate);
  const blocking = [];

  const base = {
    title: f.title || '',
    type: isFixed ? TYPE.FIXED : TYPE.FLEXIBLE,
    recurrence: f.recurrence || null,
    nature: f.nature.value,
    category: f.category.value,
    importance: f.importance.value,
    deadline: f.deadline || null,
    splittable: f.splittable,
  };

  conf.title = f.title ? 'ok' : 'missing';
  conf.nature = f.nature.conf;
  conf.category = f.category.conf;

  if (isWindow) {
    // окно планирования: не раньше «от», не позже «до»
    base.earliest = f.dateRange.from;
    base.deadline = f.dateRange.to;
    base.importance = f.importance.value;
    conf.importance = f.importance.conf;
    base.durationMinMinutes = f.durationMin;
    base.durationMaxMinutes = f.durationMax;
    conf.earliest = 'ok';
    conf.deadline = 'ok';
  } else if (f.dateRange) {
    // период: со временем («следующие 2 дня в 7 утра») — дело каждый день в это время;
    // без времени («с 4 по 6 авг отпуск») — каждый день занят целиком.
    const start = fromDateKey(f.dateRange.from);
    if (f.time) start.setHours(f.time.h, f.time.min, 0, 0);
    else start.setHours(ALL_DAY_START_H, 0, 0, 0);
    base.start = start.toISOString();
    // со временем — обычная дефолтная длительность; без времени — весь день
    base.durationMinutes = f.durationMax ?? (f.time ? DEFAULT_DURATION_MINUTES : ALL_DAY_MINUTES);
    base.allDay = !f.time && f.durationMax == null;
    // если в тексте был свой ритм («каждый второй день», «по будням») — сохраняем его,
    // период лишь ограничивает конец повтора
    base.recurrence = { ...(f.recurrence || { everyDays: 1 }), until: f.dateRange.to };
    conf.start = 'ok';
    if (f.durationExplicit) conf.duration = 'ok';
  } else if (f.eventDate) {
    // конкретная дата: со временем — событие в это время, без времени — на весь день (др, праздник)
    const start = fromDateKey(f.eventDate);
    if (f.time) start.setHours(f.time.h, f.time.min, 0, 0);
    else start.setHours(ALL_DAY_START_H, 0, 0, 0);
    base.start = start.toISOString();
    // со временем — обычная дефолтная длительность; без времени — весь день
    base.durationMinutes = f.durationMax ?? (f.time ? DEFAULT_DURATION_MINUTES : ALL_DAY_MINUTES);
    base.allDay = !f.time && f.durationMax == null;
    conf.start = 'ok';
    if (f.durationExplicit) conf.duration = 'ok';
  } else if (isFixed) {
    base.start = timeToISO(f.time, now, f.eventWeekday);
    conf.start = 'ok';
    base.durationMinutes = f.durationMax;   // всегда задана (см. дефолт в parseTask)
  } else {
    base.importance = f.importance.value;
    conf.importance = f.importance.conf;
    base.durationMinMinutes = f.durationMin;
    base.durationMaxMinutes = f.durationMax;
    if (f.deadline) conf.deadline = 'ok';
  }

  if (!f.title) blocking.push('title');

  return { task: makeTask(base), confidence: conf, blocking };
}

// ---- частные разборщики ----

function parseTime(residual) {
  // HH:MM или HH.MM
  let m = residual.match(/(?:^|\s)(?:в\s*)?(\d{1,2})[:.\-](\d{2})(?=\s|$)/);
  if (m) {
    const h = Number(m[1]); const min = Number(m[2]);
    // длина считается от позиции числа до конца совпадения, иначе затирается лишний символ
    if (h < 24 && min < 60) {
      const off = m[0].indexOf(m[1]);
      return { h, min, index: m.index + off, length: m[0].length - off };
    }
  }
  // «в 7 утра», «с 9 утра», «в 19», «в 7 часов вечера»
  // (диапазоны «с 10 до 17» и «с 4 по 6 авг» разобраны раньше и уже вырезаны)
  m = residual.match(/(?:в|с)\s*(\d{1,2})(?:\s*час[а-яё]*)?\s*(утр[а-яё]*|дня|вечер[а-яё]*|ноч[а-яё]*|полудня)?/);
  if (m) {
    let h = Number(m[1]);
    const part = m[2] ? dayPartKind(m[2]) : null;
    if (part === 'am' && h === 12) h = 0;
    if (part === 'pm' && h < 12) h += 12;
    if (part === 'night' && h === 12) h = 0;          // «12 ночи» = полночь
    if (part === 'night' && h >= 1 && h <= 5) h += 0; // «2 часа ночи» = 02:00
    if (h < 24) return { h, min: 0, index: m.index, length: m[0].length };
  }
  return null;
}

/** Найти месяц по слову: и «августа», и сокращение «авг». */
function monthFromWord(word) {
  const key = Object.keys(MONTHS).find((k) => word.startsWith(k) || k.startsWith(word));
  return key != null ? MONTHS[key] : null;
}

/**
 * Дата события без предлога: «25 августа», «25 авг», «25.08».
 * С предлогом («до 25 августа», «с 4 по 6») это дедлайн или период — их разбирают другие правила,
 * поэтому такие вхождения здесь пропускаем.
 */
function parseEventDate(residual, now) {
  const PREP = /(?:до|к|с|по|со)\s*$/;
  const mkDate = (day, mon) => {
    let d = new Date(now.getFullYear(), mon, day);
    const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    if (d < today) d = new Date(now.getFullYear() + 1, mon, day);   // дата уже прошла — значит следующий год
    return toDateKey(d);
  };

  // «25 августа» / «25 авг»
  let re = /(\d{1,2})\s+([а-яё]{3,})/g;
  let m;
  while ((m = re.exec(residual)) !== null) {
    if (PREP.test(residual.slice(0, m.index))) continue;
    const mon = monthFromWord(m[2]);
    if (mon != null) return { date: mkDate(Number(m[1]), mon), index: m.index, length: m[0].length };
  }
  // «25.08» / «25/08»
  re = /(\d{1,2})[.\-/](\d{1,2})(?![.\-/\d])/g;
  while ((m = re.exec(residual)) !== null) {
    if (PREP.test(residual.slice(0, m.index))) continue;
    const mon = Number(m[2]) - 1;
    if (mon >= 0 && mon <= 11) return { date: mkDate(Number(m[1]), mon), index: m.index, length: m[0].length };
  }
  return null;
}

/**
 * Относительный период: «следующие два дня», «ближайшие 3 дня», «2 дня подряд».
 * «Следующие N дней» отсчитываем с завтра, «N дней подряд» — с сегодня.
 */
function parseRelativeSpan(residual, now) {
  const numWord = `(\\d+|${RU_NUMERALS.map(([w]) => w).join('|')})`;
  const toNum = (s) => (/^\d+$/.test(s) ? Number(s) : (RU_NUMERALS.find(([w]) => w === s) || [null, 1])[1]);
  const span = (startOffset, count, m) => {
    const from = new Date(now.getFullYear(), now.getMonth(), now.getDate() + startOffset);
    const to = new Date(now.getFullYear(), now.getMonth(), now.getDate() + startOffset + count - 1);
    return { from: toDateKey(from), to: toDateKey(to), index: m.index, length: m[0].length };
  };

  let m = residual.match(new RegExp(`(?:следующ[а-яё]*|ближайш[а-яё]*)\\s+${numWord}\\s+д(?:ня|ней|ень)`));
  if (m) return span(1, toNum(m[1]), m);
  m = residual.match(new RegExp(`${numWord}\\s+д(?:ня|ней|ень)\\s+подряд`));
  if (m) return span(0, toNum(m[1]), m);
  return null;
}

/** Диапазон дат: «с 4 по 6 авг», «с 04.08 по 06.08», «4–6 августа». */
function parseDateRange(residual, now) {
  const mk = (d1, m1, d2, m2) => {
    const y = now.getFullYear();
    let from = new Date(y, m1, d1);
    let to = new Date(y, m2 ?? m1, d2);
    if (to < from) to = new Date(y + 1, m2 ?? m1, d2);         // период через новый год
    if (to < new Date(now.getFullYear(), now.getMonth(), now.getDate() - 180)) {
      from = new Date(y + 1, m1, d1); to = new Date(y + 1, m2 ?? m1, d2);
    }
    return { from: toDateKey(from), to: toDateKey(to) };
  };

  // «с 4 по 6 авг(уста)»
  let m = residual.match(/с\s+(\d{1,2})\s+по\s+(\d{1,2})\s+([а-яё]+)/);
  if (m) {
    const mon = monthFromWord(m[3]);
    if (mon != null) return { ...mk(Number(m[1]), mon, Number(m[2]), mon), index: m.index, length: m[0].length };
  }
  // «с 4 августа по 6 августа»
  m = residual.match(/с\s+(\d{1,2})\s+([а-яё]+)\s+по\s+(\d{1,2})\s+([а-яё]+)/);
  if (m) {
    const m1 = monthFromWord(m[2]); const m2 = monthFromWord(m[4]);
    if (m1 != null && m2 != null) return { ...mk(Number(m[1]), m1, Number(m[3]), m2), index: m.index, length: m[0].length };
  }
  // «с 04.08 по 06.08»
  m = residual.match(/с\s+(\d{1,2})[.\-/](\d{1,2})\s+по\s+(\d{1,2})[.\-/](\d{1,2})/);
  if (m) {
    return { ...mk(Number(m[1]), Number(m[2]) - 1, Number(m[3]), Number(m[4]) - 1), index: m.index, length: m[0].length };
  }
  // «4–6 августа»
  m = residual.match(/(\d{1,2})\s*[-–—]\s*(\d{1,2})\s+([а-яё]+)/);
  if (m) {
    const mon = monthFromWord(m[3]);
    if (mon != null) return { ...mk(Number(m[1]), mon, Number(m[2]), mon), index: m.index, length: m[0].length };
  }
  // смешанный период: «с завтра по 6 авг», «с сегодня по 10.08», «с 4 авг по послезавтра»
  m = residual.match(/с\s+([а-яё]+|\d{1,2}(?:[.\-/]\d{1,2})?(?:\s+[а-яё]+)?)\s+по\s+([а-яё]+|\d{1,2}(?:[.\-/]\d{1,2})?(?:\s+[а-яё]+)?)/);
  if (m) {
    const from = resolveDatePoint(m[1], now);
    const to = resolveDatePoint(m[2], now);
    if (from && to) return { from, to, index: m.index, length: m[0].length };
  }
  return null;
}

/** Одна точка периода: «завтра», «6 авг», «10.08». Возвращает 'YYYY-MM-DD' или null. */
function resolveDatePoint(str, now) {
  const s = str.trim();
  if (REL_DATES[s] != null) {
    return toDateKey(new Date(now.getFullYear(), now.getMonth(), now.getDate() + REL_DATES[s]));
  }
  const fwd = (day, mon) => {
    let d = new Date(now.getFullYear(), mon, day);
    const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    if (d < today) d = new Date(now.getFullYear() + 1, mon, day);
    return toDateKey(d);
  };
  let m = s.match(/^(\d{1,2})\s+([а-яё]+)$/);
  if (m) { const mon = monthFromWord(m[2]); if (mon != null) return fwd(Number(m[1]), mon); }
  m = s.match(/^(\d{1,2})[.\-/](\d{1,2})$/);
  if (m) { const mon = Number(m[2]) - 1; if (mon >= 0 && mon <= 11) return fwd(Number(m[1]), mon); }
  return null;
}

// Диапазон времени: «с 10 до 17», «с 10:00 до 17:30», «с 9 до 18 часов».
function parseTimeRange(residual) {
  const m = residual.match(/с\s*(\d{1,2})(?::(\d{2}))?\s*до\s*(\d{1,2})(?::(\d{2}))?/);
  if (!m) return null;
  const sh = Number(m[1]); const sm = Number(m[2] || 0);
  const eh = Number(m[3]); const em = Number(m[4] || 0);
  if (sh >= 24 || eh >= 24 || sm >= 60 || em >= 60) return null;
  const startMin = sh * 60 + sm;
  const endMin = eh * 60 + em;
  if (endMin <= startMin) return null;
  return { startMin, endMin, index: m.index, length: m[0].length };
}

// День недели события: оставшийся в тексте день недели (дедлайны «до пятницы» уже сняты).
function parseEventWeekday(residual) {
  // аббревиатуры как отдельные токены: «пт», «сб»…
  let m = residual.match(/(?:^|\s)(вс|пн|вт|ср|чт|пт|сб)(?=[\s,.!]|$)/);
  if (m) {
    return { weekday: WEEKDAY_ABBR[m[1]], index: m.index + m[0].indexOf(m[1]), length: m[1].length };
  }
  // полные названия («в пятницу», «пятница»)
  for (const [stem, idx] of Object.entries(WEEKDAYS)) {
    const mm = residual.match(new RegExp(`(?:^|\\s)((?:в\\s+)?${stem}[а-яё]*)(?=[\\s,.!]|$)`));
    if (mm) return { weekday: idx, index: mm.index + (mm[0].length - mm[1].length), length: mm[1].length };
  }
  return null;
}

function dayPartKind(word) {
  for (const key of Object.keys(DAYPARTS)) {
    if (word.startsWith(key.slice(0, 4))) return DAYPARTS[key];
  }
  if (word.startsWith('утр')) return 'am';
  if (word.startsWith('вечер')) return 'pm';
  if (word.startsWith('ноч')) return 'night';
  if (word === 'дня' || word === 'полудня') return 'pm';
  return null;
}

function timeToISO(t, now, weekday) {
  const d = new Date(now.getFullYear(), now.getMonth(), now.getDate(), t.h, t.min, 0, 0);
  if (weekday != null) {
    let add = (weekday - d.getDay() + 7) % 7;
    if (add === 0 && d < now) add = 7; // сегодня этот день, но время прошло -> через неделю
    d.setDate(d.getDate() + add);
  } else if (d < now) {
    d.setDate(d.getDate() + 1); // время сегодня прошло -> на завтра
  }
  return d.toISOString();
}

function parseDeadline(residual, now) {
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());

  // «до конца дня» -> сегодня
  let m = residual.match(/(?:до|к)\s+кон(?:ца|цу)\s+дня/);
  if (m) return { date: toDateKey(today), index: m.index, length: m[0].length };

  // «до конца недели» -> ближайшее воскресенье
  m = residual.match(/(?:до|к)\s+кон(?:ца|цу)\s+недел[а-яё]*/);
  if (m) {
    const d = new Date(today);
    d.setDate(d.getDate() + ((7 - d.getDay()) % 7)); // вс этой недели (0=вс)
    return { date: toDateKey(d), index: m.index, length: m[0].length };
  }

  // «до конца месяца» -> последний день месяца
  m = residual.match(/(?:до|к)\s+кон(?:ца|цу)\s+месяц[а-яё]*/);
  if (m) {
    const d = new Date(now.getFullYear(), now.getMonth() + 1, 0);
    return { date: toDateKey(d), index: m.index, length: m[0].length };
  }

  const sunday = (base, addWeeks) => {
    const d = new Date(base);
    d.setDate(d.getDate() + ((7 - d.getDay()) % 7) + addWeeks * 7);
    return d;
  };

  // «на эту неделю» / «на этой неделе» / «на неделю ... эту» (порядок слов свободный)
  m = residual.match(/на\s+эт[а-яё]+\s+недел[а-яё]+/)
    || residual.match(/на\s+недел[а-яё]+\s+(?:на\s+)?эт[а-яё]+/)
    || residual.match(/эт[а-яё]+\s+недел[а-яё]+/)
    || residual.match(/недел[а-яё]+\s+(?:на\s+)?эт[ауой][а-яё]*/);
  if (m) return { date: toDateKey(sunday(today, 0)), index: m.index, length: m[0].length };

  // «на следующей неделе» / «на следующую неделю»
  m = residual.match(/на\s+след[а-яё]+\s+недел[а-яё]+/)
    || residual.match(/на\s+недел[а-яё]+\s+след[а-яё]+/);
  if (m) return { date: toDateKey(sunday(today, 1)), index: m.index, length: m[0].length };

  // относительные слова — только как отдельные слова: «завтрак» не должен читаться как «завтра»
  for (const [word, off] of Object.entries(REL_DATES)) {
    const mm = residual.match(new RegExp(`(^|[\\s,;.])(${word})(?=[\\s,;.]|$)`));
    if (mm) {
      const d = new Date(now.getFullYear(), now.getMonth(), now.getDate() + off);
      return { date: toDateKey(d), index: mm.index + mm[1].length, length: word.length, relative: true };
    }
  }
  // «до 25.07» / «к 25/07»
  m = residual.match(/(?:до|к)\s+(\d{1,2})[.\-/](\d{1,2})(?:[.\-/](\d{2,4}))?/);
  if (m) {
    const day = Number(m[1]); const mon = Number(m[2]) - 1;
    let year = m[3] ? Number(m[3]) : now.getFullYear();
    if (year < 100) year += 2000;
    let d = new Date(year, mon, day);
    if (!m[3] && d < now) d = new Date(year + 1, mon, day);
    return { date: toDateKey(d), index: m.index, length: m[0].length };
  }
  // «до 25 июля»
  m = residual.match(/(?:до|к)\s+(\d{1,2})\s+([а-яё]+)/);
  if (m) {
    const day = Number(m[1]);
    const monKey = Object.keys(MONTHS).find((k) => m[2].startsWith(k));
    if (monKey != null) {
      let d = new Date(now.getFullYear(), MONTHS[monKey], day);
      if (d < now) d = new Date(now.getFullYear() + 1, MONTHS[monKey], day);
      return { date: toDateKey(d), index: m.index, length: m[0].length };
    }
  }
  // «до пятницы»
  m = residual.match(/(?:до|к)\s+([а-яё]+)/);
  if (m) {
    const wdKey = Object.keys(WEEKDAYS).find((k) => m[1].startsWith(k));
    if (wdKey != null) {
      const target = WEEKDAYS[wdKey];
      const d = new Date(now.getFullYear(), now.getMonth(), now.getDate());
      let add = (target - d.getDay() + 7) % 7;
      if (add === 0) add = 7;
      d.setDate(d.getDate() + add);
      return { date: toDateKey(d), index: m.index, length: m[0].length };
    }
  }
  return null;
}

function scanImportance(norm) {
  for (const w of IMPORTANCE_WORDS) {
    if (w.re.test(norm)) return { value: w.value, conf: 'low' };
  }
  return { value: 3, conf: 'missing' }; // по умолчанию — среднее, требует подтверждения
}

function scanNature(norm) {
  for (const kw of NATURE_WORDS.strategic) if (norm.includes(kw)) return { value: NATURE.STRATEGIC, conf: 'low' };
  for (const kw of NATURE_WORDS.tactical) if (norm.includes(kw)) return { value: NATURE.TACTICAL, conf: 'low' };
  return { value: NATURE.TACTICAL, conf: 'missing' };
}

function scanCategory(norm) {
  for (const [cat, words] of Object.entries(CATEGORY_WORDS)) {
    for (const kw of words) if (norm.includes(kw)) return { value: cat, conf: 'low' };
  }
  return { value: 'personal', conf: 'missing' };
}

// ---- утилиты ----

function blank(str, index, length) {
  return str.slice(0, index) + ' '.repeat(length) + str.slice(index + length);
}

// Разбор длительности: оба порядка слов + диапазоны («часа 4-5» -> min 240, max 300).
// Совпадения «затираются», чтобы не учитывать одно и то же дважды и не тащить в заголовок.
function parseDurations(residual) {
  let work = residual
    .replace(/продолжительн[а-яё]*|длительн[а-яё]*/g, ' ')
    .replace(/полтора\s+час[а-яё]*/g, ' 90 минут ')
    .replace(/полчаса/g, ' 30 минут ')
    .replace(/(^|[\s,;.])на\s+час(?![а-яё])/g, '$1 1 час ');   // «на час» = 60 мин
  // числительные словами -> цифры: «часа два» => «часа 2»
  for (const [word, num] of RU_NUMERALS) {
    work = work.replace(new RegExp(`(^|[\\s,;.])${word}(?=[\\s,;.]|$)`, 'g'), `$1${num}`);
  }

  const DASH = '[-–—]';
  const B = '(?:^|[\\s,;.])';   // левая граница слова: иначе «задаЧ 40» читается как «40 часов»
  const pats = [];
  // диапазоны идут первыми, чтобы «4-5» не распалось на «4» и «5»
  for (const u of DURATION_UNITS) {
    pats.push({ re: new RegExp(`(\\d+)\\s*${DASH}\\s*(\\d+)\\s*${u.core}(?=[\\s,;.]|$)`), mult: u.mult, range: true }); // «4-5 часов»
    pats.push({ re: new RegExp(`${B}${u.core}\\s+(\\d+)\\s*${DASH}\\s*(\\d+)(?=[\\s,;.]|$)`), mult: u.mult, range: true }); // «часа 4-5»
  }
  for (const u of DURATION_UNITS) {
    pats.push({ re: new RegExp(`(\\d+)\\s*${u.core}(?=[\\s,;.]|$)`), mult: u.mult });    // «3 часа»
    pats.push({ re: new RegExp(`${B}${u.core}\\s+(\\d+)(?=[\\s,;.]|$)`), mult: u.mult }); // «часа 3»
  }

  // «в 2 часа ночи» — это время, а не длительность: пропускаем такие совпадения
  const isClockTime = (str, m) => {
    const before = str.slice(0, m.index);
    const after = str.slice(m.index + m[0].length);
    return /(^|[\s,;.])в\s*$/.test(before) || /^\s*(ночи|утра|вечера|дня|полудня)/.test(after);
  };
  const findValid = (str, re) => {
    const g = new RegExp(re.source, 'g');
    let m;
    while ((m = g.exec(str)) !== null) {
      if (!isClockTime(str, m)) return m;
      if (g.lastIndex === m.index) g.lastIndex += 1;
    }
    return null;
  };

  let min = 0; let max = 0; let found = false; let guard = 0;
  while (guard++ < 30) {
    let best = null;
    for (const p of pats) {
      const m = findValid(work, p.re);
      if (m && (!best || m.index < best.m.index)) best = { p, m };
    }
    if (!best) break;
    const { p, m } = best;
    min += Number(m[1]) * p.mult;
    max += Number(p.range ? m[2] : m[1]) * p.mult;
    found = true;
    work = work.slice(0, m.index) + ' '.repeat(m[0].length) + work.slice(m.index + m[0].length);
  }
  return { found, min, max, residual: work };
}

function scanSplittable(norm) {
  if (SPLIT_NO.test(norm)) return false;
  return true; // по умолчанию дробить можно (SPLIT_YES явно подтверждает, но дефолт тот же)
}

function cleanTitle(residual) {
  let t = residual;
  for (const w of COMMAND_WORDS) t = t.replace(new RegExp(w, 'g'), ' ');
  t = t.replace(IMPORTANCE_STRIP, ' ');
  t = t.replace(/[,;.]+/g, ' ');

  // токены; выкидываем предлоги/союзы и одиночные буквы только по краям (висящие после разбора)
  let tokens = t.split(/\s+/).filter(Boolean);
  const drop = new Set(TITLE_STOPWORDS);
  const isEdgeNoise = (w) => drop.has(w) || w.length === 1;
  while (tokens.length && isEdgeNoise(tokens[0])) tokens.shift();
  while (tokens.length && isEdgeNoise(tokens[tokens.length - 1])) tokens.pop();

  const out = tokens.join(' ').trim();
  if (!out) return '';
  return out.charAt(0).toUpperCase() + out.slice(1);
}
