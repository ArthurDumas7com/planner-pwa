// Контроллер приложения (buildless SPA). Использует ядро из ./core/*.
import {
  TYPE, NATURE, STATUS, CATEGORIES, makeTask, targetDuration, newId,
} from './core/model.js';
import { parseTask } from './core/parser.js';
import { WEEKDAYS, WEEKDAY_ABBR } from './core/dict.js';
import { schedule } from './core/scheduler.js';
import { expandOccurrences } from './core/recurrence.js';
import { analyzeDrop, nearestFreeStart, suggestFreeSlots } from './core/conflicts.js';
import {
  parseHM, formatHM, startOfDay, addDays, dayAt, toDateKey, fromDateKey, minutesOfDay,
} from './core/time.js';
import {
  loadItems, saveItems, loadConfig, saveConfig,
} from './store.js';

const PV_PX = 0.55;      // пикселей на минуту в превью-календаре (компактно)
const PV_MIN_DUR = 15;   // минимальная длительность при ресайзе, мин

const CAT_LABELS = {
  work: 'Работа', own_business: 'Свой бизнес', personal_brand: 'Личный бренд', personal: 'Личное',
};
const NATURE_LABELS = { strategic: 'Стратегическая', tactical: 'Тактическая' };

const state = {
  items: loadItems(),
  config: loadConfig(),
  view: 'home',
  draft: null,    // {task, confidence, blocking}
  armed: null,      // активированный блок: {kind:'draft'} | {kind:'item', itemId, chunkId}
  shiftMode: null,  // режим «выбери, что уступит место»: {forId}
  adding: false,    // открыта ли плашка ввода
  undoStack: [],    // снимки плана для отката
  redoStack: [],    // и для повтора отменённого
};

const DRAG_TOLERANCE = 5;
const HIGHLIGHT_MS = 10000;   // сколько подсвечивать только что созданное дело
const DAYS_BACK = 7;          // сколько дней доступно прокруткой назад
const DAYS_FWD = 21;          // и вперёд

function sameArm(a, b) {
  if (!a || !b) return false;
  if (a.kind !== b.kind) return false;
  if (a.kind === 'draft') return true;
  return a.itemId === b.itemId && (a.chunkId || null) === (b.chunkId || null);
}
function isArmed(key) { return sameArm(state.armed, key); }
function arm(key) {
  state.armed = key;
  state.editSnapshot = JSON.stringify(state.items);   // для «отменить изменения» в панели
  state.centerArmed = true;      // шторка займёт место сверху — покажем дело по центру остатка
  state.segPos = null;           // другое дело — слайдеры рисуем сразу, без перетекания
  render();
}
function disarm() { if (state.armed) { state.armed = null; state.editSnapshot = null; render(); } }

const app = document.getElementById('app');

// ---------- служебное ----------
/**
 * Наложение могло разрешиться вручную (сдвинули или укоротили дело) — тогда убираем
 * интерфейс выбора и возвращаем обычное перепланирование.
 * @returns {boolean} true, если коллизия только что снята
 */
function refreshCollision() {
  const c = state.pendingCollision;
  if (!c) return false;
  const culprit = state.items.find((x) => x.id === c.culpritId);
  const stillColliding = culprit
    && collidingItems(culprit).some((v) => c.victimIds.includes(v.id));
  if (stillColliding) return false;
  state.pendingCollision = null;
  state.yieldFocus = null;
  return true;
}

function persistAndReschedule() {
  // пока наложение не разрешено — план не трогаем, просто сохраняем как есть
  if (state.pendingCollision) { saveItems(state.items); return; }
  // запоминаем, где дела стояли до пересчёта: если задачу вытеснили, покажем её
  // на прежнем месте (в наложении), а не увезём молча — решение за пользователем
  const before = new Map();
  for (const t of state.items) {
    const c = (t.chunks || [])[0];
    if (c) before.set(t.id, { start: c.start, durationMinutes: c.durationMinutes });
  }
  schedule(state.items, state.config, new Date());
  for (const t of state.items) {
    if (t.atRisk && !(t.chunks || []).length && before.has(t.id)) t.displacedFrom = before.get(t.id);
    else if (!t.atRisk) t.displacedFrom = null;
  }
  saveItems(state.items);
}

/** Кого накрывает это событие (уже размещённые чанки и другие события «ко времени»). */
function collidingItems(item) {
  const s = new Date(item.start).valueOf();
  const e = s + (item.durationMinutes || 0) * 60000;
  const hit = [];
  for (const other of state.items) {
    if (other.id === item.id || other.status === STATUS.DONE) continue;
    const spans = other.type === TYPE.FIXED
      ? expandOccurrences(other, new Date(s - 86400000), new Date(e + 86400000))
        .map((o) => [o.start.valueOf(), o.start.valueOf() + o.durationMinutes * 60000])
      : (other.chunks || []).map((c) => {
        const cs = new Date(c.start).valueOf();
        return [cs, cs + c.durationMinutes * 60000];
      });
    if (spans.some(([a, b]) => s < b && e > a)) hit.push(other);
  }
  return hit;
}

/**
 * Из тех, на кого налезло новое событие, оставить только по-настоящему проблемных.
 * Гибкую задачу спрашивать не о чем: алгоритм сам подвинет её (при необходимости — дробя),
 * если она укладывается в свой дедлайн. Проблема только если это дело «ко времени»
 * или если после переноса задача осталась без места (atRisk).
 * @returns {{blocking: Array, movable: Array}}
 */
function splitVictims(victims) {
  const blocking = victims.filter((v) => v.type === TYPE.FIXED);
  const flex = victims.filter((v) => v.type !== TYPE.FIXED);
  if (!flex.length) return { blocking, movable: [] };

  // пробный переплан на копии: пострадавших открепляем — иначе locked-чанки не сдвинутся
  const copy = JSON.parse(JSON.stringify(state.items));
  const ids = new Set(flex.map((v) => v.id));
  copy.forEach((x) => { if (ids.has(x.id)) (x.chunks || []).forEach((c) => { c.locked = false; }); });
  schedule(copy, state.config, new Date());

  const movable = [];
  for (const v of flex) {
    const after = copy.find((x) => x.id === v.id);
    if (after && !after.atRisk && (after.chunks || []).length) movable.push(v);
    else blocking.push(v);
  }
  return { blocking, movable };
}

/** Снимок плана перед изменением — для кнопок «Отменить» / «Вперёд». */
function snapshot() {
  state.undoStack.push(JSON.stringify(state.items));
  if (state.undoStack.length > 20) state.undoStack.shift();
  state.redoStack = [];            // новое действие обрывает ветку «вперёд»
}
function canUndo() { return state.undoStack.length > 0; }
function canRedo() { return state.redoStack.length > 0; }

function applyHistory(fromStack, toStack) {
  if (!fromStack.length) return;
  toStack.push(JSON.stringify(state.items));
  state.items = JSON.parse(fromStack.pop());
  state.armed = null;
  state.yieldFocus = null;
  saveItems(state.items);          // без перепланирования — возвращаем ровно то состояние
  render();
}
function undoLast() { applyHistory(state.undoStack, state.redoStack); }
function redoNext() { applyHistory(state.redoStack, state.undoStack); }
function el(html) { const t = document.createElement('template'); t.innerHTML = html.trim(); return t.content.firstElementChild; }
function esc(s) { return String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])); }

// ---------- главный экран (3 дня) ----------
function dayBlocks(day) {
  const wStart = parseHM(state.config.workStart);
  const wEnd = parseHM(state.config.workEnd);
  // собираем по всему дню (00:00–23:59), чтобы события вне рабочих часов не терялись
  const dayStart = dayAt(day, 0);
  const dayEnd = dayAt(day, 24 * 60 - 1);
  const blocks = [];

  for (const it of state.items) {
    if (it.type === TYPE.FIXED) {
      for (const occ of expandOccurrences(it, dayStart, dayEnd)) {
        blocks.push(mkBlock(it, occ.start, occ.durationMinutes, null));
      }
    } else {
      for (const ch of (it.chunks || [])) {
        const s = new Date(ch.start);
        if (toDateKey(s) === toDateKey(day)) blocks.push(mkBlock(it, s, ch.durationMinutes, ch.id));
      }
    }
  }
  // Не размещённые задачи (at-risk без кусков) показываем призрачным блоком на первом
  // предложенном месте — иначе они пропадают с экрана и по ним нельзя кликнуть.
  for (const it of state.items) {
    if (!it.atRisk || it.status === STATUS.DONE) continue;
    if ((it.chunks || []).length) continue;
    // приоритет — прежнее место (там, где случилось наложение), иначе первое предложенное
    const s = it.displacedFrom || (it.riskSuggestions || [])[0];
    if (!s || toDateKey(new Date(s.start)) !== toDateKey(day)) continue;
    const b = mkBlock(it, new Date(s.start), s.durationMinutes, null);
    b.unplaced = true;
    blocks.push(b);
  }

  blocks.sort((a, b) => a.startMin - b.startMin);
  assignLanes(blocks);
  return { blocks, wStart, wEnd };
}

/**
 * Разложить пересекающиеся блоки по «дорожкам».
 * В норме пересечений нет и блок занимает всю ширину; дорожки появляются только там,
 * где дела реально наложились (конфликт) — чтобы можно было прочитать оба названия.
 * Проставляет b.lane и b.lanes (число дорожек в его группе пересечения).
 */
function assignLanes(blocks) {
  const sorted = [...blocks].sort((a, b) => a.startMin - b.startMin || a.endMin - b.endMin);
  let group = [];
  let groupEnd = -Infinity;
  const flush = () => {
    const lanes = group.reduce((m, b) => Math.max(m, b.lane + 1), 0);
    group.forEach((b) => { b.lanes = lanes; });
    group = [];
  };
  const laneEnds = [];
  for (const b of sorted) {
    if (b.startMin >= groupEnd) { flush(); laneEnds.length = 0; }
    let lane = laneEnds.findIndex((end) => end <= b.startMin);
    if (lane === -1) { lane = laneEnds.length; }
    laneEnds[lane] = b.endMin;
    b.lane = lane;
    group.push(b);
    groupEnd = Math.max(groupEnd, b.endMin);
  }
  flush();
  return blocks;
}

/** Позиция блока по горизонтали: во всю ширину или в своей дорожке при пересечении. */
function laneStyle(b) {
  if (!b.lanes || b.lanes < 2) return 'left:4px;right:4px;';
  const w = 100 / b.lanes;
  return `left:calc(${b.lane * w}% + 2px);width:calc(${w}% - 4px);right:auto;`;
}

function mkBlock(item, startDate, durationMinutes, chunkId) {
  const startMin = minutesOfDay(startDate);
  const yieldIds = state.yieldIds || new Set();
  const endMs = startDate.valueOf() + durationMinutes * 60000;
  return {
    done: item.status === STATUS.DONE,
    past: endMs < Date.now(),          // прошедшее дело (в шторке доступны ✅ и ↷)
    itemId: item.id, chunkId: chunkId || null,
    conflictWith: item.conflict ? item.conflict.withTitle : null,
    movedCount: item.movedCount || 0,
    yielding: yieldIds.has(item.id),
    title: item.title, nature: item.nature, type: item.type,
    startMin, endMin: startMin + durationMinutes, durationMinutes,
    atRisk: item.atRisk, conflict: !!item.conflict,
    recurring: !!item.recurrence,   // повторяющиеся не переносим поштучно
    dateKey: toDateKey(startDate),
  };
}

