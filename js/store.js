// Персистентность в localStorage (для одного пользователя офлайн этого достаточно;
// апгрейд на IndexedDB — при росте объёма, см. критику спека).
import { DEFAULT_CONFIG } from './core/model.js';

const ITEMS_KEY = 'ptm.items.v1';
const CONFIG_KEY = 'ptm.config.v1';

export function loadItems() {
  try { return JSON.parse(localStorage.getItem(ITEMS_KEY)) || []; }
  catch { return []; }
}

export function saveItems(items) {
  localStorage.setItem(ITEMS_KEY, JSON.stringify(items));
}

export function loadConfig() {
  try { return { ...DEFAULT_CONFIG, ...(JSON.parse(localStorage.getItem(CONFIG_KEY)) || {}) }; }
  catch { return { ...DEFAULT_CONFIG }; }
}

export function saveConfig(config) {
  localStorage.setItem(CONFIG_KEY, JSON.stringify(config));
}
