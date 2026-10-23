import type {
  BackupComponent,
  BaselinePlan,
  CascadeCheck,
  PanelUpdateView,
  ServerDetail,
  ServerReach,
  ServiceUpdate,
  WatchList,
} from '@vps/protocol';
import { esc, tgWhen } from '../lib/telegram.js';
import { RESTART, UPDATE } from './notify-buttons.js';
import { type Btn, type Screen, reachView } from './views.js';

/** Ошибка API панели: статус и текст ответа. */
export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

/** Запросы бота к API панели (с пометкой "из Telegram" в журнале действий). */
export interface PanelApi {
  get<T>(url: string): Promise<T>;
  post<T>(url: string, body?: unknown): Promise<T>;
  put<T>(url: string, body?: unknown): Promise<T>;
}

/** Риск действия: безопасное - сразу, изменение - с подтверждением, опасное - ещё и с кодом 2FA. */
export type Risk = 'safe' | 'change' | 'danger';

export type RunResult = { actionId: string } | { text: string; kb?: Btn[][] } | { screen: Screen };

export interface ActionSpec {
  risk: Risk;
  /** кнопка подтверждения: "Перезагрузить" */
  verb: string;
  /** вопрос подтверждения: "Перезагрузить Hoster?" */
  question: string;
  /** что идёт, для хода действия: "перезапуск 3X-UI" */
  title: string;
  serverId: string | null;
  serverName: string | null;
  /** делать нечего: причина (уже работает, обновлений нет); кнопка уведомления снимается */
  stale?: string | undefined;
  run: () => Promise<RunResult>;
  /** кнопки под итогом (после обновления пакетов - перезагрузка, если нужна) */
  after?: (ok: boolean) => Promise<Btn[][]>;
}

export interface ActionDeps {
  api: PanelApi;
  /** значение короткой ссылки (null - устарела) */
  refValue: (key: string) => string | null;
  muteUntil: (serverId: string, until: Date) => void;
  now: () => number;
}

/** Операции действий: код кнопки - описание. */
export const ACTION_OPS = new Set([
  'rs',
  'rk',
  'mu',
  'ub',
  'pu',
  'rb',
  'up',
  'bf',
  'bp',
  'pv',
  'ck',
  'wo',
  'cl',
  'uc',
  'au',
  'dr',
  'ds',
  'dt',
  'fe',
  'fd',
  'bc',
]);

const enc = encodeURIComponent;

const DONE: Record<string, string> = {
  restart: ' перезапущен',
  stop: ' остановлен',
  start: ' запущен',
};

/** Размер: 1,2 ГБ, 340 МБ. */
export function size(bytes: number): string {
  if (bytes >= 1024 ** 3)
    return `${(Math.round((bytes / 1024 ** 3) * 10) / 10).toString().replace('.', ',')}\u00a0ГБ`;
  return `${Math.max(1, Math.round(bytes / 1024 ** 2))}\u00a0МБ`;
}

/**
 * Описание действия по кнопке. Состояние перечитывается сейчас: кнопка в старом уведомлении не
 * запускает то, что уже не нужно (stale). null - кнопка устарела (ссылка пропала).
 */
