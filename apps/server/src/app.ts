import { existsSync } from 'node:fs';
import { createServer } from 'node:http';
import { BlockList, isIPv6 } from 'node:net';
import { join } from 'node:path';
import fastifyCookie from '@fastify/cookie';
import fastifyRateLimit from '@fastify/rate-limit';
import fastifyStatic from '@fastify/static';
import fastifyWebsocket from '@fastify/websocket';
import { isNull, sql } from 'drizzle-orm';
import Fastify from 'fastify';
import { ZodError } from 'zod';
import { AgentRegistry } from './agents/registry.js';
import { type StatusCache, bindStateToDb } from './agents/state.js';
import type { Env } from './config.js';
import { type Db, createDb } from './db/index.js';
import { actionLog, servers } from './db/schema.js';
import { actionJournal } from './lib/action-journal.js';
import { AppReleases } from './lib/apps.js';
import { GClients } from './lib/gclients.js';
import { startHousekeeping } from './lib/housekeeping.js';
import { startMetricsPace } from './lib/metrics-pace.js';
import { EngineCatalog } from './lib/mtproxyl-engine.js';
import { Notifier } from './lib/notify.js';
import { PanelBackups } from './lib/panel-backup.js';
import { panelAddresses } from './lib/panel-host.js';
import { PanelProxy } from './lib/panel-proxy.js';
import { SecretBox } from './lib/secret-box.js';
import { ServiceUpdates } from './lib/service-updates.js';
import { Telegram } from './lib/telegram.js';
import { UiHub } from './lib/ui-hub.js';
import { XrayManager } from './lib/xray.js';
import { accessRoutes } from './routes/access.js';
import { agentDistRoutes } from './routes/agent-dist.js';
import { agentUpdateRoutes } from './routes/agent-update.js';
import { agentWsRoutes } from './routes/agent-ws.js';
import { appRoutes } from './routes/apps.js';
import { authRoutes, requireAuth, useHostCookies } from './routes/auth.js';
import { awgRoutes } from './routes/awg.js';
import { backupRoutes } from './routes/backups.js';
import { baselineFirewallRoutes } from './routes/baseline-firewall.js';
import { commandRoutes } from './routes/commands.js';
import { cspRoutes } from './routes/csp.js';
import { deployRoutes } from './routes/deploy.js';
import { dockerRoutes } from './routes/docker.js';
import { gclientRoutes } from './routes/gclients.js';
import { installRoutes } from './routes/install.js';
import { journalRoutes } from './routes/journal.js';
import { mtproxylRoutes } from './routes/mtproxyl.js';
import { notifyRoutes } from './routes/notify.js';
import { openfluxRoutes } from './routes/openflux.js';
import { panelBackupRoutes } from './routes/panel-backup.js';
import { personalRoutes } from './routes/personal.js';
import { probeRoutes } from './routes/probe.js';
import { proxyRoutes } from './routes/proxy.js';
import { securityRoutes } from './routes/security.js';
import { serverRoutes } from './routes/servers.js';
import { standardRoutes } from './routes/standard.js';
import { subscriptionRoutes } from './routes/subscription.js';
import { systemRoutes } from './routes/system.js';
import { terminalRoutes } from './routes/terminal.js';
import { uiWsRoutes } from './routes/ui-ws.js';
import { updateRoutes } from './routes/updates.js';
import { wdttRoutes } from './routes/wdtt.js';
import { xrayRoutes } from './routes/xray.js';
import { xuiRoutes } from './routes/xui.js';

export interface AppOptions {
  env: Env;
  db?: Db;
  registry?: AgentRegistry;
}

/** Частные адреса: контейнер Caddy в сети docker (или localhost в разработке). */
const privateNets = new BlockList();
for (const [net, bits] of [
  ['127.0.0.0', 8],
  ['10.0.0.0', 8],
  ['172.16.0.0', 12],
  ['192.168.0.0', 16],
] as const)
  privateNets.addSubnet(net, bits, 'ipv4');
privateNets.addAddress('::1', 'ipv6');
privateNets.addSubnet('fc00::', 7, 'ipv6');

/**
 * Кому верить в X-Forwarded-For. Перед панелью ровно один прокси - Caddy:
 * верим только непосредственному соседу (hop 0) и только с частным адресом, то есть адрес
 * клиента - последний в заголовке, его дописал Caddy. Левые адреса подставляет кто угодно, а
 * при прямом заходе на порт 3000 снаружи заголовок не учитывается совсем. Число вместо функции
 * не годится: Fastify 5.12 с числом не верит никому, и все клиенты были бы адресом Caddy.
 */
export function trustCaddy(addr: string, hop: number): boolean {
  if (hop !== 0) return false;
  const a = addr.replace(/^::ffff:/, '');
  return privateNets.check(a, isIPv6(a) ? 'ipv6' : 'ipv4');
}

