import { FindingSchema, ServiceSchema } from '@vps/protocol';
import { describe, expect, it } from 'vitest';

// Ссылки от агента - только http(s), плохое значение отбрасывается без падения
describe('ссылки от агента', () => {
  const svc = (panelUrl: unknown) =>
    ServiceSchema.parse({ kind: 'xui', title: '3X-UI', ports: [], panelUrl });

  it('http(s) остаётся', () => {
    expect(svc('https://1.2.3.4:2053/x/').panelUrl).toBe('https://1.2.3.4:2053/x/');
    expect(svc('http://1.2.3.4:8080/').panelUrl).toBe('http://1.2.3.4:8080/');
  });

  it('другие схемы и мусор отбрасываются, снимок разбирается', () => {
    for (const bad of ['javascript:alert(1)', 'data:text/html,x', 'file:///etc', 'tg://x', 42]) {
      expect(svc(bad).panelUrl).toBeUndefined();
    }
    expect(svc(undefined).panelUrl).toBeUndefined();
  });

  it('действия замечаний аудита', () => {
    const f = (url: unknown) =>
      FindingSchema.parse({ severity: 'high', text: 't', fix: 'f', url }).url;
    for (const ok of ['fix:sshd', 'cmd:xui', 'tab:firewall', 'cleanup:', 'https://a.b/']) {
      expect(f(ok)).toBe(ok);
    }
    expect(f('javascript:alert(1)')).toBeUndefined();
    expect(f('cmd:x y')).toBeUndefined();
  });
});
