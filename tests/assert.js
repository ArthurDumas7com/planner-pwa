// Крошечный тест-harness без зависимостей (запускается в браузере).
export const tests = [];
export function test(name, fn) { tests.push({ name, fn }); }

export function assert(cond, msg) { if (!cond) throw new Error(msg || 'assert failed'); }
export function eq(a, b, msg) {
  if (a !== b) throw new Error(`${msg || 'eq'}: ожидалось ${JSON.stringify(b)}, получено ${JSON.stringify(a)}`);
}
export function approx(a, b, eps = 0.01, msg) {
  if (Math.abs(a - b) > eps) throw new Error(`${msg || 'approx'}: ${a} vs ${b}`);
}

export function run(onLine) {
  let pass = 0; let fail = 0;
  const lines = [];
  for (const t of tests) {
    try {
      t.fn();
      pass += 1;
      lines.push(`PASS  ${t.name}`);
    } catch (e) {
      fail += 1;
      lines.push(`FAIL  ${t.name}  —  ${e.message}`);
    }
  }
  const summary = `ИТОГ: ${pass} passed, ${fail} failed, всего ${tests.length}`;
  lines.forEach((l) => onLine(l, l.startsWith('FAIL')));
  onLine(summary, fail > 0);
  return { pass, fail, summary };
}
