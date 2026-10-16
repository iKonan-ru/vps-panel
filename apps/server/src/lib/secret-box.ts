import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';

/**
 * Шифрование значений в базе (пароли панелей): AES-256-GCM, ключ из SESSION_SECRET.
 * Формат: "v1:" + base64(iv | tag | шифртекст). Значения без префикса считаются открытыми.
 */
export class SecretBox {
  private key: Buffer;

  constructor(secret: string) {
    this.key = createHash('sha256').update(`vps-panel-access:${secret}`).digest();
  }

  seal(plain: string): string {
    const iv = randomBytes(12);
    const c = createCipheriv('aes-256-gcm', this.key, iv);
    const enc = Buffer.concat([c.update(plain, 'utf8'), c.final()]);
    return `v1:${Buffer.concat([iv, c.getAuthTag(), enc]).toString('base64')}`;
  }

  open(value: string): string {
    if (!value.startsWith('v1:')) return value;
    const raw = Buffer.from(value.slice(3), 'base64');
    const d = createDecipheriv('aes-256-gcm', this.key, raw.subarray(0, 12));
    d.setAuthTag(raw.subarray(12, 28));
    return Buffer.concat([d.update(raw.subarray(28)), d.final()]).toString('utf8');
  }
}
