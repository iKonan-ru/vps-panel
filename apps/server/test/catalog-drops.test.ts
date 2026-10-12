import { describe, expect, it } from 'vitest';
import { findCommand } from '../src/commands/index.js';

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

  it('WDTT: правила WDTT_MIRRORED его портов убираются', () => {
    expect(findCommand('wdtt-uninstall')?.script).toMatch(/iptables -D INPUT .*WDTT_MIRRORED/);
  });
});
