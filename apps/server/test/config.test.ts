import { describe, expect, it } from 'vitest';
import { loadEnv } from '../src/config.js';

describe('loadEnv', () => {
  it('адрес подписок: SUB_PUBLIC_URL, иначе https://SUB_DOMAIN, иначе нет (адрес панели)', () => {
    expect(loadEnv({ SUB_DOMAIN: 'sub.example.org' }).SUB_PUBLIC_URL).toBe(
      'https://sub.example.org',
    );
    expect(
      loadEnv({ SUB_DOMAIN: 'sub.example.org', SUB_PUBLIC_URL: 'http://localhost:4000' })
        .SUB_PUBLIC_URL,
    ).toBe('http://localhost:4000');
    expect(loadEnv({ SUB_DOMAIN: '' }).SUB_PUBLIC_URL).toBeUndefined();
  });

  it('SESSION_SECRET обязателен, если панель не на loopback', () => {
    expect(() =>
      loadEnv({
        NODE_ENV: 'development',
        PANEL_HOST: '0.0.0.0',
        PANEL_PUBLIC_URL: 'https://panel.example',
      }),
    ).toThrow('SESSION_SECRET');
    expect(
      loadEnv({
        NODE_ENV: 'development',
        PANEL_HOST: '127.0.0.1',
        PANEL_PUBLIC_URL: 'http://127.0.0.1:3000',
      }),
    ).toBeTruthy();
    expect(loadEnv({ NODE_ENV: 'test', PANEL_PUBLIC_URL: 'https://panel.example' }).NODE_ENV).toBe(
      'test',
    );
  });

  it('совместимость с агентами v2 отключается явно', () => {
    expect(loadEnv({ AGENT_V2_COMPAT: '0' }).AGENT_V2_COMPAT).toBe(false);
    expect(loadEnv({ AGENT_V2_COMPAT: '1' }).AGENT_V2_COMPAT).toBe(true);
    expect(loadEnv({}).AGENT_V2_COMPAT).toBe(true);
  });

  it('в production адрес панели - только https (http - лишь на этой машине)', () => {
    const base = { NODE_ENV: 'production', SESSION_SECRET: 'S'.repeat(40) } as const;
    expect(() => loadEnv({ ...base, PANEL_PUBLIC_URL: 'http://panel.example' })).toThrow('https');
    expect(loadEnv({ ...base, PANEL_PUBLIC_URL: 'https://panel.example' }).PANEL_PUBLIC_URL).toBe(
      'https://panel.example',
    );
    expect(loadEnv({ ...base, PANEL_PUBLIC_URL: 'http://127.0.0.1:3000' })).toBeTruthy();
  });
});
