import { test, assert, eq, approx } from './assert.js';
import { parseHM, formatHM, toDateKey, fromDateKey } from '../js/core/time.js';
import { suggestFreeSlots } from '../js/core/conflicts.js';
import { TYPE, NATURE, STATUS, DEFAULT_CONFIG, makeTask } from '../js/core/model.js';
import { parseTask } from '../js/core/parser.js';
import { expandOccurrences } from '../js/core/recurrence.js';
import { computeFreeSlots } from '../js/core/freeSlots.js';
import { urgency, balanceFactor, priorityScore, moveBoost } from '../js/core/scoring.js';
import { schedule } from '../js/core/scheduler.js';
import { analyzeDrop } from '../js/core/conflicts.js';
import { addDays } from '../js/core/time.js';

const NOW = new Date(2026, 6, 21, 6, 0, 0); // 21 июля 2026, 06:00 (вторник)
const cfg = { ...DEFAULT_CONFIG };

function fixed(p) { return makeTask({ type: TYPE.FIXED, ...p }); }
function flex(p) { return makeTask({ type: TYPE.FLEXIBLE, ...p }); }
function clone(items) { return JSON.parse(JSON.stringify(items)); }

// ---------- time ----------
test('time: parseHM/formatHM', () => {
  eq(parseHM('08:00'), 480);
  eq(parseHM('22:30'), 1350);
  eq(formatHM(480), '08:00');
  eq(formatHM(1350), '22:30');
});
test('time: toDateKey/fromDateKey roundtrip', () => {
  eq(toDateKey(fromDateKey('2026-07-21')), '2026-07-21');
});

// ---------- parser ----------
test('parser: тренировка в 7 утра каждое второе, 30 минут', () => {
  const { task } = parseTask('поставь тренировку в 7 утра на каждое второе утро, продолжительность 30 минут', NOW);
  eq(task.type, TYPE.FIXED, 'должно быть fixed');
  eq(task.durationMinutes, 30);
  assert(task.recurrence && task.recurrence.everyDays === 2, 'recurrence everyDays=2');
  eq(task.nature, NATURE.STRATEGIC, 'тренировка -> strategic');
  const d = new Date(task.start);
  eq(d.getHours(), 7, 'час 07');
  eq(d.getMinutes(), 0);
  assert(/трениров/i.test(task.title), `title содержит тренировку, got "${task.title}"`);
});

test('parser: гибкая задача с важностью и дедлайном', () => {
  const { task, confidence } = parseTask('подготовить презентацию 2 часа важно до завтра', NOW);
  eq(task.type, TYPE.FLEXIBLE);
  eq(task.durationMaxMinutes, 120, '2 часа = 120');
  eq(task.importance, 4, 'важно -> 4');
  eq(task.deadline, toDateKey(new Date(2026, 6, 22)), 'завтра');
  eq(confidence.importance, 'low');
});

test('parser: длительность 1 час 30 минут = 90', () => {
  const { task } = parseTask('написать отчёт 1 час 30 минут', NOW);
  eq(task.durationMaxMinutes, 90);
});

test('parser: длительность в обратном порядке «часа 3» = 180', () => {
  const { task } = parseTask('отвезти дедушку к стоматологу займёт часа 3', NOW);
  eq(task.durationMaxMinutes, 180);
});

test('parser: «минут 20» = 20', () => {
  const { task } = parseTask('позвонить минут 20', NOW);
  eq(task.durationMaxMinutes, 20);
});

test('parser: окончание слова не читается как единица («задач 40 минут» = 40)', () => {
  const { task } = parseTask('разбор задач 40 минут', NOW);
  eq(task.durationMaxMinutes, 40);
});

test('parser: числительные словами — «часа два» = 120', () => {
  const { task } = parseTask('мне нужно до завтра написать презентацию. займет это часа два', NOW);
  eq(task.durationMaxMinutes, 120);
  assert(!/два|часа/i.test(task.title), `в заголовке нет остатка длительности, got "${task.title}"`);
});

test('parser: «сорок пять минут» = 45', () => {
  eq(parseTask('позвонить сорок пять минут', NOW).task.durationMaxMinutes, 45);
});

test('parser: «в 2 часа ночи» — это время, а не длительность', () => {
  const { task } = parseTask('26 августа в 2 часа ночи пижамная вечеринка', NOW);
  eq(task.type, TYPE.FIXED);
  eq(toDateKey(new Date(task.start)), '2026-08-26');
  eq(new Date(task.start).getHours(), 2, 'ровно 02:00');
  assert(task.durationMinutes !== 120, 'два часа не должны стать длительностью');
});

test('parser: «с 9 утра» — тоже время, а слова-связки не попадают в название', () => {
  const { task } = parseTask('завтра с 9 утра встреча продлится 3 часа', NOW);
  eq(new Date(task.start).getHours(), 9);
  eq(task.durationMinutes, 180);
  eq(task.title, 'Встреча');
});

test('parser: «начнётся … и продлится» вычищается из названия', () => {
  eq(parseTask('встреча начнётся в 9 утра и продлится 3 часа', NOW).task.title, 'Встреча');
});

test('parser: «с 10 до 17» по-прежнему диапазон времени', () => {
  const { task } = parseTask('с 10 до 17 конференция', NOW);
  eq(new Date(task.start).getHours(), 10);
  eq(task.durationMinutes, 420);
  eq(task.title, 'Конференция');
});