export async function buildApp(opts: AppOptions) {
  const { env } = opts;
  const db = opts.db ?? createDb(env.DATA_DIR);
  const registry = opts.registry ?? new AgentRegistry();
  const hub = new UiHub();
  // Действия, которые шли в момент перезапуска панели, никто не завершит: закрываем их явно,
  // иначе они навсегда останутся "выполняются".
  await db
    .update(actionLog)
    .set({
      finishedAt: new Date().toISOString(),
      exitCode: -1,
      output: sql`${actionLog.output} || ${'\nПанель перезапущена, действие прервано\n'}`,
    })
    .where(isNull(actionLog.finishedAt));
  const secure = env.PANEL_PUBLIC_URL.startsWith('https://');
  useHostCookies(secure);

  // Поддомены панелей сервисов (lib/panel-proxy.ts): запросы к ним разбираются до Fastify,
  // своим сервером - маршруты, хуки и обработчик ошибок Fastify их не касаются.
  let proxy: PanelProxy | null = null;
  const app = Fastify({
    logger: env.NODE_ENV === 'test' ? false : { level: env.LOG_LEVEL },
    trustProxy: trustCaddy,
    bodyLimit: 1_048_576,
    serverFactory: (handler) =>
      createServer((req, res) => {
        if (!proxy?.labelOf(req.headers.host)) return handler(req, res);
        void proxy.handle(req, res);
      }),
  });
  proxy = new PanelProxy(
    db,
    registry,
    secure ? new URL(env.PANEL_PUBLIC_URL).hostname : '',
    env.SESSION_SECRET ?? 'dev-only-secret-change-me-please-32b',
    app.log,
  );
  const panelProxy = proxy;
  app.addHook('onReady', async () => panelProxy.attachUpgrade(app.server));

  await app.register(fastifyCookie, {
    secret: env.SESSION_SECRET ?? 'dev-only-secret-change-me-please-32b',
  });
  await app.register(fastifyRateLimit, { global: false });
  await app.register(fastifyWebsocket);

  app.setErrorHandler((err: unknown, _req, reply) => {
    if (err instanceof ZodError) {
      return reply.code(400).send({ error: 'Неверные данные', issues: err.issues });
    }
    app.log.error(err);
    const e = err as { statusCode?: unknown; message?: unknown };
    const status = typeof e.statusCode === 'number' ? e.statusCode : 500;
    const message = typeof e.message === 'string' ? e.message : 'Ошибка';
    return reply.code(status).send({ error: status === 500 ? 'Внутренняя ошибка' : message });
  });

  app.addHook('preHandler', requireAuth(db));
  // ничто из панели (страницы, подписки, личные страницы, панели сервисов через неё) не
  // индексируется поисковиками; Caddy ставит тот же заголовок и отдаёт robots.txt
  app.addHook('onSend', async (_req, reply) => {
    if (!reply.hasHeader('X-Robots-Tag'))
      reply.header('X-Robots-Tag', 'noindex, nofollow, noarchive');
  });
  app.get('/robots.txt', { logLevel: 'warn' }, async (_req, reply) =>
    reply.type('text/plain; charset=utf-8').send('User-agent: *\nDisallow: /\n'),
  );

  app.get('/api/health', async () => ({
    ok: true,
    version: '0.1.0',
    now: new Date().toISOString(),
  }));
  await app.register(authRoutes, { db, secure });
  const sessionSecret = env.SESSION_SECRET ?? 'dev-only-secret-change-me-please-32b';
  const box = new SecretBox(sessionSecret);
  // xray-клиент для выхода в Telegram: дочерний процесс панели
  const xray = new XrayManager(db, env.DATA_DIR, app.log);
  await xray.load();
  await xray.start();
  app.addHook('onClose', async () => {
    await xray.stop();
  });
  // версии движка MTProxyL: готовые образы в реестре (ghcr.io), чтобы не собирать на сервере
  const engines = new EngineCatalog(registry, (url, init) => xray.fetch(url, init));
  await app.register(serverRoutes, { db, registry, env, hub, proxy: panelProxy });
  // действия над сервером через агента - по файлу на область
  const serverRouteOpts = { db, env, registry, hub, box, engines };
  await app.register(agentUpdateRoutes, serverRouteOpts);
  await app.register(awgRoutes, serverRouteOpts);
  await app.register(baselineFirewallRoutes, serverRouteOpts);
  await app.register(dockerRoutes, serverRouteOpts);
  await app.register(journalRoutes, serverRouteOpts);
  await app.register(mtproxylRoutes, serverRouteOpts);
  await app.register(openfluxRoutes, serverRouteOpts);
  await app.register(systemRoutes, serverRouteOpts);
  await app.register(xuiRoutes, serverRouteOpts);
  await app.register(installRoutes, { db, env, registry, hub });
  await app.register(securityRoutes, { db });
  await app.register(commandRoutes, { db, env, registry, hub, box });
  await app.register(accessRoutes, { db, box });
  await app.register(backupRoutes, { db, env, registry, hub });
  await app.register(probeRoutes);
  await app.register(agentWsRoutes, { db, registry, dataDir: env.DATA_DIR });
  await app.register(proxyRoutes, { proxy: panelProxy, db });
  await app.register(cspRoutes);
  await app.register(uiWsRoutes, { db, registry, hub });
  await app.register(terminalRoutes, { db, registry });
  await app.register(agentDistRoutes, { agentDir: env.AGENT_DIR });
  await app.register(deployRoutes, { dataDir: env.DATA_DIR });
  await app.register(xrayRoutes, { db, registry, box, xray });
  const telegram = new Telegram(
    db,
    box,
    registry,
    app.log,
    () => xray.dispatcher(),
    env.TG_PROXY_URL,
  );
  await app.register(notifyRoutes, { telegram });
  const notifier = new Notifier(db, registry, telegram);
  // остановка фоновых таймеров при закрытии: в тестах и при выключении они не трогают базу
  const stops: (() => void)[] = [];
  app.addHook('onClose', async () => {
    for (const stop of stops) stop();
  });
  stops.push(
    notifier.bind(
      (await db.select({ id: servers.id, cache: servers.statusCache }).from(servers)).map((r) => ({
        id: r.id,
        cache: (r.cache ?? {}) as StatusCache,
      })),
    ),
  );
  // обновления 3X-UI и MTProxyL (менеджер, веб-панель): проверка через агента,
  // строки в блоке "Безопасность", версии во вкладке MTProxyL
  const serviceUpdates = new ServiceUpdates(
    db,
    box,
    registry,
    app.log,
    (id, u) => notifier.serviceUpdate(id, u),
    (url, init) => xray.fetch(url, init),
  );
  stops.push(serviceUpdates.start());
  await app.register(standardRoutes, { db, registry, env, updates: serviceUpdates });
  await app.register(updateRoutes, { registry, updates: serviceUpdates });
  // глобальные клиенты: сверка с серверами в фоне
  const gc = new GClients(
    db,
    box,
    registry,
    actionJournal(db, hub, registry),
    () => panelAddresses(env.PANEL_PUBLIC_URL),
    app.log,
  );
  stops.push(gc.start(), startHousekeeping(db, app.log));
  // метрики агентов раз в 2 с, пока открыта вкладка панели, иначе раз в 30 с
  stops.push(startMetricsPace(registry, hub, app.log));
  await app.register(gclientRoutes, { db, registry, box, gc, env, hub });
  await app.register(wdttRoutes, { db, registry, hub, gc });
  await app.register(subscriptionRoutes, { db, env });
  // бэкап самой панели: раз в сутки в Telegram, по кнопке - сразу или скачиванием
  const panelBackups = new PanelBackups(
    db,
    box,
    { dataDir: env.DATA_DIR, sessionSecret, panelUrl: env.PANEL_PUBLIC_URL },
    telegram,
    app.log,
  );
  stops.push(panelBackups.start());
  // ссылки на клиентские приложения: релизы GitHub раз в 6 часов
  const appReleases = new AppReleases(db, (url, init) => xray.fetch(url, init), app.log);
  stops.push(appReleases.start());
  await app.register(appRoutes, { apps: appReleases });
  // личная страница клиента (подписка, MTProxy, AWG, приложения) - без входа
  await app.register(personalRoutes, { db, registry, box, env, apps: appReleases });
  await app.register(panelBackupRoutes, { backups: panelBackups });
  bindStateToDb(registry, db, app.log);
  // отброшенное сообщение агента - в журнал, не чаще раза в 10 минут на сервер: иначе снимок
  // теряется без следа
  const invalidAt = new Map<string, number>();
  registry.on('invalid', (serverId, err) => {
    if (Date.now() - (invalidAt.get(serverId) ?? 0) < 10 * 60_000) return;
    invalidAt.set(serverId, Date.now());
    app.log.warn({ serverId, err }, 'agent: сообщение не прошло схему, отброшено');
  });

  // Собранный фронтенд в проде; в dev его отдаёт Vite с прокси на /api.
  if (env.WEB_DIST && existsSync(env.WEB_DIST)) {
    await app.register(fastifyStatic, { root: env.WEB_DIST, wildcard: false });
    app.setNotFoundHandler(async (req, reply) => {
      if (req.url.startsWith('/api/')) return reply.code(404).send({ error: 'Не найдено' });
      return reply.sendFile('index.html', join(env.WEB_DIST as string));
    });
  }

  return { app, db, registry };
}
