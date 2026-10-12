import { and, desc, eq, gt, sql } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import type { Db } from '../db/index.js';
import { loginAttempts, sessions } from '../db/schema.js';
import { sha256 } from '../lib/auth.js';
import { sessionToken } from './auth.js';

/** Сводка безопасности самой панели: попытки входа и активные сессии. */
export async function securityRoutes(app: FastifyInstance, opts: { db: Db }) {
  const { db } = opts;
  app.get('/api/security', async (req) => {
    const mine = sha256(sessionToken(req) ?? '');
    const day = new Date(Date.now() - 86_400_000).toISOString();
    const week = new Date(Date.now() - 7 * 86_400_000).toISOString();
    const [failed24] = await db
      .select({ n: sql<number>`count(*)` })
      .from(loginAttempts)
      .where(and(eq(loginAttempts.ok, false), gt(loginAttempts.at, day)));
    const [failed7d] = await db
      .select({ n: sql<number>`count(*)` })
      .from(loginAttempts)
      .where(and(eq(loginAttempts.ok, false), gt(loginAttempts.at, week)));
    const topIps = await db
      .select({
        ip: loginAttempts.ip,
        n: sql<number>`count(*)`,
        last: sql<string>`max(${loginAttempts.at})`,
      })
      .from(loginAttempts)
      .where(and(eq(loginAttempts.ok, false), gt(loginAttempts.at, week)))
      .groupBy(loginAttempts.ip)
      .orderBy(desc(sql`count(*)`))
      .limit(20);
    const recent = await db
      .select({
        ip: loginAttempts.ip,
        login: loginAttempts.login,
        ok: loginAttempts.ok,
        at: loginAttempts.at,
      })
      .from(loginAttempts)
      .orderBy(desc(loginAttempts.at))
      .limit(30);
    const active = await db
      .select({
        id: sessions.id,
        ip: sessions.ip,
        userAgent: sessions.userAgent,
        createdAt: sessions.createdAt,
        expiresAt: sessions.expiresAt,
      })
      .from(sessions)
      .where(gt(sessions.expiresAt, new Date().toISOString()))
      .orderBy(desc(sessions.createdAt));
    return {
      failed24: failed24?.n ?? 0,
      failed7d: failed7d?.n ?? 0,
      topIps,
      recent,
      sessions: active.map((x) => ({ ...x, current: x.id === mine })),
    };
  });
}