test('parser: «в 7 часов вечера» = 19:00', () => {
  eq(new Date(parseTask('встреча в 7 часов вечера', NOW).task.start).getHours(), 19);
});

test('parser: «на 2 часа» остаётся длительностью', () => {
  const { task } = parseTask('встреча в 15:00 на 2 часа', NOW);
  eq(new Date(task.start).getHours(), 15);
  eq(task.durationMinutes, 120);
});

test('parser: «полчаса» = 30, «полтора часа» = 90', () => {
  eq(parseTask('прогулка полчаса', NOW).task.durationMaxMinutes, 30);
  eq(parseTask('обед полтора часа', NOW).task.durationMaxMinutes, 90);
});

test('parser: «3 часа 30 минут» не задваивается = 210', () => {
  const { task } = parseTask('проект 3 часа 30 минут', NOW);
  eq(task.durationMaxMinutes, 210);
});

test('parser: диапазон «часа 4-5» -> min 240, max 300', () => {
  const { task } = parseTask('подготовить презентацию часа 4-5', NOW);
  eq(task.durationMinMinutes, 240);
  eq(task.durationMaxMinutes, 300);
});

test('parser: диапазон «30-40 минут»', () => {
  const { task } = parseTask('разминка 30-40 минут', NOW);
  eq(task.durationMinMinutes, 30);
  eq(task.durationMaxMinutes, 40);
});

test('parser: «на эту неделю» -> воскресенье этой недели', () => {
  // NOW = вторник 21.07.2026 -> вс = 26.07.2026
  eq(parseTask('доделать отчёт на эту неделю 1 час', NOW).task.deadline, '2026-07-26');
  eq(parseTask('доделать отчёт на неделю на эту 1 час', NOW).task.deadline, '2026-07-26');
});

test('parser: «на следующей неделе» -> вс следующей недели', () => {
  eq(parseTask('созвон на следующей неделе 30 минут', NOW).task.deadline, '2026-08-02');
});

test('parser: инвестор/презентация -> strategic + own_business', () => {
  const { task } = parseTask('подготовить презентацию для инвестора часа 4-5', NOW);
  eq(task.nature, NATURE.STRATEGIC);
  eq(task.category, 'own_business');
});

test('parser: «нельзя дробить» -> splittable=false', () => {
  eq(parseTask('написать текст 2 часа нельзя дробить', NOW).task.splittable, false);
  eq(parseTask('написать текст 2 часа можно дробить', NOW).task.splittable, true);
});

test('parser: «встреча» -> длительность по умолчанию 90 мин (жёлтое)', () => {
  const { task, confidence, blocking } = parseTask('встреча с командой', NOW);
  eq(task.durationMaxMinutes, 90);
  eq(confidence.duration, 'low', 'подставлено по умолчанию');
  assert(!blocking.includes('duration'), 'не блокирует');
});

test('parser: явно указанная длительность перебивает дефолт встречи', () => {
  const { task, confidence } = parseTask('встреча с командой на 1 час', NOW);
  eq(task.durationMaxMinutes, 60);
  eq(confidence.duration, 'ok');
});

test('parser: «встреча в 15:00» -> fixed, дефолт 90 мин', () => {
  const { task } = parseTask('встреча в 15:00', NOW);
  eq(task.type, TYPE.FIXED);
  eq(new Date(task.start).getHours(), 15);
  eq(task.durationMinutes, 90);
});

test('parser: длительность по умолчанию 90 мин, если не указана', () => {
  const { task, confidence, blocking } = parseTask('позвонить маме', NOW);
  eq(task.durationMaxMinutes, 90);
  eq(confidence.duration, 'low', 'помечена как подставленная');
  assert(!blocking.includes('duration'), 'не блокирует сохранение');
});

test('parser: «через 10 минут» — это время начала, а не длительность', () => {
  const now = new Date(2026, 6, 21, 14, 0, 0);
  const { task } = parseTask('через 10 минут встреча с другом', now);
  eq(task.type, TYPE.FIXED, 'событие ко времени');
  eq(new Date(task.start).getHours(), 14);
  eq(new Date(task.start).getMinutes(), 10, 'старт 14:10');
  eq(task.durationMinutes, 90, 'длительность — дефолтные 1,5 часа');
});

test('parser: «через 2 часа» — старт через 2 часа, длительность 90', () => {
  const now = new Date(2026, 6, 21, 10, 0, 0);
  const { task } = parseTask('через 2 часа созвон с командой', now);
  eq(new Date(task.start).getHours(), 12);
  eq(task.durationMinutes, 90);
});

test('parser: явная длительность рядом с «через N» не теряется', () => {
  const now = new Date(2026, 6, 21, 9, 0, 0);
  const { task } = parseTask('через 30 минут встреча на 45 минут', now);
  eq(new Date(task.start).getHours(), 9);
  eq(new Date(task.start).getMinutes(), 30, 'старт 09:30');
  eq(task.durationMinutes, 45, 'длительность из «на 45 минут»');
});

test('parser: «др 25 августа» -> событие именно 25 августа', () => {
  const { task } = parseTask('у моего друга др 25 августа', NOW);
  eq(task.type, TYPE.FIXED);
  eq(toDateKey(new Date(task.start)), '2026-08-25');
  eq(task.allDay, true, 'без времени — на весь день');
  assert(!/25|август/i.test(task.title), `дата не в заголовке, got "${task.title}"`);
});

