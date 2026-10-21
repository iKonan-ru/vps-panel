import { createHash } from 'node:crypto';
import type { AppLink, AppOs } from '@vps/protocol';
import QRCode from 'qrcode';

/**
 * HTML личной страницы клиента: стили, скрипт копирования, иконки и помощники разметки.
 * Страница без сборки фронтенда - строки шаблонов.
 */

export const esc = (s: string) =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

const qr = (text: string) =>
  QRCode.toString(text, { type: 'svg', errorCorrectionLevel: 'L', margin: 2 });

/** Цвета - токены панели, тема - как в системе. */
const STYLE = `
:root{color-scheme:light;--bg:#f5f6f8;--surface:#fff;--surface-2:#eef0f3;--border:#d9dee6;--text:#1c1e21;--muted:#5f6975;--accent:#2f6fe4;--ok:#1f9d6a}
@media(prefers-color-scheme:dark){:root{color-scheme:dark;--bg:#0f1115;--surface:#161a20;--surface-2:#1c2129;--border:#2a313c;--text:#e8eaed;--muted:#9aa4b2;--accent:#4f8cff;--ok:#3ecf8e}}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--text);font:14px/1.5 "IBM Plex Sans",system-ui,-apple-system,"Segoe UI",Roboto,sans-serif}
main{max-width:560px;margin:0 auto;padding:20px 16px 40px}
svg{flex:none}
.head{display:flex;align-items:center;gap:10px;margin:4px 0 4px}.head svg{width:24px;height:24px;color:var(--accent)}
h1{font-size:20px;font-weight:600;margin:0}.lead{color:var(--muted);font-size:13px;margin:0 0 18px}
.card{background:var(--surface);border:1px solid var(--border);border-radius:12px;margin-bottom:14px}
.card-h{padding:12px 16px;border-bottom:1px solid var(--border);font-weight:600;font-size:15px}
.card-b{padding:14px 16px;display:flex;flex-direction:column;gap:12px}
.hint{color:var(--muted);font-size:13px;margin:0}
.btn{display:inline-flex;align-items:center;justify-content:center;gap:8px;height:36px;padding:0 14px;border-radius:8px;border:1px solid var(--border);background:var(--surface-2);color:var(--text);font:inherit;text-decoration:none;cursor:pointer;white-space:nowrap}
.btn:hover{border-color:var(--muted)}.btn svg{width:16px;height:16px}
.btn.primary{background:var(--accent);border-color:var(--accent);color:#fff}.btn.primary:hover{filter:brightness(1.1)}
.btn.sm{height:30px;padding:0 10px;font-size:13px;gap:6px}.btn.sm svg{width:14px;height:14px}
.btn.icon{width:36px;padding:0}.btn.sm.icon{width:30px}.btn.wide{width:100%}
.split{display:flex;min-width:0}.split.inline{display:inline-flex}.split>*{border-radius:0}
.split>:first-child{border-radius:8px 0 0 8px}.split>:last-child{border-radius:0 8px 8px 0}.split>:only-child{border-radius:8px}.split>*+*{border-left:0}
.split>.main{flex:1;min-width:0}.split.inline>.main{flex:none}.qrb.on{background:var(--border)}
.btn span{display:inline-flex;align-items:center;gap:inherit}
.copy .ok{display:none}.copy.done .ok{display:inline-flex}.copy.done .cp{display:none}.copy.done{color:var(--ok)}
.qrp{display:flex;flex-direction:column;align-items:center;gap:6px;flex-basis:100%;margin-top:4px}.qrp[hidden]{display:none}
.qr-box{background:#fff;padding:10px;border-radius:10px;width:100%;max-width:320px}.qr-box svg{display:block;width:100%;height:auto}
.qr-box[data-frames] .frame{display:none}.qr-box[data-frames] .frame.on{display:block}
.rows{display:flex;flex-direction:column}
.row{display:flex;align-items:center;flex-wrap:wrap;gap:8px 10px;padding:10px 0;border-top:1px solid var(--border)}
.row:first-child{border-top:0;padding-top:0}.row:last-child{padding-bottom:0}
.name{flex:1 1 160px;min-width:0;font-weight:500}.name small{color:var(--muted);font-weight:400;margin-left:6px}
.devblk{border:1px solid var(--border);border-radius:10px;overflow:hidden}
.devh{display:flex;align-items:center;gap:8px;padding:8px 12px;background:var(--surface-2);font-weight:600;font-size:13px}.devh svg{width:16px;height:16px;color:var(--muted)}
summary.devh{cursor:pointer;list-style:none;user-select:none}summary.devh::-webkit-details-marker{display:none}
summary.devh .n{margin-left:auto;font-weight:400;color:var(--muted)}summary.devh .chev.end{margin-left:auto}summary.devh .chev{transition:transform .15s}details[open]>summary.devh .chev{transform:rotate(90deg)}
.drow{flex-wrap:wrap}
.drow{display:flex;align-items:center;gap:8px;padding:10px 12px;border-top:1px solid var(--border)}.drow .name{flex:1;min-width:0}
.drow .name small{display:block;margin:0;font-size:12px;color:var(--muted)}
.devblk>.drow:first-child{border-top:0}
.go{display:flex;align-items:center;gap:8px;padding-top:12px;border-top:1px solid var(--border);color:var(--accent);text-decoration:none;font-size:13px}.go svg{width:16px;height:16px}.go .grow{flex:1}
.appb{display:flex;flex-direction:column;gap:8px}.appb+.appb{padding-top:12px;border-top:1px solid var(--border)}
.appb h3{font-size:15px;margin:0}
.apps{display:flex;flex-direction:column;gap:6px;font-size:13px}
.app{display:flex;flex-wrap:wrap;align-items:center;gap:6px 12px}.app .os{color:var(--muted);min-width:96px}
.app .links{display:flex;flex-wrap:wrap;gap:6px}.apps.picked .app:not(.mine){display:none}
.more{display:none}.pickable+.more{display:inline-flex;align-self:flex-start}
.back{display:inline-flex;align-items:center;gap:6px;color:var(--muted);text-decoration:none;font-size:13px;margin-bottom:12px}.back svg{width:16px;height:16px}
.key{font:12px/1.45 ui-monospace,"JetBrains Mono",monospace;word-break:break-all;background:var(--surface-2);border:1px solid var(--border);border-radius:8px;padding:10px;max-height:120px;overflow:auto;color:var(--muted)}
.empty{color:var(--muted);text-align:center;padding:28px 16px}
.steps{margin:0;padding-left:20px;display:flex;flex-direction:column;gap:6px;font-size:13px}.steps b{font-weight:600;word-break:break-all}
.fold-b{display:flex;flex-direction:column;gap:10px;padding:10px 12px;border-top:1px solid var(--border)}
.browsers{display:grid;grid-template-columns:repeat(auto-fit,minmax(120px,1fr));gap:8px}`;

