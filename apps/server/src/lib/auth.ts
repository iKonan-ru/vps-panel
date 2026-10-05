import { createHash, randomInt } from 'node:crypto';
import argon2 from 'argon2';
import { and, eq, gt, sql } from 'drizzle-orm';
import { authenticator } from 'otplib';
import type { Db } from '../db/index.js';
import { admins, loginAttempts, sessions } from '../db/schema.js';
import { newId, newToken } from './ids.js';

export const SESSION_TTL_DAYS = 30;
export const LOGIN_MAX_ATTEMPTS = 5;
export const LOGIN_WINDOW_MIN = 15;

export function sha256(s: string): string {
  return createHash('sha256').update(s).digest('hex');
}

export async function hashPassword(password: string): Promise<string> {
  return argon2.hash(password, { type: argon2.argon2id, memoryCost: 19456, timeCost: 2 });
}

export function verifyPassword(hash: string, password: string): Promise<boolean> {
  return argon2.verify(hash, password);
}

/** Резервные коды: 8 штук по 10 цифр, показываются один раз. */
export function generateBackupCodes(): string[] {
  return Array.from({ length: 8 }, () => String(randomInt(0, 1e10)).padStart(10, '0'));
}

export function newTotpSecret(): string {
  return authenticator.generateSecret();
}

export function totpUri(login: string, secret: string, issuer = 'VPS Panel'): string {
  return authenticator.keyuri(login, issuer, secret);
}

export function verifyTotp(secret: string, code: string): boolean {
  return authenticator.check(code.replace(/\s+/g, ''), secret);
}

export async function isSetupDone(db: Db): Promise<boolean> {
  const row = await db.select({ id: admins.id }).from(admins).limit(1);
  return row.length > 0;
}

async function adminRow(login: string, password: string) {
  const id = newId();
  const secret = newTotpSecret();
  const codes = generateBackupCodes();
  const row = {
    id,
    login,
    passwordHash: await hashPassword(password),
    totpSecret: secret,
    totpEnabled: false,
    backupCodesHash: codes.map(sha256),
  };
  return { row, admin: { id, secret, codes, uri: totpUri(login, secret) } };
}

export async function createAdmin(db: Db, login: string, password: string) {
  const { row, admin } = await adminRow(login, password);
  await db.insert(admins).values(row);
  return admin;
}

/**
 * Первый администратор (мастер настройки). Проверка "админа ещё нет" и вставка идут
 * синхронно в одной транзакции, без await между ними: argon2 (~100 мс) считается заранее,
 * и два параллельных запроса мастера не создадут двух админов.
 * null - администратор уже есть.
 */
export async function createFirstAdmin(db: Db, login: string, password: string) {
  const { row, admin } = await adminRow(login, password);
  const created = db.transaction((tx) => {
    if (tx.select({ id: admins.id }).from(admins).limit(1).all().length > 0) return false;
    tx.insert(admins).values(row).run();
    return true;
  });
  return created ? admin : null;
}

export async function tooManyAttempts(db: Db, ip: string): Promise<boolean> {
  const since = new Date(Date.now() - LOGIN_WINDOW_MIN * 60_000).toISOString();
  const rows = await db
    .select({ n: sql<number>`count(*)` })
    .from(loginAttempts)
    .where(and(eq(loginAttempts.ip, ip), eq(loginAttempts.ok, false), gt(loginAttempts.at, since)));
  return (rows[0]?.n ?? 0) >= LOGIN_MAX_ATTEMPTS;
}

export async function recordAttempt(db: Db, ip: string, login: string, ok: boolean) {
  await db.insert(loginAttempts).values({ ip, login, ok });
}

export async function findAdminByLogin(db: Db, login: string) {
  const rows = await db.select().from(admins).where(eq(admins.login, login)).limit(1);
  return rows[0] ?? null;
}

export async function createSession(db: Db, adminId: string, ip: string, userAgent: string) {
  const token = newToken();
  const expiresAt = new Date(Date.now() + SESSION_TTL_DAYS * 86_400_000).toISOString();
  await db.insert(sessions).values({ id: sha256(token), adminId, expiresAt, ip, userAgent });
  return { token, expiresAt };
}

export async function findSession(db: Db, token: string) {
  const rows = await db
    .select({ adminId: sessions.adminId, expiresAt: sessions.expiresAt, login: admins.login })
    .from(sessions)
    .innerJoin(admins, eq(admins.id, sessions.adminId))
    .where(and(eq(sessions.id, sha256(token)), gt(sessions.expiresAt, new Date().toISOString())))
    .limit(1);
  return rows[0] ?? null;
}

export async function deleteSession(db: Db, token: string) {
  await db.delete(sessions).where(eq(sessions.id, sha256(token)));
}

export async function deleteAllSessions(db: Db, adminId: string) {
  await db.delete(sessions).where(eq(sessions.adminId, adminId));
}

/** Использовать резервный код: удаляет его из списка при совпадении. */
export async function consumeBackupCode(db: Db, adminId: string, code: string): Promise<boolean> {
  const rows = await db.select().from(admins).where(eq(admins.id, adminId)).limit(1);
  const admin = rows[0];
  if (!admin) return false;
  const h = sha256(code.replace(/\s+/g, ''));
  if (!admin.backupCodesHash.includes(h)) return false;
  await db
    .update(admins)
    .set({ backupCodesHash: admin.backupCodesHash.filter((c) => c !== h) })
    .where(eq(admins.id, adminId));
  return true;
}

export async function enableTotp(db: Db, adminId: string) {
  await db.update(admins).set({ totpEnabled: true }).where(eq(admins.id, adminId));
}