function renderHome() {
  const keepScroll = document.getElementById('daysScroll')?.scrollTop;   // до пересборки DOM
  const now = new Date();
  // сколько дней показывать: выбор пользователя (по умолчанию 3 на телефоне, 5 на широком экране)
  const dayCount = state.config.daysVisible || (window.innerWidth < 700 ? 3 : 5);
  // рендерим больше дней, чем видно: календарь скроллится по дням в обе стороны.
  // Горизонт тянется до самого дальнего дела — иначе задача на далёкую дату «пропадёт».
  const today0 = startOfDay(now).valueOf();
  let daysFwd = DAYS_FWD;
  for (const t of state.items) {
    const dates = [t.start, ...(t.chunks || []).map((c) => c.start)].filter(Boolean);
    for (const d of dates) {
      const off = Math.ceil((startOfDay(new Date(d)).valueOf() - today0) / 86400000);
      if (off > daysFwd) daysFwd = Math.min(off + 2, 400);
    }
  }
  const days = Array.from({ length: DAYS_BACK + daysFwd + 1 },
    (_, n) => startOfDay(addDays(now, n - DAYS_BACK)));
  const atRisk = state.items.filter((t) => t.atRisk && t.status !== STATUS.DONE);
  const conflicts = state.items.filter((t) => t.conflict);

  // варианты размещения для «не помещается» — считаем и показываем прямо в календаре
  const horizon = horizonForPreview(now);
  atRisk.forEach((t) => {
    const dur = (t.type === TYPE.FIXED ? t.durationMinutes : targetDuration(t)) || 60;
    const free = suggestFreeSlots(dur, state.items, state.config, now, horizon, 3, t.id);
    // если чисто свободных окон мало — добираем места, занятые делами, которые можно подвинуть
    t.riskSuggestions = free.length >= 3 ? free : free.concat(slotsFreedByYielding(t, dur, free, 3 - free.length));
  });

  // Кандидаты «уступить место»: сначала собираем причастных, затем оставляем только тех,
  // чей сдвиг реально решает проблему и не порождает цепочку новых переносов.
  state.yieldIds = new Set();
  if (!state.pendingCollision && (conflicts.length || atRisk.length)) {
    const baseProblems = countProblems(state.items);
    const cand = new Map();                      // id мешающего -> id задачи, которой он мешает
    conflicts.forEach((t) => {
      const other = state.items.find((x) => x.title === t.conflict.withTitle && x.id !== t.id);
      if (other) cand.set(other.id, t.id);
    });
    if (atRisk.length) {
      const day0 = toDateKey(now);
      state.items.forEach((x) => {
        if (atRisk.some((r) => r.id === x.id)) return;
        const onToday = (x.type === TYPE.FIXED && x.start && toDateKey(new Date(x.start)) === day0)
          || (x.chunks || []).some((c) => toDateKey(new Date(c.start)) === day0);
        if (onToday && !cand.has(x.id)) cand.set(x.id, null);   // ради «не помещается» — без пары
      });
    }
    cand.forEach((targetId, id) => {
      if (isSafeYield(id, baseProblems, targetId)) state.yieldIds.add(id);
    });
  }

  // Нерешённая коллизия: оба дела остаются на своих местах (внахлёст), двигаем по выбору.
  const collision = state.pendingCollision;
  if (collision && !state.items.some((x) => x.id === collision.culpritId)) state.pendingCollision = null;
  if (state.pendingCollision) {
    if (!state.yieldFocus) state.yieldFocus = state.pendingCollision.culpritId;
    state.yieldIds = new Set(state.pendingCollision.victimIds.concat(state.pendingCollision.culpritId)
      .filter((id) => id !== state.yieldFocus));
  }

  // Если только что созданное дело вытеснило чужую задачу — двигать предлагаем именно его,
  // а не пострадавшую (её место уже было согласовано с её дедлайном).
  if (atRisk.length && !state.yieldFocus && state.lastCreatedId) {
    const culprit = state.items.find((x) => x.id === state.lastCreatedId && x.type === TYPE.FIXED);
    const victimNotCulprit = culprit && !atRisk.some((r) => r.id === culprit.id);
    if (victimNotCulprit) state.yieldFocus = culprit.id;
  }

  // Выбрано мешающее дело (клик по ↦) — показываем варианты для ЕГО переноса.
  const focus = state.yieldFocus ? state.items.find((x) => x.id === state.yieldFocus) : null;
  if (focus) {
    const dur = (focus.type === TYPE.FIXED ? focus.durationMinutes : targetDuration(focus)) || 60;
    // текущее место исключаем — предлагать «перенести туда же» бессмысленно
    const curStart = focus.start ? new Date(focus.start).valueOf()
      : (focus.chunks && focus.chunks[0] ? new Date(focus.chunks[0].start).valueOf() : null);
    focus.riskSuggestions = suggestFreeSlots(dur, state.items, state.config, now, horizon, 6, focus.id)
      .filter((s) => curStart == null || Math.abs(new Date(s.start).valueOf() - curStart) > 60000)
      .slice(0, 3);
  } else if (state.yieldFocus) {
    state.yieldFocus = null;
  }

  // маркеры возможных мест на таймлайне (конфликты + не помещающиеся задачи)
  const markers = [];
  if (focus) {
    (focus.riskSuggestions || []).forEach((s, si) => {
      const d = new Date(s.start);
      markers.push({
        dateKey: toDateKey(d), startMin: minutesOfDay(d), durationMinutes: s.durationMinutes,
        label: `вар. ${si + 1}`, itemId: focus.id, start: s.start, displaces: '',
        hint: `перенести «${focus.title}» сюда`,
      });
    });
  }
  if (!focus) conflicts.forEach((t) => (t.conflict.suggestions || []).forEach((s, si) => {
    const d = new Date(s.start);
    markers.push({ dateKey: toDateKey(d), startMin: minutesOfDay(d), durationMinutes: s.durationMinutes, label: `вар. ${si + 1}`, itemId: t.id, start: s.start });
  }));
  if (!focus) atRisk.forEach((t) => (t.riskSuggestions || []).forEach((s, si) => {
    const d = new Date(s.start);
    markers.push({
      dateKey: toDateKey(d), startMin: minutesOfDay(d), durationMinutes: s.durationMinutes,
      label: s.displaces ? `вар. ${si + 1} ↦` : `вар. ${si + 1}`,
      itemId: t.id, start: s.start, displaces: s.displaces || '',
      hint: s.displaces ? `подвинет «${s.displacesTitle}»` : 'поставить сюда',
    });
  }));

  // в сетке — полные сутки (прокрутка от 00:00 до 24:00), но в экран попадает рабочее окно
  const lo = 0;
  const span = 24 * 60;

  const cols = days.map((day) => renderDayColumn(day, now, markers, lo, span)).join('');
  const hours = [];
  for (let m = 0; m <= span; m += 60) hours.push(m);
  // шкала времени — первой колонкой слева, залипает при горизонтальной прокрутке
  const scale = `<div class="tscale">
    <div class="tshead"></div>
    <div class="tsbar" style="--span:${span}">${hours.map((m) => `<span style="top:${((m - lo) / span) * 100}%">${formatHM(m)}</span>`).join('')}</div>
  </div>`;

  app.innerHTML = `
    ${focus
    ? `<div class="hintbar focus">${state.pendingCollision
      ? `Наложение: «${esc(focus.title)}» и «${esc((state.items.find((x) => state.pendingCollision.victimIds.includes(x.id)) || {}).title || '')}».
         Куда перенести «${esc(focus.title)}»? (или кликните по другому делу с ↦)`
      : (atRisk.length && atRisk[0].id !== focus.id)
      ? `«${esc(focus.title)}» вытеснило «${esc(atRisk[0].title)}». Куда перенести «${esc(focus.title)}»?`
      : `Куда перенести «${esc(focus.title)}»?`} Выберите синее окно
        <button class="btn ghost small" id="focus-cancel">Отмена</button></div>`
    : ((conflicts.length || atRisk.length) ? `<div class="hintbar">⚠ ${conflicts.length ? 'Наложение' : 'Не помещается'}:
      выберите синее окно для переноса или кликните по делу с ↦, чтобы выбрать место для него</div>` : '')}
    <div class="toprow">
      <div class="toprow-left">
        <div class="seg rangeseg">
          <button class="${dayCount === 3 ? 'on' : ''}" data-days="3" title="3 дня">3</button>
          <button class="${dayCount === 5 ? 'on' : ''}" data-days="5" title="5 дней">5</button>
        </div>
        <button id="today-btn" class="iconbtn" hidden title="сегодня">⌖</button>
      </div>
      <div class="toprow-right">
        <button id="undo-toolbar" class="iconbtn" title="отменить" ${canUndo() ? '' : 'disabled'}>↶</button>
        <button id="redo-toolbar" class="iconbtn" title="вперёд" ${canRedo() ? '' : 'disabled'}>↷</button>
        <button id="replan" class="iconbtn" title="пересчитать план">⟳</button>
        <button id="fab" class="fab" aria-label="Добавить">+</button>
      </div>
    </div>
    <div class="calwrap">
      ${scale}
      <div class="days-scroll" id="daysScroll"><div class="days">${cols}</div></div>
    </div>
  `;
  document.getElementById('fab').onclick = openAdd;
  document.getElementById('replan').onclick = () => { persistAndReschedule(); render(); };
  app.querySelectorAll('[data-days]').forEach((b) => {
    b.onclick = () => {
      state.config = { ...state.config, daysVisible: Number(b.getAttribute('data-days')) };
      saveConfig(state.config);
      render();
    };
  });
  const sub = document.querySelector('.topbar .sub');
  if (sub) sub.textContent = `${dayCount} ${dayCount === 5 ? 'дней' : 'дня'} вперёд`;
  setupDayScroll(dayCount);
  setupPinchZoom();
  mountAddSheet();
  app.querySelectorAll('[data-move]').forEach((b) => {
    b.onclick = () => applySuggestion(b.getAttribute('data-move'), b.getAttribute('data-start'));
  });
  app.querySelectorAll('[data-place]').forEach((el) => {
    el.onclick = () => {
      snapshot();
      placeAtRiskAt(el.getAttribute('data-place'), el.getAttribute('data-start'), el.getAttribute('data-displaces') || null);
    };
  });
  document.getElementById('undo-toolbar')?.addEventListener('click', undoLast);
  document.getElementById('redo-toolbar')?.addEventListener('click', redoNext);
  document.getElementById('focus-cancel')?.addEventListener('click', () => { state.yieldFocus = null; render(); });

  app.querySelectorAll('.block[data-item]').forEach((el) => {
    // дело с ↦: первый клик — показать варианты для него; если оно уже выбрано,
    // работает обычная активация (ручки), чтобы можно было поправить время руками
    if (el.dataset.yield && el.dataset.item !== state.yieldFocus) {
      el.onclick = (e) => {
        if (e.target.closest('[data-undo]')) return;
        state.yieldFocus = el.dataset.yield;
        render();
      };
      return;
    }
    attachArm(el, { kind: 'item', itemId: el.dataset.item, chunkId: el.dataset.chunk || null });
  });
  mountPopover();
  // у низких блоков ручки делаем тоньше, иначе они закроют середину и её нечем будет тянуть
  app.querySelectorAll('.block.armed').forEach((el) => {
    el.classList.toggle('tiny', el.offsetHeight < 56);
  });
  // панели меняют высоту календаря — прокрутку возвращаем последней
  const scEl = document.getElementById('daysScroll');
  if (scEl && keepScroll) {
    void scEl.scrollHeight;
    scEl.scrollTop = keepScroll;
    state.scrollTop = scEl.scrollTop;
    scEl.dispatchEvent(new Event('scroll'));
  }
  if (state.centerArmed) { state.centerArmed = false; centerArmedBlock(); }
}

