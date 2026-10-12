import type { AddressInfo } from 'node:net';
import ssh2 from 'ssh2';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { HostKeyMismatch, sshRun } from '../src/lib/ssh.js';

const { Server, utils } = ssh2;

/** SSH-сервер на localhost: принимает пароль "pw", на exec отвечает "ok" и кодом 0. */
const hostKey = utils.generateKeyPairSync('ed25519').private;
const server = new Server({ hostKeys: [hostKey] }, (client) => {
  client
    .on('authentication', (ctx) => {
      if (ctx.method === 'password' && ctx.password === 'pw') ctx.accept();
      else ctx.reject(['password']);
    })
    .on('ready', () => {
      client.on('session', (accept) => {
        accept().on('exec', (acc) => {
          const s = acc();
          s.write('ok\n');
          s.exit(0);
          s.end();
        });
      });
    })
    .on('error', () => {});
});
let port = 0;

beforeAll(async () => {
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  port = (server.address() as AddressInfo).port;
});
afterAll(() => {
  server.close();
});

const target = (knownFingerprint: string) => ({
  host: '127.0.0.1',
  port,
  knownFingerprint,
  auth: { mode: 'password' as const, password: 'pw' },
});

describe('SSH: ключ хоста', () => {
  it('первое подключение - отпечаток запоминается, второе с ним - проходит', async () => {
    const first = await sshRun(target(''), 'true', () => {});
    expect(first.exitCode).toBe(0);
    expect(first.fingerprint).toMatch(/^SHA256:/);
    const again = await sshRun(target(first.fingerprint), 'true', () => {});
    expect(again.exitCode).toBe(0);
  });

  it('ключ сменился (переустановка ОС) - понятная ошибка, а не "Host denied"', async () => {
    const err = await sshRun(target('SHA256:old'), 'true', () => {}).catch((e) => e);
    expect(err).toBeInstanceOf(HostKeyMismatch);
    expect(String(err.message)).toContain('Сбросить отпечаток SSH');
    expect(String(err.message)).not.toContain('Host denied');
  });
});
