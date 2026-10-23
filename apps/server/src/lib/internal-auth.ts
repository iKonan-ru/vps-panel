import { randomBytes, timingSafeEqual } from 'node:crypto';
import type { FastifyRequest } from 'fastify';

/**
 * Запросы самой панели к своему API (бот Telegram через app.inject): заголовок с ключом,
 * который создаётся при запуске процесса и никуда не уходит. Снаружи заголовок бесполезен:
 * ключ неизвестен и меняется с каждым перезапуском.
 */
export const INTERNAL_HEADER = 'x-vps-internal';
/** Кто из внутренних: telegram - бот (пометка в журнале действий). */
export const INITIATOR_HEADER = 'x-vps-initiator';
const KEY = randomBytes(32).toString('hex');

export function internalHeaders(initiator?: string): Record<string, string> {
  return { [INTERNAL_HEADER]: KEY, ...(initiator ? { [INITIATOR_HEADER]: initiator } : {}) };
}

export function isInternal(req: FastifyRequest): boolean {
  const v = req.headers[INTERNAL_HEADER];
  if (typeof v !== 'string' || v.length !== KEY.length) return false;
  return timingSafeEqual(Buffer.from(v), Buffer.from(KEY));
}
