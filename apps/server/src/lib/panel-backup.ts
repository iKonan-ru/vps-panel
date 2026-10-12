import { spawn } from 'node:child_process';
import { createCipheriv, createDecipheriv, pbkdf2Sync, randomBytes } from 'node:crypto';
import { existsSync } from 'node:fs';
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import Database from 'better-sqlite3';
import { sql } from 'drizzle-orm';
import type { Db } from '../db/index.js';
import { actionLog } from '../db/schema.js';
import { newId } from './ids.js';
import { schedule } from './schedule.js';
import { getSetting, putSetting } from './settings.js';
import { esc } from './telegram.js';

/** Итераций PBKDF2: те же нужно указать openssl при расшифровке (-iter). */
export const PBKDF2_ITER = 100_000;

/** Команда расшифровки и распаковки архива file. */
export const decryptCommand = (file: string) =>
  `openssl enc -d -aes-256-cbc -pbkdf2 -iter ${PBKDF2_ITER} -in ${file} | tar xz`;

/** Та же команда для человека (в README архива, в Настройках, в deploy/README.md). */
export const DECRYPT_HINT = decryptCommand('<файл>.enc');

/**
 * Шифрование в формате `openssl enc -aes-256-cbc -pbkdf2 -iter 100000 -salt`: "Salted__",
 * соль 8 байт, шифротекст; ключ и IV - PBKDF2-SHA256 от пароля и соли. Расшифровать можно
 * обычным openssl на любой машине, без панели.
 */
export function opensslEncrypt(data: Buffer, pass: string): Buffer {
  const salt = randomBytes(8);
  const kiv = pbkdf2Sync(pass, salt, PBKDF2_ITER, 48, 'sha256');
  const c = createCipheriv('aes-256-cbc', kiv.subarray(0, 32), kiv.subarray(32));
  return Buffer.concat([Buffer.from('Salted__'), salt, c.update(data), c.final()]);
}

/** Обратное к opensslEncrypt; неверный пароль - исключение. */
export function opensslDecrypt(data: Buffer, pass: string): Buffer {
  if (data.subarray(0, 8).toString() !== 'Salted__') throw new Error('не зашифрованный файл');
  const kiv = pbkdf2Sync(pass, data.subarray(8, 16), PBKDF2_ITER, 48, 'sha256');
  const d = createDecipheriv('aes-256-cbc', kiv.subarray(0, 32), kiv.subarray(32));
  return Buffer.concat([d.update(data.subarray(16)), d.final()]);
}

function run(cmd: string, args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const p = spawn(cmd, args, { stdio: ['ignore', 'ignore', 'pipe'] });
    let err = '';
    p.stderr.on('data', (b: Buffer) => {
      err += b.toString();
    });
    p.on('error', reject);
    p.on('close', (code) =>
      code === 0 ? resolve() : reject(new Error(`${cmd}: код ${code} ${err.trim()}`)),
    );
  });
}

const README = (panelUrl: string) => `Резервная копия VPS Panel (${panelUrl}).

Внутри:
- panel.db - база панели (снимок);
- panel.env - SESSION_SECRET: ключ, которым в базе зашифрованы доступы, ключи клиентов AWG
  и токены;
- panel_ssh_ed25519 - ключ, которым панель заходит на серверы;
- panel_agent_ed25519.pem - ключ, которому верят агенты: без него восстановленной панели
  не поверит ни один агент;
- xray/config.json - выход панели в Telegram.

Восстановление: установить панель и выполнить на её сервере
  vps-panel restore <этот файл>
Команда спросит пароль резервной копии и сделает остальное.

Вручную (подробно - docs/install.md, раздел "Резервная копия и восстановление"; каталог
установки из релиза - /opt/vps-panel, из исходников - deploy):
1. ${DECRYPT_HINT}
2. cd /opt/vps-panel && docker compose stop panel
3. panel.db, panel_agent_ed25519.pem, panel_ssh_ed25519(.pub) и xray/ - в data (владелец
   uid 1000, у ключей права 600); старые panel.db-wal и panel.db-shm удалить.
   panel_ssh_ed25519 есть в архиве не всегда: панель создаёт его при первом входе на сервер
   по ключу.
4. SESSION_SECRET из panel.env - в .env (без него зашифрованное в базе не прочитать).
5. docker compose up -d panel
`;

/**
 * Архив для восстановления панели: снимок базы (VACUUM INTO - согласованная копия без
 * остановки панели, проверяется integrity_check), SESSION_SECRET, SSH-ключ панели, ключ
 * панели для агентов, конфиг xray. Бэкапы серверов (DATA_DIR/backups) не входят. Итог - tar.gz, зашифрованный паролем.
 */
