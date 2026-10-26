import type {
  BackupComponent,
  BaselinePlan,
  CascadeCheck,
  GClientDetail,
  PanelUpdateView,
  ServerDetail,
  ServerReach,
  ServiceUpdate,
  WatchList,
  XuiInboundRow,
} from '@vps/protocol';
import { esc, tgWhen } from '../lib/telegram.js';
import { RESTART, UPDATE } from './notify-buttons.js';
import { ApiError, type PanelApi } from './panel-api.js';
import { type Btn, I, type Screen, size } from './views/common.js';
import { eventAt } from './views/panel.js';
import { reachView } from './views/servers.js';

/**
 * Риск действия: безопасное - сразу; изменение и опасное - с подтверждением (опасное доступно
 * только на уровне "все действия"); удаление сервера из панели - ещё и с кодом 2FA.
 */
export type Risk = 'safe' | 'change' | 'danger' | 'code';

export type RunResult =
  | { actionId: string }
  /** итог в том же сообщении (вместо уведомления или экрана) */
  | { text: string; kb?: Btn[][] }
  | { screen: Screen }
  /**
   * короткий итог всплывающим сообщением; сообщение возвращается к прежнему виду (drop - без
   * нажатой кнопки) или к экрану reopen
   */
  | { toast: string; reopen?: { op: string; args: string[] }; drop?: boolean }
  /** открыть экран заново на месте нажатого сообщения (переключатели в списках) */
  | { reopen: { op: string; args: string[] } };

export interface ActionSpec {
  risk: Risk;
  /** кнопка подтверждения: "Перезагрузить" */
  verb: string;
  /** вопрос подтверждения: "Перезагрузить Hoster?" */
  question: string;
  /** что идёт, для хода действия: "перезапуск 3X-UI" */
  title: string;
  /** итог длинного действия при успехе (HTML): "3X-UI на Hoster обновлён до 2.8.3" */
  done?: string;
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
  /** завершить все сессии панели (маршрут API требует сессию, а у бота её нет) */
  logoutAll: () => Promise<number>;
  now: () => number;
}

/** Нажатие кнопки действия: операция, аргументы и доступ к панели. */
interface Call {
  op: string;
  args: string[];
  a0: string;
  a1: string;
  d: ActionDeps;
  server: (id: string) => Promise<ServerDetail>;
}

/** Описание действия по нажатию; null - кнопка устарела (ссылка пропала). */
type Make = (c: Call) => Promise<ActionSpec | null>;

const enc = encodeURIComponent;

const DONE: Record<string, string> = {
  restart: ' перезапущен',
  stop: ' остановлен',
  start: ' запущен',
};

const container: Make = async ({ op, a0, a1, d, server }) => {
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
      return { toast: `${c.name}${DONE[action]}`, reopen: { op: 'dc', args: [s.id, c.id] } };
    },
  };
};

const firewall: Make = async ({ op, a0, d, server }) => {
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
    done: `<b>${esc(s.name)}</b>: firewall ${op === 'fe' ? 'включён' : 'выключен'}`,
    run: () =>
      op === 'fe'
        ? d.api.post(`/api/servers/${enc(s.id)}/firewall/enable`)
        : d.api.post(`/api/servers/${enc(s.id)}/firewall/disable`, { restartDocker: false }),
  };
};

const syncClients: Make = async ({ op, d }) => {
  return {
    risk: 'safe',
    verb: op === 'sn' ? 'Синхронизировать' : 'Остановить',
    question: 'Синхронизация клиентов',
    title: 'синхронизация клиентов',
    serverId: null,
    serverName: null,
    run: async () => {
      await d.api.post(op === 'sn' ? '/api/gclients/sync' : '/api/gclients/sync/stop');
      return { reopen: { op: 'sy', args: [] } };
    },
  };
};

