import { describe, expect, it } from 'vitest';
import { findCommand, validateAnswers } from '../src/commands/index.js';
import { WDTT_FW_FUNCS } from '../src/commands/util.js';

describe('удаление сервиса стирает привязки клиентов сразу', () => {
  it('у всех команд удаления сервиса с клиентами', () => {
    for (const [cmd, service] of [
      ['xui-uninstall', 'xui'],
      ['mtproxyl-uninstall', 'mtproxyl'],
      ['wdtt-uninstall', 'wdtt'],
      ['awg-uninstall', 'awg'],
      ['openflux-uninstall', 'openflux'],
      ['naive-uninstall', 'naive'],
    ] as const) {
      const d = findCommand(cmd)?.dropsBindings;
      expect(typeof d === 'function' ? d({}) : d, cmd).toContain(service);
    }
  });

  it('MTProxyL: удаление только панели оставляет привязки и убирает доступ к панели', () => {
    const c = findCommand('mtproxyl-uninstall');
    const drops = c?.dropsBindings as (a: Record<string, string>) => string[];
    const forgets = c?.forgetsAccess as (a: Record<string, string>) => string[];
    expect(drops({ MT_WHAT: 'all' })).toEqual(['mtproxyl']);
    expect(drops({ MT_WHAT: 'panel' })).toEqual([]);
    expect(forgets({ MT_WHAT: 'panel' })).toEqual(['mtproxyl-panel']);
    expect(forgets({ MT_WHAT: 'all' })).toEqual([]);
    expect(c?.plan({ MT_WHAT: 'panel' }).join(' ')).toContain('остаются');
  });

  it('MTProxyL без панели: логин, пароль и порт панели не нужны, доступов нет', () => {
    const c = findCommand('mtproxyl');
    if (!c) throw new Error('нет команды');
    const base = { MT_PORT: '443', MT_SNI: 'example.com', MT_USERS: 'default' };
    expect(validateAnswers(c, { ...base, MT_PANEL: 'no' })).toEqual([]);
    expect(validateAnswers(c, { ...base, MT_PANEL: 'yes' }).join('; ')).toContain('Пароль');
    const ctx = { panelUrl: 'https://p.example', server: { id: 's', name: 'S', host: 'h' } };
    expect(c.access?.({ ...ctx, answers: { ...base, MT_PANEL: 'no' }, output: '' })).toBeNull();
    expect(c.plan({ ...base, MT_PANEL: 'no' }).join(' ')).toContain('Без веб-панели');
    expect(c.script).toContain('[ "$MT_PANEL" = no ] && panel=no');
  });

  it('AWG - только привязки удаляемого контейнера', () => {
    const c = findCommand('awg-uninstall');
    expect(c?.dropsBindingsRef?.({ AWG_CONTAINER: 'amnezia-awg2' })).toBe('|amnezia-awg2|');
    expect('3|amnezia-awg2|/jx2n'.includes('|amnezia-awg2|')).toBe(true);
    expect('3|amnezia-awg|/jx2n'.includes('|amnezia-awg2|')).toBe(false);
  });

  it('WDTT: зеркальные правила WDTT_MIRRORED убираются при удалении и установке', () => {
    expect(WDTT_FW_FUNCS).toContain('--comment WDTT_MIRRORED');
    expect(WDTT_FW_FUNCS).toContain("sed 's/^-A /-D /'");
    for (const cmd of ['wdtt-uninstall', 'wdtt']) {
      const s = findCommand(cmd)?.script ?? '';
      expect(s, cmd).toContain('portsync_governs()');
      expect(s, cmd).toMatch(/if portsync_governs; then[\s\S]*wdtt_mirrors_drop/);
    }
  });
});