/** Показать активное дело по центру той части календаря, что осталась под шторкой. */
function centerArmedBlock() {
  const sc = document.getElementById('daysScroll');
  const el = armedEl();
  if (!sc || !el) return;
  void sc.scrollHeight;                       // высоты только что изменились
  const scRect = sc.getBoundingClientRect();
  const elRect = el.getBoundingClientRect();
  const delta = (elRect.top + elRect.height / 2) - (scRect.top + scRect.height / 2);
  const target = sc.scrollTop + delta;
  sc.scrollTop = Math.max(0, Math.min(target, sc.scrollHeight - sc.clientHeight));
  state.scrollTop = sc.scrollTop;
  sc.dispatchEvent(new Event('scroll'));      // шкала времени едет следом
}

// ---------- активация блока: клик (мышь) / долгое нажатие (сенсор) ----------
function attachArm(el, key) {
  el.addEventListener('pointerdown', (e) => {
    // кнопки на блоке (✓, ↷, ✕) обрабатывают клик сами — активацию тут не запускаем
    if (e.target.closest('button')) return;
    if (e.target.classList.contains('pv-handle')) {
      startDragGeneric(e, e.target.classList.contains('top') ? 'top' : 'bottom', key);
      return;
    }
    if (isArmed(key)) {                    // уже активирован — можно тащить
      if (el.dataset.recurring !== '1') startDragGeneric(e, 'move', key);
      return;
    }
    const downX = e.clientX; const downY = e.clientY;
    let moved = false;
    const mv = (ev) => { if (Math.hypot(ev.clientX - downX, ev.clientY - downY) > DRAG_TOLERANCE) moved = true; };
    const up = () => {
      document.removeEventListener('pointermove', mv);
      document.removeEventListener('pointerup', up);
      if (!moved) arm(key);                // и клик мышью, и обычный тап — сразу открывают детали
    };
    document.addEventListener('pointermove', mv);
    document.addEventListener('pointerup', up);
  });
}

/** Абстракция «что двигаем»: черновик на превью или сохранённый элемент. */
function targetFor(key) {
  if (key.kind === 'draft') {
    return {
      excludeId: null,
      get: () => ({ ...state.draft.proposed }),
      set: (p) => { Object.assign(state.draft.proposed, p); },
      commit: () => render(),
    };
  }
  const t = state.items.find((x) => x.id === key.itemId);
  return {
    excludeId: key.itemId,
    get: () => {
      if (t.type === TYPE.FIXED) {
        const d = new Date(t.start);
        return { dateKey: toDateKey(d), startMin: minutesOfDay(d), durationMinutes: t.durationMinutes };
      }
      const c = (t.chunks || []).find((x) => x.id === key.chunkId);
      const d = new Date(c.start);
      return { dateKey: toDateKey(d), startMin: minutesOfDay(d), durationMinutes: c.durationMinutes };
    },
    set: (p) => {
      const iso = dayAt(fromDateKey(p.dateKey), p.startMin).toISOString();
      if (t.type === TYPE.FIXED) { t.start = iso; t.durationMinutes = p.durationMinutes; }
      else {
        const c = (t.chunks || []).find((x) => x.id === key.chunkId);
        c.start = iso; c.durationMinutes = p.durationMinutes; c.locked = true;  // ручной перенос закрепляет
      }
    },
    commit: () => { persistAndReschedule(); render(); },
  };
}

function startDragGeneric(e, mode, key) {
  e.preventDefault();
  // захватываем указатель: палец может уйти за пределы блока — события всё равно придут нам,
  // а браузер не перехватит жест под прокрутку календаря
  try { e.target.setPointerCapture?.(e.pointerId); } catch { /* не критично */ }
  const tgt = targetFor(key);
  const wStart = parseHM(state.config.workStart);
  const wEnd = parseHM(state.config.workEnd);
  const g = pointerToDayMinute(e);
  const p0 = tgt.get();
  const grabOffset = g ? g.minute - p0.startMin : 0;
  let moved = false;
  state.dragState = { key, moving: false, invalid: false };

  const move = (ev) => {
    if (!moved) {
      if (Math.hypot(ev.clientX - e.clientX, ev.clientY - e.clientY) < DRAG_TOLERANCE) return;
      moved = true; state.dragState.moving = true;
      if (key.kind !== 'draft') { snapshot(); markMoved(state.items.find((x) => x.id === key.itemId)); }
      else { state.draft.prevProposed = { ...p0 }; state.draft.pinned = true; }
    }
    const pos = pointerToDayMinute(ev);
    if (!pos) return;
    const p = tgt.get();
    if (mode === 'move') {
      p.dateKey = pos.dateKey;
      p.startMin = clampN(snap5(pos.minute - grabOffset), wStart, wEnd - p.durationMinutes);
    } else if (mode === 'top') {
      const end = p.startMin + p.durationMinutes;
      const ns = clampN(snap5(pos.minute), wStart, end - PV_MIN_DUR);
      p.startMin = ns; p.durationMinutes = end - ns;
    } else {
      const ne = clampN(snap5(pos.minute), p.startMin + PV_MIN_DUR, wEnd);
      p.durationMinutes = ne - p.startMin;
    }
    tgt.set(p);
    const now = new Date();
    const drop = analyzeDrop(dayAt(fromDateKey(p.dateKey), p.startMin).valueOf(), p.durationMinutes,
      state.items, tgt.excludeId, state.config, now, horizonForPreview(now));
    state.dragState.invalid = drop.blocked;      // красным — только если реально некуда подвинуть
    state.dragState.displaced = drop.displaced;  // кого освободить при отпускании
    if (key.kind === 'draft') updateDraftDom(); else renderHome();
    };
  const up = () => {
    document.removeEventListener('pointermove', move);
    document.removeEventListener('pointerup', up);
    document.removeEventListener('pointercancel', up);
    try { e.target.releasePointerCapture?.(e.pointerId); } catch { /* уже отпущен */ }
    if (!moved) { state.dragState = null; return; }
    // Уронили на занятое — НЕ переносим молча. Оставляем там, где отпустили: дальше включается
    // обычный разбор наложения (⚠ на блоке, 3 свободных окна, пометка ↦ у мешающих дел).
    if (!state.dragState.invalid) {
      // уронили на подвижное — освобождаем его, планировщик расставит заново
      for (const d of (state.dragState.displaced || [])) {
        const it = state.items.find((x) => x.id === d.itemId);
        const ch = it && (it.chunks || []).find((c) => c.id === d.chunkId);
        if (ch) ch.locked = false;
      }
    }
    state.dragState = null;
    tgt.commit();
  };
  document.addEventListener('pointermove', move);
  document.addEventListener('pointerup', up);
}

/**
 * Горизонтальный скролл календаря по дням: колонка занимает 1/N видимой ширины,
 * прокрутка «прилипает» к границе дня (scroll-snap), позиция переживает перерисовку.
 */
function setupDayScroll(dayCount) {
  const sc = document.getElementById('daysScroll');
  if (!sc) return;
  const scaleW = document.querySelector('.tscale')?.offsetWidth || 40;
  const w = (sc.clientWidth - scaleW) / dayCount;      // шкала слева занимает свою полосу
  sc.style.setProperty('--daywidth', `${w}px`);
  const step = w;

  // если только что создали дело на дальнюю дату — показываем именно её
  if (state.scrollToDate) {
    const cols = [...sc.querySelectorAll('.timeline')];
    const idx = cols.findIndex((t) => t.dataset.date === state.scrollToDate);
    if (idx >= 0) state.scrollLeft = Math.max(0, Math.min(idx, cols.length - dayCount)) * step;
    state.scrollToDate = null;
  }
  sc.scrollLeft = state.scrollLeft != null ? state.scrollLeft : DAYS_BACK * step;
  if (state.scrollInit && state.scrollTop != null) sc.scrollTop = state.scrollTop;   // не прыгать к 00:00

  const todayBtn = document.getElementById('today-btn');
  const bar = document.querySelector('.tsbar');
  const sync = () => {
    state.scrollLeft = sc.scrollLeft;
    const firstVisible = Math.round(sc.scrollLeft / step);
    if (todayBtn) todayBtn.hidden = firstVisible === DAYS_BACK;
    state.scrollTop = sc.scrollTop;
    if (bar) bar.style.transform = `translateY(${-sc.scrollTop}px)`;   // шкала едет вместе с сеткой
  };
  sc.onscroll = sync;
  sync();

  if (todayBtn) {
    todayBtn.onclick = () => {
      sc.scrollLeft = DAYS_BACK * step;
      sync();
    };
  }
}

const ZOOM_MIN = 0.25;    // «пиксель на минуту»: сжатый вид
const ZOOM_MAX = 3;       // и крупный

const VIEW_FROM = 8 * 60;    // в экран по умолчанию попадает 08:00…
const VIEW_TO = 20 * 60;     // …и до 20:00, остальные часы доступны прокруткой

/** Масштаб по умолчанию: в экран помещается рабочее окно, сутки — прокруткой. */
function fitZoom() {
  const sc = document.getElementById('daysScroll');
  const head = document.querySelector('.dayhead');
  const dbar = document.querySelector('.daybar');
  const headH = head ? head.offsetHeight + (dbar ? dbar.offsetHeight : 0) : 49;
  const h = (sc ? sc.clientHeight : window.innerHeight * 0.8) - headH;
  return clampN(h / (VIEW_TO - VIEW_FROM), ZOOM_MIN, ZOOM_MAX);
}

