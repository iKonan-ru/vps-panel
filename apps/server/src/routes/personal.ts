import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { deviceOf } from '@vps/protocol';
import { and, eq, isNull } from 'drizzle-orm';
import type { FastifyInstance, FastifyReply } from 'fastify';
import type { AgentRegistry } from '../agents/registry.js';
import type { Env } from '../config.js';
import type { Db } from '../db/index.js';
import { gclientBindings, gclientDevices, gclients, servers } from '../db/schema.js';
import type { AppReleases } from '../lib/apps.js';
import { awgClientConfigs } from '../lib/awg-clients.js';
import { awgTunnelNames } from '../lib/awg-config.js';
import { awgRef } from '../lib/gclient-services.js';
import {
  OS_IDS,
  appsLink,
  card,
  copyBtn,
  copyStack,
  deviceBlock,
  esc,
  head,
  icon,
  linkBtn,
  page,
  pageTitle,
  personalCsp,
  platformsHtml,
  qrPart,
  setFavicon,
} from '../lib/personal-page.js';
import type { SecretBox } from '../lib/secret-box.js';
import { wdttHashes } from '../lib/wdtt.js';
import { zip } from '../lib/zip.js';

/**
 * Личная страница клиента: по секретной ссылке /c/<токен> без
 * входа - имя, подписка VLESS, прокси MTProxy, конфиги AWG его устройств, ссылки на приложения.
 * Не больше 30 запросов в минуту с адреса.
 */
