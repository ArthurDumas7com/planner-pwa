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
  try { return migrate({ ...DEFAULT_CONFIG, ...(JSON.parse(localStorage.getItem(CONFIG_KEY)) || {}) }); }
  catch { return { ...DEFAULT_CONFIG }; }
}

/**
 * Настройки старой версии: один раз показываем новый начальный экран (один день),
 * дальше выбор пользователя снова уважается.
 */
function migrate(config) {
  if (config.configVersion === DEFAULT_CONFIG.configVersion) return config;
  const next = { ...config, daysVisible: 1, configVersion: DEFAULT_CONFIG.configVersion };
  saveConfig(next);
  return next;
}

export function saveConfig(config) {
  localStorage.setItem(CONFIG_KEY, JSON.stringify(config));
}
