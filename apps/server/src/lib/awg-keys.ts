import { generateKeyPairSync } from 'node:crypto';

/** Пара ключей клиента WireGuard/AmneziaWG (x25519) в base64, как у "awg genkey | awg pubkey". */
export function awgKeyPair(): { privateKey: string; publicKey: string } {
  const { publicKey, privateKey } = generateKeyPairSync('x25519');
  const b64 = (v: string | undefined) => Buffer.from(v ?? '', 'base64url').toString('base64');
  return {
    privateKey: b64(privateKey.export({ format: 'jwk' }).d),
    publicKey: b64(publicKey.export({ format: 'jwk' }).x),
  };
}