/** Масштаб: высоты сетки и шкалы задаём явно, чтобы они гарантированно совпадали. */
function applyZoom(px) {
  state.zoom = clampN(px, ZOOM_MIN, ZOOM_MAX);
  const bar = document.querySelector('.tsbar');
  const tl = document.querySelector('.timeline');
  const span = Number(tl?.dataset.span || 840);
  const h = Math.round(span * state.zoom);
  document.querySelectorAll('.timeline').forEach((el) => { el.style.height = `${h}px`; });
  if (bar) bar.style.height = `${h}px`;
  // шапка шкалы должна быть ровно такой же высоты, как заголовок дня + цветная полоска,
  // иначе метки времени не совпадут с сеткой
  const head = document.querySelector('.dayhead');
  const dbar = document.querySelector('.daybar');
  const tshead = document.querySelector('.tshead');
  if (tshead && head) tshead.style.height = `${head.offsetHeight + (dbar ? dbar.offsetHeight : 0)}px`;
}

/** Пинч двумя пальцами меняет масштаб времени — как в календаре на телефоне. */
function setupPinchZoom() {
  const sc = document.getElementById('daysScroll');
  if (!sc) return;
  applyZoom(state.zoom || fitZoom());
  void sc.scrollHeight;      // высоты только что изменились — форсируем пересчёт, иначе scrollTop обрежется
  // при первом показе прокручиваем к утру: сутки доступны, но начинаем с рабочего окна
  sc.scrollTop = state.scrollInit ? (state.scrollTop || 0) : VIEW_FROM * state.zoom;
  state.scrollInit = true;
  sc.dispatchEvent(new Event('scroll'));           // подвинуть шкалу времени следом

  let startDist = 0; let startZoom = 0; let anchorRatio = 0;
  const dist = (t) => Math.hypot(t[0].clientX - t[1].clientX, t[0].clientY - t[1].clientY);

  sc.addEventListener('touchstart', (e) => {
    if (e.touches.length !== 2) return;
    startDist = dist(e.touches);
    startZoom = state.zoom;
    const midY = (e.touches[0].clientY + e.touches[1].clientY) / 2 - sc.getBoundingClientRect().top;
    anchorRatio = (sc.scrollTop + midY) / Math.max(1, sc.scrollHeight);
  }, { passive: true });

  sc.addEventListener('touchmove', (e) => {
    if (e.touches.length !== 2 || !startDist) return;
    e.preventDefault();
    applyZoom(startZoom * (dist(e.touches) / startDist));
    sc.scrollTop = anchorRatio * sc.scrollHeight - (sc.clientHeight / 2);   // держим точку под пальцами
  }, { passive: false });

  sc.addEventListener('touchend', (e) => { if (e.touches.length < 2) startDist = 0; }, { passive: true });

  // на компьютере — Ctrl + колесо
  sc.addEventListener('wheel', (e) => {
    if (!e.ctrlKey) return;
    e.preventDefault();
    applyZoom(state.zoom * (e.deltaY < 0 ? 1.1 : 0.9));
  }, { passive: false });
}

function renderDayColumn(day, now, markers = [], lo, span) {
  const { blocks } = dayBlocks(day);
  const dayMarkers = markers.filter((m) => m.dateKey === toDateKey(day));
  const isToday = toDateKey(day) === toDateKey(now);
  const nowLine = isToday && minutesOfDay(now) >= lo && minutesOfDay(now) <= lo + span
    ? `<div class="nowline" style="top:${((minutesOfDay(now) - lo) / span) * 100}%"></div>` : '';

  let strat = 0; let tact = 0;
  for (const b of blocks) { if (b.nature === NATURE.STRATEGIC) strat += b.durationMinutes; else tact += b.durationMinutes; }
  const totalPlanned = strat + tact;
  const bar = totalPlanned
    ? `<div class="daybar"><span class="strategic" style="width:${(strat / totalPlanned) * 100}%"></span><span class="tactical" style="width:${(tact / totalPlanned) * 100}%"></span></div>`
    : '<div class="daybar empty"></div>';

  const blockEls = blocks.map((b) => {
    const top = ((b.startMin - lo) / span) * 100;
    const height = Math.max(2.5, ((b.endMin - b.startMin) / span) * 100);
    const key = { kind: 'item', itemId: b.itemId, chunkId: b.chunkId };
    const on = isArmed(key);
    const dragging = state.dragState && sameArm(state.dragState.key, key);
    const handles = on && !b.recurring
      ? '<div class="pv-handle top"></div><div class="pv-handle bottom"></div>' : '';
    // предупреждение прямо на блоке: значок + крестик отмены (панель снизу больше не нужна)
    const warn = b.conflict
      ? `<span class="bwarn" title="${esc(b.conflictWith ? `накладывается на «${b.conflictWith}»` : 'накладывается на другое дело')}">⚠</span>` : '';
    // дело, которое мешает: клик по нему = уступить место (сдвиг на день)
    const yields = b.yielding ? ' yielding' : '';
    const fresh = b.itemId === state.highlightId ? ' justadded' : '';
    const unplaced = b.unplaced ? ' unplaced' : '';
    // «сделано» и «перенести» живут в шторке события (открывается тапом), а не на блоке
    const pastBtns = '';
    return `<div class="block ${b.nature} ${b.type === TYPE.FIXED ? 'fixed' : 'flex'} ${b.atRisk ? 'risk' : ''} ${b.conflict ? 'conflict' : ''} ${on ? 'armed' : ''}${yields}${fresh}${unplaced}${b.done ? ' done' : ''} ${dragging && state.dragState.invalid ? 'invalid' : ''} ${dragging && state.dragState.moving ? 'dragging' : ''}"
      data-item="${b.itemId}" data-chunk="${b.chunkId || ''}" data-recurring="${b.recurring ? '1' : ''}"
      ${(b.yielding || b.unplaced) ? `data-yield="${b.itemId}"` : ''}
      style="top:${top}%;height:${height}%;${laneStyle(b)}" title="${esc(b.title)}">
      ${handles}${warn}${pastBtns}${b.movedCount ? `<span class="bmoved" title="переносилось раз: ${b.movedCount}">↻</span>` : ''}
      <span class="btime">${formatHM(b.startMin)}</span>
      <span class="btitle">${esc(b.title)}</span>
    </div>`;
  }).join('');

  const ghostEls = dayMarkers.map((m) => {
    const top = ((m.startMin - lo) / span) * 100;
    const height = Math.max(2.5, (m.durationMinutes / span) * 100);
    return `<div class="slotghost" data-place="${m.itemId}" data-start="${m.start}" data-displaces="${m.displaces || ''}"
      style="top:${top}%;height:${height}%" title="${esc(m.hint || 'поставить сюда')}">${m.label}</div>`;
  }).join('');

  const label = `${day.toLocaleDateString('ru-RU', { weekday: 'short' })}<b>${day.getDate()}</b>`;
  return `
    <div class="day">
      <div class="dayhead ${isToday ? 'today' : ''}">${label}</div>
      ${bar}
      <div class="timeline" data-date="${toDateKey(day)}" data-lo="${lo}" data-span="${span}"
        style="--span:${span};--hstep:${(60 / span) * 100}%">${nowLine}${ghostEls}${blockEls}</div>
    </div>`;
}

function renderAtRisk(list) {
  const rows = list.map((t) => {
    const opts = (t.riskSuggestions || []).map((s, i) => {
      const d = new Date(s.start);
      const lbl = `${d.toLocaleDateString('ru-RU', { weekday: 'short', day: 'numeric', month: 'short' })}, ${formatHM(minutesOfDay(d))}`;
      return `<button class="slotopt" data-place="${t.id}" data-start="${s.start}">вар. ${i + 1} · ${lbl}</button>`;
    }).join('');
    return `<div class="riskrow">
      <div><b>${esc(t.title)}</b><div class="reason">${esc(t.atRiskReason || 'не помещается')}</div></div>
      ${opts ? `<div class="slotopts">${opts}</div>` : '<div class="reason">свободных окон нет</div>'}
      <div class="slotopts">
        <button class="btn ghost small" data-shift="${t.id}">Перенести текущие события</button>
      </div>
    </div>`;
  }).join('');
  return `<div class="atrisk"><div class="section-title">⚠ Не помещается (${list.length})</div>${rows}</div>`;
}

/**
 * Места, которые освободятся, если подвинуть другое дело.
 * Берём только те, где сдвиг не нарушает дедлайны и не плодит новых проблем.
 * Возвращает варианты с пометкой displaces — какое дело придётся сдвинуть.
 */
function slotsFreedByYielding(task, dur, already, need) {
  if (need <= 0) return [];
  const now = new Date();
  const horizon = horizonForPreview(now);
  const baseProblems = countProblems(state.items);
  const taken = new Set(already.map((s) => s.start));
  const out = [];

  for (const other of state.items) {
    if (out.length >= need) break;
    if (other.id === task.id || other.status === STATUS.DONE) continue;
    const copy = JSON.parse(JSON.stringify(state.items));
    const moving = copy.find((x) => x.id === other.id);
    if (!moving) continue;
    applyShift(moving);                                  // «а если подвинуть это дело?»
    schedule(copy, state.config, now);
    if (countProblems(copy) > baseProblems) continue;    // сдвиг ломает чужие дедлайны — пропускаем
    const slots = suggestFreeSlots(dur, copy, state.config, now, horizon, 3, task.id);
    const fresh = slots.find((s) => !taken.has(s.start));
    if (fresh) {
      taken.add(fresh.start);
      out.push({ ...fresh, displaces: other.id, displacesTitle: other.title });
    }
  }
  return out;
}

/** Разместить задачу в выбранном окне (закрепляем, чтобы алгоритм не увёл). */
function placeAtRiskAt(itemId, startISO, displacesId) {
  const t = state.items.find((x) => x.id === itemId);
  if (!t) return;
  const dur = (t.type === TYPE.FIXED ? t.durationMinutes : targetDuration(t)) || 60;
  markMoved(t);
  if (displacesId) {                        // вариант требует подвинуть другое дело — двигаем
    const other = state.items.find((x) => x.id === displacesId);
    if (other) { markMoved(other); applyShift(other); }
  }
  if (t.type === TYPE.FIXED) { t.start = startISO; }
  else {
    t.chunks = [{ id: newId('c'), start: startISO, durationMinutes: dur, locked: true, status: STATUS.SCHEDULED }];
  }
  t.atRisk = false; t.atRiskReason = null; t.status = STATUS.SCHEDULED;
  state.yieldFocus = null;
  state.pendingCollision = null;      // наложение разрешено — можно пересчитывать план
  persistAndReschedule(); render();
}

/** Режим «подвинуть другое дело ради этого». */
function enterShiftMode(itemId) { state.shiftMode = { forId: itemId }; render(); }
function exitShiftMode() { state.shiftMode = null; render(); }

/** Отметить, что дело переносили (для маркера на блоке). */
function markMoved(t) { if (t) t.movedCount = (t.movedCount || 0) + 1; }

/** Правило сдвига: fixed — на день позже, гибкое — дедлайн +1 день и открепление. */
function applyShift(t) {
  markMoved(t);
  if (t.type === TYPE.FIXED) {
    t.start = addDays(new Date(t.start), 1).toISOString();
  } else {
    if (t.deadline) t.deadline = toDateKey(addDays(fromDateKey(t.deadline), 1));
    (t.chunks || []).forEach((c) => { c.locked = false; });
  }
}

function countProblems(items) {
  return items.filter((t) => t.conflict).length + items.filter((t) => t.atRisk).length;
}