export async function personalRoutes(
  app: FastifyInstance,
  opts: { db: Db; registry: AgentRegistry; box: SecretBox; env: Env; apps: AppReleases },
) {
  const { db, registry, box, env, apps } = opts;
  const subBase = (env.SUB_PUBLIC_URL ?? env.PANEL_PUBLIC_URL).replace(/\/+$/, '');
  // не больше 30 запросов в минуту с адреса: токены не перебрать
  const opts30 = {
    logLevel: 'warn',
    config: { rateLimit: { max: 30, timeWindow: '1 minute' } },
  } as const;
  // значок вкладки - icon.svg панели (в сборке веба); нет сборки (тесты) - без значка
  try {
    if (env.WEB_DIST) setFavicon(readFileSync(join(env.WEB_DIST, 'icon.svg'), 'utf8'));
  } catch {
    setFavicon('');
  }
  const csp = personalCsp(`${env.PANEL_PUBLIC_URL.replace(/\/+$/, '')}/api/csp-report`);
  const secure = (reply: FastifyReply) =>
    reply
      .header('Cache-Control', 'no-store')
      .header('X-Robots-Tag', 'noindex')
      .header('Referrer-Policy', 'no-referrer')
      .header('Content-Security-Policy', csp);

  const clientOf = (token: string) =>
    /^[0-9a-f]{32}$/.test(token)
      ? db
          .select()
          .from(gclients)
          .where(and(eq(gclients.token, token), isNull(gclients.deletedAt)))
          .get()
      : undefined;

  const serverTitle = (s: typeof servers.$inferSelect) =>
    awgTunnelNames({ provider: s.provider, country: s.country, serverName: s.name }).title;

  app.get('/c/:token', opts30, async (req, reply) => {
    secure(reply);
    const { token } = req.params as { token: string };
    const c = clientOf(token);
    if (!c) return reply.code(404).type('text/plain').send('not found');
    if (!c.enabled)
      return reply
        .type('text/html; charset=utf-8')
        .send(
          page(
            pageTitle(c.name),
            `${head(c.name)}<section class="card empty">Доступ приостановлен.</section>`,
          ),
        );
    const rows = db
      .select({ b: gclientBindings, s: servers })
      .from(gclientBindings)
      .innerJoin(servers, eq(servers.id, gclientBindings.serverId))
      // сервер выключен из глобальных клиентов - на странице его нет, как и в подписке
      .where(and(eq(gclientBindings.clientId, c.id), eq(servers.gclients, true)))
      .all()
      .sort((x, y) => x.s.name.localeCompare(y.s.name));
    const devices = db
      .select()
      .from(gclientDevices)
      .where(and(eq(gclientDevices.clientId, c.id), isNull(gclientDevices.deletedAt)))
      .all();
    const subUrl = `${subBase}/sub/${c.token}`;
    let body = head(c.name);
    const devTitle = (d: (typeof devices)[number]) =>
      [deviceOf(d.type)?.title, d.name].filter(Boolean).join(': ') || 'устройство';
    // порядок разделов: прокси для Telegram, подписка, AWG, WDTT, OpenFlux
    // MTProxy: прокси для Telegram на каждом сервере
    const mt = rows.filter((r) => r.b.service === 'mtproxyl' && r.b.links.length);
    if (mt.length) {
      let items = '';
      for (const { b, s } of mt) {
        const tg = b.links.find((l) => l.startsWith('tg://')) ?? b.links[0] ?? '';
        const web = b.links.find((l) => l.startsWith('https://t.me/'));
        items += `<div class="row"><span class="name">${esc(serverTitle(s))}</span>${await linkBtn({ href: tg, label: 'Подключить', icon: 'send', copy: web ?? tg, qr: tg, primary: true, sm: true })}</div>`;
      }
      body += card(
        'Прокси для Telegram',
        `<p class="hint">Нажмите "Подключить" - Telegram предложит добавить прокси. Если не открылся, скопируйте ссылку и откройте её в Telegram.</p><div class="rows">${items}</div>`,
      );
    }
    // VLESS: одна подписка на все серверы
    if (rows.some((r) => r.b.service === 'xui')) {
      body += card(
        'VPN по подписке',
        `<p class="hint">Приложение Happ (или v2rayNG, Hiddify): добавьте подписку кнопкой, скопированной ссылкой или QR-кодом. Серверы обновляются в приложении сами.</p>
${await linkBtn({ href: `happ://add/${subUrl}`, label: 'Добавить в Happ', copy: subUrl, qr: subUrl, primary: true, wide: true })}
${appsLink(c.token, 'vless', 'Скачать приложение Happ')}`,
      );
    }
    // AWG: конфиги по устройствам; блоки сворачиваются, развёрнут первый
    const awg = rows.filter(
      (r) => r.b.service === 'awg' && r.b.state === 'ok' && awgRef(r.b.ref).publicKey,
    );
    if (awg.length) {
      let items = '';
      let first = true;
      for (const d of devices) {
        const mine = awg.filter((r) => r.b.deviceId === d.id);
        if (!mine.length) continue;
        // у устройства с AWG 2.0 на сервере два конфига - подписываем оба
        const list = mine.map(
          ({ b, s }) =>
            `<div class="drow"><span class="name">${esc(serverTitle(s))}${d.awg20 ? `<small>AWG ${awgRef(b.ref).major}.x</small>` : ''}</span><a class="btn sm" href="/c/${c.token}/awg/${b.id}">Конфиг${icon('chevron')}</a></div>`,
        );
        items += deviceBlock({ type: d.type, title: devTitle(d), rows: list, open: first });
        first = false;
      }
      body += card(
        'VPN по конфигу AWG',
        `<p class="hint">Отдельный конфиг на каждое устройство и сервер: откройте конфиг на нужном устройстве.</p>${items}${appsLink(c.token, 'awg', 'Скачать Amnezia VPN или AmneziaWG')}`,
      );
    }
    // WDTT: подписка qWDTT и ссылки серверов
    const wd = rows.filter((r) => r.b.service === 'wdtt' && r.b.state === 'ok' && r.b.links[0]);
    if (wd.length) {
      let items = '';
      for (const { b, s } of wd)
        items += `<div class="row"><span class="name">${esc(serverTitle(s))}</span>${await copyStack(b.links[0] ?? '', 'Скопировать', true)}</div>`;
      const ownHashes = wdttHashes(db).length
        ? ''
        : ' Хеши звонков VK добавьте в приложении (вход в аккаунт VK).';
      body += card(
        'VPN через звонки VK (WDTT)',
        `<p class="hint">Телефон (qWDTT): в разделе подписок добавьте ссылку подписки - серверы и пароли обновятся сами. Компьютер (PWDTT): добавьте сервер ссылкой ниже.${ownHashes}</p>
${await copyStack(`${subBase}/sub/${c.token}/wdtt`, 'Скопировать подписку', false, true)}
<div class="rows">${items}</div>${appsLink(c.token, 'wdtt', 'Скачать qWDTT или PWDTT')}`,
      );
    }
    // OpenFlux: канал на устройство на каждом сервере - по устройствам, как AWG
    const of = rows.filter((r) => r.b.service === 'openflux' && r.b.state === 'ok' && r.b.links[0]);
    if (of.length) {
      let items = '';
      let first = true;
      for (const d of devices) {
        const mine = of.filter((r) => r.b.deviceId === d.id);
        if (!mine.length) continue;
        const list: string[] = [];
        for (const { b, s } of mine) {
          const link = b.links[0] ?? '';
          list.push(
            `<div class="drow"><span class="name">${esc(serverTitle(s))}</span>${await linkBtn({ href: link, label: 'Подключить', copy: link, qr: link, primary: true, sm: true })}</div>`,
          );
        }
        items += deviceBlock({ type: d.type, title: devTitle(d), rows: list, open: first });
        first = false;
      }
      body += card(
        'OpenFlux',
        `<p class="hint">Приложение OpenFlux: "Подключить" открывает профиль в приложении, на другом устройстве - QR-код или скопированная ссылка. Ссылка - для своего устройства: на одном канале одновременно работает одно устройство.</p>${items}${appsLink(c.token, 'openflux', 'Скачать OpenFlux')}`,
      );
    }
    // Прокси для браузера: расширение Chrome - архив со ссылкой внутри
    if (rows.some((r) => r.b.service === 'naive' && r.b.state === 'ok' && r.b.links[0])) {
      const pageUrl = `${subBase}/c/${c.token}`;
      body += card(
        'Браузер Chrome без программ',
        `<p class="hint">Расширение для Chrome: VPN только для браузера, ничего не нужно устанавливать в систему. Ссылка уже внутри архива.</p>
<ol class="steps"><li>Скачайте архив и распакуйте его в папку, которую не будете удалять.</li><li>Откройте в Chrome адрес <b>chrome://extensions</b> и включите "Режим разработчика" (справа вверху).</li><li>Нажмите "Загрузить распакованное расширение" и выберите распакованную папку <b>vps-panel-proxy</b> (не архив .zip: внутри папки лежит manifest.json).</li><li>Готово: значок VPS Panel - на панели расширений (под значком пазла), там же включение и выбор сервера.</li></ol>
<span class="split"><a class="btn main primary" href="/c/${c.token}/chrome.zip">${icon('download')}Скачать расширение</a></span>
<p class="hint">Если расширение попросит ссылку - вставьте ссылку этой страницы:</p><span class="split">${copyBtn(pageUrl, 'Скопировать ссылку страницы', 'main')}</span>`,
      );
    }
    if (!rows.length)
      body += '<section class="card empty">Подключения ещё готовятся. Загляните позже.</section>';
    return reply.type('text/html; charset=utf-8').send(page(pageTitle(c.name), body));
  });

  /**
   * Архив расширения Chrome: файлы apps/extension и config.json со
   * ссылкой подписки клиента - после установки вводить ничего не нужно. Папка в архиве -
   * vps-panel-proxy (её выбирают в "Загрузить распакованное расширение").
   */
  app.get('/c/:token/chrome.zip', opts30, async (req, reply) => {
    secure(reply);
    const { token } = req.params as { token: string };
    const c = clientOf(token);
    if (!c || !c.enabled) return reply.code(404).type('text/plain').send('not found');
    let names: string[];
    try {
      names = readdirSync(env.EXTENSION_DIR).filter((n) =>
        statSync(join(env.EXTENSION_DIR, n)).isFile(),
      );
    } catch {
      return reply.code(503).type('text/plain').send('extension is not available');
    }
    const files = names
      // config.json - свой для клиента; README.md - описание для разработки, клиенту не нужно
      .filter((n) => n !== 'config.json' && n !== 'README.md')
      .map((n) => ({
        name: `vps-panel-proxy/${n}`,
        data: readFileSync(join(env.EXTENSION_DIR, n)),
      }));
    const config = { subscription: `${subBase}/sub/${c.token}/browser` };
    files.push({
      name: 'vps-panel-proxy/config.json',
      data: Buffer.from(`${JSON.stringify(config, null, 2)}\n`),
    });
    return reply
      .type('application/zip')
      .header('Content-Disposition', 'attachment; filename="vps-panel-proxy.zip"')
      .send(zip(files));
  });

  /** Конфиг AWG устройства на сервере: QR, скачивание .conf, ключ для Amnezia VPN. */
  const awgConfig = async (token: string, bid: string) => {
    const c = clientOf(token);
    if (!c || !c.enabled) return null;
    const row = db
      .select({ b: gclientBindings, s: servers })
      .from(gclientBindings)
      .innerJoin(servers, eq(servers.id, gclientBindings.serverId))
      .where(and(eq(gclientBindings.id, bid), eq(gclientBindings.clientId, c.id)))
      .get();
    if (!row || row.b.service !== 'awg') return null;
    const { container, publicKey } = awgRef(row.b.ref);
    const d = row.b.deviceId
      ? db.select().from(gclientDevices).where(eq(gclientDevices.id, row.b.deviceId)).get()
      : undefined;
    const device = [deviceOf(d?.type)?.title, d?.name].filter(Boolean).join(': ');
    const type = d?.type ?? '';
    if (!registry.isOnline(row.s.id)) return { c, row, device, type, cfg: null };
    const cfg = await awgClientConfigs({
      db,
      registry,
      box,
      server: row.s,
      container,
      publicKey,
      mtu: deviceOf(d?.type)?.mtu ?? 1280,
    });
    return { c, row, device, type, cfg };
  };

  app.get('/c/:token/awg/:bid', opts30, async (req, reply) => {
    secure(reply);
    const { token, bid } = req.params as { token: string; bid: string };
    const r = await awgConfig(token, bid);
    if (!r) return reply.code(404).type('text/plain').send('not found');
    const back = `<a class="back" href="/c/${token}">${icon('back')}Все подключения</a>`;
    if (!r.cfg)
      return reply
        .type('text/html; charset=utf-8')
        .send(
          page(
            pageTitle(r.c.name),
            `${back}<section class="card empty">Сервер сейчас недоступен, попробуйте позже.</section>`,
          ),
        );
    const { cfg } = r;
    const conf = await qrPart(false, [cfg.conf]);
    const frames = await qrPart(false, cfg.frames.length ? cfg.frames : [cfg.vpn]);
    const os = deviceOf(r.type)?.os;
    const body = `${back}<div class="head"><h1>${esc(serverTitle(r.row.s))}</h1></div><p class="lead">${esc([r.c.name, r.device].filter(Boolean).join(', '))}. Подойдёт любое из двух приложений.</p>
${card(
  'Вариант 1: приложение Amnezia VPN',
  `<p class="hint">"Добавить" - вставить ключ или отсканировать QR-код. Подключение будет называться "${esc(cfg.title)}".</p>
<div class="key">${esc(cfg.vpn)}</div><span class="split">${copyBtn(cfg.vpn, 'Скопировать ключ', 'main primary')}${frames.btn}</span>${frames.panel}
${appsLink(token, 'amnezia-vpn', 'Скачать Amnezia VPN', os)}`,
)}
${card(
  'Вариант 2: приложение AmneziaWG',
  `<p class="hint">Скачайте файл и откройте его в приложении или отсканируйте QR-код (приложение спросит имя - введите ${esc(cfg.fileName)}).</p>
<span class="split"><a class="btn main" href="/c/${token}/awg/${bid}/conf">${icon('download')}Скачать ${esc(cfg.fileName)}.conf</a>${conf.btn}</span>${conf.panel}
${appsLink(token, 'amneziawg', 'Скачать AmneziaWG', os)}`,
)}`;
    return reply.type('text/html; charset=utf-8').send(page(pageTitle(r.c.name), body));
  });

  /**
   * Приложения по услугам клиента: Happ для подписки, AmneziaWG и Amnezia VPN для конфигов AWG
   * (подойдёт любое), Telegram для прокси. Сверху - ОС посетителя или ?os= (из конфига устройства).
   */
  app.get('/c/:token/apps', opts30, async (req, reply) => {
    secure(reply);
    const { token } = req.params as { token: string };
    const c = clientOf(token);
    if (!c || !c.enabled) return reply.code(404).type('text/plain').send('not found');
    const q = (req.query as { os?: string }).os;
    const prefer = OS_IDS.find((x) => x === q) ?? null;
    const services = new Set(
      db
        .select({ service: gclientBindings.service })
        .from(gclientBindings)
        .where(eq(gclientBindings.clientId, c.id))
        .all()
        .map((r) => r.service),
    );
    const list = apps.list().apps;
    const appBlock = async (id: string, about: string) => {
      const a = list.find((x) => x.id === id);
      if (!a) return '';
      return `<div class="appb" id="${id}"><h3>${esc(a.name)}</h3><p class="hint">${esc(about)}</p>${await platformsHtml(a.platforms, prefer)}</div>`;
    };
    let body = `<a class="back" href="/c/${token}">${icon('back')}Все подключения</a><div class="head"><h1>Приложения</h1></div><p class="lead">Для вашего устройства - сверху, остальные платформы - кнопкой.</p>`;
    if (services.has('xui'))
      body += card(
        'VPN по подписке',
        await appBlock('happ', 'Добавьте в нём подписку - серверы обновятся сами.'),
        'vless',
      );
    if (services.has('awg'))
      body += card(
        'VPN по конфигу AWG',
        `<p class="hint">Подойдёт любое из двух приложений.</p>${await appBlock('amnezia-vpn', 'Клиент Amnezia: вставить ключ vpn:// или отсканировать QR-код из нескольких кадров.')}${await appBlock('amneziawg', 'Простое приложение: открыть файл конфига (.conf) или отсканировать QR-код.')}`,
        'awg',
      );
    if (services.has('wdtt'))
      body += card(
        'VPN через звонки VK',
        await appBlock(
          'qwdtt',
          'Телефон на Android - qWDTT, компьютер (Windows, macOS, Linux) - PWDTT. Добавьте подписку или ссылку сервера.',
        ),
        'wdtt',
      );
    if (services.has('openflux'))
      body += card(
        'OpenFlux',
        await appBlock(
          'openflux',
          'Телефон (Android, iPhone - бета через TestFlight) и компьютер. Добавьте профиль ссылкой или QR-кодом.',
        ),
        'openflux',
      );
    if (services.has('mtproxyl'))
      body += card(
        'Прокси для Telegram',
        `<p class="hint">Отдельное приложение не нужно - достаточно Telegram.</p>${await linkBtn({ href: 'https://telegram.org/apps', label: 'Telegram для всех устройств', sm: true })}`,
        'telegram',
      );
    if (!services.size)
      body += '<section class="card empty">Подключения ещё готовятся. Загляните позже.</section>';
    return reply.type('text/html; charset=utf-8').send(page(pageTitle(c.name), body));
  });

  app.get('/c/:token/awg/:bid/conf', opts30, async (req, reply) => {
    secure(reply);
    const { token, bid } = req.params as { token: string; bid: string };
    const r = await awgConfig(token, bid);
    if (!r?.cfg) return reply.code(404).type('text/plain').send('not found');
    return reply
      .type('text/plain; charset=utf-8')
      .header('Content-Disposition', `attachment; filename="${r.cfg.fileName}.conf"`)
      .send(r.cfg.conf);
  });
}
