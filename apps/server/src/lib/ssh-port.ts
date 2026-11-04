import { type SshPortChange, SshPortChangeSchema, type SshPortPrepared } from '@vps/protocol';
import { eq } from 'drizzle-orm';
import type { AgentRegistry } from '../agents/registry.js';
import type { Env } from '../config.js';
import type { Db } from '../db/index.js';
import { portsyncConfigs, servers } from '../db/schema.js';
import { loadPanelKey, sshRun } from './ssh.js';

/** Вызывать внутри блокировки действия сервера; старый вход сохраняется до проверки нового. */
export async function changeSshPort(
  deps: { db: Db; env: Env; registry: AgentRegistry },
  id: string,
  input: SshPortChange,
  out: (text: string) => void,
) {
  const { db, registry, env } = deps;
  const body = SshPortChangeSchema.parse(input);
  const row = db.select().from(servers).where(eq(servers.id, id)).get();
  if (!row) throw new Error('сервер не найден');
  let prepared: SshPortPrepared | undefined;
  let verified = false;
  try {
    out(`Подготовка SSH-порта ${body.port}; прежние порты пока сохраняются.\n`);
    prepared = await registry.request<SshPortPrepared>(
      id,
      'ssh.port.prepare',
      { port: body.port },
      { timeoutMs: 120_000 },
    );
    if (
      prepared.port !== body.port ||
      !prepared.fingerprints?.length ||
      !/^[0-9a-f]{32}$/.test(prepared.token)
    )
      throw new Error('неверный ответ подготовки SSH');
    out('Проверка отдельного SSH-входа с ключом панели через новый порт...\n');
    const check = await sshRun(
      {
        host: row.host,
        port: prepared.port,
        knownFingerprint: row.hostKeyFingerprint,
        fingerprints: prepared.fingerprints,
        auth: { mode: 'key', privateKey: loadPanelKey(env.DATA_DIR).privateKey },
      },
      'true',
      () => {},
      30_000,
    );
    if (check.exitCode !== 0) throw new Error('новый SSH-вход не прошёл проверку');
    await registry.request(id, 'ssh.port.commit', { token: prepared.token }, { timeoutMs: 30_000 });
    verified = true;
    const port = prepared.port;
    db.transaction(() => {
      db.update(servers)
        .set({ sshPort: port, hostKeyFingerprint: check.fingerprint })
        .where(eq(servers.id, id))
        .run();
      const saved = db.select().from(portsyncConfigs).where(eq(portsyncConfigs.serverId, id)).get();
      if (saved)
        db.update(portsyncConfigs)
          .set({ config: { ...saved.config, ssh_port: port } })
          .where(eq(portsyncConfigs.serverId, id))
          .run();
    });
    await registry.request(
      id,
      'ssh.port.finish',
      { token: prepared.token },
      { timeoutMs: 120_000 },
    );
    out(`SSH-порт ${prepared.port} проверен и сохранён.\n`);
  } catch (error) {
    if (prepared && !verified) {
      await registry
        .request(id, 'ssh.port.rollback', { token: prepared.token }, { timeoutMs: 120_000 })
        .catch(() => {
          out('Откат не подтверждён: на сервере действует независимый таймер на 5 минут.\n');
        });
    }
    if (verified)
      out(
        'Новый вход проверен. Завершение не подтверждено. Повторите смену на тот же порт, чтобы завершить переход.\n',
      );
    throw error;
  }
}