export async function actionSpec(
  op: string,
  args: string[],
  d: ActionDeps,
): Promise<ActionSpec | null> {
  const server = async (id: string) => d.api.get<ServerDetail>(`/api/servers/${enc(id)}`);
  const [a0 = '', a1 = ''] = args;
  switch (op) {
    case 'rs': {
      const s = await server(a0);
      const kind = Object.keys(RESTART).find((k) => RESTART[k]?.code === a1);
      if (!kind) return null;
      const title = RESTART[kind]?.title ?? kind;
      const svc = s.services.find((x) => x.kind === kind);
      return {
        risk: 'safe',
        verb: 'Перезапустить',
        question: `Перезапустить ${title} на ${esc(s.name)}?`,
        title: `перезапуск ${title}`,
        serverId: s.id,
        serverName: s.name,
        stale: !svc
          ? `${title} на сервере нет`
          : svc.details?.down !== true
            ? `${title} уже работает`
            : undefined,
        run: () =>
          kind === 'xui'
            ? d.api.post(`/api/servers/${enc(s.id)}/xui/service`, { action: 'restart' })
            : d.api.post(`/api/servers/${enc(s.id)}/mtproxyl/exec`, { op: 'restart' }),
      };
    }
    case 'rk': {
      const s = await server(a0);
      return {
        risk: 'safe',
        verb: 'Проверить',
        question: `Проверить доступность ${esc(s.name)} из России?`,
        title: 'проверка доступности',
        serverId: s.id,
        serverName: s.name,
        run: async () => {
          const r = await d.api.post<ServerReach>(`/api/servers/${enc(s.id)}/reach/check`);
          return { screen: reachView({ s, r }, { now: d.now(), panelUrl: '', ref: (v) => v }) };
        },
      };
    }
    case 'mu': {
      const s = await server(a0);
      return {
        risk: 'safe',
        verb: 'Не уведомлять',
        question: `Не уведомлять о ${esc(s.name)} час?`,
        title: 'уведомления',
        serverId: s.id,
        serverName: s.name,
        run: async () => {
          const until = new Date(d.now() + 3600_000);
          d.muteUntil(s.id, until);
          return {
            text: `Уведомления о <b>${esc(s.name)}</b> отключены до ${tgWhen(until.toISOString(), d.now())}`,
          };
        },
      };
    }
    case 'ub': {
      const raw = d.refValue(a0);
      if (!raw) return null;
      const { sid, jail, ip } = JSON.parse(raw) as { sid: string; jail: string; ip: string };
      const s = await server(sid);
      const still = s.audit?.jails.some((j) => j.name === jail && j.bannedIps.includes(ip));
      return {
        risk: 'safe',
        verb: 'Снять бан',
        question: `Снять бан с ${esc(ip)}?`,
        title: `снятие бана ${ip}`,
        serverId: s.id,
        serverName: s.name,
        stale: still ? undefined : `${ip} уже не в бане`,
        run: async () => {
          await d.api.post(`/api/servers/${enc(s.id)}/fail2ban/unban`, { jail, ip });
          return {
            text: `<b>${esc(s.name)}</b>: бан с <code>${esc(ip)}</code> снят (${esc(jail)})`,
          };
        },
      };
    }
    case 'pu': {
      const s = await server(a0);
      return {
        risk: 'danger',
        verb: 'Обновить',
        question: `Обновить пакеты на ${esc(s.name)}?\nСервисы могут ненадолго перезапуститься.`,
        title: 'обновление пакетов',
        serverId: s.id,
        serverName: s.name,
        stale: s.status !== 'online' ? 'Сервер не в сети' : undefined,
        run: () => d.api.post(`/api/servers/${enc(s.id)}/upgrade`),
        after: async (ok) => {
          if (!ok) return [];
          // снимок после действия приходит не сразу: признак перезагрузки - через несколько секунд
          await new Promise((r) => setTimeout(r, 8_000));
          const fresh = await server(s.id).catch(() => null);
          return fresh?.audit?.rebootRequired
            ? [[{ text: 'Перезагрузить', data: `rb:${s.id}` }]]
            : [];
        },
      };
    }
    case 'rb': {
      const s = await server(a0);
      return {
        risk: 'danger',
        verb: 'Перезагрузить',
        question: `Перезагрузить ${esc(s.name)}?\nVPN на сервере прервётся на минуту-две.`,
        title: 'перезагрузка',
        serverId: s.id,
        serverName: s.name,
        stale: s.status !== 'online' ? 'Сервер не в сети' : undefined,
        run: async () => {
          await d.api.post(`/api/servers/${enc(s.id)}/reboot`, { confirmName: s.name });
          return { text: `<b>${esc(s.name)}</b>: перезагрузка запущена` };
        },
      };
    }
    case 'up': {
      const s = await server(a0);
      const kind = Object.keys(UPDATE).find((k) => UPDATE[k]?.code === a1);
      if (!kind) return null;
      const title = UPDATE[kind]?.title ?? kind;
      const list = await d.api.get<ServiceUpdate[]>(`/api/servers/${enc(s.id)}/updates`);
      const u = list.find((x) => x.kind === kind);
      const base = `/api/servers/${enc(s.id)}`;
      return {
        risk: 'danger',
        verb: 'Обновить',
        question: `Обновить ${title}${u ? ` до ${esc(u.latest)}` : ''} на ${esc(s.name)}?\nКлиенты переподключатся.`,
        title: `обновление ${title}`,
        serverId: s.id,
        serverName: s.name,
        stale: u ? undefined : `${title}: новой версии нет`,
        run: () =>
          kind === 'xui'
            ? d.api.post(`${base}/xui/update`)
            : kind === 'xray'
              ? d.api.post(`${base}/xray/update`)
              : d.api.post(`${base}/mtproxyl/exec`, {
                  op: kind === 'mtproxyl' ? 'update' : 'panel.update',
                }),
      };
    }
    case 'bf': {
      const s = await server(a0);
      const plan = await d.api.post<BaselinePlan>(`/api/servers/${enc(s.id)}/baseline/plan`);
      const steps = plan.steps.filter((x) => x.needed).map((x) => x.id);
      return {
        risk: 'danger',
        verb: 'Исправить',
        question: `Исправить проблемы безопасности на ${esc(s.name)}?\n${plan.steps
          .filter((x) => x.needed)
          .map((x) => `- ${esc(x.title)}`)
          .join('\n')}`,
        title: 'исправление проблем',
        serverId: s.id,
        serverName: s.name,
        stale: !steps.length
          ? 'Исправлять нечего'
          : !plan.canApply
            ? `Исправить нельзя: ${plan.blockers.join('; ')}`
            : undefined,
        run: () => d.api.post(`/api/servers/${enc(s.id)}/baseline/apply`, { steps }),
      };
    }
    case 'bp':
      return {
        risk: 'safe',
        verb: 'Отправить',
        question: 'Отправить резервную копию панели?',
        title: 'резервная копия панели',
        serverId: null,
        serverName: null,
        run: async () => {
          const r = await d.api.post<{ ok: boolean; error?: string }>('/api/panel-backup/telegram');
          if (!r.ok) throw new ApiError(502, r.error ?? 'не отправлена');
          return { text: 'Резервная копия панели отправлена' };
        },
      };
    case 'pv': {
      const version = d.refValue(a0);
      if (!version) return null;
      const v = await d.api.get<PanelUpdateView>('/api/panel/update');
      return {
        risk: 'danger',
        verb: 'Обновить',
        question: `Обновить панель до ${esc(version)}?\nПанель перезапустится, бот ответит через минуту.`,
        title: `обновление панели до ${version}`,
        serverId: null,
        serverName: null,
        stale: !v.managed
          ? 'Панель установлена не из релиза: обновление только в консоли'
          : !v.newer.some((r) => r.version === version)
            ? `Версия ${version} уже не новее текущей`
            : undefined,
        run: async () => {
          await d.api.post('/api/panel/update', { version });
          return { text: `Обновление до ${esc(version)} запущено` };
        },
      };
    }
    case 'ck':
      return {
        risk: 'safe',
        verb: 'Проверить',
        question: 'Проверить каскад?',
        title: 'проверка каскада',
        serverId: null,
        serverName: null,
        run: async () => {
          const c = await d.api.post<CascadeCheck>(`/api/cascades/${enc(a0)}/check`);
          return {
            text: c.ok
              ? `Каскад отвечает, ${Math.round(c.ms)}\u00a0мс`
              : `Каскад не отвечает: ${esc(c.error ?? '')}`,
          };
        },
      };
    case 'wo': {
      const list = await d.api.get<WatchList>('/api/watch');
      const r = list.rules.find((x) => x.id === a0);
      return {
        risk: 'change',
        verb: 'Выключить',
        question: `Выключить уведомление о подключении ${esc(r?.clientName ?? '')}?`,
        title: 'правило уведомления',
        serverId: null,
        serverName: null,
        stale: !r ? 'Правило удалено' : !r.enabled ? 'Правило уже выключено' : undefined,
        run: async () => {
          if (!r) throw new ApiError(404, 'правило удалено');
          const { clientId, serverId, service, deviceId, event, delayMinutes } = r;
          await d.api.put(`/api/watch/${enc(r.id)}`, {
            clientId,
            serverId,
            service,
            deviceId,
            event,
            delayMinutes,
            enabled: false,
          });
          return { text: `Уведомление о подключении ${esc(r.clientName)} выключено` };
        },
      };
    }
    case 'cl': {
      const s = await server(a0);
      const scan = await d.api.get<{
        items: { id: string; title: string; bytes: number; safe: boolean }[];
      }>(`/api/servers/${enc(s.id)}/cleanup`);
      const items = (scan.items ?? []).filter((x) => x.safe);
      const total = items.reduce((a, x) => a + x.bytes, 0);
      return {
        risk: 'change',
        verb: 'Очистить',
        question: `Очистить диск ${esc(s.name)}? Освободится около ${size(total)}:\n${items
          .map((x) => `- ${esc(x.title)}: ${size(x.bytes)}`)
          .join('\n')}`,
        title: 'очистка диска',
        serverId: s.id,
        serverName: s.name,
        stale: items.length ? undefined : 'Чистить нечего',
        run: () => d.api.post(`/api/servers/${enc(s.id)}/cleanup`, { ids: items.map((x) => x.id) }),
      };
    }
    case 'uc': {
      const s = await server(a0);
      return {
        risk: 'safe',
        verb: 'Проверить',
        question: `Проверить новые версии сервисов на ${esc(s.name)}?`,
        title: 'проверка обновлений',
        serverId: s.id,
        serverName: s.name,
        run: async () => {
          const list = await d.api.post<ServiceUpdate[]>(`/api/servers/${enc(s.id)}/updates/check`);
          const text = list.length
            ? `<b>${esc(s.name)}</b>: доступны ${list.map((u) => `${esc(u.title)} ${esc(u.latest)}`).join(', ')}`
            : `<b>${esc(s.name)}</b>: новых версий сервисов нет`;
          return {
            text,
            kb: list.flatMap((u) => {
              const c = UPDATE[u.kind];
              return c ? [[{ text: `Обновить ${c.title}`, data: `up:${s.id}:${c.code}` }]] : [];
            }),
          };
        },
      };
    }
    case 'au': {
      const s = await server(a0);
      return {
        risk: 'change',
        verb: 'Обновить',
        question: `Обновить агент на ${esc(s.name)}? VPN не прерывается.`,
        title: 'обновление агента',
        serverId: s.id,
        serverName: s.name,
        stale: s.agentUpdating
          ? 'Агент уже обновляется'
          : !s.agentUpdateAvailable
            ? 'Агент последней версии'
            : undefined,
        run: () => d.api.post(`/api/servers/${enc(s.id)}/agent/update`),
      };
    }
    case 'dr':
    case 'ds':
    case 'dt': {
      const s = await server(a0);
      const c = s.inventory?.containers.find((x) => x.id === a1);
      if (!c) return null;
      const action = op === 'dr' ? 'restart' : op === 'ds' ? 'stop' : 'start';
      const verb = op === 'dr' ? 'Перезапустить' : op === 'ds' ? 'Остановить' : 'Запустить';
      const running = c.state === 'running';
      return {
        risk: op === 'ds' ? 'change' : 'safe',
        verb,
        question: `${verb} контейнер ${esc(c.name)} на ${esc(s.name)}?`,
        title: `${verb.toLowerCase()} ${c.name}`,
        serverId: s.id,
        serverName: s.name,
        stale:
          op === 'ds' && !running
            ? 'Контейнер уже остановлен'
            : op === 'dt' && running
              ? 'Контейнер уже запущен'
              : undefined,
        run: async () => {
          await d.api.post(`/api/servers/${enc(s.id)}/docker/${enc(c.id)}/${action}`);
          return { text: `<b>${esc(s.name)}</b>: ${esc(c.name)}${DONE[action]}` };
        },
      };
    }
    case 'fe':
    case 'fd': {
      const s = await server(a0);
      const on = s.firewall?.ufwActive === true;
      return {
        risk: op === 'fe' ? 'change' : 'danger',
        verb: op === 'fe' ? 'Включить' : 'Выключить',
        question:
          op === 'fe'
            ? `Включить firewall на ${esc(s.name)}? Открытыми останутся порты сервисов.`
            : `Выключить firewall на ${esc(s.name)}? Сервер останется без защиты портов.`,
        title: op === 'fe' ? 'включение firewall' : 'выключение firewall',
        serverId: s.id,
        serverName: s.name,
        stale:
          op === 'fe' && on
            ? 'Firewall уже включён'
            : op === 'fd' && !on
              ? 'Firewall уже выключен'
              : undefined,
        run: () =>
          op === 'fe'
            ? d.api.post(`/api/servers/${enc(s.id)}/firewall/enable`)
            : d.api.post(`/api/servers/${enc(s.id)}/firewall/disable`, { restartDocker: false }),
      };
    }
    case 'bc': {
      const s = await server(a0);
      return {
        risk: 'change',
        verb: 'Создать',
        question: `Создать резервную копию ${esc(s.name)}? Все найденные сервисы.`,
        title: 'резервная копия',
        serverId: s.id,
        serverName: s.name,
        stale: s.status !== 'online' ? 'Сервер не в сети' : undefined,
        run: async () => {
          const comps = await d.api.get<BackupComponent[]>(
            `/api/servers/${enc(s.id)}/backups/components`,
          );
          return d.api.post(`/api/servers/${enc(s.id)}/backups`, {
            components: comps.map((x) => x.id),
          });
        },
      };
    }
    default:
      return null;
  }
}
