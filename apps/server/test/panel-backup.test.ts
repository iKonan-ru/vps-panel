import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { type Db, createDb } from '../src/db/index.js';
import { actionLog, servers } from '../src/db/schema.js';
import {
  PBKDF2_ITER,
  PanelBackups,
  createPanelBackup,
  opensslDecrypt,
  opensslEncrypt,
} from '../src/lib/panel-backup.js';

let dir: string;
let db: Db;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'pb-'));
  db = createDb(dir);
  db.insert(servers)
    .values({ id: 's1', name: 'Hoster', host: '1.2.3.4' } as never)
    .run();
  writeFileSync(join(dir, 'panel_ssh_ed25519'), 'PRIVATE KEY\n');
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe('шифрование как у openssl enc', () => {
  it('туда-обратно, неверный пароль - ошибка', () => {
    const enc = opensslEncrypt(Buffer.from('секрет'), 'pass-1');
    expect(enc.subarray(0, 8).toString()).toBe('Salted__');
    expect(opensslDecrypt(enc, 'pass-1').toString()).toBe('секрет');
    // CBC без проверки целостности: с чужим ключом паддинг иногда (~1/256) сходится случайно -
    // тогда расшифровка даёт мусор, но не исходный текст
    let wrong = '';
    try {
      wrong = opensslDecrypt(enc, 'pass-2').toString();
    } catch {
      wrong = 'ошибка';
    }
    expect(wrong).not.toBe('секрет');
  });
});

describe('createPanelBackup', () => {
  it('архив расшифровывается обычным openssl, внутри база, секрет и ключ', async () => {
    const b = await createPanelBackup({
      db,
      dataDir: dir,
      sessionSecret: 'S'.repeat(40),
      panelUrl: 'https://panel.example.com',
      password: 'correct horse',
    });
    expect(b.name).toMatch(/^vps-panel-backup-\d{8}-\d{4}\.tar\.gz\.enc$/);
    const out = join(dir, 'out');
    const enc = join(dir, 'b.enc');
    writeFileSync(enc, b.data);
    execFileSync('mkdir', ['-p', out]);
    // ровно та команда, что в подсказке: openssl enc -d ... | tar xz
    execFileSync('sh', [
      '-c',
      `openssl enc -d -aes-256-cbc -pbkdf2 -iter ${PBKDF2_ITER} -pass pass:'correct horse' -in ${enc} | tar xz -C ${out}`,
    ]);
    const root = join(out, 'vps-panel-backup');
    expect(readFileSync(join(root, 'panel.env'), 'utf8')).toContain(
      `SESSION_SECRET=${'S'.repeat(40)}`,
    );
    expect(readFileSync(join(root, 'panel_ssh_ed25519'), 'utf8')).toBe('PRIVATE KEY\n');
    const copy = new Database(join(root, 'panel.db'), { readonly: true });
    expect(copy.prepare('select name from server').get()).toEqual({ name: 'Hoster' });
    copy.close();
    expect(readFileSync(join(root, 'README.txt'), 'utf8')).toContain('SESSION_SECRET');
  });
});

describe('PanelBackups', () => {
  it('без пароля - 409; с паролем файл уходит в Telegram, итог в статусе и журнале', async () => {
    const sent: { name: string; size: number; caption: string }[] = [];
    let tgError: string | null = null;
    const box = { seal: (s: string) => `sealed:${s}`, open: (s: string) => s.slice(7) };
    const pb = new PanelBackups(
      db,
      box,
      { dataDir: dir, sessionSecret: 'S'.repeat(40), panelUrl: 'https://panel.example.com' },
      {
        sendDocument: async (name, data, caption) => {
          sent.push({ name, size: data.length, caption });
          return tgError;
        },
        send: async () => null,
      },
      { warn: () => {} },
    );
    await expect(pb.sendToTelegram()).rejects.toMatchObject({ statusCode: 409 });
    pb.setPassword('correct horse');
    pb.setTelegram(true);
    const last = await pb.sendToTelegram();
    expect(last).toMatchObject({ to: 'telegram', ok: true });
    expect(sent).toHaveLength(1);
    // команда - блоком кода, с именем присланного файла; HTML экранирован
    expect(sent[0]?.caption).toContain(
      `<pre>openssl enc -d -aes-256-cbc -pbkdf2 -iter ${PBKDF2_ITER} -in ${sent[0]?.name} | tar xz</pre>`,
    );
    expect(pb.status()).toMatchObject({ passwordSet: true, telegram: true, last: { ok: true } });
    tgError = 'Telegram: 403 бот заблокирован';
    expect(await pb.sendToTelegram()).toMatchObject({ ok: false, error: tgError });
    const log = db.select().from(actionLog).all();
    // без пароля бэкап не начинается - записи нет
    expect(log.filter((r) => r.kind === 'panel.backup').map((r) => r.exitCode)).toEqual([0, 1]);
  });
});
