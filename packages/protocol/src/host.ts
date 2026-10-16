/**
 * Модель процессора для показа: без (R), (TM), частоты и числа ядер физического хоста
 * ("AMD EPYC 7542 32-Core Processor" у VPS на 2 vCPU путает). Процессор, который хостинг
 * прячет за виртуальной моделью (QEMU, "Common KVM processor"), - пустая строка.
 */
export function cpuModelLabel(raw: string | undefined): string {
  const s = (raw ?? '')
    .replace(/\((R|TM|tm|r)\)|\u00ae|\u2122/g, '')
    .replace(/@\s*[\d.]+\s*[GM]Hz/i, '')
    .replace(/\b\d+-Core\b/gi, '')
    .replace(/\b(CPU|Processor|processor)\b/g, '')
    .replace(/\(\s*\)/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  if (!s || /^(QEMU|Common KVM|Common 32-bit KVM|KVM|Virtual)\b/i.test(s) || /^version\b/i.test(s))
    return '';
  return s;
}