test('parser: «25.08» -> дата события', () => {
  eq(toDateKey(new Date(parseTask('оплатить страховку 25.08', NOW).task.start)), '2026-08-25');
});

test('parser: дата в прошлом переносится на следующий год', () => {
  // NOW = 21.07.2026, значит «5 марта» — это уже 2027
  eq(toDateKey(new Date(parseTask('поездка 5 марта', NOW).task.start)), '2027-03-05');
});

test('parser: «до 25 августа» остаётся дедлайном, а не датой события', () => {
  const { task } = parseTask('сдать отчёт до 25 августа 2 часа', NOW);
  eq(task.type, TYPE.FLEXIBLE, 'это гибкая задача с дедлайном');
  eq(task.deadline, '2026-08-25');
});

test('parser: «до конца недели» -> воскресенье, не утекает в заголовок', () => {
  const { task } = parseTask('написать константину до конца недели 15 минут', NOW);
  // NOW = вторник 21.07.2026 -> конец недели = вс 26.07.2026
  eq(task.deadline, '2026-07-26');
  assert(!/конца|недел/i.test(task.title), `в заголовке нет остатка дедлайна, got "${task.title}"`);
});

test('parser: «до конца месяца» -> последний день месяца', () => {
  const { task } = parseTask('сдать налоги до конца месяца 1 час', NOW);
  eq(task.deadline, '2026-07-31');
});

test('parser: слово «задача» вычищается из хвоста заголовка', () => {
  const { task } = parseTask('подготовить отчёт задача 30 минут', NOW);
  eq(task.title, 'Подготовить отчёт');
});

test('parser: диапазон времени «с 10 до 17» -> fixed, длительность 420', () => {
  const { task } = parseTask('провести день с дедушкой с 10 до 17', NOW);
  eq(task.type, TYPE.FIXED);
  eq(new Date(task.start).getHours(), 10);
  eq(task.durationMinutes, 420);
});

test('parser: «Пт с 10 до 17» -> пятница как дата события', () => {
  // NOW = вторник 21.07.2026 -> ближайшая пятница 24.07
  const { task } = parseTask('Пт с 10 до 17 провести день с дедушкой', NOW);
  eq(task.type, TYPE.FIXED);
  eq(toDateKey(new Date(task.start)), '2026-07-24');
  eq(new Date(task.start).getHours(), 10);
  eq(task.durationMinutes, 420);
});

test('parser: время через дефис «в 15-00»', () => {
  const { task } = parseTask('встреча в сб в 15-00', NOW);
  eq(task.type, TYPE.FIXED);
  eq(new Date(task.start).getHours(), 15);
  eq(new Date(task.start).getMinutes(), 0);
});

test('parser: «каждый рабочий день» -> пн-пт', () => {
  const { task } = parseTask('пробежка в 7 утра каждый рабочий день 30 минут', NOW);
  eq(task.type, TYPE.FIXED);
  eq(new Date(task.start).getHours(), 7);
  assert(task.recurrence && Array.isArray(task.recurrence.weekdays), 'weekdays');
  eq(task.recurrence.weekdays.join(','), '1,2,3,4,5');
});

test('parser: «каждый вторник» -> только вторник', () => {
  const { task } = parseTask('каждый вторник тренировка в 13-00 длительность 45 мин', NOW);
  eq(task.type, TYPE.FIXED);
  eq(task.durationMinutes, 45);
  eq(new Date(task.start).getHours(), 13);
  eq(task.recurrence.weekdays.join(','), '2');
});

test('parser: «по пятницам» -> только пятница', () => {
  const { task } = parseTask('созвон по пятницам в 16:00 на час', NOW);
  eq(task.recurrence.weekdays.join(','), '5');
});

test('parser: «с 4 по 6 авг» -> многодневный период', () => {
  const { task } = parseTask('с 4 по 6 авг я в отпуске', NOW);
  eq(task.type, TYPE.FIXED);
  eq(toDateKey(new Date(task.start)), '2026-08-04');
  eq(task.allDay, true);
  assert(task.recurrence && task.recurrence.everyDays === 1, 'ежедневно внутри периода');
  eq(task.recurrence.until, '2026-08-06');
});

test('parser: «с 10 по 12 авг нужно сделать» -> окно, а не занятые дни', () => {
  const { task } = parseTask('с 10 по 12 авг нужно сделать отчёт 2 часа', NOW);
  eq(task.type, TYPE.FLEXIBLE);
  eq(task.earliest, '2026-08-10');
  eq(task.deadline, '2026-08-12');
  eq(task.allDay, false);
  eq(task.durationMaxMinutes, 120);
  assert(!task.recurrence, 'окно не повторяется');
});

test('parser: окно без длительности -> дефолт, не весь день', () => {
  const { task } = parseTask('с 10 по 12 авг надо подготовить презентацию', NOW);
  eq(task.type, TYPE.FLEXIBLE);
  eq(task.earliest, '2026-08-10');
  eq(task.deadline, '2026-08-12');
  assert(task.durationMaxMinutes > 0 && task.durationMaxMinutes <= 120, `дефолт, got ${task.durationMaxMinutes}`);
});