/**
 * Копирование ссылок; QR - под стеком кнопок по нажатию, кадры Amnezia VPN листаются раз в 1,2 с.
 * Приложения - сначала для ОС устройства (data-prefer) или посетителя (iPad в новых версиях
 * представляется Mac - отличаем по сенсорному экрану), остальные платформы - кнопкой, она же
 * их и скрывает. Без скрипта видны все платформы.
 */
const SCRIPT = `document.addEventListener('click',function(e){var b=e.target.closest('[data-copy]');if(b){navigator.clipboard.writeText(b.getAttribute('data-copy')).then(function(){b.classList.add('done');setTimeout(function(){b.classList.remove('done')},1200)});return}
var q=e.target.closest('[data-qr]');if(q){var p=document.getElementById(q.getAttribute('data-qr'));p.hidden=!p.hidden;q.classList.toggle('on',!p.hidden);q.setAttribute('aria-expanded',String(!p.hidden));return}
var m=e.target.closest('.more');if(m){var a=m.previousElementSibling,on=a.classList.toggle('picked');m.textContent=on?'Другие платформы':'Скрыть другие платформы'}});
var u=navigator.userAgent,os=/Android/i.test(u)?'android':/iPhone|iPad|iPod/.test(u)||(/Macintosh/.test(u)&&navigator.maxTouchPoints>1)?'ios':/Windows/.test(u)?'windows':/Macintosh|Mac OS X/.test(u)?'macos':/Linux|X11|CrOS/.test(u)?'linux':'';
var ff=/Firefox\\//.test(u);document.querySelectorAll('[data-browser]').forEach(function(b){b.classList.toggle('primary',b.getAttribute('data-browser')===(ff?'firefox':'chrome'))});
document.querySelectorAll('[data-pick]').forEach(function(a){var m=a.querySelector('[data-os="'+(a.getAttribute('data-prefer')||os)+'"]');if(m){m.classList.add('mine');a.classList.add('pickable','picked')}});
setInterval(function(){document.querySelectorAll('.qrp:not([hidden]) [data-frames]').forEach(function(x){var f=x.querySelectorAll('.frame'),i=0;f.forEach(function(e,j){if(e.classList.contains('on'))i=j});f[i].classList.remove('on');i=(i+1)%f.length;f[i].classList.add('on');var c=x.parentNode.querySelector('.cap');if(c)c.firstChild.textContent='кадр '+(i+1)+' из '+f.length})},1200)`;

