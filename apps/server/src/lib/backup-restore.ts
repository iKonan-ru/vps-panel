import { randomBytes } from 'node:crypto';
import { existsSync, statSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { eq } from 'drizzle-orm';
import type { AgentRegistry } from '../agents/registry.js';
import type { Env } from '../config.js';
import type { Db } from '../db/index.js';
import { backups, servers } from '../db/schema.js';
import { backupSnapshot } from './backup-setup.js';
import { newId } from './ids.js';

/** Ссылка скачивания архива для агента живёт столько и срабатывает один раз. */
const LINK_TTL_MS = 30 * 60_000;

/** Загрузка архива агентом: одноразовый токен; busy - загрузка началась, sha256 - принято. */
interface BackupUpload {
  backupId: string;
  serverId: string;
  expires: number;
  busy?: boolean;
  sha256?: string;
}

/**
 * Восстановление резервной копии сервера на любой сервер: одноразовая ссылка для агента и
 * backup.restore со стримом. Общее для маршрута "Восстановить" и настройки сервера.
 */
export class BackupRestorer {
  /** used - ссылку уже скачали: агент скачивает архив один раз. */
  private links = new Map<string, { backupId: string; expires: number; used?: boolean }>();
  /** Токены загрузки архивов агентами (создание копии). */
  private uploads = new Map<string, BackupUpload>();

  constructor(
    private db: Db,
    private env: Env,
    private registry: AgentRegistry,
  ) {}

  /** Архив копии в DATA_DIR/backups. */
  file(id: string) {
    return join(this.env.DATA_DIR, 'backups', `${id}.tar.gz`);
  }

  private sweep() {
    const now = Date.now();
    for (const [k, v] of this.links) if (v.expires < now) this.links.delete(k);
    for (const [k, v] of this.uploads) if (v.expires < now) this.uploads.delete(k);
  }

  /** Загрузка по токену агента (маршрут приёма архива); недействительна - undefined. */
  upload(token: string): BackupUpload | undefined {
    this.sweep();
    return this.uploads.get(token);
  }

  /**
   * Создать копию: агент архивирует сервисы и загружает архив в панель по одноразовому токену,
   * в manifest.json - состав сервисов (по нему настройка ставит те же сервисы на другой
   * сервер). Итог - id копии; ошибка - исключение, оборванный архив не остаётся.
   */
  async create(
    serverId: string,
    components: string[],
    onStream: (channel: string, chunk: string) => void,
    /** id копии заранее: маршрут отдаёт его сразу, а архив ещё создаётся. */
    backupId: string = newId(),
  ): Promise<string> {
    if (!this.registry.isOnline(serverId))
      throw Object.assign(new Error('сервер не в сети'), { statusCode: 409 });
    const row = this.db
      .select({ name: servers.name })
      .from(servers)
      .where(eq(servers.id, serverId))
      .get();
    if (!row) throw Object.assign(new Error('сервер не найден'), { statusCode: 404 });
    this.sweep();
    const token = randomBytes(24).toString('base64url');
    // что стоит на сервере: агент кладёт это в manifest.json архива - скачанный файл
    // разворачивается на чистый сервер и без панели, в которой его делали
    const setup = await backupSnapshot(this.db, this.registry, serverId).catch(() => null);
    this.uploads.set(token, { backupId, serverId, expires: Date.now() + LINK_TTL_MS });
    const f = this.file(backupId);
    try {
      const man = await this.registry.request<{
        sha256: string;
        archiveSize: number;
        hostname: string;
        components: unknown[];
      }>(
        serverId,
        'backup.create',
        {
          components,
          uploadUrl: `${this.env.PANEL_PUBLIC_URL}/api/agent/backups/upload/${token}`,
          token,
          ...(setup ? { setup } : {}),
        },
        { timeoutMs: 20 * 60_000, onStream },
      );
      const got = this.uploads.get(token)?.sha256;
      if (!got || !existsSync(f)) throw new Error('архив не дошёл до панели');
      if (got !== man.sha256)
        throw new Error('архив пришёл повреждённым: контрольная сумма не совпала');
      this.db
        .insert(backups)
        .values({
          id: backupId,
          serverId,
          serverName: row.name,
          hostname: man.hostname,
          size: statSync(f).size,
          sha256: man.sha256,
          // что стояло на сервере: по нему настройка поставит те же сервисы на чистый сервер
          manifest: { components: man.components, ...(setup ? { setup } : {}) },
        })
        .run();
      return backupId;
    } catch (e) {
      if (existsSync(f)) unlinkSync(f);
      throw e;
    } finally {
      this.uploads.delete(token);
    }
  }

  /** Файл по ссылке агента; ссылка гаснет. Недействительна - null. */
  take(token: string): string | null {
    this.sweep();
    const d = this.links.get(token);
    if (!d || d.used || !existsSync(this.file(d.backupId))) return null;
    d.used = true;
    return this.file(d.backupId);
  }

  /** Копия с её manifest и именем сервера; нет копии или архива - null. */
  get(bid: string) {
    const row = this.db.select().from(backups).where(eq(backups.id, bid)).get();
    return row && existsSync(this.file(bid)) ? row : null;
  }

  /**
   * Агент скачивает архив и раскладывает компоненты (пусто - все). Сервисы на сервере уже
   * должны стоять: это делает настройка сервера или команды каталога. Ошибка - исключение.
   */
  async restore(
    serverId: string,
    bid: string,
    components: string[],
    onStream: (channel: string, chunk: string) => void,
  ): Promise<void> {
    const row = this.get(bid);
    if (!row) throw Object.assign(new Error('резервная копия не найдена'), { statusCode: 404 });
    if (!this.registry.isOnline(serverId))
      throw Object.assign(new Error('сервер не в сети'), { statusCode: 409 });
    this.sweep();
    const token = randomBytes(24).toString('base64url');
    this.links.set(token, { backupId: bid, expires: Date.now() + LINK_TTL_MS });
    try {
      await this.registry.request(
        serverId,
        'backup.restore',
        {
          downloadUrl: `${this.env.PANEL_PUBLIC_URL}/api/agent/backups/download/${token}`,
          sha256: row.sha256,
          components,
        },
        { timeoutMs: 20 * 60_000, onStream },
      );
    } finally {
      this.links.delete(token);
    }
  }
}
