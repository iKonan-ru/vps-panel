import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import { loadEnv } from '../src/config.js';
import { createDb } from '../src/db/index.js';
import { gclients } from '../src/db/schema.js';
import { newClientToken, newXuiSubId } from '../src/lib/gclient-names.js';
import { cspPage } from '../src/routes/csp.js';

const dir = mkdtempSync(join(tmpdir(), 'vps-csp-'));
const env = loadEnv({ NODE_ENV: 'test', DATA_DIR: dir, PANEL_PUBLIC_URL: 'https://panel.example' });
let built: Awaited<ReturnType<typeof buildApp>>;
const token = newClientToken();

beforeAll(async () => {
  built = await buildApp({ env, db: createDb(':memory:') });
  await built.app.ready();
  built.db
    .insert(gclients)
    .values({ id: 'c1', name: 'Иван', slug: 'ivan-1', token, xuiSubId: newXuiSubId() })
    .run();
});
afterAll(async () => {
  await built.app.close();
  rmSync(dir, { recursive: true, force: true });
});

describe('CSP', () => {
  it('отчёт принимается без входа и с чужим Origin (страница на sub.)', async () => {
    const res = await built.app.inject({
      method: 'POST',
      url: '/api/csp-report',
      headers: { 'content-type': 'application/csp-report', origin: 'https://sub.panel.example' },
      payload: JSON.stringify({
        'csp-report': {
          'document-uri': `https://sub.panel.example/c/${token}`,
          'effective-directive': 'script-src-elem',
          'blocked-uri': 'https://evil.example/x.js?a=1',
        },
      }),
    });
    expect(res.statusCode).toBe(204);
  });

  it('в журнал страница попадает без токена клиента', () => {
    expect(cspPage(`https://sub.panel.example/c/${token}/awg/b1`)).toBe(
      'sub.panel.example/c/***/awg/b1',
    );
    expect(cspPage(`https://sub.panel.example/sub/${token}`)).toBe('sub.panel.example/sub/***');
  });

  it('личная страница: хеши в политике совпадают со скриптом и стилями страницы', async () => {
    const res = await built.app.inject({ method: 'GET', url: `/c/${token}` });
    expect(res.statusCode).toBe(200);
    const csp = String(res.headers['content-security-policy']);
    const script = /<script>([\s\S]*?)<\/script>/.exec(res.body)?.[1] ?? '';
    const style = /<style>([\s\S]*?)<\/style>/.exec(res.body)?.[1] ?? '';
    const h = (s: string) => `'sha256-${createHash('sha256').update(s).digest('base64')}'`;
    expect(csp).toContain(`script-src ${h(script)}`);
    expect(csp).toContain(`style-src ${h(style)}`);
    expect(csp).toContain("default-src 'none'");
    expect(csp).toContain('report-uri https://panel.example/api/csp-report');
  });
});