/**
 * Безопасен ли сдвиг: решает ли он проблему, не порождая цепочку новых.
 * Проверяем на копии плана — предлагаем только такие дела.
 */
function isSafeYield(itemId, baseProblems, targetId) {
  const copy = JSON.parse(JSON.stringify(state.items));
  const t = copy.find((x) => x.id === itemId);
  if (!t) return false;
  applyShift(t);
  schedule(copy, state.config, new Date());
  if (countProblems(copy) > baseProblems) return false;      // не ухудшаем план
  if (!targetId) return countProblems(copy) < baseProblems;
  const tgt = copy.find((x) => x.id === targetId);           // конфликт именно с этим делом снят?
  return !tgt || !tgt.conflict;
}

/** Выбранное дело уступает место. */
function shiftItemByDay(itemId) {
  const t = state.items.find((x) => x.id === itemId);
  if (!t) return;
  applyShift(t);
  state.shiftMode = null;
  persistAndReschedule(); render();
}

function renderConflicts(list) {
  const cards = list.map((t) => {
    const opts = (t.conflict.suggestions || []).map((s) => {
      const d = new Date(s.start);
      const lbl = `${d.toLocaleDateString('ru-RU', { weekday: 'short', day: 'numeric', month: 'short' })}, ${formatHM(minutesOfDay(d))}`;
      return `<button class="slotopt" data-move="${t.id}" data-start="${s.start}">${lbl}</button>`;
    }).join('');
    const body = opts || '<div class="reason">свободных окон нет</div>';
    return `<div class="conflictrow">
      <div><b>${esc(t.title)}</b><div class="reason">накладывается на «${esc(t.conflict.withTitle)}». Перенести на:</div></div>
      <div class="slotopts">${body}</div>
      <div class="slotopts"><button class="btn ghost small" data-shift="${t.id}">Перенести другое событие</button></div>
    </div>`;
  }).join('');
  return `<div class="conflict-panel"><div class="section-title">⛔ Конфликт по времени (${list.length})</div>${cards}</div>`;
}

function applySuggestion(id, startISO) {
  const t = state.items.find((x) => x.id === id);
  if (!t) return;
  snapshot();
  markMoved(t);
  t.start = startISO;   // переносим событие на выбранный слот
  t.conflict = null;
  persistAndReschedule();
  render();
}

/**
 * Перенести прошедшее дело.
 * Гибкую задачу просто открепляем — планировщик сам поставит её с учётом дедлайна.
 * Событие «ко времени» переносим в ближайшее подходящее окно; если такого нет —
 * помечаем как «не помещается», и на экране появляются 3 варианта (см. renderHome).
 */
/**
 * Перенос прошедшего дела.
 * Молча переносим только когда дедлайн ещё не истёк и место до него нашлось —
 * тогда решение однозначно. Во всех остальных случаях показываем 3 варианта на выбор.
 */
function movePastItem(itemId) {
  const t = state.items.find((x) => x.id === itemId);
  if (!t) return;
  const now = new Date();
  const dur = (t.type === TYPE.FIXED ? t.durationMinutes : targetDuration(t)) || 60;
  const cutoff = t.deadline
    ? dayAt(fromDateKey(t.deadline), parseHM(state.config.workEnd)).valueOf() : null;

  if (cutoff && cutoff > now.valueOf()) {
    const ms = nearestFreeStart(now.valueOf(), dur, state.items, state.config, now, horizonForPreview(now), t.id);
    if (ms != null && ms + dur * 60000 <= cutoff) {
      snapshot();
      markMoved(t);
      if (t.type === TYPE.FIXED) t.start = new Date(ms).toISOString();
      else {
        t.chunks = [{ id: newId('c'), start: new Date(ms).toISOString(), durationMinutes: dur, locked: true, status: STATUS.SCHEDULED }];
        t.status = STATUS.SCHEDULED;
      }
      t.atRisk = false; t.atRiskReason = null;
      persistAndReschedule(); render();
      return;
    }
  }
  state.yieldFocus = itemId;   // дедлайн истёк / его нет / места до него нет — выбирает пользователь
  render();
}

/**
 * Освободилось время (удалили дело / отметили выполненным) — даём плану подтянуться:
 * открепляем задачи, которые раньше уже двигали, чтобы они могли вернуться на более ранний срок.
 * Кто именно поедет вперёд, решает скоринг (moveBoost: стратегическим компенсация выше).
 */
function reclaimFreedTime() {
  for (const t of state.items) {
    if (t.type !== TYPE.FLEXIBLE || t.status === STATUS.DONE) continue;
    if (!(t.movedCount > 0)) continue;
    (t.chunks || []).forEach((c) => { if (new Date(c.start) > new Date()) c.locked = false; });
  }
}

function markDone(id) {
  const t = state.items.find((x) => x.id === id);
  if (t) { snapshot(); t.status = STATUS.DONE; reclaimFreedTime(); persistAndReschedule(); render(); }
}

// ---------- добавление: ввод текста ----------
function openAdd() {
  state.adding = true;
  mountAddSheet();
}

/**
 * Ввод задачи. Плашка — это разросшаяся кнопка «+»: сам плюс остаётся на месте
 * и поворачивается в крестик (закрыть), под ним появляется галочка (создать),
 * а синий фон кнопки расширяется и становится фоном всей плашки.
 */
function mountAddSheet() {
  document.getElementById('addsheet')?.remove();
  if (!state.adding) return;

  const fab = document.getElementById('fab');
  const f = fab ? fab.getBoundingClientRect() : { top: 12, right: window.innerWidth - 12, width: 44, height: 44 };

  const el = document.createElement('div');
  el.id = 'addsheet';
  el.className = 'addsheet collapsed';
  // плашка растёт от кнопки: её правый верхний угол остаётся там же, где был «+»
  el.style.top = `${f.top}px`;
  el.style.right = `${window.innerWidth - f.right}px`;
  el.innerHTML = `
    <textarea id="nl" rows="2" placeholder="Напишите задачу…"></textarea>
    <button id="add-cancel" class="as-toggle" title="закрыть">+</button>
    <button id="parse" class="as-ok" title="создать">✓</button>
    <div id="adderr" class="err"></div>`;
  document.body.appendChild(el);
  if (fab) fab.style.visibility = 'hidden';        // её место занимает кнопка внутри плашки
  void el.offsetHeight;                            // фиксируем свёрнутое состояние...
  el.classList.remove('collapsed');                // ...и сразу запускаем разворот

  const ta = document.getElementById('nl');
  ta.focus();
  const submit = () => createFromText(ta.value.trim());
  document.getElementById('parse').onclick = submit;
  document.getElementById('add-cancel').onclick = closeAdd;
  ta.onkeydown = (e) => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); submit(); }
    if (e.key === 'Escape') closeAdd();
  };
}

/**
 * Перенос активного дела фразой: «завтра в 15:00», «в пятницу с 10 до 12».
 * Разбирается тем же парсером, но берём только когда — название и остальное не трогаем.
 */
function openMoveByText() {
  if (!state.armed) return;
  document.getElementById('movesheet')?.remove();
  const el = document.createElement('div');
  el.id = 'movesheet';
  el.className = 'addsheet movesheet collapsed';
  el.innerHTML = `
    <textarea id="mv" rows="2" placeholder="Куда перенести? «завтра» или «завтра в 15:00»"></textarea>
    <button id="mv-cancel" class="as-toggle" title="закрыть">+</button>
    <button id="mv-ok" class="as-ok" title="перенести">✓</button>
    <div id="mverr" class="err"></div>`;
  document.body.appendChild(el);
  void el.offsetHeight;
  el.classList.remove('collapsed');
  const ta = document.getElementById('mv');
  ta.focus();

  const apply = () => {
    const now = new Date();
    const res = parseTask(ta.value.trim(), now);
    const parsed = res.task;
    const explicitDuration = res.confidence.duration === 'ok';   // «на час» назвали явно
    const hasTime = res.confidence.time === 'ok';                // время названо, а не подставлено
    const when = parsed.start ? new Date(parsed.start) : null;
    // «перенеси на завтра» — день без времени: парсер отдаёт его дедлайном
    const dayKey = when ? toDateKey(when) : (parsed.deadline || moveDayFromWeekday(ta.value, now));
    if (!dayKey) {
      document.getElementById('mverr').textContent = 'Не понял, когда — например «завтра» или «завтра в 15:00»';
      return;
    }
    const tgt = targetFor(state.armed);
    const p = tgt.get();
    const durationMinutes = explicitDuration && parsed.durationMinutes
      ? parsed.durationMinutes : p.durationMinutes;

    // Время не названо — сами ищем свободное окно в этом дне.
    let startMin = hasTime && when ? minutesOfDay(when) : null;
    if (startMin == null) {
      const slot = freeSlotInDay(dayKey, durationMinutes, tgt.excludeId, now);
      if (slot == null) {
        document.getElementById('mverr').textContent = `В этот день нет свободного окна на ${durationMinutes} мин`;
        return;
      }
      startMin = slot;
    }

    snapshot();
    markMoved(armedTask());
    tgt.set({ dateKey: dayKey, startMin, durationMinutes });
    closeMoveSheet();
    persistAndReschedule();
    render();
  };
  document.getElementById('mv-ok').onclick = apply;
  document.getElementById('mv-cancel').onclick = closeMoveSheet;
  ta.onkeydown = (e) => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); apply(); }
    if (e.key === 'Escape') closeMoveSheet();
  };
}

/** «в пятницу» без времени — ближайшая такая дата (сегодня не считаем). */
function moveDayFromWeekday(text, now) {
  const s = ` ${text.toLowerCase()} `;
  let wd = null;
  for (const [stem, idx] of Object.entries(WEEKDAYS)) {
    if (s.includes(stem)) { wd = idx; break; }
  }
  if (wd == null) {
    const m = s.match(/(?:^|[\s,;.])(вс|пн|вт|ср|чт|пт|сб)(?=[\s,;.]|$)/);
    if (m) wd = WEEKDAY_ABBR[m[1]];
  }
  if (wd == null) return null;
  const d = startOfDay(now);
  const delta = ((wd - d.getDay()) + 7) % 7 || 7;   // ближайший будущий такой день
  return toDateKey(addDays(d, delta));
}

/**
 * Свободное окно нужной длины внутри одного дня (для «перенеси на завтра» без времени).
 * @returns {number|null} минута начала внутри дня
 */
function freeSlotInDay(dayKey, durationMinutes, excludeId, now) {
  const day = fromDateKey(dayKey);
  let from = dayAt(day, parseHM(state.config.workStart));
  if (from < now) from = new Date(Math.ceil(now.valueOf() / 300000) * 300000);  // сегодня — не в прошлое
  const to = dayAt(day, parseHM(state.config.workEnd));
  if (from >= to) return null;
  const [slot] = suggestFreeSlots(durationMinutes, state.items, state.config, from, to, 1, excludeId);
  return slot ? minutesOfDay(new Date(slot.start)) : null;
}

