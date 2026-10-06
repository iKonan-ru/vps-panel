#!/usr/bin/env node
// Расширение Firefox: сборка из apps/extension, подпись у Mozilla (addons.mozilla.org, канал
// unlisted - в каталоге не появляется) и раскладка в deploy/files/firefox: архив
// vps-panel-proxy-<версия>.xpi и updates.json для автообновления. Панель раздаёт их по
// /sub/firefox/<файл> и /c/<токен>/firefox.xpi.
//
// Версия - из apps/extension/manifest.json (общая с Chrome). Подписанный архив этой версии уже
// есть - только пересобирается updates.json. Mozilla не подписывает одну версию дважды: если
// версия уже подписана (архив потерян), архив скачивается заново.
//
// Окружение (tools/ship.sh берёт его из .ship.env):
//   AMO_KEY_FILE  файл с ключом API addons.mozilla.org: 1-я строка - JWT issuer, 2-я - secret
//   PANEL_DOMAIN  домен панели: из него ID расширения vps-panel-proxy@<домен> (менять нельзя -
//                 иначе это другое расширение); свой ID - FIREFOX_ID
//   SUB_DOMAIN    имя подписок и личных страниц (пусто - домен панели): на нём updates.json,
//                 его страницы расширение читает при установке (зашивается в архив)
// Использование: AMO_KEY_FILE=... PANEL_DOMAIN=... SUB_DOMAIN=... node tools/sign-firefox.mjs