export async function createPanelBackup(o: {
  db: Db;
  dataDir: string;
  sessionSecret: string;
  panelUrl: string;
  password: string;
}): Promise<{ name: string; data: Buffer }> {
  const tmp = await mkdtemp(join(tmpdir(), 'panel-backup-'));
  try {
    const dir = join(tmp, 'vps-panel-backup');
    await mkdir(dir);
    const dbFile = join(dir, 'panel.db');
    o.db.run(sql.raw(`VACUUM INTO '${dbFile.replaceAll("'", "''")}'`));
    const check = new Database(dbFile, { readonly: true });
    try {
      const res = check.pragma('integrity_check', { simple: true });
      if (res !== 'ok') throw new Error(`снимок базы повреждён: ${String(res)}`);
    } finally {
      check.close();
    }
    for (const f of [
      'panel_ssh_ed25519',
      'panel_ssh_ed25519.pub',
      // ключ, которому верят агенты: без него восстановленной панели не поверит ни один
      'panel_agent_ed25519.pem',
      'xray/config.json',
    ]) {
      const src = join(o.dataDir, f);
      if (!existsSync(src)) continue;
      await mkdir(dirname(join(dir, f)), { recursive: true });
      await cp(src, join(dir, f));
    }
    await writeFile(
      join(dir, 'panel.env'),
      `SESSION_SECRET=${o.sessionSecret}\nPANEL_PUBLIC_URL=${o.panelUrl}\n`,
      { mode: 0o600 },
    );
    await writeFile(join(dir, 'README.txt'), README(o.panelUrl));
    const archive = join(tmp, 'backup.tar.gz');
    await run('tar', ['czf', archive, '-C', tmp, 'vps-panel-backup']);
    const data = opensslEncrypt(await readFile(archive), o.password);
    const ts = new Date().toISOString().slice(0, 16).replace(/[-:]/g, '').replace('T', '-');
    return { name: `vps-panel-backup-${ts}.tar.gz.enc`, data };
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
}

/** Последний бэкап: когда, куда, итог. */
export interface PanelBackupLast {
  at: string;
  to: 'telegram' | 'download';
  ok: boolean;
  size?: number;
  error?: string;
}

const K_PASS = 'panel_backup_pass';
const K_TG = 'panel_backup_tg';
const K_LAST = 'panel_backup_last';
const DAY_MS = 24 * 60 * 60_000;

/**
 * Бэкап панели: пароль (зашифрован SecretBox) и включение отправки
 * в Telegram - в setting; раз в сутки архив уходит файлом в чат бота, по кнопке - сразу или
 * скачиванием. Каждый бэкап - запись в журнале.
 */
export class PanelBackups {
  constructor(
    private db: Db,
    private box: { seal: (s: string) => string; open: (s: string) => string },
    private opts: { dataDir: string; sessionSecret: string; panelUrl: string },
    private telegram: {
      sendDocument: (name: string, data: Buffer, caption: string) => Promise<string | null>;
      send: (text: string) => Promise<string | null>;
    },
    private log: { warn: (o: unknown, m?: string) => void },
  ) {}

  start() {
    return schedule(() => void this.tick(), 5 * 60_000, 30 * 60_000);
  }

  private get(key: string): string | undefined {
    return getSetting(this.db, key);
  }

  private put(key: string, value: string) {
    putSetting(this.db, key, value);
  }

  status() {
    let last: PanelBackupLast | null = null;
    try {
      last = JSON.parse(this.get(K_LAST) ?? 'null') as PanelBackupLast | null;
    } catch {}
    return {
      passwordSet: Boolean(this.get(K_PASS)),
      telegram: this.get(K_TG) === '1',
      last,
      decryptHint: DECRYPT_HINT,
    };
  }

  setPassword(password: string) {
    this.put(K_PASS, this.box.seal(password));
  }

  setTelegram(on: boolean) {
    this.put(K_TG, on ? '1' : '0');
  }

  /** Собрать зашифрованный архив; без пароля - ошибка 409. */
  async build(to: PanelBackupLast['to']) {
    const sealed = this.get(K_PASS);
    if (!sealed)
      throw Object.assign(new Error('не задан пароль резервной копии'), { statusCode: 409 });
    const startedAt = new Date().toISOString();
    try {
      const b = await createPanelBackup({
        db: this.db,
        ...this.opts,
        password: this.box.open(sealed),
      });
      return { ...b, startedAt };
    } catch (e) {
      this.finish(startedAt, to, false, undefined, (e as Error).message);
      throw e;
    }
  }

  /** Итог в setting и журнал (без сервера: это панель целиком). */
  finish(startedAt: string, to: PanelBackupLast['to'], ok: boolean, size?: number, error?: string) {
    const last: PanelBackupLast = {
      at: startedAt,
      to,
      ok,
      ...(size ? { size } : {}),
      ...(error ? { error } : {}),
    };
    this.put(K_LAST, JSON.stringify(last));
    this.db
      .insert(actionLog)
      .values({
        id: newId(),
        serverId: null,
        kind: 'panel.backup',
        params: { to },
        startedAt,
        finishedAt: new Date().toISOString(),
        exitCode: ok ? 0 : 1,
        output: ok
          ? `${to === 'telegram' ? 'отправлена в Telegram' : 'скачана'}, ${size ?? 0} байт`
          : (error ?? ''),
      })
      .run();
    return last;
  }

  /** Отправить бэкап в Telegram сейчас. */
  async sendToTelegram(): Promise<PanelBackupLast> {
    const b = await this.build('telegram');
    // команда - блоком кода (в Telegram копируется нажатием) и сразу с именем этого файла
    const err = await this.telegram.sendDocument(
      b.name,
      b.data,
      `Резервная копия VPS Panel ${esc(this.opts.panelUrl)}\n\nРасшифровка и распаковка:\n<pre>${esc(decryptCommand(b.name))}</pre>\nВосстановление\u00a0\u2014 по README.txt в архиве.`,
    );
    return this.finish(b.startedAt, 'telegram', !err, b.data.length, err ?? undefined);
  }

  /** Раз в сутки по расписанию, если включено и задан пароль; сбой - сообщение в Telegram. */
  private async tick() {
    const st = this.status();
    if (!st.telegram || !st.passwordSet) return;
    const lastTg = st.last?.to === 'telegram' ? Date.parse(st.last.at) : 0;
    if (Date.now() - lastTg < DAY_MS) return;
    try {
      const r = await this.sendToTelegram();
      if (!r.ok)
        await this.telegram.send(`Резервная копия панели не отправлена: ${esc(r.error ?? '')}`);
    } catch (e) {
      this.log.warn({ err: (e as Error).message }, 'panel backup');
      await this.telegram.send(`Резервная копия панели не создана: ${esc((e as Error).message)}`);
    }
  }
}
