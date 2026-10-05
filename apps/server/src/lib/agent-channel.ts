import {
  type KeyObject,
  createCipheriv,
  createDecipheriv,
  createHash,
  createHmac,
  createPrivateKey,
  createPublicKey,
  diffieHellman,
  generateKeyPairSync,
  hkdfSync,
  sign,
} from 'node:crypto';
import { EventEmitter } from 'node:events';
import { chmodSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { WebSocket } from 'ws';

/**
 * Канал панель-агент v2: агент верит ключу панели ed25519, а не
 * домену. Рукопожатие и формат - как в apps/agent/internal/transport/secure.go:
 * hello2 (X25519 агента) -> server-hello (X25519 панели, ключ, подпись стенограммы) -> дальше
 * двоичные кадры AES-256-GCM с ключами направлений из HKDF и nonce - номером сообщения.
 * Агент доказывает знание токена HMAC-ом от его sha256, панель отвечает тем же в welcome.
 */
export const HANDSHAKE_CONTEXT = 'vps-panel agent channel v2';
const X25519_SPKI = Buffer.from('302a300506032b656e032100', 'hex');
const KEY_FILE = 'panel_agent_ed25519.pem';

/** Ключ панели для агентов: DATA_DIR/panel_agent_ed25519.pem, создаётся при первом запуске. */
export interface PanelKey {
  /** Открытый ключ, 32 байта. */
  pub: Buffer;
  /** Он же в base64 - так его получает агент (команда установки, agent.json). */
  b64: string;
  sign(data: Buffer): Buffer;
}

const keys = new Map<string, PanelKey>();

export function panelKey(dataDir: string): PanelKey {
  const cached = keys.get(dataDir);
  if (cached) return cached;
  const file = join(dataDir, KEY_FILE);
  if (!existsSync(file)) {
    const { privateKey } = generateKeyPairSync('ed25519');
    // wx: два процесса не перезапишут ключ друг друга (потеря ключа = потеря всех агентов)
    writeFileSync(file, privateKey.export({ type: 'pkcs8', format: 'pem' }), {
      mode: 0o600,
      flag: 'wx',
    });
  }
  chmodSync(file, 0o600);
  const priv: KeyObject = createPrivateKey(readFileSync(file));
  const der = createPublicKey(priv).export({ type: 'spki', format: 'der' });
  const pub = Buffer.from(der.subarray(der.length - 32));
  const k: PanelKey = { pub, b64: pub.toString('base64'), sign: (d) => sign(null, d, priv) };
  keys.set(dataDir, k);
  return k;
}

/** Хеш рукопожатия: его подписывает панель, к нему привязаны доказательства токена. */
export function transcript(ephA: Buffer, ephP: Buffer, key: Buffer): Buffer {
  return createHash('sha256')
    .update(HANDSHAKE_CONTEXT)
    .update(Buffer.from([0]))
    .update(ephA)
    .update(ephP)
    .update(key)
    .digest();
}

/** HMAC-SHA256(ключ - hex sha256 токена, метка || стенограмма) в base64. */
export function proof(tokenHash: string, label: 'agent' | 'panel', th: Buffer): string {
  return createHmac('sha256', tokenHash).update(label).update(th).digest('base64');
}

function nonce(seq: bigint): Buffer {
  const n = Buffer.alloc(12);
  n.writeBigUInt64BE(seq, 4);
  return n;
}

/** Шифрованный канал: свой ключ на направление, nonce - номер сообщения. */
export class Channel {
  private sendSeq = 0n;
  private recvSeq = 0n;
  constructor(
    private sendKey: Buffer,
    private recvKey: Buffer,
  ) {}

  seal(plain: Buffer): Buffer {
    const c = createCipheriv('aes-256-gcm', this.sendKey, nonce(this.sendSeq++));
    const body = Buffer.concat([c.update(plain), c.final()]);
    return Buffer.concat([body, c.getAuthTag()]);
  }

  open(frame: Buffer): Buffer {
    if (frame.length < 16) throw new Error('короткий кадр');
    const d = createDecipheriv('aes-256-gcm', this.recvKey, nonce(this.recvSeq));
    d.setAuthTag(frame.subarray(frame.length - 16));
    const plain = Buffer.concat([d.update(frame.subarray(0, frame.length - 16)), d.final()]);
    this.recvSeq++;
    return plain;
  }
}

/**
 * Ответ панели на hello2: X25519 панели, подпись, канал (сторона панели) и стенограмма.
 * ephA - X25519 агента (32 байта).
 */
export function serverHandshake(ephA: Buffer, key: PanelKey) {
  if (ephA.length !== 32) throw new Error('неверный ключ агента');
  const { publicKey, privateKey } = generateKeyPairSync('x25519');
  const spki = publicKey.export({ type: 'spki', format: 'der' });
  const ephP = Buffer.from(spki.subarray(spki.length - 32));
  const th = transcript(ephA, ephP, key.pub);
  const shared = diffieHellman({
    privateKey,
    publicKey: createPublicKey({
      key: Buffer.concat([X25519_SPKI, ephA]),
      format: 'der',
      type: 'spki',
    }),
  });
  const k = Buffer.from(
    hkdfSync('sha256', shared, Buffer.concat([ephA, ephP]), HANDSHAKE_CONTEXT, 64),
  );
  // агент шлёт ключом k[0:32], панель - k[32:64]
  const channel = new Channel(k.subarray(32), k.subarray(0, 32));
  const reply = {
    type: 'server-hello',
    eph: ephP.toString('base64'),
    key: key.b64,
    sig: key.sign(th).toString('base64'),
  };
  return { reply, channel, th };
}

/**
 * Сокет агента поверх канала v2 - для реестра выглядит как обычный websocket: 'message' с
 * расшифрованным текстом, send() шифрует. Открытый кадр или кадр, который не расшифровался, -
 * обрыв соединения (подмена, повтор, перестановка).
 */
export class SecureAgentSocket extends EventEmitter {
  constructor(
    private ws: WebSocket,
    private ch: Channel,
  ) {
    super();
    ws.on('message', (raw, isBinary) => {
      if (!isBinary) {
        ws.close(4002, 'plain message on secure channel');
        return;
      }
      let plain: Buffer;
      try {
        plain = this.ch.open(toBuffer(raw));
      } catch {
        ws.terminate();
        return;
      }
      this.emit('message', plain);
    });
    ws.on('close', (code, reason) => this.emit('close', code, reason));
    ws.on('error', (e) => this.emit('error', e));
    ws.on('pong', () => this.emit('pong'));
  }

  send(data: string, cb?: (err?: Error) => void) {
    this.ws.send(this.ch.seal(Buffer.from(data)), { binary: true }, cb);
  }
  close(code?: number, reason?: string) {
    this.ws.close(code, reason);
  }
  ping() {
    this.ws.ping();
  }
  terminate() {
    this.ws.terminate();
  }
}

export function toBuffer(raw: Buffer | ArrayBuffer | Buffer[]): Buffer {
  if (Buffer.isBuffer(raw)) return raw;
  if (Array.isArray(raw)) return Buffer.concat(raw);
  return Buffer.from(raw);
}
