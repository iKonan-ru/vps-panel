import { existsSync } from 'node:fs';
import { createServer } from 'node:http';
import { BlockList, isIPv6 } from 'node:net';
import { join } from 'node:path';
import fastifyCookie from '@fastify/cookie';
import fastifyRateLimit from '@fastify/rate-limit';
import fastifyStatic from '@fastify/static';
import fastifyWebsocket from '@fastify/websocket';
import type { PanelRelease } from '@vps/protocol';
import { isNull, sql } from 'drizzle-orm';
import Fastify from 'fastify';
import { ZodError } from 'zod';
import { AgentRegistry } from './agents/registry.js';
import { bindStateToDb } from './agents/state.js';

import { type Env, panelDomain } from './config.js';
import { type Db, createDb } from './db/index.js';
import { actionLog, servers } from './db/schema.js';
import { actionJournal } from './lib/action-journal.js';
import { AppReleases } from './lib/apps.js';
import { BackupRestorer } from './lib/backup-restore.js';
import { Cascades } from './lib/cascades.js';
import { catalogRunner } from './lib/catalog-runner.js';
import { startFail2banIgnore } from './lib/fail2ban-ignore.js';
import { FirefoxSigner } from './lib/firefox.js';
import { GClients } from './lib/gclients.js';
import { startHousekeeping } from './lib/housekeeping.js';
import { startMetricsPace } from './lib/metrics-pace.js';
import { EngineCatalog } from './lib/mtproxyl-engine.js';
import { Notifier } from './lib/notify.js';
import { PanelBackups } from './lib/panel-backup.js';
import { PanelCerts } from './lib/panel-certs.js';
import { panelAddresses } from './lib/panel-host.js';
import { PanelProxy } from './lib/panel-proxy.js';
import { PanelUpdates } from './lib/panel-updates.js';
import { RuReach } from './lib/ru-reach.js';
import { schedule } from './lib/schedule.js';
import { SecretBox } from './lib/secret-box.js';
import { onServerRemoved } from './lib/server-remove.js';
import { serverSetup } from './lib/server-setup.js';
import { ServiceUpdates } from './lib/service-updates.js';
import { Telegram } from './lib/telegram.js';
import { UiHub } from './lib/ui-hub.js';
import { PANEL_VERSION } from './lib/version.js';
import { XraySpares, exitsAfterInboundChange, exitsAfterServerRemoved } from './lib/xray-exits.js';
import { XrayManager } from './lib/xray.js';
import { accessRoutes } from './routes/access.js';
import { accountRoutes } from './routes/account.js';
import { agentDistRoutes } from './routes/agent-dist.js';
import { agentUpdateRoutes } from './routes/agent-update.js';
import { agentWsRoutes } from './routes/agent-ws.js';
import { appRoutes } from './routes/apps.js';
import { authRoutes, requireAuth, useHostCookies } from './routes/auth.js';
import { awgRoutes } from './routes/awg.js';
import { backupRoutes } from './routes/backups.js';
import { baselineFirewallRoutes } from './routes/baseline-firewall.js';
import { cascadeRoutes } from './routes/cascades.js';
import { clientHostRoutes } from './routes/client-host.js';
import { commandRoutes } from './routes/commands.js';
import { cspRoutes } from './routes/csp.js';
import { deployRoutes } from './routes/deploy.js';
import { dockerRoutes } from './routes/docker.js';
import { firefoxRoutes } from './routes/firefox.js';
import { gclientRoutes } from './routes/gclients.js';
import { installRoutes } from './routes/install.js';
import { ipChangeRoutes } from './routes/ip-change.js';
import { journalRoutes } from './routes/journal.js';
import { mtproxylRoutes } from './routes/mtproxyl.js';
import { notifyRoutes } from './routes/notify.js';
import { openfluxRoutes } from './routes/openflux.js';
import { panelBackupRoutes } from './routes/panel-backup.js';
import { panelUpdateRoutes } from './routes/panel-update.js';
import { personalRoutes } from './routes/personal.js';
import { probeRoutes } from './routes/probe.js';
import { proxyRoutes } from './routes/proxy.js';
import { reachRoutes } from './routes/reach.js';
import { securityRoutes } from './routes/security.js';
import { serverRoutes } from './routes/servers.js';
import { setupRoutes } from './routes/setup.js';
import { standardRoutes } from './routes/standard.js';
import { subscriptionRoutes } from './routes/subscription.js';
import { systemRoutes } from './routes/system.js';
import { terminalRoutes } from './routes/terminal.js';
import { uiWsRoutes } from './routes/ui-ws.js';
import { updateRoutes } from './routes/updates.js';
import { wdttRoutes } from './routes/wdtt.js';
import { xrayRoutes } from './routes/xray.js';
import { xuiInboundRoutes } from './routes/xui-inbounds.js';
import { xuiRoutes } from './routes/xui.js';

