import { and, eq } from 'drizzle-orm';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { Db } from '../db/index.js';
import { admins, sessions } from '../db/schema.js';
import {
  LOGIN_RE,
  PASSWORD_MIN,
  consumeBackupCode,
  deleteOtherSessions,
  findAdminById,
  generateBackupCodes,
  recordAttempt,
  saveTotp,
  setBackupCodes,
  setLogin,
  setPassword,
  sha256,
  tooManyAttempts,
  totpEnrollment,
  verifyPassword,
  verifyTotp,
} from '../lib/auth.js';
import { sessionCookie, sessionOf, sessionToken } from './auth.js';

/** Новая 2FA из аккаунта: ждёт первого кода, по сессии (sha256 токена). */
const enrolling = new Map<
  string,
  { secret: string; codes: string[]; uri: string; expires: number }
>();

const fail = (code: number, error: string) => Object.assign(new Error(error), { statusCode: code });

/**
 * Аккаунт администратора (раздел "Аккаунт"): логин, пароль, 2FA, резервные коды, сессии.
 * Изменения - только с текущим паролем (и кодом 2FA для её перенастройки); неверный пароль
 * считается неудачной попыткой входа - те же 5 за 15 минут и fail2ban. Восстановления пароля
 * нет: сброс - только из консоли сервера панели (vps-panel admin).
 */
export async function accountRoutes(app: FastifyInstance, opts: { db: Db; secure: boolean }) {
  const { db, secure } = opts;

  async function me(req: FastifyRequest) {
    const token = sessionToken(req);
    const s = await sessionOf(db, token);
    const admin = s ? await findAdminById(db, s.adminId) : null;
    if (!s || !admin || !token) throw fail(401, 'вход не выполнен');
    return { admin, token };
  }

  /** Текущий пароль: неверный - неудачная попытка (лимит и журнал как у входа). */
  async function checkPassword(
    req: FastifyRequest,
    admin: { login: string; passwordHash: string },
    password: string,
  ) {
    if (await tooManyAttempts(db, req.ip))
      throw fail(429, 'слишком много попыток, следующая\u00a0\u2014 через 15\u00a0минут');
    const ok = await verifyPassword(admin.passwordHash, password);
    if (!ok) {
      await recordAttempt(db, req.ip, admin.login, false);
      throw fail(400, 'неверный текущий пароль');
    }
  }

  const limited = { config: { rateLimit: { max: 10, timeWindow: '1 minute' } } };

  app.get('/api/account', async (req) => {
    const { admin } = await me(req);
    return {
      login: admin.login,
      totpEnabled: admin.totpEnabled,
      backupCodesLeft: admin.backupCodesHash.length,
      createdAt: admin.createdAt,
    };
  });

  app.put('/api/account/login', limited, async (req) => {
    const { admin } = await me(req);
    const b = z
      .object({ login: z.string().max(64), password: z.string().min(1).max(200) })
      .parse(req.body);
    const login = b.login.trim();
    if (!LOGIN_RE.test(login))
      throw fail(400, 'логин: 3\u201332 символа, латиница, цифры, точка, дефис, подчёркивание');
    await checkPassword(req, admin, b.password);
    if (login !== admin.login) {
      const taken = await db.select({ id: admins.id }).from(admins).where(eq(admins.login, login));
      if (taken.some((t) => t.id !== admin.id)) throw fail(409, 'такой логин уже есть');
      await setLogin(db, admin.id, login);
    }
    return { ok: true, login };
  });

  app.put('/api/account/password', limited, async (req) => {
    const { admin, token } = await me(req);
    const b = z
      .object({ password: z.string().min(1).max(200), newPassword: z.string().max(200) })
      .parse(req.body);
    if (b.newPassword.length < PASSWORD_MIN)
      throw fail(400, `новый пароль\u00a0\u2014 не короче ${PASSWORD_MIN}\u00a0символов`);
    if (b.newPassword === b.password) throw fail(400, 'новый пароль совпадает с текущим');
    await checkPassword(req, admin, b.password);
    await setPassword(db, admin.id, b.newPassword);
    // остальные устройства входят заново, эта сессия остаётся
    await deleteOtherSessions(db, admin.id, token);
    return { ok: true };
  });

  // Перенастроить 2FA (новый телефон): текущий пароль и код (или резервный) -> новый секрет.
  app.post('/api/account/totp', limited, async (req) => {
    const { admin, token } = await me(req);
    const b = z
      .object({ password: z.string().min(1).max(200), code: z.string().min(6).max(12) })
      .parse(req.body);
    await checkPassword(req, admin, b.password);
    const ok =
      (admin.totpSecret ? verifyTotp(admin.totpSecret, b.code) : false) ||
      (await consumeBackupCode(db, admin.id, b.code));
    if (!ok) {
      await recordAttempt(db, req.ip, admin.login, false);
      throw fail(400, 'неверный код 2FA');
    }
    const e = totpEnrollment(admin.login);
    enrolling.set(sha256(token), { ...e, expires: Date.now() + 15 * 60_000 });
    return { totpUri: e.uri, totpSecret: e.secret, backupCodes: e.codes };
  });

  app.post('/api/account/totp/confirm', limited, async (req) => {
    const { admin, token } = await me(req);
    const { code } = z.object({ code: z.string().min(6).max(8) }).parse(req.body);
    const key = sha256(token);
    const e = enrolling.get(key);
    if (!e || e.expires < Date.now())
      throw fail(400, 'время настройки истекло, нужно начать заново');
    if (!verifyTotp(e.secret, code)) throw fail(400, 'неверный код');
    await saveTotp(db, admin.id, e.secret, e.codes);
    enrolling.delete(key);
    await deleteOtherSessions(db, admin.id, token);
    return { ok: true };
  });

  // Новые резервные коды (старые перестают действовать): показываются один раз.
  app.post('/api/account/backup-codes', limited, async (req) => {
    const { admin } = await me(req);
    const { password } = z.object({ password: z.string().min(1).max(200) }).parse(req.body);
    await checkPassword(req, admin, password);
    const codes = generateBackupCodes();
    await setBackupCodes(db, admin.id, codes);
    return { backupCodes: codes };
  });

  // Закрыть одну сессию (id - как в /api/security); свою - тоже, тогда выход.
  app.delete('/api/account/sessions/:id', async (req, reply: FastifyReply) => {
    const { admin, token } = await me(req);
    const { id } = z.object({ id: z.string().regex(/^[0-9a-f]{64}$/) }).parse(req.params);
    await db.delete(sessions).where(and(eq(sessions.id, id), eq(sessions.adminId, admin.id)));
    const self = id === sha256(token);
    if (self) reply.clearCookie(sessionCookie(), { path: '/', secure });
    return { ok: true, self };
  });
}
