import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { Db } from '../db/index.js';
import {
  consumeBackupCode,
  createSession,
  deleteAllSessions,
  deleteSession,
  findAdminByLogin,
  findSession,
  isSetupDone,
  recordAttempt,
  saveTotp,
  tooManyAttempts,
  totpEnrollment,
  verifyPassword,
  verifyTotp,
} from '../lib/auth.js';
import { newToken } from '../lib/ids.js';

/**
 * Префикс имён cookie: на https - `__Host-`. Такую cookie браузер принимает только с Secure,
 * Path=/ и без Domain, поэтому поддомены панели (sub., панели сервисов на серверах) не могут
 * подложить или перекрыть её своей. Задаётся один раз при сборке приложения.
 */
let cookiePrefix = '';
export function useHostCookies(secure: boolean) {
  cookiePrefix = secure ? '__Host-' : '';
}
export const sessionCookie = () => `${cookiePrefix}vps_session`;
/** Промежуточная cookie между паролем и кодом TOTP, живёт 5 минут. */
const pendingCookie = () => `${cookiePrefix}vps_pending`;
/** Токен сессии из cookie запроса. */
export const sessionToken = (req: import('fastify').FastifyRequest) => req.cookies[sessionCookie()];

/**
 * Между паролем и кодом: кто вошёл паролем и, если 2FA ещё не настроена (первый вход или сброс
 * из консоли), новый секрет с резервными кодами - в базу они попадают после первого верного кода.
 */
const pending = new Map<
  string,
  {
    adminId: string;
    login: string;
    expires: number;
    enroll?: { secret: string; codes: string[]; uri: string };
  }
>();

function sweep() {
  const now = Date.now();
  for (const [k, v] of pending) if (v.expires < now) pending.delete(k);
}

function cookieOpts(secure: boolean, maxAgeSec: number) {
  return { path: '/', httpOnly: true, sameSite: 'strict' as const, secure, maxAge: maxAgeSec };
}

export async function authRoutes(app: FastifyInstance, opts: { db: Db; secure: boolean }) {
  const { db, secure } = opts;

  // Администратор создаётся при установке (vps-panel install) или из консоли (vps-panel admin):
  // мастера в браузере нет - до него панель была бы открыта первому зашедшему.
  app.get('/api/setup/status', async () => ({ setupDone: await isSetupDone(db) }));

  // Шаг 1: логин и пароль.
  app.post(
    '/api/auth/login',
    { config: { rateLimit: { max: 20, timeWindow: '1 minute' } } },
    async (req, reply) => {
      const { login, password } = z
        .object({ login: z.string().min(1).max(64), password: z.string().min(1).max(200) })
        .parse(req.body);
      if (await tooManyAttempts(db, req.ip)) {
        return reply
          .code(429)
          .send({ error: 'слишком много попыток, следующая\u00a0\u2014 через 15\u00a0минут' });
      }
      const admin = await findAdminByLogin(db, login);
      const ok = admin ? await verifyPassword(admin.passwordHash, password) : false;
      await recordAttempt(db, req.ip, login, ok);
      if (!admin || !ok) return reply.code(401).send({ error: 'неверный логин или пароль' });
      sweep();
      const p = newToken();
      if (admin.totpEnabled && admin.totpSecret) {
        pending.set(p, { adminId: admin.id, login: admin.login, expires: Date.now() + 5 * 60_000 });
        reply.setCookie(pendingCookie(), p, cookieOpts(secure, 300));
        return { next: 'totp' };
      }
      // 2FA ещё не настроена: первый вход после установки или сброс из консоли
      const enroll = totpEnrollment(admin.login);
      pending.set(p, {
        adminId: admin.id,
        login: admin.login,
        expires: Date.now() + 15 * 60_000,
        enroll,
      });
      reply.setCookie(pendingCookie(), p, cookieOpts(secure, 900));
      return {
        next: 'enroll',
        totpUri: enroll.uri,
        totpSecret: enroll.secret,
        backupCodes: enroll.codes,
      };
    },
  );

  // Первый вход: код из приложения с новым секретом включает 2FA и открывает сессию.
  app.post(
    '/api/auth/enroll',
    { config: { rateLimit: { max: 20, timeWindow: '1 minute' } } },
    async (req, reply) => {
      const p = req.cookies[pendingCookie()];
      const pend = p ? pending.get(p) : undefined;
      if (!p || !pend?.enroll || pend.expires < Date.now())
        return reply.code(401).send({ error: 'время входа истекло, нужно войти заново' });
      const { code } = z.object({ code: z.string().min(6).max(8) }).parse(req.body);
      const ok = verifyTotp(pend.enroll.secret, code);
      await recordAttempt(db, req.ip, pend.login, ok);
      if (!ok) return reply.code(400).send({ error: 'неверный код' });
      await saveTotp(db, pend.adminId, pend.enroll.secret, pend.enroll.codes);
      pending.delete(p);
      reply.clearCookie(pendingCookie(), { path: '/', secure });
      return openSession(db, reply, pend.adminId, req.ip, req.headers['user-agent'] ?? '', secure);
    },
  );

  // Шаг 2: код из приложения или резервный код.
  app.post(
    '/api/auth/totp',
    { config: { rateLimit: { max: 20, timeWindow: '1 minute' } } },
    async (req, reply) => {
      const p = req.cookies[pendingCookie()];
      const pend = p ? pending.get(p) : undefined;
      if (!p || !pend || pend.expires < Date.now())
        return reply.code(401).send({ error: 'время входа истекло, нужно войти заново' });
      const { code } = z.object({ code: z.string().min(6).max(12) }).parse(req.body);
      const admin = await findAdminByLogin(db, pend.login);
      if (!admin?.totpEnabled || pend.enroll)
        return reply.code(401).send({ error: 'время входа истекло, нужно войти заново' });
      const okTotp = admin.totpSecret ? verifyTotp(admin.totpSecret, code) : false;
      const okBackup = okTotp ? false : await consumeBackupCode(db, admin.id, code);
      await recordAttempt(db, req.ip, admin.login, okTotp || okBackup);
      if (!okTotp && !okBackup) return reply.code(401).send({ error: 'неверный код' });
      pending.delete(p);
      reply.clearCookie(pendingCookie(), { path: '/', secure });
      return openSession(db, reply, admin.id, req.ip, req.headers['user-agent'] ?? '', secure);
    },
  );

  app.get('/api/auth/me', async (req, reply) => {
    const s = await sessionOf(db, sessionToken(req));
    if (!s) return reply.code(401).send({ error: 'вход не выполнен' });
    return { login: s.login, expiresAt: s.expiresAt };
  });

  app.post('/api/auth/logout', async (req, reply) => {
    const t = sessionToken(req);
    if (t) await deleteSession(db, t);
    reply.clearCookie(sessionCookie(), { path: '/', secure });
    return { ok: true };
  });

  app.post('/api/auth/logout-all', async (req, reply) => {
    const s = await sessionOf(db, sessionToken(req));
    if (!s) return reply.code(401).send({ error: 'вход не выполнен' });
    await deleteAllSessions(db, s.adminId);
    reply.clearCookie(sessionCookie(), { path: '/', secure });
    return { ok: true };
  });
}