interface AppOptions {
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
  const sessionSecret = env.SESSION_SECRET ?? 'dev-only-secret-change-me-please-32b';
  const journal = actionJournal(db, hub, registry);
  useHostCookies(secure);

  // Поддомены панелей сервисов: запросы к ним разбираются до Fastify,
  // своим сервером - маршруты, хуки и обработчик ошибок Fastify их не касаются.
  let proxy: PanelProxy | null = null;
  // сертификаты сервисов на самом сервере панели (прокси для браузера): выпускает Caddy панели,
  // запросы на эти имена панель не обслуживает
  const panelCerts = new PanelCerts(db, env.PANEL_PUBLIC_URL);
  const app = Fastify({
    logger: env.NODE_ENV === 'test' ? false : { level: env.LOG_LEVEL },
    trustProxy: trustCaddy,
    bodyLimit: 1_048_576,
    serverFactory: (handler) =>
      createServer((req, res) => {
        if (panelCerts.isCertHost(req.headers.host)) {
          res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' }).end('Not found');
          return;
        }
        if (!proxy?.labelOf(req.headers.host)) return handler(req, res);
        void proxy.handle(req, res);
      }),
  });
  proxy = new PanelProxy(
    db,
    registry,
    // без домена (панель по IP) поддоменов нет: панели сервисов - напрямую, без прокси
    secure ? panelDomain(env) : '',
    sessionSecret,
    app.log,
  );
  const panelProxy = proxy;
  app.addHook('onReady', async () => panelProxy.attachUpgrade(app.server));

  await app.register(fastifyCookie, {
    secret: sessionSecret,
  });
  await app.register(fastifyRateLimit, { global: false });
  await app.register(fastifyWebsocket);

