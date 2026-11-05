import { randomBytes } from 'node:crypto';
import type { FastifyRequest } from 'fastify';

/** Сколько действует подтверждение пароля+2FA. */
export const STEP_UP_TTL_MS = 5 * 60_000;

const cookieName = (secure: boolean) => `${secure ? '__Host-' : ''}vps_stepup`;

/**
 * Короткое подтверждение для особо чувствительных действий (бэкап панели, Telegram-бот).
 * Токен живёт только в памяти: после перезапуска панели подтверждение нужно снова.
 */
export class StepUp {
  private tokens = new Map<string, { sid: string; exp: number }>();

  issue(sessionId: string): string {
    for (const [k, v] of this.tokens) if (v.exp < Date.now()) this.tokens.delete(k);
    const token = randomBytes(24).toString('base64url');
    this.tokens.set(token, { sid: sessionId, exp: Date.now() + STEP_UP_TTL_MS });
    while (this.tokens.size > 1000) {
      const first = this.tokens.keys().next().value;
      if (!first) break;
      this.tokens.delete(first);
    }
    return token;
  }

  valid(token: string | undefined, sessionId: string | undefined): boolean {
    if (!token || !sessionId) return false;
    const t = this.tokens.get(token);
    if (!t || t.exp < Date.now() || t.sid !== sessionId) {
      if (t && t.exp < Date.now()) this.tokens.delete(token);
      return false;
    }
    return true;
  }
}

export const stepUpCookie = (secure: boolean) => cookieName(secure);

/** Проверка подтверждения по cookie; ответ 403 с кодом для фронтенда. */
export function hasStepUp(
  stepUp: StepUp,
  req: FastifyRequest,
  secure: boolean,
  sessionId: string | undefined,
): boolean {
  return stepUp.valid(req.cookies[cookieName(secure)], sessionId);
}
