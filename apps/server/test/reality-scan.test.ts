import { describe, expect, it } from 'vitest';
import { normalizeTarget, realityScan, rejectReason } from '../src/lib/reality-scan.js';

const ok = (obj: unknown) => ({ status: 200, data: { success: true, obj } });

describe('подбор цели Reality', () => {
  it('свой адрес: имя или IPv4, порт по умолчанию 443, мусор - null', () => {
    expect(normalizeTarget('https://Example.COM/path')).toBe('example.com:443');
    expect(normalizeTarget('203.0.113.10:8443')).toBe('203.0.113.10:8443');
    expect(normalizeTarget('example')).toBeNull();
    expect(normalizeTarget('example.com:99999')).toBeNull();
  });

  it('причины отказа - по-русски', () => {
    expect(rejectReason({ reason: 'server does not negotiate HTTP/2 (h2)' })).toBe('нет HTTP/2');
    expect(rejectReason({ reason: 'connection failed: dial tcp: i/o timeout' })).toBe(
      'не отвечает',
    );
  });

  it('свои адреса - формой, отказы с причинами; неверный адрес не уходит на сервер', async () => {
    const sent: string[] = [];
    const form = async (_m: string, _p: string, f?: Record<string, string> | null) => {
      sent.push(f?.targets ?? '');
      return ok([
        {
          target: 'ya.ru:443',
          host: 'ya.ru',
          feasible: true,
          latencyMs: 5,
          serverNames: ['ya.ru'],
        },
        {
          target: 'bad.ru:443',
          host: 'bad.ru',
          feasible: false,
          reason: 'server does not negotiate TLS 1.3',
        },
      ]);
    };
    const r = await realityScan(
      { form: form as never, api: (async () => ok([])) as never, host: '198.51.100.5' },
      { targets: ['ya.ru', 'bad.ru', 'не адрес'] },
    );
    expect(sent).toEqual(['ya.ru:443,bad.ru:443']);
    expect(r.targets.map((t) => t.target)).toEqual(['ya.ru:443']);
    expect(r.rejected).toEqual([
      { target: 'не адрес', reason: 'неверный адрес' },
      { target: 'bad.ru:443', reason: 'нет TLS 1.3' },
    ]);
  });

  it('рядом с сервером: /24 двумя запросами, сам сервер не предлагается', async () => {
    const sent: string[] = [];
    const form = async (_m: string, _p: string, f?: Record<string, string> | null) => {
      sent.push(f?.targets ?? '');
      return ok([
        {
          target: '198.51.100.5:443',
          feasible: true,
          latencyMs: 1,
          serverNames: ['panel.example.com'],
        },
        {
          target: '198.51.100.7:443',
          feasible: true,
          latencyMs: 2,
          serverNames: ['shop.example.com'],
        },
      ]);
    };
    const r = await realityScan(
      { form: form as never, api: (async () => ok([])) as never, host: '198.51.100.5' },
      { preset: 'nearby' },
    );
    expect(sent).toEqual(['198.51.100.0/25', '198.51.100.128/25']);
    expect(r.targets.map((t) => t.target)).toEqual(['198.51.100.7:443']);
  });

  it('старый агент: только список 3X-UI, свои адреса - ошибка', async () => {
    const calls: string[] = [];
    const api = async (_m: string, p: string) => {
      calls.push(p);
      return ok([]);
    };
    await realityScan({ form: null, api: api as never, host: '198.51.100.5' }, { preset: 'ru' });
    expect(calls).toEqual(['server/scanRealityTargets']);
    await expect(
      realityScan({ form: null, api: api as never, host: '198.51.100.5' }, { targets: ['ya.ru'] }),
    ).rejects.toThrow(/агент/);
  });
});
