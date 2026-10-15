import { randomBytes } from 'node:crypto';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { eq } from 'drizzle-orm';
import type { AgentRegistry } from '../agents/registry.js';
import type { Env } from '../config.js';
import type { Db } from '../db/index.js';
import { backups } from '../db/schema.js';

/** Ссылка скачивания архива для агента живёт столько и срабатывает один раз. */
const LINK_TTL_MS = 30 * 60_000;

/**
 * Восстановление резервной копии сервера на любой сервер: одноразовая ссылка для агента и
 * backup.restore со стримом. Общее для маршрута "Восстановить" и настройки сервера.
 */
export class BackupRestorer {
  /** used - ссылку уже скачали: агент скачивает архив один раз. */
  private links = new Map<string, { backupId: string; expires: number; used?: boolean }>();

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
