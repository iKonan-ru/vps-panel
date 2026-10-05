import { randomBytes } from 'node:crypto';

/** Короткий уникальный id (22 символа base64url) для записей и сессий. */
export function newId(): string {
  return randomBytes(16).toString('base64url');
}

/** Токен для агента / сессии: 32 байта случайности. */
export function newToken(): string {
  return randomBytes(32).toString('base64url');
}