test('scheduler: окно — задача не встаёт раньше даты начала', () => {
  const items = [makeTask({
    title: 'Отчёт', nature: 'tactical', importance: 4,
    earliest: '2026-08-10', deadline: '2026-08-12',
    durationMinMinutes: 120, durationMaxMinutes: 120,
  })];
  schedule(items, DEFAULT_CONFIG, NOW);
  const c = items[0].chunks[0];
  assert(c, 'задача размещена');
  assert(toDateKey(new Date(c.start)) >= '2026-08-10', `не раньше 10-го, got ${new Date(c.start).toISOString()}`);
  assert(toDateKey(new Date(c.start)) <= '2026-08-12', `не позже 12-го, got ${new Date(c.start).toISOString()}`);
});

test('parser: «с 4 по 6 авг отпуск» остаётся занятым периодом', () => {
  const { task } = parseTask('с 4 по 6 авг отпуск', NOW);
  eq(task.type, TYPE.FIXED);
  eq(task.earliest, null);
  eq(task.allDay, true);
});

test('parser: «следующие два дня в 7 утра 20 мин» -> 2 дня подряд', () => {
  const { task } = parseTask('следующие два дня в 7 утра у меня 20 мин пробежка', NOW);
  eq(task.type, TYPE.FIXED);
  eq(task.durationMinutes, 20);
  eq(new Date(task.start).getHours(), 7, 'время сохранено');
  eq(toDateKey(new Date(task.start)), '2026-07-22', 'старт — завтра');
  eq(task.recurrence.until, '2026-07-23', 'и ещё один день');
  const occ = expandOccurrences(task, new Date(2026, 6, 21), new Date(2026, 6, 30));
  eq(occ.length, 2, 'ровно два вхождения');
});

test('parser: смешанный период «с завтра по 6 авг» + свой ритм повтора', () => {
  const { task } = parseTask('с завтра по 6 авг каждый второй день завтрак по 20 мин', NOW);
  eq(task.type, TYPE.FIXED);
  eq(toDateKey(new Date(task.start)), '2026-07-22', 'старт — завтра');
  eq(task.durationMinutes, 20);
  eq(task.recurrence.everyDays, 2, 'ритм из фразы сохранён');
  eq(task.recurrence.until, '2026-08-06', 'период ограничивает конец');
  eq(task.deadline, null, '«завтра» — начало периода, а не дедлайн');
  assert(/завтрак/i.test(task.title), `название сохранено, got "${task.title}"`);
  assert(!/авг/i.test(task.title), `месяц не в заголовке, got "${task.title}"`);
});

test('parser: время не съедает соседнюю букву («планёрка», не «ланёрка»)', () => {
  eq(parseTask('сегодня в 15:30 планёрка на 5 часов', NOW).task.title, 'Планёрка');
});

test('parser: «завтра в 20:00» — это дата события, а не дедлайн', () => {
  const { task } = parseTask('завтра в 20:00 встреча с другом', NOW);
  eq(task.type, TYPE.FIXED);
  eq(toDateKey(new Date(task.start)), '2026-07-22', 'событие завтра');
  eq(new Date(task.start).getHours(), 20);
  eq(task.deadline, null, 'дедлайна тут нет');
});

test('parser: «до завтра» без времени остаётся дедлайном', () => {
  const { task } = parseTask('дописать текст до завтра 2 часа', NOW);
  eq(task.type, TYPE.FLEXIBLE);
  eq(task.deadline, '2026-07-22');
});

test('parser: «завтрак» не читается как «завтра»', () => {
  const { task } = parseTask('завтрак 20 минут', NOW);
  eq(task.deadline, null);
  assert(/завтрак/i.test(task.title), `название сохранено, got "${task.title}"`);
});

test('recurrence: период «с 4 по 6» разворачивается ровно в 3 дня', () => {
  const { task } = parseTask('с 4 по 6 авг отпуск', NOW);
  const occ = expandOccurrences(task, new Date(2026, 7, 1), new Date(2026, 7, 30));
  eq(occ.length, 3, 'три дня: 4, 5, 6');
  eq(toDateKey(occ[0].start), '2026-08-04');
  eq(toDateKey(occ[2].start), '2026-08-06');
});

test('parser: по будням -> weekdays', () => {
  const { task } = parseTask('стендап в 10:00 по будням 15 минут', NOW);
  assert(task.recurrence && Array.isArray(task.recurrence.weekdays), 'weekdays');
  eq(task.recurrence.weekdays.length, 5);
});

// ---------- recurrence ----------
test('recurrence: everyDays=2 разворачивается корректно', () => {
  const t = fixed({ start: new Date(2026, 6, 21, 7, 0).toISOString(), durationMinutes: 30, recurrence: { everyDays: 2 } });
  const occ = expandOccurrences(t, new Date(2026, 6, 21), new Date(2026, 6, 27, 23, 59));
  eq(occ.length, 4, '21,23,25,27 июля');
  for (let i = 1; i < occ.length; i++) {
    const days = (occ[i].start - occ[i - 1].start) / 86400000;
    approx(days, 2, 0.01, 'шаг 2 дня');
  }
});