function closeMoveSheet() {
  const el = document.getElementById('movesheet');
  if (!el) return;
  el.classList.add('collapsed');
  setTimeout(() => el.remove(), 240);
}

function closeAdd() {
  state.adding = false;
  const el = document.getElementById('addsheet');
  const fab = document.getElementById('fab');
  if (!el) { if (fab) fab.style.visibility = ''; return; }
  el.classList.add('collapsed');                 // схлопывается обратно в кнопку «+»
  setTimeout(() => {
    el.remove();
    const f = document.getElementById('fab');
    if (f) f.style.visibility = '';
  }, 240);
}

/**
 * Создать задачу из текста и сразу поставить её в план — без отдельного шага подтверждения.
 * Новое дело подсвечивается на главном экране, чтобы было видно, куда его поставил алгоритм.
 */
function createFromText(text) {
  if (!text) return;
  const parsed = parseTask(text, new Date());
  const t = makeTask(parsed.task);
  if (!t.title || !t.title.trim()) {
    const err = document.getElementById('adderr');
    if (err) err.textContent = 'Не понял название — напишите подробнее';
    return;
  }
  snapshot();
  state.items.push(t);
  // Новое событие «ко времени» накрыло чужие дела: подвижные разъедутся сами (молча),
  // и только если кого-то переставить некуда — показываем наложение и спрашиваем.
  const victims = t.type === TYPE.FIXED ? collidingItems(t) : [];
  const { blocking, movable } = victims.length ? splitVictims(victims) : { blocking: [], movable: [] };
  if (blocking.length) {
    state.pendingCollision = { culpritId: t.id, victimIds: blocking.map((v) => v.id) };
    state.yieldFocus = t.id;
    saveItems(state.items);
  } else {
    state.pendingCollision = null;
    // открепляем подвинутых: закреплённые чанки переплан не трогает
    const ids = new Set(movable.map((v) => v.id));
    state.items.forEach((x) => { if (ids.has(x.id)) (x.chunks || []).forEach((c) => { c.locked = false; }); });
    persistAndReschedule();
  }
  closeAdd();
  state.highlightId = t.id;
  state.lastCreatedId = t.id;      // виновник возможного вытеснения — предлагать двигать его
  // показываем день, куда алгоритм поставил дело (даже если он далеко за краем экрана)
  const placedAt = t.start || (t.chunks || [])[0]?.start;
  if (placedAt) state.scrollToDate = toDateKey(new Date(placedAt));
  state.view = 'home';
  render();
  setTimeout(() => {
    if (state.highlightId === t.id) { state.highlightId = null; if (state.view === 'home') render(); }
  }, HIGHLIGHT_MS);
}

// ---------- экран подтверждения: превью-календарь с перетаскиванием ----------
function horizonForPreview(now) { return addDays(startOfDay(now), 21); }

/**
 * Куда поставить гибкую задачу: спрашиваем у планировщика на копии плана.
 * Так учитывается, что незакреплённые задачи можно подвинуть — место может найтись
 * раньше, чем ближайшее сейчас свободное окно (важно при близком дедлайне).
 */
function proposeByScheduler(t, dur, now) {
  const copy = JSON.parse(JSON.stringify(state.items));
  const probe = makeTask({
    ...t, id: 'draft_probe', type: TYPE.FLEXIBLE, chunks: [], status: STATUS.UNSCHEDULED,
    durationMinMinutes: dur, durationMaxMinutes: dur,
  });
  copy.push(probe);
  schedule(copy, state.config, now);
  const placed = copy.find((x) => x.id === probe.id);
  return placed && placed.chunks && placed.chunks.length ? new Date(placed.chunks[0].start) : null;
}

/** Вычислить предлагаемое место (start, длительность), если ещё не задано. */
function ensureProposed() {
  const t = state.draft.task;
  if (state.draft.proposed) return;
  const dur = (t.type === TYPE.FIXED ? t.durationMinutes : targetDuration(t)) || 60;
  const now = new Date();
  const wStart = parseHM(state.config.workStart);
  let startDate;
  if (t.type === TYPE.FIXED && t.start) {
    startDate = new Date(t.start);
  } else {
    startDate = proposeByScheduler(t, dur, now);
    if (!startDate) {                              // планировщик не смог — ближайшее свободное окно
      const desired = Math.max(now.valueOf(), dayAt(startOfDay(now), wStart).valueOf());
      const ms = nearestFreeStart(desired, dur, state.items, state.config, now, horizonForPreview(now));
      startDate = ms != null ? new Date(ms) : dayAt(startOfDay(now), wStart);
    }
  }
  state.draft.proposed = { dateKey: toDateKey(startDate), startMin: minutesOfDay(startDate), durationMinutes: dur };
  state.draft.pinned = false;
}

/** Неделя от сегодня; если предложенное место дальше — окно сдвигается, чтобы оно попало в вид. */
function pvDaysList() {
  const today = startOfDay(new Date());
  const prop = fromDateKey(state.draft.proposed.dateKey);
  const offset = Math.max(0, Math.round((prop - today) / 86400000) - 6);
  const start = startOfDay(addDays(today, offset));
  return Array.from({ length: 7 }, (_, i) => startOfDay(addDays(start, i)));
}

function wcColHtml(day, idx, count) {
  const wStart = parseHM(state.config.workStart);
  const wEnd = parseHM(state.config.workEnd);
  const H = (wEnd - wStart) * PV_PX;
  const dayKey = toDateKey(day);
  const now = new Date();
  const isToday = dayKey === toDateKey(now);

  const yieldSet = state.draftYields || new Set();
  const P0 = state.draft.proposed;
  const ctxBlocks = dayBlocks(day).blocks;
  // черновик участвует в раскладке: если он пересёк чужое дело — оба сузятся и станут читаемы
  const draftPseudo = P0.dateKey === dayKey
    ? { startMin: P0.startMin, endMin: P0.startMin + P0.durationMinutes, __draft: true } : null;
  assignLanes(draftPseudo ? [...ctxBlocks, draftPseudo] : ctxBlocks);

  const ctx = ctxBlocks.map((b) => {
    const top = Math.max(0, (b.startMin - wStart) * PV_PX);
    const h = Math.max(4, b.durationMinutes * PV_PX);
    const canYield = yieldSet.has(b.itemId);
    return `<div class="pvblock ctx ${b.nature} ${b.type === TYPE.FIXED ? 'fixed' : 'flex'} ${canYield ? 'yielding' : ''}"
      data-item="${b.itemId}" ${canYield ? `data-yield="${b.itemId}"` : ''}
      style="top:${top}px;height:${h}px;${laneStyle(b)}">
      <span class="pvb-label">${esc(b.title)}</span></div>`;
  }).join('');

  // призрачные варианты размещения черновика
  const ghosts = (state.draft.suggestions || []).map((s, i) => ({ d: new Date(s.start), i, start: s.start }))
    .filter((g) => toDateKey(g.d) === dayKey)
    .map((g) => `<div class="slotghost" data-draftslot="${g.start}"
      style="top:${(minutesOfDay(g.d) - wStart) * PV_PX}px;height:${state.draft.proposed.durationMinutes * PV_PX}px"
      title="поставить сюда">вар. ${g.i + 1}</div>`).join('');

  let draftEl = '';
  const P = state.draft.proposed;
  if (P.dateKey === dayKey) {
    const t = state.draft.task;
    const flip = idx >= count - 2 ? 'flip' : '';   // у правых колонок тег категории — слева
    const on = isArmed({ kind: 'draft' });
    const dragging = state.dragState && state.dragState.key.kind === 'draft';
    const inval = (dragging && state.dragState.invalid) || P.invalid;
    const names0 = (state.draft.blockedBy || []).map((b) => `«${b.title}»`).join(', ');
    const handles = on ? '<div class="pv-handle top"></div><div class="pv-handle bottom"></div>' : '';
    draftEl = `<div id="pvdraft" class="pvblock draft ${t.nature} ${t.type === TYPE.FIXED ? 'fixed' : 'flex'} ${inval ? 'invalid' : ''} ${dragging && state.dragState.moving ? 'dragging' : ''} ${on ? 'armed' : ''}"
      style="top:${(P.startMin - wStart) * PV_PX}px;height:${P.durationMinutes * PV_PX}px;${laneStyle(draftPseudo || {})}">
      ${handles}
      ${inval ? `<span class="bwarn" title="${esc(names0 || 'место занято')}">⚠</span>` : ''}
      ${state.draft.prevProposed ? '<button class="bundo" data-draftundo="1" title="отменить перенос">✕</button>' : ''}
      <span class="pvb-label">${esc(t.title || '')}</span>
      <span class="pv-cattag ${flip}">${CAT_LABELS[t.category] || t.category}</span>
    </div>`;
  }

  const nowLine = isToday && minutesOfDay(now) >= wStart && minutesOfDay(now) <= wEnd
    ? `<div class="pv-nowline" style="top:${(minutesOfDay(now) - wStart) * PV_PX}px"></div>` : '';

  const label = day.toLocaleDateString('ru-RU', { weekday: 'short', day: 'numeric' });
  return `<div class="wc-col">
    <div class="wc-head ${isToday ? 'today' : ''}">${label}</div>
    <div class="ptimeline" data-date="${dayKey}" data-lo="${wStart}" data-span="${wEnd - wStart}" style="height:${H}px">${nowLine}${ctx}${ghosts}${draftEl}</div>
  </div>`;
}

function renderWeek() {
  const days = pvDaysList();
  return `<div class="wc-grid">${days.map((day, i) => wcColHtml(day, i, days.length)).join('')}</div>`;
}

/** Проверка предложенного места: с чем накладывается и куда можно поставить. */
function evaluateDraft() {
  const P = state.draft.proposed;
  const now = new Date();
  const horizon = horizonForPreview(now);
  const drop = analyzeDrop(dayAt(fromDateKey(P.dateKey), P.startMin).valueOf(), P.durationMinutes,
    state.items, null, state.config, now, horizon);
  P.invalid = drop.blocked;
  state.draft.blockedBy = drop.blockedBy || [];
  state.draft.suggestions = drop.blocked
    ? suggestFreeSlots(P.durationMinutes, state.items, state.config, now, horizon, 3)
    : [];
  return drop;
}

/** Пересекается ли дело с местом черновика. */
function overlapsDraft(item, startMs, endMs) {
  const spans = item.type === TYPE.FIXED
    ? expandOccurrences(item, new Date(startMs - 86400000), new Date(endMs + 86400000))
      .map((o) => [o.start.valueOf(), o.start.valueOf() + o.durationMinutes * 60000])
    : (item.chunks || []).map((c) => {
      const s = new Date(c.start).valueOf();
      return [s, s + c.durationMinutes * 60000];
    });
  return spans.some(([s, e]) => startMs < e && endMs > s);
}

/**
 * Можно ли предложить перенос этого дела ради черновика.
 * Не требуем, чтобы один сдвиг решал всё (накладка бывает сразу на несколько дел) —
 * достаточно, чтобы само это дело ушло с места черновика и не появилось новых проблем.
 */
