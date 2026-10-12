import { awgCmd } from './catalog-awg.js';
import { mtproxylHostCmd } from './catalog-mtproxyl-host.js';
import { mtproxylCmd } from './catalog-mtproxyl.js';
import { naiveCmd, naiveUninstallCmd } from './catalog-naive.js';
import { openfluxCmd, openfluxUninstallCmd } from './catalog-openflux.js';
import { legacyCertsCmd, panelsLocalCmd } from './catalog-panels.js';
import {
  awgUninstallCmd,
  mtproxylUninstallCmd,
  wdttUninstallCmd,
  xuiUninstallCmd,
} from './catalog-uninstall.js';
import { wdttCmd } from './catalog-wdtt.js';
import { xuiCmd } from './catalog-xui.js';
import type { CommandDef, CommandParam } from './types.js';

/** Готовый каталог. Порядок - порядок показа в группе. */
export const CATALOG: CommandDef[] = [
  xuiCmd,
  mtproxylCmd,
  awgCmd,
  wdttCmd,
  openfluxCmd,
  naiveCmd,
  xuiUninstallCmd,
  mtproxylUninstallCmd,
  wdttUninstallCmd,
  awgUninstallCmd,
  openfluxUninstallCmd,
  naiveUninstallCmd,
  panelsLocalCmd,
  mtproxylHostCmd,
  legacyCertsCmd,
];

export function findCommand(id: string): CommandDef | undefined {
  return CATALOG.find((c) => c.id === id);
}

/** Значения по умолчанию для формы: default, либо generate() на каждый показ. */
export function defaultsFor(c: CommandDef): Record<string, string> {
  const out: Record<string, string> = {};
  for (const p of c.params) {
    if (p.generate) out[p.name] = p.generate();
    else if (p.default !== undefined) out[p.name] = p.default;
  }
  return out;
}

function visible(p: CommandParam, answers: Record<string, string>): boolean {
  if (!p.showIf) return true;
  return Object.entries(p.showIf).every(([k, v]) => answers[k] === v);
}

/** Проверяет ответы по описанию параметров. Возвращает список ошибок (пусто - всё хорошо). */
export function validateAnswers(c: CommandDef, answers: Record<string, string>): string[] {
  const errors: string[] = [];
  for (const p of c.params) {
    if (!visible(p, answers)) continue;
    const v = (answers[p.name] ?? '').trim();
    if (!v) {
      if (p.required) errors.push(`${p.label}: обязательное поле`);
      continue;
    }
    if (p.type === 'port' || p.type === 'number') {
      const n = Number(v);
      const min = p.min ?? (p.type === 'port' ? 1 : Number.NEGATIVE_INFINITY);
      const max = p.max ?? (p.type === 'port' ? 65535 : Number.POSITIVE_INFINITY);
      if (!Number.isInteger(n) || n < min || n > max)
        errors.push(`${p.label}: число от ${min} до ${max}`);
    }
    if (p.type === 'domain' && !/^([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/i.test(v))
      errors.push(`${p.label}: неверное доменное имя`);
    if (p.type === 'awg-container' && !/^amnezia-awg[0-9]*(-[0-9]{1,5})?$/.test(v))
      errors.push(`${p.label}: неверное имя контейнера AWG`);
    if (p.type === 'select' && p.options && !p.options.some((o) => o.value === v))
      errors.push(`${p.label}: недопустимое значение`);
    if (p.pattern && !new RegExp(p.pattern).test(v)) errors.push(`${p.label}: неверный формат`);
    if (v.length > 4000) errors.push(`${p.label}: слишком длинное значение`);
  }
  return errors;
}

/** Ответы без секретов - для журнала и значений по умолчанию. */
export function stripSecrets(
  c: CommandDef,
  answers: Record<string, string>,
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const p of c.params) {
    if (p.secret || p.type === 'password') continue;
    if (answers[p.name] !== undefined) out[p.name] = answers[p.name] ?? '';
  }
  return out;
}
