import { describe, expect, it } from 'vitest';
import { findCommand } from '../src/commands/index.js';
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
    ] as const)
      expect(findCommand(cmd)?.dropsBindings, cmd).toContain(service);
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