import { createHash, createHmac, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { deflateRawSync } from 'node:zlib';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const extDir = join(root, 'apps/extension');
const outDir = join(root, 'deploy/files/firefox');
const AMO = 'https://addons.mozilla.org/api/v5';

function die(msg) {
  console.error(`Firefox: ${msg}`);
  process.exit(1);
}

const keyFile = process.env.AMO_KEY_FILE || die('не задан AMO_KEY_FILE (ключ API addons.mozilla.org)');
const panelDomain = process.env.PANEL_DOMAIN || die('не задан PANEL_DOMAIN');
const subDomain = process.env.SUB_DOMAIN || panelDomain;
const id = process.env.FIREFOX_ID || `vps-panel-proxy@${panelDomain}`;
const [issuer, secret] = readFileSync(keyFile, 'utf8').split('\n').map((l) => l.trim());
if (!issuer || !secret) die(`в ${keyFile} нужны две строки: JWT issuer и secret`);

// --- манифест Firefox (MV2: фоновая страница, browser_action, разрешения сразу при установке)
const chrome = JSON.parse(readFileSync(join(extDir, 'manifest.json'), 'utf8'));
const version = chrome.version;
const manifest = {
  manifest_version: 2,
  name: chrome.name,
  short_name: chrome.short_name,
  version,
  description: chrome.description,
  browser_specific_settings: {
    gecko: {
      id,
      strict_min_version: '115.0',
      update_url: `https://${subDomain}/sub/firefox/updates.json`,
      data_collection_permissions: { required: ['none'] },
    },
  },
  permissions: ['proxy', 'storage', 'alarms', 'privacy', '<all_urls>'],
  background: { scripts: ['rules.js', 'bg.js'], persistent: true },
  browser_action: {
    default_popup: chrome.action.default_popup,
    default_title: chrome.action.default_title,
    default_icon: chrome.icons,
  },
  icons: chrome.icons,
};
const files = [
  ['manifest.json', Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`)],
  // имя личных страниц: с них расширение берёт ссылку при установке (только с этого имени)
  ['firefox.json', Buffer.from(`${JSON.stringify({ subHost: subDomain })}\n`)],
  ...['bg.js', 'rules.js', 'popup.html', 'popup.js', ...new Set(Object.values(chrome.icons))].map(
    (n) => [n, readFileSync(join(extDir, n))],
  ),
];

// --- zip (deflate)
const CRC = new Uint32Array(256).map((_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
function crc32(b) {
  let c = 0xffffffff;
  for (const x of b) c = CRC[(c ^ x) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function zip(list) {
  const local = [];
  const central = [];
  let off = 0;
  for (const [name, data] of list) {
    const nm = Buffer.from(name);
    const comp = deflateRawSync(data, { level: 9 });
    const crc = crc32(data);
    const h = Buffer.alloc(30);
    h.writeUInt32LE(0x04034b50, 0);
    h.writeUInt16LE(20, 4);
    h.writeUInt16LE(0x0800, 6);
    h.writeUInt16LE(8, 8);
    h.writeUInt32LE(0x00210000, 10); // 1980-01-01 00:00: одна сборка - одинаковые байты
    h.writeUInt32LE(crc, 14);
    h.writeUInt32LE(comp.length, 18);
    h.writeUInt32LE(data.length, 22);
    h.writeUInt16LE(nm.length, 26);
    local.push(h, nm, comp);
    const c = Buffer.alloc(46);
    c.writeUInt32LE(0x02014b50, 0);
    c.writeUInt16LE(20, 4);
    c.writeUInt16LE(20, 6);
    c.writeUInt16LE(0x0800, 8);
    c.writeUInt16LE(8, 10);
    c.writeUInt32LE(0x00210000, 12);
    c.writeUInt32LE(crc, 16);
    c.writeUInt32LE(comp.length, 20);
    c.writeUInt32LE(data.length, 24);
    c.writeUInt16LE(nm.length, 28);
    c.writeUInt32LE(off, 42);
    central.push(c, nm);
    off += 30 + nm.length + comp.length;
  }
  const cd = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(list.length, 8);
  end.writeUInt16LE(list.length, 10);
  end.writeUInt32LE(cd.length, 12);
  end.writeUInt32LE(off, 16);
  return Buffer.concat([...local, cd, end]);
}

// --- API addons.mozilla.org: JWT HS256 на каждый запрос (живёт минуту)
function jwt() {
  const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
  const now = Math.floor(Date.now() / 1000);
  const head = `${b64({ alg: 'HS256', typ: 'JWT' })}.${b64({ iss: issuer, jti: randomUUID(), iat: now, exp: now + 60 })}`;
  return `${head}.${createHmac('sha256', secret).update(head).digest('base64url')}`;
}
async function api(method, path, body) {
  const form = body instanceof FormData;
  const r = await fetch(path.startsWith('https://') ? path : `${AMO}${path}`, {
    method,
    headers: {
      Authorization: `JWT ${jwt()}`,
      ...(body && !form ? { 'Content-Type': 'application/json' } : {}),
    },
    body: form ? body : body ? JSON.stringify(body) : undefined,
  });
  const text = await r.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {}
  return { status: r.status, json, text };
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const gid = encodeURIComponent(id);

async function signed() {
  const v = await api('GET', `/addons/addon/${gid}/versions/v${version}/`);
  return v.status === 200 ? v.json : null;
}

async function sign() {
  let v = await signed();
  if (!v) {
    console.log(`Firefox: отправляю ${version} на подпись`);
    const form = new FormData();
    form.append('upload', new Blob([zip(files)]), 'vps-panel-proxy.xpi');
    form.append('channel', 'unlisted');
    const up = await api('POST', '/addons/upload/', form);
    if (up.status !== 201 && up.status !== 200) die(`загрузка: HTTP ${up.status} ${up.text.slice(0, 300)}`);
    let u = up.json;
    for (let i = 0; !u.processed && i < 100; i++) {
      await sleep(3000);
      u = (await api('GET', `/addons/upload/${u.uuid}/`)).json;
    }
    if (!u.processed) die('проверка Mozilla не закончилась за 5 минут - запустить позже');
    if (!u.valid) {
      const errs = (u.validation?.messages ?? []).filter((m) => m.type === 'error');
      die(`проверка Mozilla не прошла:\n${errs.map((m) => `  ${m.message} (${m.file ?? ''})`).join('\n')}`);
    }
    const exists = (await api('GET', `/addons/addon/${gid}/`)).status === 200;
    const made = exists
      ? await api('POST', `/addons/addon/${gid}/versions/`, { upload: u.uuid })
      : await api('PUT', `/addons/addon/${gid}/`, { version: { upload: u.uuid } });
    if (made.status >= 300) die(`новая версия: HTTP ${made.status} ${made.text.slice(0, 300)}`);
  }
  // подпись unlisted - автоматическая, обычно минута-две
  for (let i = 0; i < 120; i++) {
    v = await signed();
    const st = v?.file?.status;
    if (st === 'public' && v.file.url) break;
    if (st === 'disabled') die('Mozilla отклонила версию (status disabled)');
    await sleep(10_000);
  }
  if (v?.file?.status !== 'public') die('подпись не готова за 20 минут - запустить позже');
  const r = await fetch(v.file.url, { headers: { Authorization: `JWT ${jwt()}` } });
  if (!r.ok) die(`скачивание подписанного архива: HTTP ${r.status}`);
  return Buffer.from(await r.arrayBuffer());
}

const name = `vps-panel-proxy-${version}.xpi`;
const target = join(outDir, name);
mkdirSync(outDir, { recursive: true });
if (!existsSync(target)) {
  const xpi = await sign();
  writeFileSync(target, xpi, { mode: 0o644 });
  console.log(`Firefox: подписан ${name} (${xpi.length} байт)`);
} else console.log(`Firefox: ${name} уже подписан`);

const hash = createHash('sha256').update(readFileSync(target)).digest('hex');
const updates = {
  addons: {
    [id]: {
      updates: [
        {
          version,
          update_link: `https://${subDomain}/sub/firefox/${name}`,
          update_hash: `sha256:${hash}`,
        },
      ],
    },
  },
};
writeFileSync(join(outDir, 'updates.json'), `${JSON.stringify(updates, null, 2)}\n`, { mode: 0o644 });
