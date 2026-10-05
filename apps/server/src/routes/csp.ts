import type { FastifyInstance } from 'fastify';

/** Путь страницы без токенов клиента в адресе (личная страница, подписка). */
export function cspPage(raw: unknown): string {
  try {
    const u = new URL(String(raw ?? ''));
    return `${u.host}${u.pathname.replace(/^\/(c|sub)\/[^/]+/, '/$1/***')}`;
  } catch {
    return '';
  }
}

/** Что заблокировано: источник (без пути и запроса) или inline/eval/data. */
function blocked(raw: unknown): string {
  const s = String(raw ?? '');
  try {
    const u = new URL(s);
    return u.protocol === 'data:' || u.protocol === 'blob:' ? u.protocol : u.origin;
  } catch {
    return s.slice(0, 40);
  }
}

/**
 * Отчёты о нарушениях CSP: их шлют панель и личные страницы. В журнал - страница без токенов, директива и источник;
 * образцы кода (script-sample) не пишутся. Без входа и без проверки Origin: отчёт шлёт
 * браузер, в том числе со страницы на sub.<домен>.
 */
export async function cspRoutes(app: FastifyInstance) {
  app.addContentTypeParser(
    ['application/csp-report', 'application/reports+json'],
    { parseAs: 'string', bodyLimit: 16 * 1024 },
    (_req, body, done) => {
      try {
        done(null, JSON.parse(String(body)));
      } catch {
        done(null, {});
      }
    },
  );

  app.post(
    '/api/csp-report',
    { bodyLimit: 16 * 1024, config: { rateLimit: { max: 60, timeWindow: '1 minute' } } },
    async (req, reply) => {
      const body = req.body as Record<string, unknown> | Record<string, unknown>[] | null;
      // старый формат: {"csp-report": {...}}; Reporting API: [{type, body: {...}}]
      const items = Array.isArray(body)
        ? body.map((r) => (r.body ?? {}) as Record<string, unknown>)
        : [(body?.['csp-report'] ?? {}) as Record<string, unknown>];
      for (const r of items.slice(0, 10)) {
        req.log.warn(
          {
            csp: {
              page: cspPage(r['document-uri'] ?? r.documentURL),
              directive: String(
                r['effective-directive'] ?? r.effectiveDirective ?? r['violated-directive'] ?? '',
              ).slice(0, 60),
              blocked: blocked(r['blocked-uri'] ?? r.blockedURL),
              source: blocked(r['source-file'] ?? r.sourceFile),
              line: Number(r['line-number'] ?? r.lineNumber ?? 0) || undefined,
            },
          },
          'csp: нарушение',
        );
      }
      return reply.code(204).send();
    },
  );
}