// ---------- free slots ----------
test('freeSlots: fixed событие делит день на два слота (без буфера)', () => {
  const noBuf = { ...cfg, bufferMinutes: 0 };
  const items = [fixed({ start: new Date(2026, 6, 21, 12, 0).toISOString(), durationMinutes: 120 })];
  const slots = computeFreeSlots(items, noBuf, NOW, new Date(2026, 6, 21, 23, 59));
  // сегодня: 08:00-12:00 и 14:00-22:00 (now=06:00 < 08:00)
  eq(slots.length, 2);
  eq(new Date(slots[0].start).getHours(), 8);
  eq(slots[0].minutes, 240);
  eq(new Date(slots[1].start).getHours(), 14);
  eq(slots[1].minutes, 480);
});

test('freeSlots: буфер 15 мин вокруг событий', () => {
  const items = [fixed({ start: new Date(2026, 6, 21, 12, 0).toISOString(), durationMinutes: 120 })];
  const slots = computeFreeSlots(items, cfg, NOW, new Date(2026, 6, 21, 23, 59));
  // утро до 11:45 (буфер перед событием), день с 14:15 (буфер после)
  eq(slots[0].minutes, 225, '08:00–11:45');
  eq(new Date(slots[1].start).getHours() * 60 + new Date(slots[1].start).getMinutes(), 14 * 60 + 15, 'начало 14:15');
  eq(slots[1].minutes, 465, '14:15–22:00');
});

test('freeSlots: сегодня начинается не раньше now', () => {
  const now = new Date(2026, 6, 21, 9, 30);
  const slots = computeFreeSlots([], cfg, now, new Date(2026, 6, 21, 23, 59));
  eq(slots.length, 1);
  eq(new Date(slots[0].start).getHours(), 9);
  eq(new Date(slots[0].start).getMinutes(), 30);
});

// ---------- scoring ----------
test('scoring: ургентность выше при близком дедлайне', () => {
  const slots = computeFreeSlots([], cfg, NOW, new Date(2026, 7, 10));
  const near = flex({ durationMinMinutes: 60, durationMaxMinutes: 60, deadline: '2026-07-22' });
  const far = flex({ durationMinMinutes: 60, durationMaxMinutes: 60, deadline: '2026-08-05' });
  assert(urgency(near, slots, cfg) > urgency(far, slots, cfg), 'ближе -> срочнее');
});

test('scoring: balanceFactor поднимает стратегию при недоборе', () => {
  const s = flex({ nature: NATURE.STRATEGIC });
  const t = flex({ nature: NATURE.TACTICAL });
  eq(balanceFactor(t, 0, 0, cfg), 1, 'тактика = 1');
  approx(balanceFactor(s, 0, 100, cfg), 1 + cfg.balanceK * cfg.targetStrategic, 0.001, 'стратегия при share=0');
  eq(balanceFactor(s, 50, 100, cfg), 1, 'при share=50% > target -> без буста');
});

test('scoring: при равной важности стратегия приоритетнее (share=0)', () => {
  const slots = computeFreeSlots([], cfg, NOW, new Date(2026, 7, 4));
  const s = flex({ nature: NATURE.STRATEGIC, importance: 3 });
  const t = flex({ nature: NATURE.TACTICAL, importance: 3 });
  assert(priorityScore(s, slots, cfg, 0, 0) > priorityScore(t, slots, cfg, 0, 0));
});

test('scoring: перенесённая задача получает компенсацию, стратегическая — большую', () => {
  const plain = flex({ nature: NATURE.TACTICAL });
  const movedTac = flex({ nature: NATURE.TACTICAL, movedCount: 2 });
  const movedStr = flex({ nature: NATURE.STRATEGIC, movedCount: 2 });
  eq(moveBoost(plain, cfg), 1, 'не переносили — без бонуса');
  assert(moveBoost(movedTac, cfg) > 1, 'переносили — бонус есть');
  assert(moveBoost(movedStr, cfg) > moveBoost(movedTac, cfg), 'стратегической компенсация выше');
});

test('scheduler: после освобождения времени первой едет перенесённая стратегическая', () => {
  const base = () => ([
    flex({ id: 's', title: 'Стратегическая (переносили)', nature: NATURE.STRATEGIC, movedCount: 2, importance: 3, durationMinMinutes: 120, durationMaxMinutes: 120, createdAt: '2026-07-20T10:00:00Z' }),
    flex({ id: 't', title: 'Тактическая (переносили)', nature: NATURE.TACTICAL, movedCount: 2, importance: 3, durationMinMinutes: 120, durationMaxMinutes: 120, createdAt: '2026-07-20T10:00:00Z' }),
    flex({ id: 'n', title: 'Обычная', nature: NATURE.TACTICAL, importance: 3, durationMinMinutes: 120, durationMaxMinutes: 120, createdAt: '2026-07-20T10:00:00Z' }),
  ]);
  const items = base();
  schedule(items, cfg, NOW);
  const startOf = (id) => new Date(items.find((x) => x.id === id).chunks[0].start).getTime();
  assert(startOf('s') < startOf('t'), 'стратегическая перенесённая — раньше тактической перенесённой');
  assert(startOf('t') < startOf('n'), 'перенесённая тактическая — раньше не переносившейся');
});

// ---------- scheduler ----------
test('scheduler: простая задача ставится на начало рабочего дня', () => {
  const items = [flex({ durationMinMinutes: 60, durationMaxMinutes: 60, importance: 3 })];
  schedule(items, cfg, NOW);
  eq(items[0].chunks.length, 1);
  const c = items[0].chunks[0];
  eq(new Date(c.start).getHours(), 8, 'на 08:00');
  eq(c.durationMinutes, 60);
  eq(items[0].status, STATUS.SCHEDULED);
});

