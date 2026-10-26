import { type GClientDetail, deviceOf } from '@vps/protocol';
import QRCode from 'qrcode';
import { getJsonSetting, putSetting } from '../lib/settings.js';
import { esc } from '../lib/telegram.js';
import type { Core } from './core.js';
import { type Answer, type ChatId, type TgMessage, sentId } from './transport.js';
import { linksView } from './views/clients.js';

/** Ссылки и конфиги клиентов удаляются из чата через 10 минут. */
const SECRET_TTL_MS = 10 * 60_000;
/** Очередь удаления - в настройках: переживает перезапуск панели. */
const DELETE_KEY = 'tg_bot_delete';

/** Сообщение со ссылками клиента: когда удалить. */
interface Pending {
  chat: string;
  id: number;
  at: number;
}

/**
 * Ссылки, QR подписки и конфиги AWG клиента: отдельными сообщениями ответом на экран клиента,
 * через 10 минут удаляются из чата.
 */
export class Secrets {
  private timer: NodeJS.Timeout | null = null;

  constructor(private core: Core) {}

  /** gk - ссылки, gq - QR подписки, ga - .conf AWG по привязке устройства. */
  async handle(msg: TgMessage, op: string, args: string[], answer: Answer) {
    const { api, tg, deps } = this.core;
    const g = await api
      .get<GClientDetail>(`/api/gclients/${encodeURIComponent(args[0] ?? '')}`)
      .catch(() => null);
    if (!g) return answer('Клиент не найден', true);
    const chat = msg.chat.id;
    const failed = (err: string) =>
      tg.reply(chat, { text: `\u274c ${esc(err)}`, kb: [] }, msg.message_id);
    if (op === 'gk') {
      await answer();
      const id = sentId(await tg.reply(chat, linksView(g), msg.message_id));
      if (id) this.forgetLater(chat, id);
      return;
    }
    if (op === 'gq') {
      await answer();
      const png = await QRCode.toBuffer(g.subscription.url, { margin: 2, width: 720 });
      const r = await deps.telegram.sendFile(
        'photo',
        'subscription.png',
        png,
        `<b>${esc(g.client.name)}</b>: QR подписки (удалится через 10 мин)`,
        String(chat),
      );
      if (r.messageId) this.forgetLater(chat, r.messageId);
      else if (r.err) await failed(r.err);
      return;
    }
    // ga: тот же файл, что на личной странице клиента
    const b = g.bindings.find((x) => x.id === args[1] && x.service === 'awg');
    if (!b) return answer('Привязка не найдена', true);
    const res = await deps.inject({
      method: 'GET',
      url: `/c/${encodeURIComponent(g.client.token)}/awg/${encodeURIComponent(b.id)}/conf`,
    });
    if (res.statusCode !== 200) return answer('Конфиг недоступен: у привязки нет ключа', true);
    await answer();
    const dev = g.devices.find((x) => x.id === b.deviceId);
    const name =
      /filename="([^"]+)"/.exec(String(res.headers['content-disposition'] ?? ''))?.[1] ??
      'awg.conf';
    const who = dev ? `, ${esc(dev.name || deviceOf(dev.type)?.title || '')}` : '';
    const r = await deps.telegram.sendFile(
      'document',
      name,
      Buffer.from(res.body, 'utf8'),
      `<b>${esc(g.client.name)}</b>${who}: AWG ${esc(b.serverName)} (удалится через 10 мин)`,
      String(chat),
    );
    if (r.messageId) this.forgetLater(chat, r.messageId);
    else if (r.err) await failed(r.err);
  }

  /** Удалить сообщение через 10 минут. */
  private forgetLater(chat: ChatId, id: number) {
    const { db } = this.core.deps;
    const list = getJsonSetting<Pending[]>(db, DELETE_KEY, []);
    list.push({ chat: String(chat), id, at: Date.now() + SECRET_TTL_MS });
    putSetting(db, DELETE_KEY, JSON.stringify(list.slice(-200)));
    this.schedule();
  }

  /** Таймер на ближайшее удаление из очереди. */
  schedule() {
    if (this.timer) clearTimeout(this.timer);
    const list = getJsonSetting<Pending[]>(this.core.deps.db, DELETE_KEY, []);
    if (!list.length) return;
    const next = Math.min(...list.map((x) => x.at));
    this.timer = setTimeout(() => void this.run(), Math.max(1_000, next - Date.now()));
    this.timer.unref?.();
  }

  stop() {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }

  private async run() {
    const { db } = this.core.deps;
    const now = Date.now();
    const list = getJsonSetting<Pending[]>(db, DELETE_KEY, []);
    putSetting(db, DELETE_KEY, JSON.stringify(list.filter((x) => x.at > now)));
    for (const x of list.filter((v) => v.at <= now)) await this.core.tg.remove(x.chat, x.id);
    this.schedule();
  }
}