function isSafeYieldForDraft(itemId) {
  const P = state.draft.proposed;
  const now = new Date();
  const startMs = dayAt(fromDateKey(P.dateKey), P.startMin).valueOf();
  const endMs = startMs + P.durationMinutes * 60000;
  const copy = JSON.parse(JSON.stringify(state.items));
  const t = copy.find((x) => x.id === itemId);
  if (!t) return false;
  applyShift(t);
  schedule(copy, state.config, now);
  const moved = copy.find((x) => x.id === itemId);
  return !overlapsDraft(moved, startMs, endMs) && countProblems(copy) <= countProblems(state.items);
}

/** Кто может уступить место черновику (только безопасные варианты). */
function draftYieldIds() {
  const ids = new Set();
  if (!state.draft.proposed.invalid) return ids;
  (state.draft.blockedBy || []).forEach((b) => { if (isSafeYieldForDraft(b.itemId)) ids.add(b.itemId); });
  return ids;
}

function renderConfirm() {
  ensureProposed();
  evaluateDraft();
  state.draftYields = draftYieldIds();
  const bad = state.draft.proposed.invalid;
  const names = (state.draft.blockedBy || []).map((b) => `«${esc(b.title)}»`).join(', ');
  app.innerHTML = `
    <div class="screen wide">
      <button class="back" id="back">← Назад</button>
      <p class="hint">${bad
    ? `⚠ Накладывается на ${names}: выберите синее окно или кликните по делу с ↦, чтобы оно уступило место`
    : 'Коснитесь события, чтобы открыть детали и перенести его.'}</p>
      <div class="weekcal" id="pvcal">${renderWeek()}</div>
      <button id="save" class="btn primary">Сохранить и запланировать</button>
      <div id="saveerr" class="err"></div>
    </div>`;
  document.getElementById('back').onclick = () => { state.view = 'add'; render(); };
  document.getElementById('save').onclick = saveDraft;
  wirePvDraft();
}

/** Выбор предложенного окна = решение принято: ставим туда и сразу сохраняем (без лишнего шага). */
function moveDraftTo(startISO) {
  const d = new Date(startISO);
  Object.assign(state.draft.proposed, { dateKey: toDateKey(d), startMin: minutesOfDay(d) });
  state.draft.pinned = true;
  saveDraft();
}

function undoDraftMove() {
  if (!state.draft.prevProposed) return;
  Object.assign(state.draft.proposed, state.draft.prevProposed);
  state.draft.prevProposed = null;
  render();
}

// ---------- всплывающая шторка деталей рядом с событием ----------
function armedEl() {
  if (!state.armed) return null;
  if (state.armed.kind === 'draft') return document.getElementById('pvdraft');
  return document.querySelector(`.block[data-item="${state.armed.itemId}"][data-chunk="${state.armed.chunkId || ''}"]`);
}

function armedTask() {
  if (!state.armed) return null;
  return state.armed.kind === 'draft' ? state.draft.task : state.items.find((x) => x.id === state.armed.itemId);
}

function mountPopover() {
  document.getElementById('blockpop')?.remove();
  if (!state.armed) return;
  const t = armedTask();
  if (!t) { state.armed = null; return; }
  const isDraft = state.armed.kind === 'draft';
  const pos = isDraft ? state.draft.proposed : targetFor(state.armed).get();
  const isFixed = t.type === TYPE.FIXED;
  const endMin = pos.startMin + pos.durationMinutes;
  // дело уже идёт или прошло — прямо здесь можно отметить «сделано» или перенести
  const started = !isDraft && t.status !== STATUS.DONE
    && dayAt(fromDateKey(pos.dateKey), pos.startMin).valueOf() <= Date.now();

  const pop = document.createElement('div');
  pop.id = 'blockpop';
  pop.className = 'blockpop';
  pop.innerHTML = `
    <input type="text" id="bp-title" value="${esc(t.title || '')}" placeholder="Название">
    <div class="bp-when">
      <button class="bp-cal" id="bp-cal" title="дата: ${pos.dateKey}">📅</button>
      <input type="date" id="bp-date" value="${pos.dateKey}" class="bp-hidden-date">
      <input type="time" id="bp-start" value="${formatHM(pos.startMin)}" step="300" title="начало">
      <span class="bp-dash">–</span>
      <input type="time" id="bp-end" value="${formatHM(endMin)}" step="300" title="конец">
      <span class="bp-dur">${pos.durationMinutes} мин</span>
      <button class="bp-ai" id="bp-ai" title="перенести текстом">✨</button>
    </div>
    <div class="bp-row">
      <div class="seg slider" data-seg="nature" data-pos="${t.nature === NATURE.STRATEGIC ? 0 : 1}">
        <span class="seg-thumb"></span>
        <button data-bp-nature="strategic" title="стратегическая — вклад в будущее">📈</button>
        <button data-bp-nature="tactical" title="тактическая — текущие дела">⏩</button>
      </div>
      <div class="seg slider soft" data-seg="type" data-pos="${isFixed ? 0 : 1}">
        <span class="seg-thumb"></span>
        <button data-bp-type="fixed" title="привязано ко времени">🔒</button>
        <button data-bp-type="flexible" title="без привязки ко времени — ставит алгоритм">↻</button>
      </div>
      <select id="bp-cat">${CATEGORIES.map((c) => `<option value="${c}" ${t.category === c ? 'selected' : ''}>${CAT_LABELS[c]}</option>`).join('')}</select>
    </div>
    <!-- строка появляется только у дел без привязки ко времени и выдвигается снизу -->
    <div class="bp-flexrow${isFixed ? ' hidden' : ' collapsed'}">
      <div class="seg slider soft" data-seg="split" data-pos="${t.splittable ? 0 : 1}"
        title="дробление задачи (минимальный фрагмент ${state.config.minChunkFloorMinutes || 45} мин)">
        <span class="seg-thumb"></span>
        <button data-bp-split="1" title="можно дробить на фрагменты по ${state.config.minChunkFloorMinutes || 45} мин">✂</button>
        <button data-bp-split="0" title="делать целиком, не дробить">🧱</button>
      </div>
      <button class="bp-date-btn soft ${t.earliest ? '' : 'pale'}" id="bp-earliest-btn"
        title="${t.earliest ? `не раньше ${t.earliest}` : 'не задано: не раньше какой даты планировать'}">📅<span class="bp-badge">от</span></button>
      <input type="date" id="bp-earliest" value="${t.earliest || ''}" class="bp-hidden-date">
      <button class="bp-date-btn soft ${t.deadline ? '' : 'pale'}" id="bp-deadline-btn"
        title="${t.deadline ? `дедлайн ${t.deadline}` : 'дедлайн не задан'}">📅<span class="bp-badge">до</span></button>
      <input type="date" id="bp-deadline" value="${t.deadline || ''}" class="bp-hidden-date">
      ${!isDraft && (t.chunks || []).some((c) => c.locked)
    ? '<button class="bp-unpin soft" id="bp-unpin" title="открепить — пусть ставит алгоритм">↻</button>' : ''}
    </div>
    <div class="bp-row bp-bottom">
      ${started ? `
      <button class="bp-done" id="bp-done" title="сделано">✅</button>
      <button class="bp-move" id="bp-move" title="перенести — подобрать новое место">↷</button>` : ''}
      ${isDraft ? '' : '<button class="bp-del" id="bp-del" title="удалить">🗑</button>'}
      <button class="bp-ok" id="bp-ok" title="сохранить и закрыть">✓</button>
      <button class="bp-cancel" id="bp-cancel" title="отменить изменения">✕</button>
    </div>`;
  app.insertBefore(pop, app.querySelector('.calwrap'));   // над календарём, календарь сдвигается вниз
  // выдвигаем строку гибкой задачи: сначала схлопнутая, затем в полную высоту
  const flexRow = pop.querySelector('.bp-flexrow.collapsed');
  if (flexRow) { void flexRow.offsetHeight; flexRow.classList.remove('collapsed'); }
  // панель пересобирается целиком, поэтому подсветку слайдера рисуем на прежней позиции
  // и лишь затем сдвигаем — так фон перетекает под соседний значок, а не прыгает
  pop.querySelectorAll('.seg[data-seg]').forEach((el) => {
    const key = el.dataset.seg;
    const now = el.dataset.pos;
    const prev = state.segPos ? state.segPos[key] : null;
    const thumb = el.querySelector('.seg-thumb');
    // CSS-переход на только что вставленном элементе не запускается (нет предыдущего
    // стиля), поэтому проигрываем сдвиг явно — от прежней позиции к текущей
    if (prev != null && prev !== now && thumb && thumb.animate) {
      thumb.animate(
        [{ transform: `translateX(${prev === '1' ? '100%' : '0%'})` },
          { transform: `translateX(${now === '1' ? '100%' : '0%'})` }],
        { duration: 260, easing: 'cubic-bezier(.4, 0, .2, 1)' },
      );
    }
    (state.segPos = state.segPos || {})[key] = now;
  });
  wirePopover();
}

