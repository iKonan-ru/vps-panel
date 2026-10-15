import type {
  SetupCheck,
  SetupPlan,
  SetupProgress,
  SetupRunRequest,
  SetupStep,
  SetupStepState,
} from '@vps/protocol';
import { eq } from 'drizzle-orm';
import type { AgentRegistry } from '../agents/registry.js';
import type { StatusCache } from '../agents/state.js';
import { findCommand, validateAnswers } from '../commands/index.js';
import type { Env } from '../config.js';
import type { Db } from '../db/index.js';
import { gclientBindings, servers } from '../db/schema.js';
import { type actionJournal, liveOutput } from './action-journal.js';
import type { CatalogRunner } from './catalog-runner.js';
import { checkClientHost } from './client-host.js';
import { type GClients, queued } from './gclients.js';
import { redactOutput } from './redact.js';
import type { SecretBox } from './secret-box.js';
import { getJsonSetting, putSetting } from './settings.js';
import { loadPanelKey } from './ssh.js';
import type { UiHub } from './ui-hub.js';
import { ownVlessInbounds, xuiApi } from './xui-api.js';
import { type NewItem, addInbounds, bestRealityTarget, inboundList } from './xui-inbound-ops.js';
import {
  KIND_REMARK,
  XHTTP_PORT,
  freeRemark,
  portBusy,
  randomFreePort,
} from './xui-new-inbound.js';
import { xuiToken } from './xui-token.js';

/** Сервисы каталога по порядку установки: команда и вид сервиса в отчёте агента. */
const SERVICES: { command: string; kind: string; title: string }[] = [
  { command: 'xui', kind: 'xui', title: '3X-UI' },
  { command: 'mtproxyl', kind: 'mtproxyl', title: 'MTProxyL' },
  { command: 'awg', kind: 'amnezia', title: 'AmneziaWG' },
  { command: 'wdtt', kind: 'wdtt', title: 'WDTT' },
  { command: 'openflux', kind: 'openflux', title: 'OpenFlux' },
  { command: 'naive', kind: 'naive', title: 'Прокси для браузера' },
];

const progressKey = (id: string) => `setup.progress.${id}`;
const err = (message: string, statusCode: number) =>
  Object.assign(new Error(message), { statusCode });
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export interface SetupDeps {
  db: Db;
  env: Env;
  registry: AgentRegistry;
  box: SecretBox;
  hub: UiHub;
  journal: ReturnType<typeof actionJournal>;
  runner: CatalogRunner;
  gc: Pick<GClients, 'kick'>;
  reach: { check: (serverId: string) => Promise<unknown> };
  /** Новый RAW может стать запасным выходом в Telegram. */
  syncSpares?: () => void;
  /** Паузы ожидания (тесты - короче). */
  timing?: { rebootDownMs: number; rebootUpMs: number; pollMs: number; xrayChecks?: number[] };
}

/**
 * Настройка сервера в один клик: план по умолчанию (всё, чего на сервере нет), проверки перед
 * запуском и запуск одним действием server.setup, которое держит сервер. Шаги зовут агента
 * сами и пишут в вывод этого действия; ход - в настройках (setup.progress.<сервер>): упавший
 * шаг можно продолжить, сделанное не повторяется.
 */
