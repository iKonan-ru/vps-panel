import { createHash } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import ssh2 from 'ssh2';

// ssh2 - CommonJS, именованные импорты в ESM не работают.
const { Client, utils } = ssh2;

/**
 * SSH нужен панели ровно для одного: зайти на сервер и поставить агента.
 * Ключ панели лежит в DATA_DIR/panel_ssh_ed25519 и создаётся при первом обращении.
 */
export interface PanelKey {
  privateKey: string;
  publicKey: string;
}

export function loadPanelKey(dataDir: string): PanelKey {
  const priv = join(dataDir, 'panel_ssh_ed25519');
  const pub = `${priv}.pub`;
  if (!existsSync(priv)) {
    mkdirSync(dataDir, { recursive: true });
    const kp = utils.generateKeyPairSync('ed25519', { comment: 'vps-panel' });
    writeFileSync(priv, kp.private, { mode: 0o600 });
    writeFileSync(pub, `${kp.public}\n`, { mode: 0o644 });
    chmodSync(priv, 0o600);
  }
  return { privateKey: readFileSync(priv, 'utf8'), publicKey: readFileSync(pub, 'utf8').trim() };
}

export type SshAuth = { mode: 'password'; password: string } | { mode: 'key'; privateKey: string };

export interface SshTarget {
  host: string;
  port: number;
  auth: SshAuth;
  /** Известный отпечаток хоста; пустая строка - первое подключение (запоминаем). */
  knownFingerprint: string;
}

export class HostKeyMismatch extends Error {
  constructor(
    public expected: string,
    public actual: string,
  ) {
    super(
      `Ключ SSH-хоста изменился: ожидался ${expected}, получен ${actual}. Если сервер переустановлен - нажми "Сбросить отпечаток SSH" под выводом установки и повтори. Если нет - не сбрасывай: на этом адресе может отвечать чужой сервер.`,
    );
  }
}

function fingerprint(key: Buffer): string {
  return `SHA256:${createHash('sha256').update(key).digest('base64').replace(/=+$/, '')}`;
}

/**
 * Выполняет команду от root, стримит вывод. Возвращает код выхода и
 * отпечаток хоста (чтобы вызывающий мог его сохранить).
 */
export async function sshRun(
  target: SshTarget,
  command: string,
  onOutput: (chunk: string) => void,
  timeoutMs = 10 * 60_000,
): Promise<{ exitCode: number; fingerprint: string }> {
  const conn = new Client();
  let seen = '';
  const auth =
    target.auth.mode === 'password'
      ? { password: target.auth.password }
      : { privateKey: target.auth.privateKey };
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      conn.end();
      reject(new Error('SSH: превышено время ожидания'));
    }, timeoutMs);
    const done = (fn: () => void) => {
      clearTimeout(timer);
      fn();
    };
    conn
      .on('ready', () => {
        conn.exec(command, { pty: false }, (err, stream) => {
          if (err) return done(() => reject(err));
          stream.on('data', (d: Buffer) => onOutput(d.toString()));
          stream.stderr.on('data', (d: Buffer) => onOutput(d.toString()));
          stream.on('close', (code: number | null) => {
            conn.end();
            done(() => resolve({ exitCode: code ?? 1, fingerprint: seen }));
          });
        });
      })
      .on('error', (e: Error & { level?: string }) => {
        // ключ хоста не тот: ssh2 сам отвечает "Host denied (verification failed)" - объясняем
        if (target.knownFingerprint && seen && seen !== target.knownFingerprint)
          return done(() => reject(new HostKeyMismatch(target.knownFingerprint, seen)));
        const msg =
          e.level === 'client-authentication'
            ? 'SSH: сервер не принял пароль или ключ'
            : e.level === 'client-timeout'
              ? 'SSH: сервер не отвечает'
              : `SSH: ${e.message}`;
        done(() => reject(new Error(msg)));
      })
      .connect({
        host: target.host,
        port: target.port,
        username: 'root',
        readyTimeout: 20_000,
        keepaliveInterval: 15_000,
        hostVerifier: (key: Buffer) => {
          seen = fingerprint(key);
          // бросать из verifier нельзя: false, а причину объясняет обработчик error выше
          return !target.knownFingerprint || target.knownFingerprint === seen;
        },
        ...auth,
      });
  });
}
