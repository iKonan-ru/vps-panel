import { DEVICES, type GClientDetail, type ServerDetail, deviceOf } from '@vps/protocol';
import { esc } from '../lib/telegram.js';
import { type Core, refusal } from './core.js';
import type { Answer, TgMessage } from './transport.js';
import { askDeviceName, askName, askType, created } from './views/clients.js';
import { STALE_TEXT } from './views/menu.js';
import { type IpStep, askIp, ipCheckView } from './views/services.js';

/** Мастер забывается через 15 минут. */
const FLOW_TTL_MS = 15 * 60_000;

/** Мастер: новый клиент, устройство или смена IP; mid - сообщение, которое правится по шагам. */
interface Flow {
  kind: 'client' | 'device' | 'ip';
  step: 'name' | 'type' | 'device' | 'ip' | 'check';
  serverId?: string;
  chat: number;
  mid: number;
  clientId?: string;
  name?: string;
  type?: string;
  expires: number;
}

const enc = encodeURIComponent;

/**
 * Мастера: ответы - сообщениями и кнопками, вопросы и итог - в одном сообщении на месте экрана,
 * с которого начали ("Отмена" возвращает экран).
 */
export class Flows {
  private flow: Flow | null = null;

  constructor(private core: Core) {}

  /** Идёт мастер, который ждёт ответа сообщением. */
  active(): boolean {
    if (this.flow && Date.now() > this.flow.expires) this.flow = null;
    return this.flow !== null;
  }

  busyIn(mid: number): boolean {
    return this.flow?.mid === mid;
  }

  /** Бросить мастер (/cancel): сообщение, где он был. */
  drop(): { chat: number; mid: number } | null {
    const f = this.flow;
    this.flow = null;
    return f;
  }

  private start(msg: TgMessage, f: Omit<Flow, 'chat' | 'mid' | 'expires'>) {
    this.flow = {
      ...f,
      chat: msg.chat.id,
      mid: msg.message_id,
      expires: Date.now() + FLOW_TTL_MS,
    };
  }

  private client(id: string) {
    return this.core.api.get<GClientDetail>(`/api/gclients/${enc(id)}`).catch(() => null);
  }

  private server(id: string) {
    return this.core.api.get<ServerDetail>(`/api/servers/${enc(id)}`).catch(() => null);
  }

  /** Кнопки мастеров клиента и устройства: nc, nd - начать; fy - тип, fs - без имени, fx - отмена. */
  async onButton(msg: TgMessage, op: string, args: string[], answer: Answer) {
    const { tg, msgs } = this.core;
    const chat = msg.chat.id;
    if (op === 'nc' || op === 'nd') {
      const no = refusal(this.core.level(), 'change');
      if (no) return answer(no, true);
      await answer();
      msgs.stash(msg);
      if (op === 'nc') {
        await tg.show(chat, msg.message_id, askName());
        this.start(msg, { kind: 'client', step: 'name' });
        return;
      }
      const g = await this.client(args[0] ?? '');
      if (!g) return;
      await tg.show(chat, msg.message_id, askType('Новое устройство', g.client.name));
      this.start(msg, { kind: 'device', step: 'type', clientId: g.client.id, name: g.client.name });
      return;
    }
    const f = this.flow;
    if (!f || f.mid !== msg.message_id || Date.now() > f.expires) {
      this.flow = null;
      await answer(STALE_TEXT, true);
      return;
    }
    await answer();
    if (op === 'fx') {
      this.flow = null;
      await msgs.cancelIn(chat, f.mid);
      return;
    }
    if (op === 'fy' && f.step === 'type') {
      const type = args[0] ?? '-';
      if (type === '-') {
        // клиент без устройств: VLESS, MTProxy и WDTT у него всё равно будут
        if (f.kind === 'client') return this.finish(f, null);
        this.flow = null;
        await tg.editText(chat, f.mid, 'Отменено');
        return;
      }
      if (!DEVICES.some((d) => d.id === type)) return;
      f.type = type;
      f.step = 'device';
      const title = f.kind === 'client' ? 'Новый клиент' : 'Новое устройство';
      await tg.show(chat, f.mid, askDeviceName(title, deviceOf(type)?.title ?? type));
      return;
    }
    if (op === 'fs' && f.step === 'device') return this.finish(f, '');
  }

