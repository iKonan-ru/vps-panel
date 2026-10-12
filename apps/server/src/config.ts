import { isIP } from 'node:net';
import { z } from 'zod';

const EnvSchema = z.object({
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
  PANEL_HOST: z.string().default('127.0.0.1'),
  PANEL_PORT: z.coerce.number().int().default(3000),
  /** Публичный адрес панели, его получают агенты при установке. */
  PANEL_PUBLIC_URL: z.string().url().default('http://localhost:3000'),
  /**
   * Адрес подписок и личных страниц клиентов, если он не https://SUB_DOMAIN (обычно задаётся
   * SUB_DOMAIN). Пусто - https://SUB_DOMAIN или адрес панели.
   */
  SUB_PUBLIC_URL: z.preprocess((v) => (v === '' ? undefined : v), z.string().url().optional()),
  /** Имя для подписок (sub.example.com): его же обслуживает Caddy (deploy/Caddyfile). */
  SUB_DOMAIN: z.string().default(''),
  DATA_DIR: z.string().default('./data'),
  /** Секрет для подписи сессий, 32+ байта. В проде обязателен. */
  SESSION_SECRET: z.string().min(32).optional(),
  LOG_LEVEL: z.enum(['trace', 'debug', 'info', 'warn', 'error']).default('info'),
  /** Путь к собранному фронтенду, пусто в dev (его отдаёт Vite). */
  WEB_DIST: z.string().optional(),
  /** Каталог с бинарниками агента (vps-agent-linux-amd64, -arm64). */
  AGENT_DIR: z.string().default('./agent-dist'),
  /** Каталог файлов для команд (deploy.sh и бинарник WDTT и т.п.), раздаётся по /files. */
  FILES_DIR: z.string().default('./files'),
  /** Исходники расширения Chrome (apps/extension): архив с личной страницы. */
  EXTENSION_DIR: z.string().default('../extension'),
  /** HTTP-прокси для api.telegram.org (xray рядом с панелью); пусто - без прокси. */
  TG_PROXY_URL: z.string().default(''),
  /**
   * IP-адрес панели при сертификате на IP (панель без домена или прежний адрес после
   * vps-panel domain): Caddy спрашивает о нём /api/proxy/ask для запросов без SNI.
   */
  PANEL_SNI: z.string().default(''),
  /** Канал обновлений установки (vps-panel install --beta): по умолчанию в "Версии панели". */
  PANEL_CHANNEL: z.preprocess(
    (v) => (v === 'beta' ? 'beta' : 'stable'),
    z.enum(['stable', 'beta']),
  ),
});

export type Env = z.infer<typeof EnvSchema>;

export function loadEnv(source: NodeJS.ProcessEnv = process.env): Env {
  const env = EnvSchema.parse(source);
  if (!env.SUB_PUBLIC_URL && env.SUB_DOMAIN) env.SUB_PUBLIC_URL = `https://${env.SUB_DOMAIN}`;
  if (env.NODE_ENV === 'production' && !env.SESSION_SECRET) {
    throw new Error('SESSION_SECRET обязателен в production (32+ символа)');
  }
  // агенты и install.sh ходят только по https; http - лишь панель на
  // этой же машине (docker-compose.dev.yml, стенд)
  const pub = new URL(env.PANEL_PUBLIC_URL);
  if (
    env.NODE_ENV === 'production' &&
    pub.protocol !== 'https:' &&
    !['localhost', '127.0.0.1', '[::1]'].includes(pub.hostname)
  ) {
    throw new Error('PANEL_PUBLIC_URL в production - только https://');
  }
  return env;
}

/**
 * Домен панели; пусто - панель без домена (https://<IP>, сертификат Let's Encrypt на IP). Без
 * домена нет поддоменов: панели сервисов через панель и имена naive по умолчанию.
 */
export function panelDomain(env: Pick<Env, 'PANEL_PUBLIC_URL'>): string {
  const host = new URL(env.PANEL_PUBLIC_URL).hostname.replace(/^\[|\]$/g, '');
  return isIP(host) ? '' : host;
}