/** Иконки lucide - те же, что в панели. */
const ICONS = {
  shield:
    '<path d="M20 13c0 5-3.5 7.5-7.66 8.95a1 1 0 0 1-.67-.01C7.5 20.5 4 18 4 13V6a1 1 0 0 1 1-1c2 0 4.5-1.2 6.24-2.72a1.17 1.17 0 0 1 1.52 0C14.51 3.81 17 5 19 5a1 1 0 0 1 1 1z"/><path d="m9 12 2 2 4-4"/>',
  copy: '<rect width="14" height="14" x="8" y="8" rx="2" ry="2"/><path d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2"/>',
  check: '<path d="M20 6 9 17l-5-5"/>',
  external:
    '<path d="M15 3h6v6"/><path d="M10 14 21 3"/><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/>',
  download:
    '<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" x2="12" y1="15" y2="3"/>',
  qr: '<rect width="5" height="5" x="3" y="3" rx="1"/><rect width="5" height="5" x="16" y="3" rx="1"/><rect width="5" height="5" x="3" y="16" rx="1"/><path d="M21 16h-3a2 2 0 0 0-2 2v3"/><path d="M21 21v.01"/><path d="M12 7v3a2 2 0 0 1-2 2H7"/><path d="M3 12h.01"/><path d="M12 3h.01"/><path d="M12 16v.01"/><path d="M16 12h1"/><path d="M21 12v.01"/><path d="M12 21v-1"/>',
  send: '<path d="M14.536 21.686a.5.5 0 0 0 .937-.024l6.5-19a.496.496 0 0 0-.635-.635l-19 6.5a.5.5 0 0 0-.024.937l7.93 3.18a2 2 0 0 1 1.112 1.11z"/><path d="m21.854 2.147-10.94 10.939"/>',
  chevron: '<path d="m9 18 6-6-6-6"/>',
  back: '<path d="m12 19-7-7 7-7"/><path d="M19 12H5"/>',
  device: '<rect width="14" height="20" x="5" y="2" rx="2" ry="2"/><path d="M12 18h.01"/>',
  router:
    '<rect width="20" height="8" x="2" y="14" rx="2"/><path d="M6.01 18H6"/><path d="M10.01 18H10"/><path d="M15 10v4"/><path d="M17.84 7.17a4 4 0 0 0-5.66 0"/><path d="M20.66 4.34a8 8 0 0 0-11.31 0"/>',
  monitor:
    '<rect width="20" height="14" x="2" y="3" rx="2"/><line x1="8" x2="16" y1="21" y2="21"/><line x1="12" x2="12" y1="17" y2="21"/>',
};

