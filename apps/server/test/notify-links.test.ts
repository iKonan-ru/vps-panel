import { describe, expect, it } from 'vitest';
import { serverHref, serverLabel } from '../src/lib/notify.js';

describe('ссылки на сервер в уведомлениях', () => {
  it('карточка сервера и вкладка сервиса', () => {
    expect(serverHref('https://panel.example.com', 'abc123')).toBe(
      'https://panel.example.com/servers/abc123',
    );
    expect(serverHref('https://panel.example.com/', 'abc123', 'xui')).toBe(
      'https://panel.example.com/servers/abc123/xui',
    );
    expect(serverHref('https://203.0.113.5', 'a b')).toBe('https://203.0.113.5/servers/a%20b');
  });

  it('без адреса панели - без ссылки', () => {
    expect(serverHref('', 'abc123')).toBe('');
    expect(serverLabel('Hoster', '198.51.100.7', '')).toBe('<b>Hoster</b> (198.51.100.7)');
  });

  it('имя и адрес экранируются', () => {
    expect(
      serverLabel('A<b>&"', '198.51.100.7', 'https://panel.example.com/servers/x?a=1&b="2"'),
    ).toBe(
      '<a href="https://panel.example.com/servers/x?a=1&amp;b=&quot;2&quot;"><b>A&lt;b&gt;&amp;"</b></a> (198.51.100.7)',
    );
  });
});
