import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { eq } from 'drizzle-orm';
import type { Env } from '../config.js';
import type { Db } from '../db/index.js';
import { servers } from '../db/schema.js';
import { panelKey } from './agent-channel.js';
import { sha256 } from './auth.js';
import { fileSha256 } from './file-send.js';
import { newToken } from './ids.js';

/** Архитектуры, под которые собирается агент. */
export const ARCHES = ['linux-amd64', 'linux-arm64'];

/**
 * sha256 бинарников агента по архитектурам: панель передаёт их в agent.update по защищённому
 * каналу - агент не верит контрольной сумме, скачанной с того же адреса, что и бинарник.
 */
export async function agentChecksums(agentDir: string): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  for (const arch of ARCHES) {
    const f = join(agentDir, `vps-agent-${arch}`);
    if (existsSync(f)) out[arch] = await fileSha256(f);
  }
  return out;
}

/** Версия последнего собранного агента (version.txt рядом с бинарниками). */
export function latestAgentVersion(agentDir: string): string | null {
  const f = join(agentDir, 'version.txt');
  if (!existsSync(f)) return null;
  return readFileSync(f, 'utf8').trim() || null;
}

/** Срок жизни токена регистрации агента. */
const REGISTRATION_TTL_MS = 3600_000;

/**
 * Новый одноразовый токен регистрации агента: в базе - только sha256 и срок 1 час,
 * сам токен уходит в команду установки. Прежний токен сервера перестаёт действовать.
 */
export async function issueRegistration(db: Db, serverId: string): Promise<string | null> {
  const token = newToken();
  const res = await db
    .update(servers)
    .set({
      registrationToken: sha256(token),
      registrationExpiresAt: new Date(Date.now() + REGISTRATION_TTL_MS).toISOString(),
    })
    .where(eq(servers.id, serverId))
    .returning({ id: servers.id });
  return res.length ? token : null;
}

/**
 * Команда установки агента на сервер: скрипт с панели, одноразовый токен регистрации и ключ
 * панели - агент с первого подключения верит ключу, а не домену. На https -
 * curl только по https (`--proto =https`).
 */
export function installCommand(env: Env, registrationToken: string): string {
  const url = env.PANEL_PUBLIC_URL;
  const proto = url.startsWith('https://') ? " --proto '=https'" : '';
  return `curl${proto} -fsSL ${url}/agent/install.sh | sh -s -- --panel ${url} --token ${registrationToken} --key ${panelKey(env.DATA_DIR).b64}`;
}