/** Иконка устройства по типу: роутер, компьютер, остальное - телефон. */
const deviceIcon = (type: string) =>
  icon(
    type === 'router'
      ? 'router'
      : ['windows', 'macos', 'linux'].includes(type)
        ? 'monitor'
        : 'device',
  );

/** "роутер: Keenetic" -> "Роутер: Keenetic". */
const capital = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);
export const icon = (n: keyof typeof ICONS) =>
  `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICONS[n]}</svg>`;

/**
 * CSP личной страницы: только свой скрипт и свои стили по хешу, картинки - data:
 * (QR - SVG прямо в странице), ничего внешнего. Нарушения уходят в отчёты панели (reportUri).
 */
export function personalCsp(reportUri: string): string {
  const h = (s: string) => `'sha256-${createHash('sha256').update(s).digest('base64')}'`;
  return [
    "default-src 'none'",
    `script-src ${h(SCRIPT)}`,
    `style-src ${h(STYLE)}`,
    "img-src 'self' data:",
    "base-uri 'none'",
    "form-action 'none'",
    "frame-ancestors 'none'",
    `report-uri ${reportUri}`,
  ].join('; ');
}

/** Значок вкладки - тот же, что у панели (icon.svg из сборки веба), прямо в странице: data: (CSP). */
let favicon = '';
export function setFavicon(svg: string) {
  favicon = svg ? `data:image/svg+xml;base64,${Buffer.from(svg).toString('base64')}` : '';
}

/** Заголовок вкладки личных страниц: "VPS Panel :: Имя". */
export const pageTitle = (name: string) => `VPS Panel :: ${name}`;

export const page = (title: string, body: string) =>
  `<!doctype html><html lang="ru"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex,nofollow,noarchive"><title>${esc(title)}</title>${favicon ? `<link rel="icon" type="image/svg+xml" href="${favicon}">` : ''}<style>${STYLE}</style></head><body><main>${body}</main><script>${SCRIPT}</script></body></html>`;

export const card = (title: string, body: string, id = '') =>
  `<section class="card"${id ? ` id="${id}"` : ''}><div class="card-h">${esc(title)}</div><div class="card-b">${body}</div></section>`;

export const OS_IDS: AppOs[] = ['android', 'ios', 'windows', 'macos', 'linux'];

/**
 * Платформы приложения: скрипт оставит ОС prefer (устройства) или посетителя, остальные -
 * кнопкой "Другие платформы" (она же их скрывает).
 */
export const platformsHtml = async (
  ps: { os: AppOs; title: string; links: AppLink[] }[],
  prefer?: AppOs | null,
) => {
  const items = (
    await Promise.all(
      ps.map(
        async (p) =>
          `<div class="app" data-os="${p.os}"><span class="os">${esc(p.title)}</span><span class="links">${await appLinks(p.links)}</span></div>`,
      ),
    )
  ).join('');
  return ps.length > 1
    ? `<div class="apps" data-pick${prefer ? ` data-prefer="${prefer}"` : ''}>${items}</div><button type="button" class="btn sm more">Другие платформы</button>`
    : `<div class="apps">${items}</div>`;
};

/** Кнопка копирования: иконка (и подпись), после копирования - галочка. */
export const copyBtn = (text: string, label = '', cls = 'icon') =>
  `<button type="button" class="btn copy ${cls}" data-copy="${esc(text)}" title="Скопировать" aria-label="Скопировать"><span class="cp">${icon('copy')}${esc(label)}</span><span class="ok">${icon('check')}${label ? 'Скопировано' : ''}</span></button>`;

let qrSeq = 0;

/**
 * QR за кнопкой (последняя в стеке): код - панелью под стеком, открывается и закрывается
 * нажатием. frames - несколько кодов (ключ Amnezia VPN), листаются сами.
 */