/** Действия по коду операции кнопки. */
const ACTIONS: Record<string, Make> = {
  rs: async ({ args, a0, a1, d, server }) => {
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
      // с экрана сервиса (f) - перезапуск и работающего
      stale: !svc
        ? `${title} на сервере нет`
        : svc.details?.down !== true && args[2] !== 'f'
          ? `${title} уже работает`
          : undefined,
      done: `<b>${esc(s.name)}</b>: ${title} перезапущен`,
      run: () =>
        kind === 'xui'
          ? d.api.post(`/api/servers/${enc(s.id)}/xui/service`, { action: 'restart' })
          : d.api.post(`/api/servers/${enc(s.id)}/mtproxyl/exec`, { op: 'restart' }),
    };
  },
  rk: async ({ a0, d, server }) => {
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
  },
  mu: async ({ a0, d, server }) => {
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
          toast: `Уведомления о ${s.name} отключены до ${tgWhen(until.toISOString(), d.now())}`,
          drop: true,
        };
      },
    };
  },
  ub: async ({ a0, d, server }) => {
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
        return { toast: `Бан с ${ip} снят`, reopen: { op: 'bn', args: [s.id] } };
      },
    };
  },
  pu: async ({ a0, d, server }) => {
    const s = await server(a0);
    return {
      risk: 'danger',
      verb: 'Обновить',
      question: `Обновить пакеты на ${esc(s.name)}?\nСервисы могут ненадолго перезапуститься.`,
      title: 'обновление пакетов',
      serverId: s.id,
      serverName: s.name,
      stale: s.status !== 'online' ? 'Сервер не в сети' : undefined,
      done: `<b>${esc(s.name)}</b>: пакеты обновлены`,
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
  },
  rb: async ({ a0, d, server }) => {
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
        return { text: `${I.run} <b>${esc(s.name)}</b>: перезагружается` };
      },
    };
  },
  up: async ({ a0, a1, d, server }) => {
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
      done: `<b>${esc(s.name)}</b>: ${title} обновлён${u ? ` до ${esc(u.latest)}` : ''}`,
      run: () =>
        kind === 'xui'
          ? d.api.post(`${base}/xui/update`)
          : kind === 'xray'
            ? d.api.post(`${base}/xray/update`)
            : d.api.post(`${base}/mtproxyl/exec`, {
                op: kind === 'mtproxyl' ? 'update' : 'panel.update',
              }),
    };
  },
  bf: async ({ a0, d, server }) => {
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
      done: `<b>${esc(s.name)}</b>: проблемы безопасности исправлены`,
      run: () => d.api.post(`/api/servers/${enc(s.id)}/baseline/apply`, { steps }),
    };
  },
  bp: async ({ d }) => {
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
        return { toast: 'Резервная копия панели отправлена', drop: true };
      },
    };
  },
  pv: async ({ a0, d }) => {
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
  },
  ck: async ({ a0, d }) => {
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
          toast: c.ok
            ? `Каскад отвечает, ${Math.round(c.ms)}\u00a0мс`
            : `Каскад не отвечает: ${c.error ?? ''}`,
        };
      },
    };
  },
  wo: async ({ a0, d }) => {
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
        return { toast: `Уведомление о подключении ${r.clientName} выключено`, drop: true };
      },
    };
  },
  cl: async ({ a0, d, server }) => {
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
      done: `<b>${esc(s.name)}</b>: диск очищен, освобождено около ${size(total)}`,
      run: () => d.api.post(`/api/servers/${enc(s.id)}/cleanup`, { ids: items.map((x) => x.id) }),
    };
  },
  uc: async ({ a0, d, server }) => {
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
  },
  au: async ({ a0, d, server }) => {
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
      done: `<b>${esc(s.name)}</b>: агент обновлён`,
      run: () => d.api.post(`/api/servers/${enc(s.id)}/agent/update`),
    };
  },
  dr: container,
  ds: container,
  dt: container,
  fe: firewall,
  fd: firewall,
  bc: async ({ a0, d, server }) => {
    const s = await server(a0);
    return {
      risk: 'change',
      verb: 'Создать',
      question: `Создать резервную копию ${esc(s.name)}? Все найденные сервисы.`,
      title: 'резервная копия',
      serverId: s.id,
      serverName: s.name,
      stale: s.status !== 'online' ? 'Сервер не в сети' : undefined,
      done: `<b>${esc(s.name)}</b>: резервная копия создана`,
      run: async () => {
        const comps = await d.api.get<BackupComponent[]>(
          `/api/servers/${enc(s.id)}/backups/components`,
        );
        return d.api.post(`/api/servers/${enc(s.id)}/backups`, {
          components: comps.map((x) => x.id),
        });
      },
    };
  },
  ge: async ({ a0, a1, d }) => {
    const g = await d.api.get<GClientDetail>(`/api/gclients/${enc(a0)}`);
    const on = a1 === '1';
    return {
      risk: 'change',
      verb: on ? 'Включить' : 'Выключить',
      question: on
        ? `Включить клиента ${esc(g.client.name)}? Доступ вернётся на всех его серверах.`
        : `Выключить клиента ${esc(g.client.name)}? VPN и прокси перестанут работать, ссылки останутся прежними.`,
      title: on ? 'включение клиента' : 'выключение клиента',
      serverId: null,
      serverName: g.client.name,
      stale:
        g.client.enabled === on ? (on ? 'Клиент уже включён' : 'Клиент уже выключен') : undefined,
      run: async () => {
        await d.api.patch(`/api/gclients/${enc(g.client.id)}`, { enabled: on });
        return {
          toast: `${g.client.name} ${on ? 'включён' : 'выключен'}`,
          reopen: { op: 'gc', args: [g.client.id] },
        };
      },
    };
  },
  gt: async ({ a0, d }) => {
    const g = await d.api.get<GClientDetail>(`/api/gclients/${enc(a0)}`);
    return {
      risk: 'change',
      verb: 'Выдать новую',
      question: `Новая ссылка подписки и личной страницы для ${esc(g.client.name)}?\nСтарые перестанут работать сразу: клиенту нужно будет добавить новую подписку.`,
      title: 'новая ссылка',
      serverId: null,
      serverName: g.client.name,
      run: async () => {
        await d.api.post(`/api/gclients/${enc(g.client.id)}/rotate-token`);
        return {
          toast: 'Новая ссылка выдана, старые не работают',
          reopen: { op: 'gc', args: [g.client.id] },
        };
      },
    };
  },
  wt: async ({ a0, a1, d }) => {
    const list = await d.api.get<WatchList>('/api/watch');
    const r = list.rules.find((x) => x.id === a0);
    const on = a1 === '1';
    return {
      risk: 'safe',
      verb: on ? 'Включить' : 'Выключить',
      question: 'Правило уведомления',
      title: 'правило уведомления',
      serverId: null,
      serverName: r?.clientName ?? null,
      stale: !r ? 'Правило удалено' : r.enabled === on ? 'Уже так' : undefined,
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
          enabled: on,
        });
        return { reopen: { op: 'gw', args: [clientId] } };
      },
    };
  },
  wn: async ({ a0, d }) => {
    const g = await d.api.get<GClientDetail>(`/api/gclients/${enc(a0)}`);
    return {
      risk: 'safe',
      verb: 'Создать',
      question: 'Уведомление о подключении',
      title: 'уведомление о подключении',
      serverId: null,
      serverName: g.client.name,
      run: async () => {
        await d.api.post('/api/watch', {
          clientId: g.client.id,
          serverId: null,
          service: null,
          deviceId: null,
          event: 'both',
          delayMinutes: 10,
          enabled: true,
        });
        return { reopen: { op: 'gw', args: [g.client.id] } };
      },
    };
  },
  rx: async ({ a0, d, server }) => {
    const s = await server(a0);
    return {
      risk: 'safe',
      verb: 'Перезапустить',
      question: `Перезапустить Xray на ${esc(s.name)}?`,
      title: 'перезапуск Xray',
      serverId: s.id,
      serverName: s.name,
      done: `<b>${esc(s.name)}</b>: Xray перезапущен`,
      run: () => d.api.post(`/api/servers/${enc(s.id)}/xui/service`, { action: 'restart-xray' }),
    };
  },
  ib: async ({ args, a0, a1, d, server }) => {
    const s = await server(a0);
    const list = await d.api.get<XuiInboundRow[]>(`/api/servers/${enc(s.id)}/xui/inbound-list`);
    const ib = list.find((x) => String(x.id) === a1);
    const on = args[2] === '1';
    const name = ib?.remark || String(ib?.port ?? a1);
    return {
      risk: 'change',
      verb: on ? 'Включить' : 'Выключить',
      question: on
        ? `Включить inbound ${esc(name)} на ${esc(s.name)}?`
        : `Выключить inbound ${esc(name)} на ${esc(s.name)}? Клиенты этого inbound потеряют связь.`,
      title: on ? `включение ${name}` : `выключение ${name}`,
      serverId: s.id,
      serverName: s.name,
      stale: !ib ? 'Inbound не найден' : ib.enable === on ? 'Уже так' : undefined,
      run: async () => {
        await d.api.post(`/api/servers/${enc(s.id)}/xui/inbounds/${enc(a1)}`, { enable: on });
        return {
          toast: `${name} ${on ? 'включён' : 'выключен'}`,
          reopen: { op: 'xu', args: [s.id] },
        };
      },
    };
  },
  ae: async ({ a0, a1, d, server }) => {
    const raw = d.refValue(a0);
    if (!raw) return null;
    const r = JSON.parse(raw) as { sid: string; ct: string; pk: string; n: string };
    const s = await server(r.sid);
    const on = a1 === '1';
    return {
      risk: 'change',
      verb: on ? 'Включить' : 'Выключить',
      question: `${on ? 'Включить' : 'Выключить'} пользователя AWG ${esc(r.n || r.pk.slice(0, 8))} на ${esc(s.name)}?`,
      title: on ? 'включение пользователя AWG' : 'выключение пользователя AWG',
      serverId: s.id,
      serverName: s.name,
      run: async () => {
        await d.api.post(`/api/servers/${enc(s.id)}/awg/exec`, {
          op: on ? 'client.enable' : 'client.disable',
          container: r.ct,
          publicKey: r.pk,
        });
        return {
          toast: `${r.n || r.pk.slice(0, 8)} ${on ? 'включён' : 'выключен'}`,
          reopen: { op: 'aw', args: [s.id] },
        };
      },
    };
  },
  ix: async ({ a0, d, server }) => {
    const raw = d.refValue(a0);
    if (!raw) return null;
    const r = JSON.parse(raw) as { sid: string; ip: string };
    const s = await server(r.sid);
    return {
      risk: 'danger',
      verb: 'Сменить IP',
      question: `Сменить адрес ${esc(s.name)} на ${esc(r.ip)}?\nПанель переключит сервер, маршрут до Telegram и проверки на новый адрес.`,
      title: 'смена IP',
      serverId: s.id,
      serverName: s.name,
      stale: s.host === r.ip ? 'Адрес уже сменён' : undefined,
      run: async () => {
        await d.api.post(`/api/servers/${enc(s.id)}/ip-change`, { ip: r.ip });
        return {
          text: `<b>${esc(s.name)}</b>: адрес сменён на <code>${esc(r.ip)}</code>, синхронизация клиентов запущена`,
          kb: [[{ text: 'Сервер', data: `sv:${s.id}` }]],
        };
      },
    };
  },
  vc: async ({ d }) => {
    return {
      risk: 'safe',
      verb: 'Проверить',
      question: 'Проверить новые версии панели?',
      title: 'проверка версии',
      serverId: null,
      serverName: null,
      run: async () => {
        await d.api.post('/api/panel/update/check');
        return { reopen: { op: 'vs', args: [] } };
      },
    };
  },
  vh: async ({ a0, d }) => {
    const ch = a0 === 'beta' ? 'beta' : 'stable';
    return {
      risk: 'change',
      verb: 'Сменить',
      question:
        ch === 'beta'
          ? 'Канал обновлений: предварительный? Панель будет получать предварительные версии.'
          : 'Канал обновлений: стабильный? Предварительные версии больше не придут.',
      title: 'канал обновлений',
      serverId: null,
      serverName: null,
      run: async () => {
        await d.api.put('/api/panel/update/settings', { channel: ch });
        return {
          toast: `Канал обновлений: ${ch === 'beta' ? 'предварительный' : 'стабильный'}`,
          reopen: { op: 'vs', args: [] },
        };
      },
    };
  },
  va: async ({ a0, d }) => {
    const on = a0 === '1';
    return {
      risk: 'change',
      verb: on ? 'Включить' : 'Выключить',
      question: on
        ? 'Включить автоматическое обновление панели?'
        : 'Выключить автоматическое обновление панели?',
      title: 'автоматическое обновление',
      serverId: null,
      serverName: null,
      run: async () => {
        await d.api.put('/api/panel/update/settings', { autoUpdate: on });
        return {
          toast: `Автоматическое обновление панели ${on ? 'включено' : 'выключено'}`,
          reopen: { op: 'vs', args: [] },
        };
      },
    };
  },
  nt: async ({ a0, a1, d }) => {
    const key = eventAt(Number(a0));
    if (!key) return null;
    return {
      risk: 'safe',
      verb: 'Сменить',
      question: 'Уведомление',
      title: 'уведомления',
      serverId: null,
      serverName: null,
      run: async () => {
        await d.api.put('/api/notify/telegram', { events: { [key]: a1 === '1' } });
        return { reopen: { op: 'ns', args: [] } };
      },
    };
  },
  nx: async ({ d }) => {
    return {
      risk: 'safe',
      verb: 'Отправить',
      question: 'Отправить тестовое сообщение?',
      title: 'тестовое сообщение',
      serverId: null,
      serverName: null,
      run: async () => {
        await d.api.post('/api/notify/telegram/test');
        return { toast: 'Тестовое сообщение отправлено в чат уведомлений' };
      },
    };
  },
  sn: syncClients,
  so: syncClients,
  sx: async ({ d }) => {
    return {
      risk: 'danger',
      verb: 'Завершить',
      question: 'Завершить все сессии панели? Во всех браузерах понадобится войти заново.',
      title: 'завершение сессий',
      serverId: null,
      serverName: null,
      run: async () => {
        const n = await d.logoutAll();
        return { toast: `Сессии панели завершены: ${n}`, reopen: { op: 'ss', args: [] } };
      },
    };
  },
  rm: async ({ a0, d, server }) => {
    const s = await server(a0);
    return {
      risk: 'code',
      verb: 'Удалить',
      question: `Удалить ${esc(s.name)} из панели?\nЖурнал и ручные правила firewall удалятся из панели. На самом сервере ничего не изменится, клиенты на нём перестанут синхронизироваться.`,
      title: 'удаление из панели',
      serverId: s.id,
      serverName: s.name,
      run: async () => {
        await d.api.delete(`/api/servers/${enc(s.id)}`);
        return { text: `Сервер <b>${esc(s.name)}</b> удалён из панели` };
      },
    };
  },
};

/** Операции кнопок, которые запускают действия (остальные - экраны и служебные). */
export const ACTION_OPS: ReadonlySet<string> = new Set(Object.keys(ACTIONS));

/**
 * Описание действия по кнопке. Состояние перечитывается сейчас: кнопка в старом уведомлении не
 * запускает то, что уже не нужно (stale). null - кнопка устарела (ссылка пропала).
 */
export async function actionSpec(
  op: string,
  args: string[],
  d: ActionDeps,
): Promise<ActionSpec | null> {
  const make = Object.hasOwn(ACTIONS, op) ? ACTIONS[op] : undefined;
  if (!make) return null;
  const [a0 = '', a1 = ''] = args;
  return make({
    op,
    args,
    a0,
    a1,
    d,
    server: (id) => d.api.get<ServerDetail>(`/api/servers/${enc(id)}`),
  });
}