test('scheduler: не дробит, если влезает целиком (один кусок)', () => {
  const task = flex({ durationMinMinutes: 200, durationMaxMinutes: 200, importance: 3 });
  const items = [task];
  schedule(items, cfg, NOW);
  eq(task.chunks.length, 1, 'один кусок, без дробления');
  eq(task.chunks.reduce((s, c) => s + c.durationMinutes, 0), 200);
  assert(!task.atRisk);
});

test('scheduler: длинную задачу дробит только вынужденно, кусками ≥45', () => {
  const noBuf = { ...cfg, bufferMinutes: 0 };
  // сегодня и завтра свободно лишь по 120 мин (fixed 10:00–22:00 в оба дня); дедлайн завтра
  const b1 = fixed({ start: new Date(2026, 6, 21, 10, 0).toISOString(), durationMinutes: 720 });
  const b2 = fixed({ start: new Date(2026, 6, 22, 10, 0).toISOString(), durationMinutes: 720 });
  const task = flex({ durationMinMinutes: 200, durationMaxMinutes: 200, importance: 4, deadline: '2026-07-22' });
  const items = [b1, b2, task];
  schedule(items, noBuf, NOW);
  eq(task.chunks.reduce((s, c) => s + c.durationMinutes, 0), 200, 'вся длительность');
  eq(task.chunks.length, 2, 'два куска');
  for (const c of task.chunks) assert(c.durationMinutes >= 45, `кусок ${c.durationMinutes} < 45`);
  assert(!task.atRisk);
});

test('scheduler: короткую задачу (≤90) не дробит — at_risk вместо мелочи', () => {
  const noBuf = { ...cfg, bufferMinutes: 0 };
  const b1 = fixed({ start: new Date(2026, 6, 21, 9, 0).toISOString(), durationMinutes: 780 }); // сегодня свободно 08:00–09:00 = 60
  const b2 = fixed({ start: new Date(2026, 6, 22, 9, 0).toISOString(), durationMinutes: 780 }); // завтра тоже 60
  const task = flex({ durationMinMinutes: 90, durationMaxMinutes: 90, importance: 4, deadline: '2026-07-22' });
  const items = [b1, b2, task];
  schedule(items, noBuf, NOW);
  eq(task.chunks.length, 0, 'не дробится');
  assert(task.atRisk, 'помечена at_risk');
});

test('scheduler: при дроблении не оставляет мелкий осколок (<45)', () => {
  const noBuf = { ...cfg, bufferMinutes: 0 };
  // сегодня 120 мин, завтра 45 мин; задача 135, дедлайн завтра.
  // наивно было бы 120+15 (осколок 15) — должно стать 90+45.
  const b1 = fixed({ start: new Date(2026, 6, 21, 10, 0).toISOString(), durationMinutes: 720 });
  const b2 = fixed({ start: new Date(2026, 6, 22, 8, 45).toISOString(), durationMinutes: 795 });
  const task = flex({ durationMinMinutes: 135, durationMaxMinutes: 135, importance: 4, deadline: '2026-07-22' });
  const items = [b1, b2, task];
  schedule(items, noBuf, NOW);
  eq(task.chunks.reduce((s, c) => s + c.durationMinutes, 0), 135);
  for (const c of task.chunks) assert(c.durationMinutes >= 45, `осколок ${c.durationMinutes} < 45`);
  assert(!task.atRisk);
});

test('scheduler: не откалывает мелкий фрагмент от задачи', () => {
  // день занят fixed 10:00–22:00 -> сегодня свободно только 08:00–09:45 (с буфером перед событием).
  // Задача 135 мин с дедлайном сегодня: 105 мин влезает, оставшиеся 30 < мин-чанка -> at_risk,
  // но НИ ОДНОГО куска меньше 45 мин быть не должно.
  const busy = fixed({ start: new Date(2026, 6, 21, 10, 0).toISOString(), durationMinutes: 720 });
  const task = flex({ durationMinMinutes: 135, durationMaxMinutes: 135, importance: 4, deadline: '2026-07-21', minChunkMinutes: 30 });
  const items = [busy, task];
  schedule(items, cfg, NOW);
  for (const c of task.chunks) assert(c.durationMinutes >= 45, `кусок ${c.durationMinutes} мин < 45`);
  assert(task.atRisk, 'помечена at_risk (нельзя доложить без мелкого куска)');
});

test('scheduler: at_risk при нехватке времени до дедлайна', () => {
  const busy = fixed({ start: new Date(2026, 6, 21, 8, 0).toISOString(), durationMinutes: 780 }); // 08:00-21:00
  const task = flex({
    durationMinMinutes: 300, durationMaxMinutes: 300, importance: 4,
    deadline: '2026-07-21', minChunkMinutes: 30,
  });
  const items = [busy, task];
  schedule(items, cfg, NOW);
  assert(task.atRisk, 'должна быть at_risk');
  assert(task.shortfallMinutes > 0, 'показан дефицит');
});