export const qrPart = async (sm: boolean, codes: string[]) => {
  const id = `qr${++qrSeq}`;
  const svgs = await Promise.all(codes.map((t) => qr(t)));
  const box =
    svgs.length > 1
      ? `<div class="qr-box" data-frames>${svgs.map((v, i) => `<div class="frame${i ? '' : ' on'}">${v}</div>`).join('')}</div><p class="hint cap">кадр 1 из ${svgs.length}<br>держите камеру, пока приложение не соберёт все</p>`
      : `<div class="qr-box">${svgs[0] ?? ''}</div>`;
  return {
    btn: `<button type="button" class="btn ${sm ? 'sm ' : ''}icon qrb" data-qr="${id}" aria-expanded="false" title="QR-код" aria-label="QR-код">${icon('qr')}</button>`,
    panel: `<div class="qrp" id="${id}" hidden>${box}</div>`,
  };
};

/** Текст, который не открыть ссылкой (подписка qWDTT, qwdtt://): копирование и QR одним стеком. */
export const copyStack = async (text: string, label: string, sm: boolean, wide = false) => {
  const q = await qrPart(sm, [text]);
  return `<span class="split${wide ? '' : ' inline'}">${copyBtn(text, label, `main${sm ? ' sm' : ''}`)}${q.btn}</span>${q.panel}`;
};

/**
 * Ссылка стеком кнопок, как в панели: переход, копирование (copy - если копировать нужно
 * другое), по желанию QR. http(s) - в новой вкладке, happ:// и tg:// - в приложении.
 */
export const linkBtn = async (o: {
  href: string;
  label: string;
  icon?: keyof typeof ICONS;
  copy?: string;
  qr?: string;
  primary?: boolean;
  sm?: boolean;
  wide?: boolean;
}) => {
  const web = /^https?:/i.test(o.href) ? ' target="_blank" rel="noreferrer"' : '';
  const cls = ['btn main', o.primary ? 'primary' : '', o.sm ? 'sm' : ''].filter(Boolean).join(' ');
  const q = o.qr ? await qrPart(Boolean(o.sm), [o.qr]) : null;
  return `<span class="split${o.wide ? '' : ' inline'}"><a class="${cls}" href="${esc(o.href)}"${web}>${icon(o.icon ?? 'external')}${esc(o.label)}</a>${copyBtn(o.copy ?? o.href, '', o.sm ? 'sm icon' : 'icon')}${q?.btn ?? ''}</span>${q?.panel ?? ''}`;
};

/** Ссылки на приложение для ОС (страница "Приложения" панели клиенту недоступна). */
const appLinks = async (links: AppLink[]) =>
  (
    await Promise.all(
      links.map((l) =>
        linkBtn({ href: l.url, label: [l.label, l.version].filter(Boolean).join(' '), sm: true }),
      ),
    )
  ).join('');

/** Ссылка на страницу приложений (раздел anchor, сверху - ОС устройства os). */
export const appsLink = (token: string, anchor: string, label: string, os?: AppOs | null) =>
  `<a class="go" href="/c/${token}/apps${os ? `?os=${os}` : ''}#${anchor}">${icon('device')}<span class="grow">${esc(label)}</span>${icon('chevron')}</a>`;

/**
 * Блок устройства, свёрнут (details, без скрипта): заголовок - значок, имя и число строк,
 * внутри - строки серверов.
 */
export const deviceBlock = (o: { type: string; title: string; rows: string[] }) =>
  fold({
    head: `${deviceIcon(o.type)}${esc(capital(o.title))}`,
    n: o.rows.length,
    body: o.rows.join(''),
  });

/**
 * Свёрнутый блок (details, без скрипта): заголовок (готовый HTML), справа - число строк n,
 * внутри - body: строки .drow или произвольное содержимое в .fold-b.
 */
export const fold = (o: { head: string; body: string; n?: number }) =>
  `<details class="devblk"><summary class="devh">${o.head}${o.n === undefined ? '' : `<span class="n">${o.n}</span>`}${icon('chevron').replace('<svg ', `<svg class="chev${o.n === undefined ? ' end' : ''}" `)}</summary>${o.body}</details>`;

export const head = (name: string) =>
  `<div class="head">${icon('shield')}<h1>${esc(name)}</h1></div><p class="lead">Подключение к VPN. Сохраните эту страницу: здесь всегда актуальные настройки.</p>`;
