import { describe, expect, it } from 'vitest';
import { xuiLinksOutdated, xuiTargets } from '../src/lib/gclient-services.js';

const ib = (id: number, extra: Record<string, unknown> = {}) => ({
  id,
  protocol: 'vless',
  remark: `in${id}`,
  enable: true,
  nodeId: 0,
  ...extra,
});

describe('xuiTargets', () => {
  it('свои включённые VLESS без исключённых', () => {
    const r = xuiTargets(
      [ib(1), ib(2, { enable: false }), ib(3, { nodeId: 7 }), ib(4, { protocol: 'trojan' }), ib(5)],
      [5],
    );
    expect(r).toEqual({ target: [1], reason: '' });
  });

  it('своих VLESS нет', () => {
    expect(xuiTargets([ib(3, { nodeId: 7 })], []).reason).toBe('в 3X-UI нет своих inbound VLESS');
  });

  it('причина называет исключённые и выключенные inbound-ы', () => {
    const r = xuiTargets([ib(1), ib(2, { enable: false, remark: '' })], [1]);
    expect(r.target).toEqual([]);
    expect(r.reason).toBe(
      'некуда добавить VLESS\u00a0\u2014 исключены на странице \u00abКлиенты\u00bb: in1; выключены в 3X-UI: inbound 2',
    );
  });
});

describe('xuiLinksOutdated', () => {
  const b = {
    links: ['vless://u@localhost:48670?security=reality#x'],
    updatedAt: '2026-10-01T18:12:35Z',
  };
  it('порт inbound-а сменили в 3X-UI - ссылки устарели', () => {
    expect(xuiLinksOutdated(b, { at: '2026-10-01T18:23:42Z', ports: [8443] })).toBe(true);
  });
  it('порт тот же, отчёт старше ссылок или его нет - не трогать', () => {
    expect(xuiLinksOutdated(b, { at: '2026-10-01T18:23:42Z', ports: [48670] })).toBe(false);
    expect(xuiLinksOutdated(b, { at: '2026-10-01T18:10:00Z', ports: [8443] })).toBe(false);
    expect(xuiLinksOutdated(b, null)).toBe(false);
  });
  it('адрес IPv6 в ссылке', () => {
    const v6 = { ...b, links: ['vless://u@[::1]:443?type=tcp#x'] };
    expect(xuiLinksOutdated(v6, { at: '2026-10-01T18:23:42Z', ports: [443] })).toBe(false);
  });
});