test('scheduler: обмен дедлайнами меняет порядок задач в плане', () => {
  const a = flex({ id: 'a', title: 'A', durationMinMinutes: 240, durationMaxMinutes: 240, importance: 3, deadline: '2026-07-22' });
  const b = flex({ id: 'b', title: 'B', durationMinMinutes: 240, durationMaxMinutes: 240, importance: 3, deadline: '2026-07-23' });
  const items = [a, b];
  schedule(items, cfg, NOW);
  const startA1 = new Date(a.chunks[0].start).getTime();
  const startB1 = new Date(b.chunks[0].start).getTime();
  assert(startA1 < startB1, 'сначала A (дедлайн раньше)');

  // меняем дедлайны местами — план должен перестроиться зеркально
  a.deadline = '2026-07-23';
  b.deadline = '2026-07-22';
  schedule(items, cfg, NOW);
  const startA2 = new Date(a.chunks[0].start).getTime();
  const startB2 = new Date(b.chunks[0].start).getTime();
  assert(startB2 < startA2, 'теперь первым идёт B');
});

test('scheduler: закреплённая задача не двигается, откреплённая — перестраивается', () => {
  const a = flex({ id: 'a', durationMinMinutes: 120, durationMaxMinutes: 120, importance: 3 });
  a.chunks = [{ id: 'c1', start: new Date(2026, 6, 21, 18, 0).toISOString(), durationMinutes: 120, locked: true, status: STATUS.SCHEDULED }];
  const items = [a];
  schedule(items, cfg, NOW);
  eq(new Date(a.chunks[0].start).getHours(), 18, 'закреплённая осталась на месте');

  a.chunks.forEach((c) => { c.locked = false; });   // открепили — как кнопкой в шторке
  schedule(items, cfg, NOW);
  eq(new Date(a.chunks[0].start).getHours(), 8, 'после открепления уехала в самый ранний слот');
});

test('scheduler: детерминизм — два прогона совпадают', () => {
  const base = [
    flex({ id: 'a', title: 'A', durationMinMinutes: 90, durationMaxMinutes: 90, importance: 4, nature: NATURE.STRATEGIC, createdAt: '2026-07-20T10:00:00Z' }),
    flex({ id: 'b', title: 'B', durationMinMinutes: 60, durationMaxMinutes: 60, importance: 4, nature: NATURE.TACTICAL, createdAt: '2026-07-20T11:00:00Z' }),
    flex({ id: 'c', title: 'C', durationMinMinutes: 120, durationMaxMinutes: 120, importance: 2, deadline: '2026-07-23', createdAt: '2026-07-20T12:00:00Z' }),
  ];
  const r1 = schedule(clone(base), cfg, NOW).items;
  const r2 = schedule(clone(base), cfg, NOW).items;
  const sig = (items) => items.map((t) => `${t.id}:${(t.chunks || []).map((c) => c.start + '/' + c.durationMinutes).join(',')}`).join('|');
  eq(sig(r1), sig(r2), 'одинаковый результат');
});

test('scheduler: новое fixed-событие не накладывается на свежий гибкий чанк', () => {
  const task = flex({ id: 'p', durationMinMinutes: 120, durationMaxMinutes: 120, importance: 3, minChunkMinutes: 30 });
  const items = [task];
  schedule(items, cfg, NOW);                       // чанк 08:00–10:00
  eq(new Date(task.chunks[0].start).getHours(), 8);

  const fx = fixed({ id: 'f', start: new Date(2026, 6, 21, 8, 30).toISOString(), durationMinutes: 60 });
  items.push(fx);
  schedule(items, cfg, NOW);                       // после добавления события — переплан

  const fs = new Date(2026, 6, 21, 8, 30).getTime();
  const fe = new Date(2026, 6, 21, 9, 30).getTime();
  for (const c of task.chunks) {
    const cs = new Date(c.start).getTime();
    const ce = cs + c.durationMinutes * 60000;
    assert(ce <= fs || cs >= fe, `чанк ${c.start} пересекается с событием 08:30–09:30`);
  }
  eq(task.chunks.reduce((s, c) => s + c.durationMinutes, 0), 120, 'вся длительность сохранена');
});

test('conflicts: два fixed-события внахлёст — новое помечено, есть варианты переноса', () => {
  const older = fixed({ id: 'e1', title: 'Планёрка', start: new Date(2026, 6, 25, 15, 0).toISOString(), durationMinutes: 90, createdAt: '2026-07-20T10:00:00Z' });
  const newer = fixed({ id: 'e2', title: 'Встреча с клиентом', start: new Date(2026, 6, 25, 15, 30).toISOString(), durationMinutes: 90, createdAt: '2026-07-21T10:00:00Z' });
  const items = [older, newer];
  schedule(items, cfg, NOW);
  assert(!older.conflict, 'старое событие без конфликта');
  assert(newer.conflict, 'новое помечено конфликтом');
  eq(newer.conflict.withTitle, 'Планёрка');
  assert(newer.conflict.suggestions.length >= 1, 'есть хотя бы один вариант');
  const os = new Date(2026, 6, 25, 15, 0).getTime();
  const oe = new Date(2026, 6, 25, 16, 30).getTime();
  for (const s of newer.conflict.suggestions) {
    const ss = new Date(s.start).getTime();
    const se = ss + s.durationMinutes * 60000;
    assert(se <= os || ss >= oe, `вариант ${s.start} пересекается со старым событием`);
  }
});