function wirePopover() {
  const t = armedTask();
  const isDraft = state.armed.kind === 'draft';
  const after = () => { if (isDraft) { rebuildWeek(); mountPopover(); } else { persistAndReschedule(); render(); } };
  const beforeChange = () => { if (!isDraft) snapshot(); };

  document.querySelectorAll('#blockpop [data-bp-nature]').forEach((b) => {
    b.onclick = () => { beforeChange(); t.nature = b.getAttribute('data-bp-nature'); if (isDraft) state.draft.confidence.nature = 'ok'; after(); };
  });
  document.querySelectorAll('#blockpop [data-bp-type]').forEach((b) => {
    b.onclick = () => {
      const next = b.getAttribute('data-bp-type');
      if (next === t.type) return;
      beforeChange();
      // тип хранит время по-разному: fixed — в start/durationMinutes, flexible — в чанках.
      // без конвертации задача теряет и время, и длительность и пропадает с экрана.
      if (!isDraft) convertItemType(t, next, targetFor(state.armed).get());
      else t.type = next;
      after();
    };
  });
  const title = document.getElementById('bp-title');
  if (title) title.oninput = (e) => {
    t.title = e.target.value;
    const el = armedEl();
    const lab = el?.querySelector('.pvb-label') || el?.querySelector('.btitle');
    if (lab) lab.textContent = t.title;
    if (!isDraft) saveItems(state.items);
  };
  const cat = document.getElementById('bp-cat');
  if (cat) cat.onchange = (e) => { beforeChange(); t.category = e.target.value; after(); };

  // дата и время начала/конца — правятся вручную, как в обычном календаре
  const dateEl = document.getElementById('bp-date');
  const startEl = document.getElementById('bp-start');
  const endEl = document.getElementById('bp-end');
  const applyWhen = () => {
    const tgt = targetFor(state.armed);
    const p = tgt.get();
    const startMin = parseHM(startEl.value || formatHM(p.startMin));
    let endMin = parseHM(endEl.value || formatHM(p.startMin + p.durationMinutes));
    if (endMin <= startMin) endMin = startMin + PV_MIN_DUR;       // конец не раньше начала
    beforeChange();
    tgt.set({ dateKey: dateEl.value || p.dateKey, startMin, durationMinutes: endMin - startMin });
    if (isDraft) { rebuildWeek(); mountPopover(); } else { persistAndReschedule(); render(); }
  };
  [dateEl, startEl, endEl].forEach((el) => { if (el) el.onchange = applyWhen; });

  // значок календаря открывает системный выбор даты
  const calBtn = document.getElementById('bp-cal');
  if (calBtn) calBtn.onclick = () => {
    if (dateEl.showPicker) dateEl.showPicker();
    else { dateEl.style.position = 'static'; dateEl.focus(); dateEl.click(); }
  };

  // ✨ — перенос события фразой («перенеси на завтра в 15:00»)
  const aiBtn = document.getElementById('bp-ai');
  if (aiBtn) aiBtn.onclick = () => openMoveByText();

  // дробление задачи (только для гибких): целиком или фрагментами от minChunkFloorMinutes
  document.querySelectorAll('#blockpop [data-bp-split]').forEach((b) => {
    b.onclick = () => {
      const next = b.getAttribute('data-bp-split') === '1';
      if (next === !!t.splittable) return;
      beforeChange();
      t.splittable = next;
      if (next) t.minChunkMinutes = Math.max(t.minChunkMinutes || 0, state.config.minChunkFloorMinutes || 45);
      if (!isDraft) (t.chunks || []).forEach((c) => { c.locked = false; });  // пересобрать по новому правилу
      after();
    };
  });

  // границы окна планирования: «не раньше» и дедлайн — значки открывают выбор даты
  const openPicker = (el) => {
    if (!el) return;
    if (el.showPicker) el.showPicker();
    else { el.classList.remove('bp-hidden-date'); el.focus(); el.click(); }
  };
  const applyWindow = (field, value) => {
    if (!isDraft) snapshot();
    t[field] = value || null;
    if (isDraft) { mountPopover(); return; }
    // условия изменились — открепляем, чтобы алгоритм пересобрал план под новые границы
    (t.chunks || []).forEach((c) => { c.locked = false; });
    after();
  };
  const dl = document.getElementById('bp-deadline');
  if (dl) dl.onchange = (e) => applyWindow('deadline', e.target.value);
  const ea = document.getElementById('bp-earliest');
  if (ea) ea.onchange = (e) => applyWindow('earliest', e.target.value);
  const eaBtn = document.getElementById('bp-earliest-btn');
  if (eaBtn) eaBtn.onclick = () => openPicker(ea);
  const dlBtn = document.getElementById('bp-deadline-btn');
  if (dlBtn) dlBtn.onclick = () => openPicker(dl);

  // «сделано» и «перенести» для дела, которое уже идёт или прошло
  const doneBtn = document.getElementById('bp-done');
  if (doneBtn) doneBtn.onclick = () => { const id = state.armed.itemId; state.armed = null; markDone(id); };
  const moveBtn = document.getElementById('bp-move');
  if (moveBtn) moveBtn.onclick = () => { const id = state.armed.itemId; state.armed = null; movePastItem(id); };
  const unpin = document.getElementById('bp-unpin');
  if (unpin) unpin.onclick = () => {
    snapshot();
    (t.chunks || []).forEach((c) => { c.locked = false; });
    state.armed = null;
    persistAndReschedule(); render();
  };
  document.getElementById('bp-ok').onclick = () => disarm();
  const cancelBtn = document.getElementById('bp-cancel');
  if (cancelBtn) cancelBtn.onclick = () => {
    if (state.editSnapshot) {                        // возвращаем дело таким, каким открыли панель
      state.items = JSON.parse(state.editSnapshot);
      saveItems(state.items);
    }
    state.armed = null;
    state.editSnapshot = null;
    render();
  };
  const del = document.getElementById('bp-del');
  if (del) del.onclick = () => {
    snapshot();
    state.items = state.items.filter((x) => x.id !== state.armed.itemId);
    state.armed = null;
    reclaimFreedTime();
    persistAndReschedule(); render();
  };
}

/**
 * Шторка ставится сбоку от события и НИКОГДА его не перекрывает:
 * справа → слева → (если места мало) сужается → иначе уходит под/над блоком.
 */
/** Смена типа с переносом времени и длительности (иначе задача теряет размещение). */
function convertItemType(t, next, pos) {
  const startISO = dayAt(fromDateKey(pos.dateKey), pos.startMin).toISOString();
  const dur = pos.durationMinutes;
  if (next === TYPE.FIXED) {
    t.type = TYPE.FIXED;
    t.start = startISO;
    t.durationMinutes = dur;
    t.chunks = [];
    t.status = STATUS.SCHEDULED;
  } else {
    t.type = TYPE.FLEXIBLE;
    t.durationMinMinutes = dur;
    t.durationMaxMinutes = dur;
    t.importance = t.importance || 3;
    t.start = null;
    t.durationMinutes = null;
    t.chunks = [{ id: newId('c'), start: startISO, durationMinutes: dur, locked: true, status: STATUS.SCHEDULED }];
    t.status = STATUS.SCHEDULED;
  }
  // ключ активации привязан к чанку — обновляем, иначе шторка «потеряет» блок
  if (state.armed && state.armed.kind === 'item' && state.armed.itemId === t.id) {
    state.armed = { kind: 'item', itemId: t.id, chunkId: t.type === TYPE.FLEXIBLE ? t.chunks[0].id : null };
  }
}

// Шторка событий закрывается ТОЛЬКО кнопками ✓ (сохранить) и ✕ (отменить):
// случайный тап по календарю больше не сбрасывает правки.

// ----- перетаскивание черновика -----
function proposedStartDate() {
  const P = state.draft.proposed;
  return dayAt(fromDateKey(P.dateKey), P.startMin);
}
function clampN(v, lo, hi) { return hi < lo ? lo : Math.max(lo, Math.min(hi, v)); }
function snap5(m) { return Math.round(m / 5) * 5; }

function pointerToDayMinute(ev) {
  // колонки есть и в превью (.ptimeline), и на главном экране (.timeline) — у обеих есть data-date/lo/span
  const tls = [...document.querySelectorAll('[data-date][data-lo]')];
  if (!tls.length) return null;
  let inside = null; let nearest = null; let bestD = Infinity;
  for (const tl of tls) {
    const r = tl.getBoundingClientRect();
    const inX = ev.clientX >= r.left && ev.clientX <= r.right;
    const inY = ev.clientY >= r.top && ev.clientY <= r.bottom;
    if (inX && inY) { inside = { tl, r }; break; }
    const dx = ev.clientX < r.left ? r.left - ev.clientX : (ev.clientX > r.right ? ev.clientX - r.right : 0);
    const dy = ev.clientY < r.top ? r.top - ev.clientY : (ev.clientY > r.bottom ? ev.clientY - r.bottom : 0);
    const d = dx * dx + dy * dy;
    if (d < bestD) { bestD = d; nearest = { tl, r }; }
  }
  const c = inside || nearest;
  if (!c) return null;
  const lo = Number(c.tl.dataset.lo);
  const span = Number(c.tl.dataset.span);
  const frac = clampN((ev.clientY - c.r.top) / c.r.height, 0, 1);
  return { dateKey: c.tl.dataset.date, minute: lo + frac * span };
}

function updateDraftDom() {
  const P = state.draft.proposed;
  const el = document.getElementById('pvdraft');
  if (!el || el.closest('.ptimeline')?.dataset.date !== P.dateKey) { rebuildWeek(); return; }
  const wStart = parseHM(state.config.workStart);
  const ds = state.dragState;
  el.style.top = `${(P.startMin - wStart) * PV_PX}px`;
  el.style.height = `${P.durationMinutes * PV_PX}px`;
  el.classList.toggle('invalid', !!(ds ? ds.invalid : P.invalid));
  el.classList.toggle('dragging', !!(ds && ds.moving));
  const lab = el.querySelector('.pvb-label');
  if (lab) lab.textContent = state.draft.task.title || '';
}

function rebuildWeek() {
  const cal = document.getElementById('pvcal');
  if (!cal) return;
  cal.innerHTML = renderWeek();
  wirePvDraft();
}

function wirePvDraft() {
  // дела с ↦ уступают место одним кликом (без отдельного режима)
  document.querySelectorAll('#pvcal [data-yield]').forEach((el) => {
    el.onclick = () => { snapshot(); shiftItemByDay(el.dataset.yield); };
  });
  document.querySelectorAll('#pvcal [data-draftslot]').forEach((g) => {
    g.onclick = () => moveDraftTo(g.getAttribute('data-draftslot'));
  });
  document.querySelectorAll('#pvcal [data-draftundo]').forEach((b) => {
    b.onclick = (e) => { e.stopPropagation(); undoDraftMove(); };
  });
  const el = document.getElementById('pvdraft');
  if (el) attachArm(el, { kind: 'draft' });
  mountPopover();
}

function num(v) { const n = Number(v); return Number.isFinite(n) && n > 0 ? n : null; }

function saveDraft() {
  const t = state.draft.task;
  const P = state.draft.proposed;
  const errEl = document.getElementById('saveerr');
  const problems = [];
  if (!t.title || !t.title.trim()) problems.push('название');
  if (!P.durationMinutes) problems.push('длительность');
  if (problems.length) { if (errEl) errEl.textContent = `Заполните: ${problems.join(', ')}`; return; }

  const startISO = proposedStartDate().toISOString();
  if (t.type === TYPE.FIXED) {
    t.start = startISO;
    t.durationMinutes = P.durationMinutes;
  } else {
    t.durationMinMinutes = t.durationMaxMinutes = P.durationMinutes;
    if (state.draft.pinned) {
      t.chunks = [{ id: newId('c'), start: startISO, durationMinutes: P.durationMinutes, locked: true, status: STATUS.SCHEDULED }];
      t.status = STATUS.SCHEDULED;
    }
  }
  snapshot();
  state.items.push(makeTask(t));
  persistAndReschedule();
  state.draft = null;
  state.view = 'home';
  render();
}

// ---------- маршрутизация ----------
/**
 * После переплана чанки пересоздаются с новыми id — активная шторка иначе «теряет» дело
 * и молча закрывается. Переносим активацию на актуальный фрагмент той же задачи.
 */
function resyncArmedChunk() {
  const a = state.armed;
  if (!a || a.kind === 'draft') return;
  const t = state.items.find((x) => x.id === a.itemId);
  if (!t) { state.armed = null; state.editSnapshot = null; return; }
  if (t.type === TYPE.FIXED) { a.chunkId = null; return; }
  const chunks = t.chunks || [];
  if (chunks.some((c) => c.id === a.chunkId)) return;
  if (!chunks.length) { state.armed = null; state.editSnapshot = null; return; }
  a.chunkId = chunks[0].id;
}

function render() {
  // если наложение устранили вручную — снимаем режим выбора и пересчитываем план
  if (refreshCollision()) persistAndReschedule();
  resyncArmedChunk();
  if (state.view === 'confirm') return renderConfirm();
  return renderHome();
}

// начальная расстановка (рефлоу прошедшего) и старт
persistAndReschedule();
render();

if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('./sw.js').catch(() => {});
}