  /** Ответ мастеру сообщением: имя клиента, имя устройства, новый IP. */
  async onText(m: TgMessage, text: string) {
    const f = this.flow;
    if (!f) return;
    await this.core.tg.remove(m.chat.id, m.message_id);
    if (f.kind === 'ip' && f.serverId) return this.ipCheck(f, text.trim());
    if (f.step === 'name' && f.kind === 'client') {
      f.name = text.slice(0, 64);
      f.step = 'type';
      await this.core.tg.show(f.chat, f.mid, askType('Новый клиент', f.name));
      return;
    }
    if (f.step === 'device') return this.finish(f, text.slice(0, 64));
  }

  private async finish(f: Flow, deviceName: string | null) {
    const { api, tg, msgs } = this.core;
    this.flow = null;
    msgs.dropOrigin(f.chat, f.mid);
    const device =
      f.type && deviceName !== null ? { name: deviceName, type: f.type, awg20: false } : null;
    try {
      if (f.kind === 'client') {
        const r = await api.post<{ id: string }>('/api/gclients', {
          name: f.name ?? '',
          devices: device ? [device] : [],
          access: null,
        });
        await tg.show(f.chat, f.mid, created(f.name ?? '', r.id));
        return;
      }
      if (!device || !f.clientId) return;
      await api.post(`/api/gclients/${enc(f.clientId)}/devices`, device);
      const v = await this.core.screen('gd', [f.clientId]);
      if (v) await tg.show(f.chat, f.mid, v);
    } catch (e) {
      await tg.editText(f.chat, f.mid, `\u274c ${esc((e as Error).message)}`);
    }
  }

  // ---- смена IP: адрес сообщением, проверка, переключение (опасное, с подтверждением) ----

  /** ic - спросить адрес; iy - проверить адрес из короткой ссылки ещё раз. */
  async onIpButton(msg: TgMessage, op: string, args: string[], answer: Answer) {
    const no = refusal(this.core.level(), 'danger');
    if (no) return answer(no, true);
    if (op === 'ic') {
      const s = await this.server(args[0] ?? '');
      if (!s) return answer('Сервер не найден', true);
      await answer();
      this.core.msgs.stash(msg);
      await this.core.tg.show(msg.chat.id, msg.message_id, askIp(s));
      this.start(msg, { kind: 'ip', step: 'ip', serverId: s.id });
      return;
    }
    const r = this.core.refs.json<{ sid: string; ip: string }>(args[0] ?? '');
    if (!r) return answer(STALE_TEXT, true);
    await answer();
    const f: Flow = {
      kind: 'ip',
      step: 'check',
      serverId: r.sid,
      chat: msg.chat.id,
      mid: msg.message_id,
      expires: Date.now() + FLOW_TTL_MS,
    };
    await this.ipCheck(f, r.ip);
  }

  private async ipCheck(f: Flow, ip: string) {
    const sid = f.serverId ?? '';
    const s = await this.server(sid);
    if (!s) return;
    this.flow = { ...f, step: 'check', expires: Date.now() + FLOW_TTL_MS };
    try {
      const r = await this.core.api.post<{ steps: IpStep[]; canSwitch: boolean }>(
        `/api/servers/${enc(sid)}/ip-change/check`,
        { ip },
      );
      const ref = this.core.refs.put(JSON.stringify({ sid, ip }));
      await this.core.tg.show(f.chat, f.mid, ipCheckView(s, ip, r.steps, r.canSwitch, ref));
    } catch (e) {
      const v = askIp(s);
      await this.core.tg.editText(
        f.chat,
        f.mid,
        `${v.text}\n\n\u274c ${esc((e as Error).message)}`,
        v,
      );
      this.flow = { ...f, step: 'ip' };
    }
  }
}
