import { createHash, createHmac, randomInt } from 'node:crypto';
import argon2 from 'argon2';
import { and, eq, gt, ne, sql } from 'drizzle-orm';
import { authenticator } from 'otplib';
import type { Db } from '../db/index.js';
import { admins, loginAttempts, sessions } from '../db/schema.js';
import { newId, newToken } from './ids.js';
import type { SecretBox } from './secret-box.js';

const SESSION_TTL_DAYS = 30;
/** Сессия без запросов столько минут завершается, даже если абсолютный срок ещё не вышел. */
const SESSION_IDLE_MIN = 72 * 60;
export const sessionIdleCutoff = () =>
  new Date(Date.now() - SESSION_IDLE_MIN * 60_000).toISOString();
const LOGIN_MAX_ATTEMPTS = 5;
const LOGIN_WINDOW_MIN = 15;

export function sha256(s: string): string {
  return createHash('sha256').update(s).digest('hex');
}

async function hashPassword(password: string): Promise<string> {
  return argon2.hash(password, { type: argon2.argon2id, memoryCost: 19456, timeCost: 2 });
}

export function verifyPassword(hash: string, password: string): Promise<boolean> {
  return argon2.verify(hash, password);
}

/** Резервный код: HMAC с секретом панели, а не бессолый SHA-256. */
export function backupCodeHash(pepper: string, code: string): string {
  return createHmac('sha256', pepper).update(`backup:${code}`).digest('hex');
}

/** TOTP-секрет мог быть сохранён старым форматом без v1:; SecretBox.open это поддерживает. */
export function openTotp(box: SecretBox, value: string | null): string | null {
  if (!value) return null;
  try {
    return box.open(value);
  } catch {
    return null;
  }
}

/** Резервные коды: 8 штук по 10 цифр, показываются один раз. */
export function generateBackupCodes(): string[] {
  return Array.from({ length: 8 }, () => String(randomInt(0, 1e10)).padStart(10, '0'));
}

function newTotpSecret(): string {
  return authenticator.generateSecret();
}

function totpUri(login: string, secret: string, issuer = 'VPS Panel'): string {
  return authenticator.keyuri(login, issuer, secret);
}

export function verifyTotp(secret: string, code: string): boolean {
  return authenticator.check(code.replace(/\s+/g, ''), secret);
}

/** Логин администратора: латиница, цифры, точка, дефис, подчёркивание; 3-32 символа. */
export const LOGIN_RE = /^[A-Za-z0-9._-]{3,32}$/;
/** Новый пароль, заданный в панели: не короче 12 символов. */
export const PASSWORD_MIN = 12;

const ALNUM = 'abcdefghijkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789';

/** Случайная строка без похожих символов (0/O, 1/l/I): пароль и логин из консоли. */
function randomString(len: number, alphabet = ALNUM): string {
  let out = '';
  for (let i = 0; i < len; i++) out += alphabet[randomInt(0, alphabet.length)];
  return out;
}

/** Пароль администратора: 20 символов (~115 бит). */
export const randomPassword = () => randomString(20);
/** Логин, если при установке его не задали: admin- и 6 строчных букв и цифр. */
export const randomLogin = () => `admin-${randomString(6, 'abcdefghijkmnpqrstuvwxyz23456789')}`;

/** Хеш случайного пароля: неизвестный логин тратит столько же времени, сколько известный. */
const unknownPasswordHash = hashPassword(randomString(32));

/** Проверка пароля для несуществующего логина: результат не важен, важно время. */
export async function verifyUnknownPassword(password: string): Promise<boolean> {
  try {
    return await argon2.verify(await unknownPasswordHash, password);
  } catch {
    return false;
  }
}

export async function isSetupDone(db: Db): Promise<boolean> {
  const row = await db.select({ id: admins.id }).from(admins).limit(1);
  return row.length > 0;
}

/** Новая настройка 2FA: секрет, резервные коды, адрес для QR. В базу - после первого кода. */
export function totpEnrollment(login: string) {
  const secret = newTotpSecret();
  return { secret, codes: generateBackupCodes(), uri: totpUri(login, secret) };
}

/** Администратор без 2FA: её настраивают при первом входе. */
export async function createAdmin(db: Db, login: string, password: string) {
  const id = newId();
  await db.insert(admins).values({
    id,
    login,
    passwordHash: await hashPassword(password),
    totpSecret: null,
    totpEnabled: false,
    backupCodesHash: [],
  });
  return { id };
}

/**
 * Первый администратор (установка из консоли): проверка "админа ещё нет" и вставка - синхронно
 * в одной транзакции (argon2 считается заранее). null - администратор уже есть.
 */
export async function initAdmin(db: Db, login: string) {
  const password = randomPassword();
  const row = {
    id: newId(),
    login,
    passwordHash: await hashPassword(password),
    totpSecret: null,
    totpEnabled: false,
    backupCodesHash: [] as string[],
  };
  const created = db.transaction((tx) => {
    if (tx.select({ id: admins.id }).from(admins).limit(1).all().length > 0) return false;
    tx.insert(admins).values(row).run();
    return true;
  });
  return created ? { login, password } : null;
}