  app.setErrorHandler((err: unknown, _req, reply) => {
    if (err instanceof ZodError) {
      return reply.code(400).send({ error: 'неверные данные', issues: err.issues });
    }
    app.log.error(err);
    const e = err as { statusCode?: unknown; message?: unknown; code?: unknown };
    const status = typeof e.statusCode === 'number' ? e.statusCode : 500;
    if (status === 500) return reply.code(500).send({ error: 'внутренняя ошибка' });
    const message = typeof e.message === 'string' ? e.message : 'ошибка';
    // код ошибки (no-token и т.п.) - для интерфейса: по нему, а не по тексту
    return reply
      .code(status)
      .send({ error: message, ...(typeof e.code === 'string' ? { code: e.code } : {}) });
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
    version: PANEL_VERSION,
    now: new Date().toISOString(),
  }));
  await app.register(authRoutes, { db, secure });
  const box = new SecretBox(sessionSecret);
  // xray-клиент для выхода в Telegram: дочерний процесс панели
  const xray = new XrayManager(db, env.DATA_DIR, app.log);
  /** Запросы панели наружу (GitHub, реестр образов): через выход xray, если он задан. */
  const outFetch: typeof xray.fetch = (url, init) => xray.fetch(url, init);
  await xray.load();
  await xray.start();
  app.addHook('onClose', async () => {
    await xray.stop();
  });
  // версии движка MTProxyL: готовые образы в реестре (ghcr.io), чтобы не собирать на сервере
  const engines = new EngineCatalog(registry, outFetch);
  await app.register(serverRoutes, { db, registry, env, hub, proxy: panelProxy });
  // действия над сервером через агента - по файлу на область
  const serverRouteOpts = { db, env, registry, hub, box, engines };
  // новые версии панели (релизы GitHub) и обновление через службу на хосте; уведомление -
  // через notifier, он создаётся ниже
  let onPanelRelease: (r: PanelRelease) => Promise<void> = async () => undefined;
  const panelUpdates = new PanelUpdates(
    db,
    env.DATA_DIR,
    outFetch,
    app.log,
    (r) => onPanelRelease(r),
    PANEL_VERSION,
    env.PANEL_CHANNEL,
  );
  await app.register(panelUpdateRoutes, { updates: panelUpdates });
  // панель обновилась - агенты за ней, если это не выключено
  const panelUpdated = panelUpdates.versionChanged();
  await app.register(agentUpdateRoutes, {
    ...serverRouteOpts,
    autoRollout: () => panelUpdated && panelUpdates.settings().agentsAuto,
  });
  await app.register(awgRoutes, serverRouteOpts);
  await app.register(baselineFirewallRoutes, serverRouteOpts);
  await app.register(dockerRoutes, serverRouteOpts);
  await app.register(journalRoutes, serverRouteOpts);
  await app.register(mtproxylRoutes, serverRouteOpts);
  await app.register(openfluxRoutes, serverRouteOpts);
  await app.register(systemRoutes, serverRouteOpts);
  await app.register(installRoutes, { db, env, registry, hub });
  await app.register(securityRoutes, { db });
  await app.register(accountRoutes, { db, secure });
  await app.register(commandRoutes, { db, env, registry, hub, box, certs: panelCerts });
  await app.register(accessRoutes, { db, box });
  const restorer = new BackupRestorer(db, env, registry);
  await app.register(backupRoutes, {
    db,
    env,
    registry,
    hub,
    restorer,
    // пароль резервных копий общий с копией панели; спрашивается при запросе, когда panelBackups
    // уже создан
    password: () => panelBackups.password(),
  });
  await app.register(probeRoutes);
  await app.register(agentWsRoutes, { db, registry, dataDir: env.DATA_DIR });
  await app.register(proxyRoutes, {
    proxy: panelProxy,
    db,
    certs: panelCerts,
    selfIp: env.PANEL_SNI,
  });
  await app.register(cspRoutes);
  await app.register(uiWsRoutes, { db, registry, hub });
  await app.register(terminalRoutes, { db, registry });
  await app.register(agentDistRoutes, { agentDir: env.AGENT_DIR });
  await app.register(deployRoutes, { dataDir: env.DATA_DIR });
  // запасные выходы xray: клиент vps-panel на каждом сервере с 3X-UI
  const exitDeps = { db, registry, box, xray, log: app.log, panelUrl: env.PANEL_PUBLIC_URL };
  const xraySpares = new XraySpares(exitDeps);
  const syncSpares = () => void xraySpares.sync().catch(() => undefined);
  await app.register(xrayRoutes, { db, registry, box, xray, spares: xraySpares, deps: exitDeps });
  // inbound-ы 3X-UI меняются из панели - выходы в Telegram за ними (основной хранит снимок)
  // и каскады VLESS, у которых этот inbound на входе или на выходе
  let cascades: Cascades | null = null;
  const exitsAfter = (serverId: string, inboundId: number, gone: boolean) => {
    cascades?.afterInboundChange(serverId, inboundId);
    return exitsAfterInboundChange(exitDeps, xraySpares, serverId, inboundId, gone);
  };
  // глобальные клиенты: сверка с серверами в фоне (до маршрутов 3X-UI: их правки запускают её)
  const gc = new GClients(
    db,
    box,
    registry,
    journal,
    () => panelAddresses(env.PANEL_PUBLIC_URL),
    app.log,
  );
  gc.onSyncChange = (syncing) => hub.broadcast({ type: 'gclients.sync', syncing });
  await app.register(xuiRoutes, {
    ...serverRouteOpts,
    gc,
    xray,
    exitsAfter,
    syncSpares,
  });
  const telegram = new Telegram(
    db,
    box,
    registry,
    app.log,
    { routes: () => xray.routes(), worked: (id) => xray.worked(id) },
    env.TG_PROXY_URL,
  );
  await app.register(notifyRoutes, { telegram });
  const notifier = new Notifier(db, registry, telegram, env.PANEL_PUBLIC_URL);
  onPanelRelease = (r) => notifier.panelRelease(r);
  // остановка фоновых таймеров при закрытии: в тестах и при выключении они не трогают базу
  const stops: (() => void)[] = [];
  stops.push(panelUpdates.start());
  // доступность из России: адрес и inbound-ы - агент через Globalping, MTProxyL - его итог
  const ruReach = new RuReach(db, box, registry, app.log, (id, note) => notifier.reach(id, note));
  stops.push(ruReach.start());
  // имена сервисов сервера панели с сертификатом от её Caddy - из снимков
  stops.push(schedule(() => void panelCerts.refresh().catch(() => undefined), 5_000, 5 * 60_000));
  await app.register(reachRoutes, { reach: ruReach });
  stops.push(xraySpares.start());
  // доставка в Telegram: раз в 5 минут проверка выходов xray и getMe бота
  stops.push(
    schedule(
      () =>
        void xray
          .checkAll()
          .then(() => telegram.probe())
          .catch((e: Error) => app.log.warn({ err: e.message }, 'telegram: проверка')),
      90_000,
      5 * 60_000,
    ),
  );
  app.addHook('onClose', async () => {
    for (const stop of stops) stop();
  });
  stops.push(
    notifier.bind(
      (await db.select({ id: servers.id, cache: servers.statusCache }).from(servers)).map((r) => ({
        id: r.id,
        cache: r.cache ?? {},
      })),
    ),
  );
  // обновления 3X-UI, Xray в нём и MTProxyL (менеджер, веб-панель): проверка через агента,
  // строки в блоке "Обслуживание", версии во вкладке MTProxyL
  const serviceUpdates = new ServiceUpdates(
    db,
    box,
    registry,
    app.log,
    (id, u) => notifier.serviceUpdate(id, u),
    outFetch,
  );
  stops.push(serviceUpdates.start());
  await app.register(standardRoutes, { db, registry, env, updates: serviceUpdates });
  await app.register(updateRoutes, { db, hub, registry, updates: serviceUpdates });
  stops.push(gc.start(), startHousekeeping(db, app.log));
  // IP своих серверов - мимо fail2ban панели
  stops.push(startFail2banIgnore(db, registry, env.DATA_DIR, app.log));
  // метрики агентов раз в 2 с, пока открыта вкладка панели, иначе раз в 30 с
  stops.push(startMetricsPace(registry, hub, app.log));
  await app.register(gclientRoutes, { db, registry, box, gc, env });
  // добавление и удаление inbound-ов VLESS: после изменений - синхронизация клиентов сразу
  await app.register(xuiInboundRoutes, {
    ...serverRouteOpts,
    gc,
    reach: ruReach,
    xray,
    exitsAfter,
    syncSpares,
  });
  // каскады VLESS: inbound на входе, outbound к выходу и правила в шаблоне Xray входа
  cascades = new Cascades({
    db,
    box,
    registry,
    journal,
    gc,
    log: app.log,
    notify: (id, text, back) => void notifier.cascade(id, text, back),
  });
  stops.push(cascades.start());
  await app.register(cascadeRoutes, { cascades });
  // настройка сервера в один клик: команды каталога, inbound-ы, синхронизация - одним действием
  const setup = serverSetup({
    db,
    env,
    registry,
    box,
    hub,
    journal,
    runner: catalogRunner({ db, env, registry, box, certs: panelCerts, log: app.log }),
    restorer,
    gc,
    reach: ruReach,
    syncSpares,
  });
  await app.register(setupRoutes, { setup });
  stops.push(
    onServerRemoved((id) => {
      void notifier.forget(id);
      gc.forget(id);
      ruReach.forget(id);
      void serviceUpdates.forget(id);
      setup.forget(id);
      void exitsAfterServerRemoved(exitDeps, xraySpares, id);
      void cascades?.forget(id);
    }),
  );
  await app.register(clientHostRoutes, {
    db,
    gc,
    hub,
    panelUrl: env.PANEL_PUBLIC_URL,
    registry,
    journal,
  });
  await app.register(ipChangeRoutes, {
    db,
    registry,
    hub,
    gc,
    xray,
    reach: ruReach,
    journal,
  });
  await app.register(wdttRoutes, { db, registry, hub, gc });
  await app.register(subscriptionRoutes, { db, env });
  // бэкап самой панели: раз в сутки в Telegram, по кнопке - сразу или скачиванием
  const panelBackups = new PanelBackups(
    db,
    box,
    { dataDir: env.DATA_DIR, sessionSecret, panelUrl: env.PANEL_PUBLIC_URL },
    {
      sendDocument: (name, data, caption) => telegram.sendDocument(name, data, caption),
      // сбой бэкапа - событие backupFail в настройках уведомлений
      send: async (text) => ((await telegram.wants('backupFail')) ? telegram.send(text) : null),
    },
    app.log,
  );
  stops.push(panelBackups.start());
  // расширение Firefox: подпись ключом addons.mozilla.org из Настроек, новая версия - сама
  const firefox = new FirefoxSigner(db, box, env, app.log);
  stops.push(firefox.start());
  await app.register(firefoxRoutes, { firefox });
  // ссылки на клиентские приложения: релизы GitHub раз в 6 часов
  const appReleases = new AppReleases(db, outFetch, app.log);
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
  // Адрес панели сменился (vps-panel domain): агент, подключившийся по старому адресу, получает
  // новый и переподключается; адрес тот же - агент ничего не делает. Через 5 с после
  // подключения: запрос до welcome агент считает нарушением и рвёт связь.
  registry.on('online', (serverId) => {
    if (!secure) return;
    setTimeout(() => {
      if (!registry.isOnline(serverId) || !registry.supports(serverId, 'panel.url')) return;
      registry
        .request(serverId, 'panel.url', { url: env.PANEL_PUBLIC_URL }, { timeoutMs: 15_000 })
        .then((r) => {
          if ((r as { changed?: boolean }).changed)
            app.log.info({ serverId, url: env.PANEL_PUBLIC_URL }, 'agent: новый адрес панели');
        })
        .catch(() => undefined);
    }, 5_000).unref();
  });

  // Собранный фронтенд в проде; в dev его отдаёт Vite с прокси на /api.
  if (env.WEB_DIST && existsSync(env.WEB_DIST)) {
    await app.register(fastifyStatic, { root: env.WEB_DIST, wildcard: false });
    app.setNotFoundHandler(async (req, reply) => {
      if (req.url.startsWith('/api/')) return reply.code(404).send({ error: 'не найдено' });
      return reply.sendFile('index.html', join(env.WEB_DIST as string));
    });
  }

  return { app, db, registry };
}
