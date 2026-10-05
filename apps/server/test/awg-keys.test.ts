import { createPrivateKey, createPublicKey, diffieHellman } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { awgKeyPair } from '../src/lib/awg-keys.js';

const b64url = (b64: string) => Buffer.from(b64, 'base64').toString('base64url');
const priv = (k: { privateKey: string; publicKey: string }) =>
  createPrivateKey({
    key: { kty: 'OKP', crv: 'X25519', d: b64url(k.privateKey), x: b64url(k.publicKey) },
    format: 'jwk',
  });
const pub = (publicKey: string) =>
  createPublicKey({ key: { kty: 'OKP', crv: 'X25519', x: b64url(publicKey) }, format: 'jwk' });

describe('awgKeyPair', () => {
  it('ключи - 32 байта в base64, как у awg genkey', () => {
    const k = awgKeyPair();
    for (const v of [k.privateKey, k.publicKey]) {
      expect(v).toMatch(/^[A-Za-z0-9+/]{43}=$/);
      expect(Buffer.from(v, 'base64')).toHaveLength(32);
    }
  });
  it('публичный ключ соответствует приватному (общий секрет совпадает)', () => {
    const a = awgKeyPair();
    const b = awgKeyPair();
    const ab = diffieHellman({ privateKey: priv(a), publicKey: pub(b.publicKey) });
    const ba = diffieHellman({ privateKey: priv(b), publicKey: pub(a.publicKey) });
    expect(ab.equals(ba)).toBe(true);
  });
});