export function serverSetup(deps: SetupDeps) {
  const { db, env, registry, box, hub, journal, runner, gc, reach } = deps;
  const timing = deps.timing ?? { rebootDownMs: 120_000, rebootUpMs: 600_000, pollMs: 3_000 };

  const row = (id: string) => {
    const r = db.select().from(servers).where(eq(servers.id, id)).get();
    if (!r) throw err('сервер не найден', 404);
    return r;
  };
  const inventory = (id: string) => (row(id).statusCache as StatusCache | null)?.inventory;
  const has = (id: string, kind: string) =>
    inventory(id)?.services.some((s) => s.kind === kind) ?? false;

  /** Ответы команды для экрана: пароли пустые - их вводят (решение владельца). */
  async function screenAnswers(id: string, cmd: string, extra: Record<string, string> = {}) {
    const c = findCommand(cmd);
    const all = { ...(await runner.defaults(id, cmd)), ...extra };
    for (const p of c?.params ?? []) if (p.type === 'password' || p.secret) all[p.name] = '';
    return all;
  }

  function progress(id: string): SetupProgress | null {
    const p = getJsonSetting<SetupProgress | null>(db, progressKey(id), null);
    if (!p) return null;
    // запуск, прерванный перезапуском панели: идущий шаг - упал
    if (!p.finishedAt && liveOutput(p.actionId) === null)
      return {
        ...p,
        finishedAt: p.finishedAt ?? new Date().toISOString(),
        steps: p.steps.map((s) =>
          s.state === 'running'
            ? { ...s, state: 'failed', note: 'прервано перезапуском панели' }
            : s,
        ),
      };
    return p;
  }

  async function plan(id: string): Promise<SetupPlan> {
    const r = row(id);
    const steps: SetupStep[] = [
      { id: 'key', kind: 'key', title: 'Ключ панели в root', enabled: true },
      {
        id: 'baseline',
        kind: 'baseline',
        title: 'Исправление проблем безопасности',
        enabled: true,
      },
      { id: 'upgrade', kind: 'upgrade', title: 'Обновление пакетов', enabled: true },
      {
        id: 'client-host',
        kind: 'client-host',
        title: 'Адрес для клиентов',
        enabled: true,
        answers: { NAME: r.clientHost ?? '' },
      },
    ];
    for (const s of SERVICES) {
      const installed = has(id, s.kind);
      steps.push({
        id: s.command,
        kind: 'service',
        title: s.title,
        command: s.command,
        enabled: !installed,
        ...(installed ? { note: 'уже установлен' } : {}),
        answers: await screenAnswers(id, s.command),
      });
    }
    steps.push({
      id: 'awg-extra',
      kind: 'service',
      title: 'AmneziaWG 2.0: дополнительный контейнер',
      command: 'awg',
      enabled: false,
      // порт и подсеть подбираются при запуске, когда основной контейнер уже стоит
      answers: { AWG_VERSION: '2.0' },
    });
    const xuiThere = has(id, 'xui');
    steps.push({
      id: 'inbounds',
      kind: 'inbounds',
      title: 'Соединения VLESS: RAW и XHTTP',
      enabled: true,
      answers: {
        RAW: '1',
        XHTTP: '1',
        RAW_PORT: String(randomFreePort((p) => p === XHTTP_PORT)),
        XHTTP_PORT: String(XHTTP_PORT),
      },
      ...(xuiThere ? { note: 'если своих inbound VLESS ещё нет' } : {}),
    });
    steps.push(
      { id: 'gclients', kind: 'gclients', title: 'Синхронизация клиентов', enabled: true },
      { id: 'reboot', kind: 'reboot', title: 'Перезагрузка, если нужна', enabled: true },
      { id: 'reach', kind: 'reach', title: 'Проверка доступности из России', enabled: true },
    );
    return { steps, progress: progress(id) };
  }

  /** Шаги запуска: план, поверх - выбор и ответы из запроса (неизвестные id не берутся). */
  async function resolve(id: string, req: SetupRunRequest): Promise<SetupStep[]> {
    const base = (await plan(id)).steps;
    return base.map((s) => {
      const q = req.steps.find((x) => x.id === s.id);
      if (!q) return { ...s, enabled: false };
      return { ...s, enabled: q.enabled, answers: { ...(s.answers ?? {}), ...(q.answers ?? {}) } };
    });
  }

  /** Ошибки полей и пересечения портов - до запуска, без сервера. */
  function localChecks(steps: SetupStep[]): SetupCheck[] {
    const out: SetupCheck[] = [];
    const ports = new Map<string, string>();
    const port = (step: SetupStep, label: string, v: string | undefined) => {
      if (!v) return;
      const other = ports.get(v);
      if (other) out.push({ step: step.id, level: 'fail', text: `порт ${v}: ${label} и ${other}` });
      else ports.set(v, `${step.title}, ${label}`);
    };
    for (const s of steps.filter((x) => x.enabled)) {
      if (s.kind === 'service' && s.command) {
        const c = findCommand(s.command);
        if (!c) continue;
        if (s.id !== 'awg-extra')
          for (const e of validateAnswers(c, s.answers ?? {}))
            out.push({ step: s.id, level: 'fail', text: e });
        for (const p of c.params)
          if (p.type === 'port') port(s, p.label, s.answers?.[p.name]?.trim());
      }
      if (s.kind === 'inbounds') {
        if (s.answers?.RAW) port(s, 'RAW', s.answers.RAW_PORT);
        if (s.answers?.XHTTP) port(s, 'XHTTP', s.answers.XHTTP_PORT);
      }
    }
    return out;
  }

  /** Проверки перед запуском: поля, порты, проверки команд каталога на сервере. */
  async function preflight(id: string, req: SetupRunRequest) {
    if (!registry.isOnline(id)) throw err('сервер не в сети', 409);
    const steps = await resolve(id, req);
    const checks = localChecks(steps);
    for (const s of steps.filter((x) => x.enabled && x.kind === 'service' && x.command)) {
      if (s.id === 'awg-extra') continue;
      try {
        const r = await runner.preflight(id, s.command as string, s.answers ?? {});
        for (const ch of r.checks)
          if (ch.level !== 'ok' && !checks.some((x) => x.step === s.id && x.text === ch.text))
            checks.push({ step: s.id, ...ch });
      } catch (e) {
        checks.push({ step: s.id, level: 'fail', text: (e as Error).message });
      }
    }
    const name = steps.find((s) => s.id === 'client-host' && s.enabled)?.answers?.NAME?.trim();
    if (name) {
      const c = await checkClientHost(name.toLowerCase(), row(id).host);
      if (!c.ok)
        checks.push({ step: 'client-host', level: 'fail', text: c.error ?? 'имя не подходит' });
    }
    return { checks, canRun: !checks.some((c) => c.level === 'fail') };
  }

  async function waitOnline(id: string, up: boolean, ms: number) {
    const until = Date.now() + ms;
    while (Date.now() < until) {
      if (registry.isOnline(id) === up) return true;
      await sleep(timing.pollMs);
    }
    return registry.isOnline(id) === up;
  }

  /** Запуск: id действия сразу, шаги - в фоне. */
  async function run(id: string, req: SetupRunRequest): Promise<{ actionId: string }> {
    if (!registry.isOnline(id)) throw err('сервер не в сети', 409);
    const prev = progress(id);
    if (req.from && !prev?.steps.some((s) => s.id === req.from))
      throw err('нечего продолжать: шага нет в прошлом запуске', 400);
    // продолжение - те же шаги, что в прошлом запуске (план мог измениться: сервис уже стоит)
    const keep = req.from ? new Set(prev?.steps.map((s) => s.id)) : null;
    const steps = (await resolve(id, req)).filter((s) => (keep ? keep.has(s.id) : s.enabled));
    if (!steps.length) throw err('не выбрано ни одного шага', 400);
    const bad = localChecks(steps).filter((c) => c.level === 'fail');
    if (bad.length)
      throw err(
        bad
          .map((c) => `${steps.find((s) => s.id === c.step)?.title ?? c.step}: ${c.text}`)
          .join('; '),
        400,
      );
    // продолжение: шаги, сделанные прошлым запуском до from, не повторяются
    const done = new Set<string>();
    if (req.from && prev)
      for (const s of prev.steps) {
        if (s.id === req.from) break;
        if (s.state === 'done' || s.state === 'skipped') done.add(s.id);
      }
    const action = journal.open(id, 'server.setup', { steps: steps.map((s) => s.id) });
    const say = (line: string) => action.stream('log', `${line}\n`);
    const state: SetupProgress = {
      actionId: action.id,
      startedAt: new Date().toISOString(),
      finishedAt: null,
      steps: steps.map((s) => ({
        id: s.id,
        title: s.title,
        state: done.has(s.id) ? ('done' as SetupStepState) : 'pending',
        ...(done.has(s.id) ? { note: 'сделано прошлым запуском' } : {}),
      })),
    };
    const save = () => {
      putSetting(db, progressKey(id), JSON.stringify(state));
      hub.broadcast({ type: 'server.changed', serverId: id });
    };
    save();
    const secrets: string[] = [];
    void (async () => {
      let exit = 0;
      for (const [i, s] of steps.entries()) {
        const st = state.steps[i];
        if (!st || st.state === 'done') continue;
        st.state = 'running';
        save();
        say(`\n== ${s.title}`);
        try {
          const note = await exec(id, s, { action, say, secrets });
          st.state = note === null ? 'skipped' : 'done';
          if (note) st.note = note;
          if (note) say(note);
        } catch (e) {
          st.state = 'failed';
          st.note = (e as Error).message;
          say(`ОШИБКА: ${st.note}`);
          exit = 1;
          save();
          break;
        }
        save();
      }
      state.finishedAt = new Date().toISOString();
      save();
      await action.finish(exit, redactOutput(action.output, secrets));
      // синхронизация - после окончания: пока шло действие, сервер был занят
      if (state.steps.some((s) => s.id === 'gclients' && s.state === 'done')) gc.kick();
    })();
    return { actionId: action.id };
  }

  type Ctx = {
    action: ReturnType<SetupDeps['journal']['open']>;
    say: (line: string) => void;
    secrets: string[];
  };

  /** Один шаг; итог для журнала, null - шаг пропущен (делать было нечего). */
  async function exec(id: string, s: SetupStep, ctx: Ctx): Promise<string | null> {
    const { action, say } = ctx;
    const a = s.answers ?? {};
    switch (s.kind) {
      case 'key': {
        const key = loadPanelKey(env.DATA_DIR).publicKey;
        await registry.request(id, 'ssh.keys.add', { keys: [key] }, { timeoutMs: 30_000 });
        return 'ключ панели добавлен в authorized_keys root';
      }
      case 'baseline':
        await registry.request(
          id,
          'baseline.apply',
          { steps: [] },
          { timeoutMs: 20 * 60_000, onStream: action.stream },
        );
        await registry.refreshInventory(id);
        return 'готово';
      case 'upgrade':
        await registry.request(
          id,
          'system.upgrade',
          {},
          { timeoutMs: 40 * 60_000, onStream: action.stream },
        );
        return 'готово';
      case 'client-host': {
        const name = (a.NAME ?? '').trim().toLowerCase();
        if (!name) return null;
        const r = row(id);
        if (r.clientHost === name) return `${name} - уже задано`;
        const c = await checkClientHost(name, r.host);
        if (!c.ok) throw new Error(c.error ?? 'имя не указывает на сервер');
        db.update(servers).set({ clientHost: name }).where(eq(servers.id, id)).run();
        return `${name}: клиенты получат это имя вместо IP`;
      }
      case 'service': {
        const cmd = s.command as string;
        const svc = SERVICES.find((x) => x.command === cmd);
        if (s.id !== 'awg-extra' && svc && has(id, svc.kind)) return null;
        // дополнительный AWG: порт и подсеть - свободные сейчас, когда основной уже стоит
        const answers =
          s.id === 'awg-extra'
            ? {
                ...(await runner.defaults(id, 'awg')),
                AWG_VERSION: a.AWG_VERSION || '2.0',
                ...(a.AWG_SERVER_PORT ? { AWG_SERVER_PORT: a.AWG_SERVER_PORT } : {}),
                AWG_INSTANCE: 'extra',
              }
            : a;
        const p = await runner.prepare(id, cmd, answers);
        const from = action.output.length;
        const r = await runner.execute(id, p, {
          runId: action.id,
          stream: action.stream,
          output: () => action.output.slice(from),
        });
        ctx.secrets.push(...r.secrets);
        if (r.exitCode !== 0) throw new Error(`команда завершилась с кодом ${r.exitCode}`);
        // следующим шагам нужен свежий отчёт: что стоит, какие порты заняты
        await registry.refreshInventory(id);
        return 'установлен';
      }
      case 'inbounds': {
        if (!has(id, 'xui')) return null;
        const api = xuiApi(registry, id, await xuiToken(db, box, registry, id));
        const list = await inboundList(api);
        if (ownVlessInbounds(list).length) return null;
        const listeners = () => inventory(id)?.firewall.listeners ?? [];
        const items: NewItem[] = [];
        const taken = list.map((i) => String(i.remark ?? ''));
        const busy = (p: number) => portBusy(p, list, listeners()) !== null;
        if (a.XHTTP) {
          const port = Number(a.XHTTP_PORT) || XHTTP_PORT;
          items.push({ kind: 'xhttp', port, remark: freeRemark(KIND_REMARK.xhttp, taken) });
        }
        if (a.RAW) {
          const want = Number(a.RAW_PORT);
          const port =
            want && !busy(want)
              ? want
              : randomFreePort((p) => busy(p) || items.some((x) => x.port === p));
          items.unshift({ kind: 'raw', port, remark: freeRemark(KIND_REMARK.raw, taken) });
        }
        if (!items.length) return null;
        say('Подбор цели Reality с сервера');
        const target = await bestRealityTarget(api);
        if (!target) throw new Error('скан 3X-UI не нашёл подходящей цели Reality');
        say(`Цель Reality: ${target.target}`);
        const created = await addInbounds(api, {
          items,
          target: target.target,
          serverNames: target.serverNames,
          fingerprint: 'firefox',
          listeners,
          say,
          ...(timing.xrayChecks ? { checks: timing.xrayChecks } : {}),
        });
        deps.syncSpares?.();
        return `добавлены: ${created.join('; ')}`;
      }
      case 'gclients':
        db.update(servers).set({ gclients: true }).where(eq(servers.id, id)).run();
        db.update(gclientBindings).set(queued()).where(eq(gclientBindings.serverId, id)).run();
        return 'начнётся сразу после настройки';
      case 'reboot': {
        await registry.refreshInventory(id);
        if (!inventory(id)?.audit.rebootRequired) return null;
        say('Перезагрузка сервера');
        await registry.request(id, 'system.reboot', {}, { timeoutMs: 15_000 }).catch(() => {});
        if (!(await waitOnline(id, false, timing.rebootDownMs)))
          throw new Error('сервер не ушёл на перезагрузку');
        if (!(await waitOnline(id, true, timing.rebootUpMs)))
          throw new Error('агент не вернулся после перезагрузки за 10 минут');
        await registry.refreshInventory(id);
        return 'сервер перезагружен, агент в сети';
      }
      case 'reach':
        void reach.check(id).catch(() => undefined);
        return 'запущена, итог - в блоке \u00abДоступность из России\u00bb';
      case 'restore':
        return null;
    }
  }

  return { plan, preflight, run, progress };
}

export type ServerSetup = ReturnType<typeof serverSetup>;
