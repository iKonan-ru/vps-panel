import { describe, expect, it } from 'vitest';
import { githubError } from '../src/lib/github.js';

const res = (status: number, headers: Record<string, string> = {}) =>
  new Response(null, { status, headers });

describe('ошибка GitHub API', () => {
  it('исчерпан лимит без токена - понятный текст со сроком, а не "GitHub: 403"', () => {
    const reset = String(Math.floor(Date.now() / 1000) + 25 * 60);
    const m = githubError(
      res(403, { 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': reset }),
    ).message;
    expect(m).toContain('лимит запросов GitHub исчерпан');
    expect(m).toMatch(/сбросится через 2[56]\u00a0мин/);
    expect(githubError(res(429, { 'x-ratelimit-remaining': '0' })).message).toContain('лимит');
  });

  it('прочие коды - как есть', () => {
    expect(githubError(res(403)).message).toBe('GitHub: 403');
    expect(githubError(res(502)).message).toBe('GitHub: 502');
  });
});