test('drop: над авто-размещённой гибкой задачей — НЕ блокируем (она подвинется)', () => {
  const task = flex({ id: 'f1', durationMinMinutes: 60, durationMaxMinutes: 60, importance: 3 });
  const items = [task];
  schedule(items, cfg, NOW);                       // авто-чанк, не locked
  const at = new Date(task.chunks[0].start).valueOf();
  const res = analyzeDrop(at, 60, items, 'other', cfg, NOW, addDays(NOW, 14));
  assert(!res.blocked, 'подвижная задача не должна блокировать');
});

test('drop: над fixed-событием — блокируем', () => {
  const ev = fixed({ id: 'e1', start: new Date(2026, 6, 21, 12, 0).toISOString(), durationMinutes: 60 });
  const res = analyzeDrop(new Date(2026, 6, 21, 12, 30).valueOf(), 60, [ev], 'other', cfg, NOW, addDays(NOW, 14));
  assert(res.blocked, 'жёсткая привязка ко времени блокирует');
});

test('drop: над закреплённой гибкой — не блокируем, если её есть куда переставить', () => {
  const t = flex({ id: 'f2', durationMinMinutes: 60, durationMaxMinutes: 60, importance: 3 });
  t.chunks = [{ id: 'c1', start: new Date(2026, 6, 21, 12, 0).toISOString(), durationMinutes: 60, locked: true, status: STATUS.SCHEDULED }];
  const res = analyzeDrop(new Date(2026, 6, 21, 12, 30).valueOf(), 60, [t], 'other', cfg, NOW, addDays(NOW, 14));
  assert(!res.blocked, 'день свободен — закреплённую можно переставить');
  eq(res.displaced.length, 1, 'помечена к освобождению');
  eq(res.displaced[0].chunkId, 'c1');
});

test('conflicts: предложенные окна не пересекаются с уже размещёнными делами', () => {
  const ev = fixed({ id: 'e', start: new Date(2026, 6, 21, 10, 0).toISOString(), durationMinutes: 120 });
  const task = flex({ id: 'f', durationMinMinutes: 180, durationMaxMinutes: 180, importance: 3 });
  const items = [ev, task];
  schedule(items, cfg, NOW);                       // задача встала незакреплённым куском
  assert(task.chunks.length > 0, 'задача размещена');

  const slots = suggestFreeSlots(60, items, cfg, NOW, addDays(NOW, 7), 3);
  const busy = [
    [new Date(ev.start).getTime(), new Date(ev.start).getTime() + 120 * 60000],
    ...task.chunks.map((c) => [new Date(c.start).getTime(), new Date(c.start).getTime() + c.durationMinutes * 60000]),
  ];
  for (const s of slots) {
    const a = new Date(s.start).getTime();
    const b = a + s.durationMinutes * 60000;
    assert(!busy.some(([x, y]) => a < y && b > x), `вариант ${s.start} попал на занятое время`);
  }
});

test('conflicts: применение варианта снимает конфликт и наложение', () => {
  const older = fixed({ id: 'e1', title: 'Планёрка', start: new Date(2026, 6, 25, 15, 0).toISOString(), durationMinutes: 90, createdAt: '2026-07-20T10:00:00Z' });
  const newer = fixed({ id: 'e2', title: 'Встреча', start: new Date(2026, 6, 25, 15, 30).toISOString(), durationMinutes: 90, createdAt: '2026-07-21T10:00:00Z' });
  const items = [older, newer];
  schedule(items, cfg, NOW);
  assert(newer.conflict && newer.conflict.suggestions.length >= 1, 'есть вариант');
  // применяем первый вариант — как это делает UI (applySuggestion)
  newer.start = newer.conflict.suggestions[0].start;
  newer.conflict = null;
  schedule(items, cfg, NOW);
  assert(!newer.conflict, 'после переноса конфликта нет');
  const os = new Date(older.start).getTime(); const oe = os + 90 * 60000;
  const ns = new Date(newer.start).getTime(); const ne = ns + 90 * 60000;
  assert(ne <= os || ns >= oe, 'события больше не пересекаются');
});

test('conflicts: fixed поверх гибкой задачи — не конфликт, гибкая обтекает (случай B)', () => {
  const task = flex({ id: 'p', durationMinMinutes: 60, durationMaxMinutes: 60, importance: 3 });
  schedule([task], cfg, NOW); // гибкая встала на 08:00
  const ev = fixed({ id: 'f', title: 'Звонок', start: new Date(2026, 6, 21, 8, 0).toISOString(), durationMinutes: 60, createdAt: '2026-07-21T09:00:00Z' });
  const items = [task, ev];
  schedule(items, cfg, NOW);
  assert(!ev.conflict, 'событие без конфликта (гибкая подвинулась)');
  const cs = new Date(task.chunks[0].start).getTime();
  assert(cs >= new Date(2026, 6, 21, 9, 0).getTime(), 'гибкая ушла после события+буфер');
});

test('scheduler: locked-чанк не двигается при переплане', () => {
  const task = flex({ durationMinMinutes: 60, durationMaxMinutes: 60, importance: 3 });
  task.chunks = [{ id: 'x', start: new Date(2026, 6, 25, 15, 0).toISOString(), durationMinutes: 60, locked: true, status: STATUS.SCHEDULED }];
  const items = [task];
  schedule(items, cfg, NOW);
  const still = task.chunks.find((c) => c.id === 'x');
  assert(still && still.locked, 'locked-чанк сохранён');
  eq(new Date(still.start).getHours(), 15);
});