export async function openSession(
  db: Db,
  reply: import('fastify').FastifyReply,
  adminId: string,
  ip: string,
  ua: string,
  secure: boolean,
) {
  const s = await createSession(db, adminId, ip, ua);
  reply.setCookie(sessionCookie(), s.token, cookieOpts(secure, 30 * 86_400));
  return { ok: true, expiresAt: s.expiresAt };
}

export async function sessionOf(db: Db, token: string | undefined) {
  if (!token) return null;
  return findSession(db, token);
}

/**
 * Запрос браузера с чужой страницы: Origin есть и не совпадает с адресом, на который пришёл
 * запрос. Cookie SameSite=strict уходит и со страниц поддоменов того же сайта (sub., панели
 * сервисов), поэтому изменяющие /api и websocket (терминал - это root) проверяют Origin. Без
 * Origin - не браузер: подделать запрос с cookie админа он не может.
 */
export function foreignOrigin(req: import('fastify').FastifyRequest): boolean {
  const origin = req.headers.origin;
  if (!origin) return false;
  try {
    return new URL(origin).host !== req.headers.host;
  } catch {
    return true;
  }
}

/**
 * Маршруты /api без сессии - перечислены явно: новый маршрут, даже под
 * /api/agent/, по умолчанию закрыт входом.
 */
export const OPEN_API = new Set([
  '/api/health',
  '/api/setup/status',
  '/api/auth/login',
  '/api/auth/totp',
  '/api/auth/enroll',
  // агенты: свои одноразовые токены (загрузка - ещё и Bearer)
  '/api/agent/backups/upload/:token',
  '/api/agent/backups/download/:token',
  // спрашивает Caddy перед выпуском сертификата поддомена
  '/api/proxy/ask',
  // сам проверяет сессию и отправляет на вход
  '/api/proxy/open/:label',
  // отчёт CSP шлёт браузер, в том числе со страницы на sub.<домен>
  '/api/csp-report',
]);

/** Хук: закрывает все /api/* кроме OPEN_API. */
export function requireAuth(db: Db) {
  return async (req: import('fastify').FastifyRequest, reply: import('fastify').FastifyReply) => {
    // Шаблон совпавшего маршрута, а не req.url: роутер декодирует путь, и /%61pi/... иначе
    // попадал бы в /api/... мимо проверки. Нет маршрута - ответит 404, данных там нет.
    const url = req.routeOptions.url ?? '';
    // отчёт CSP шлёт браузер, в том числе со страницы на sub.<домен> - с чужим Origin
    if (
      url.startsWith('/api/') &&
      req.method !== 'GET' &&
      url !== '/api/csp-report' &&
      foreignOrigin(req)
    )
      return reply.code(403).send({ error: 'запрос с чужой страницы' });
    if (!url.startsWith('/api/') || OPEN_API.has(url)) return;
    const s = await sessionOf(db, sessionToken(req));
    if (!s) return reply.code(401).send({ error: 'вход не выполнен' });
  };
}