export async function findAdminById(db: Db, id: string) {
  return (await db.select().from(admins).where(eq(admins.id, id)).limit(1))[0] ?? null;
}

/** Единственный администратор панели (null - ещё не создан). */
export async function theAdmin(db: Db) {
  return (await db.select().from(admins).limit(1))[0] ?? null;
}

export async function setPassword(db: Db, adminId: string, password: string) {
  await db
    .update(admins)
    .set({ passwordHash: await hashPassword(password) })
    .where(eq(admins.id, adminId));
}

export async function setLogin(db: Db, adminId: string, login: string) {
  await db.update(admins).set({ login }).where(eq(admins.id, adminId));
}

/** Включить 2FA с подтверждённым секретом и новыми резервными кодами. */
export async function saveTotp(
  db: Db,
  adminId: string,
  secret: string,
  codes: string[],
  box?: SecretBox,
  pepper = '',
) {
  await db
    .update(admins)
    .set({
      totpSecret: box ? box.seal(secret) : secret,
      totpEnabled: true,
      backupCodesHash: codes.map((c) => (pepper ? backupCodeHash(pepper, c) : sha256(c))),
    })
    .where(eq(admins.id, adminId));
}

/** Сбросить 2FA (консоль): при следующем входе её настраивают заново. */
export async function resetTotp(db: Db, adminId: string) {
  await db
    .update(admins)
    .set({ totpSecret: null, totpEnabled: false, backupCodesHash: [] })
    .where(eq(admins.id, adminId));
}

export async function setBackupCodes(db: Db, adminId: string, codes: string[], pepper: string) {
  await db
    .update(admins)
    .set({ backupCodesHash: codes.map((c) => backupCodeHash(pepper, c)) })
    .where(eq(admins.id, adminId));
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
  const now = new Date();
  const expiresAt = new Date(now.getTime() + SESSION_TTL_DAYS * 86_400_000).toISOString();
  await db.insert(sessions).values({
    id: sha256(token),
    adminId,
    expiresAt,
    ip,
    userAgent,
    lastSeenAt: now.toISOString(),
  });
  return { token, expiresAt };
}

/** Обновлять last_seen не на каждый запрос, а раз в 5 минут. */
const touched = new Map<string, number>();
export async function touchSession(db: Db, token: string) {
  const id = sha256(token);
  const now = Date.now();
  if (now - (touched.get(id) ?? 0) < 5 * 60_000) return;
  touched.set(id, now);
  await db
    .update(sessions)
    .set({ lastSeenAt: new Date(now).toISOString() })
    .where(eq(sessions.id, id));
  while (touched.size > 10_000) {
    const first = touched.keys().next().value;
    if (!first) break;
    touched.delete(first);
  }
}

export async function findSession(db: Db, token: string) {
  const rows = await db
    .select({
      adminId: sessions.adminId,
      expiresAt: sessions.expiresAt,
      login: admins.login,
      displayName: admins.displayName,
    })
    .from(sessions)
    .innerJoin(admins, eq(admins.id, sessions.adminId))
    .where(
      and(
        eq(sessions.id, sha256(token)),
        gt(sessions.expiresAt, new Date().toISOString()),
        gt(sessions.lastSeenAt, sessionIdleCutoff()),
      ),
    )
    .limit(1);
  return rows[0] ?? null;
}

export async function deleteSession(db: Db, token: string) {
  await db.delete(sessions).where(eq(sessions.id, sha256(token)));
}

export async function deleteAllSessions(db: Db, adminId: string) {
  await db.delete(sessions).where(eq(sessions.adminId, adminId));
}

/** Закрыть все сессии, кроме этой (смена пароля). */
export async function deleteOtherSessions(db: Db, adminId: string, keepToken: string) {
  await db
    .delete(sessions)
    .where(and(eq(sessions.adminId, adminId), ne(sessions.id, sha256(keepToken))));
}

/** Использовать резервный код: удаляет его из списка при совпадении. */
export async function consumeBackupCode(
  db: Db,
  adminId: string,
  code: string,
  pepper = '',
): Promise<boolean> {
  const rows = await db.select().from(admins).where(eq(admins.id, adminId)).limit(1);
  const admin = rows[0];
  if (!admin) return false;
  const norm = code.replace(/\s+/g, '');
  const h = backupCodeHash(pepper, norm);
  // старые коды (SHA-256 без соли) продолжают работать до первого успешного входа
  const legacy = sha256(norm);
  const used = admin.backupCodesHash.includes(h)
    ? h
    : admin.backupCodesHash.includes(legacy)
      ? legacy
      : null;
  if (!used) return false;
  await db
    .update(admins)
    .set({ backupCodesHash: admin.backupCodesHash.filter((c) => c !== used) })
    .where(eq(admins.id, adminId));
  return true;
}
