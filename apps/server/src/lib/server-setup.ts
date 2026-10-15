import { randomBytes } from 'node:crypto';
import type {
  SetupCheck,
  SetupPlan,
  SetupProgress,
  SetupRunRequest,
  SetupStep,
  SetupStepState,
} from '@vps/protocol';
import { and, eq, inArray } from 'drizzle-orm';
import type { AgentRegistry } from '../agents/registry.js';
import type { StatusCache } from '../agents/state.js';
import { findCommand, validateAnswers } from '../commands/index.js';
import type { Env } from '../config.js';
import type { Db } from '../db/index.js';
import { access, gclientBindings, servers } from '../db/schema.js';
import { upsertAccess } from './access.js';
import { type actionJournal, liveOutput } from './action-journal.js';
import type { BackupRestorer } from './backup-restore.js';
import { AWG_MAIN, type BackupSetup } from './backup-setup.js';
import type { CatalogRunner } from './catalog-runner.js';
import { checkClientHost } from './client-host.js';
import { type GClients, queued } from './gclients.js';
import { MT_HOST_SCRIPT } from './mtproxyl-host.js';
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
import { saveXuiToken, xuiToken } from './xui-token.js';

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
  restorer: BackupRestorer;
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
  const { db, env, registry, box, hub, journal, runner, restorer, gc, reach } = deps;
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

  /** Копия для восстановления и снимок набора старого сервера. */
  function backupSource(bid: string) {
    const bk = restorer.get(bid);
    if (!bk) throw err('резервная копия не найдена', 404);
    const m = bk.manifest as Record<string, unknown>;
    const snap = m.setup as BackupSetup | undefined;
    if (!snap || !Array.isArray(snap.services))
      throw err('в копии нет состава сервисов: она сделана до версии 1.6, нужна новая копия', 400);
    // что лежит в архиве: без компонента - сервис ставится, но данных для него нет
    const comps = new Set(
      ((Array.isArray(m.components) ? m.components : []) as { id?: string }[]).map((c) => c.id),
    );
    return { bk, snap, comps };
  }

  async function plan(id: string, backupId?: string): Promise<SetupPlan> {
    if (backupId) return backupPlan(id, backupId);
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

  /**
   * План восстановления на чистый сервер: сервисы - как на старом сервере, с его портами;
   * контейнеры AWG из копии - обязательно; затем раскладка данных архива. Пароли сервисов,
   * чьи данные в архиве, не спрашиваются: их заменит копия.
   */
  async function backupPlan(id: string, bid: string): Promise<SetupPlan> {
    const { bk, snap, comps } = backupSource(bid);
    const base = (await plan(id)).steps;
    const steps: SetupStep[] = [];
    for (const s of base) {
      if (s.id === 'client-host') {
        const name = snap.clientHost ?? s.answers?.NAME ?? '';
        steps.push({
          ...s,
          answers: { NAME: name },
          ...(snap.clientHost
            ? { note: 'имя старого сервера: его A-запись нужно перевести на новый IP' }
            : {}),
        });
        continue;
      }
      if (s.kind === 'service' && s.id === 'awg') {
        const main = snap.awg.find((a) => a.container === AWG_MAIN);
        const inSnap = snap.services.includes('amnezia');
        steps.push({
          ...s,
          enabled: inSnap && s.enabled,
          ...(main ? { locked: true, note: 'контейнер из копии, с её портом и подсетью' } : {}),
          answers: {
            ...(s.answers ?? {}),
            ...(snap.answers.awg ?? {}),
            AWG_INSTANCE: 'main',
            ...(main?.version ? { AWG_VERSION: main.version } : {}),
            ...(main?.port ? { AWG_SERVER_PORT: String(main.port) } : {}),
            ...(main?.subnet ? { AWG_SUBNET_IP: main.subnet } : {}),
          },
        });
        continue;
      }
      if (s.id === 'awg-extra') {
        const extras = snap.awg.filter((a) => a.container !== AWG_MAIN);
        for (const x of extras)
          steps.push({
            ...s,
            id: `awg-extra:${x.port}`,
            title: `AmneziaWG ${x.version || ''}: дополнительный контейнер`.replace('  ', ' '),
            enabled: true,
            locked: true,
            note: 'контейнер из копии',
            answers: {
              AWG_VERSION: x.version || '2.0',
              AWG_SERVER_PORT: String(x.port),
              ...(x.subnet ? { AWG_SUBNET_IP: x.subnet } : {}),
            },
          });
        if (!extras.length) steps.push(s);
        continue;
      }
      if (s.kind === 'service' && s.command) {
        const kind = SERVICES.find((x) => x.command === s.command)?.kind ?? '';
        const inSnap = snap.services.includes(kind);
        steps.push({
          ...s,
          enabled: inSnap && s.enabled,
          ...(comps.has(s.command) ? { fromBackup: true } : {}),
          answers: { ...(s.answers ?? {}), ...(snap.answers[s.command] ?? {}) },
        });
        continue;
      }
      if (s.id === 'inbounds')
        steps.push({
          id: 'restore',
          kind: 'restore',
          title: 'Данные из резервной копии',
          enabled: true,
          locked: true,
          note: 'ключи, пользователи и inbound-ы старого сервера',
          answers: { BACKUP: bid },
        });
      steps.push(s);
    }
    return {
      steps,
      progress: progress(id),
      backup: { id: bk.id, serverName: bk.serverName, createdAt: bk.createdAt },
    };
  }

  /** Шаги запуска: план, поверх - выбор и ответы из запроса (неизвестные id не берутся). */
  async function resolve(id: string, req: SetupRunRequest): Promise<SetupStep[]> {
    const base = (await plan(id, req.backupId)).steps;
    return base.map((s) => {
      const q = req.steps.find((x) => x.id === s.id);
      // шаг из копии, который нельзя выключить, идёт и без явного выбора
      if (!q) return { ...s, enabled: Boolean(s.locked) };
      return {
        ...s,
        enabled: s.locked ? true : q.enabled,
        answers: { ...(s.answers ?? {}), ...(q.answers ?? {}) },
      };
    });
  }

  /**
   * Ответы шага; у сервиса из копии пустые пароли - случайные: установщику пароль нужен, но
   * после раскладки архива действует пароль старого сервера.
   */
  function withPasswords(s: SetupStep): Record<string, string> {
    const a = { ...(s.answers ?? {}) };
    if (!s.fromBackup || !s.command) return a;
    for (const p of findCommand(s.command)?.params ?? [])
      if (p.type === 'password' && p.required && !a[p.name])
        a[p.name] = randomBytes(12).toString('hex');
    return a;
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
        if (!s.id.startsWith('awg-extra'))
          for (const e of validateAnswers(c, withPasswords(s)))
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
      if (s.id.startsWith('awg-extra')) continue;
      try {
        const r = await runner.preflight(id, s.command as string, withPasswords(s));
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
  async function run(id: string, request: SetupRunRequest): Promise<{ actionId: string }> {
    if (!registry.isOnline(id)) throw err('сервер не в сети', 409);
    let req = request;
    const prev = progress(id);
    // продолжение восстановления - с той же копией
    if (req.from && prev?.backupId) req = { ...req, backupId: prev.backupId };
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
    const action = journal.open(id, 'server.setup', {
      steps: steps.map((s) => s.id),
      ...(req.backupId ? { backupId: req.backupId } : {}),
    });
    const say = (line: string) => action.stream('log', `${line}\n`);
    const state: SetupProgress = {
      actionId: action.id,
      ...(req.backupId ? { backupId: req.backupId } : {}),
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

  /**
   * Раскладка архива на поставленные сервисы, затем то, что после неё стало другим: токен API
   * 3X-UI (база заменена - прежний токен в ней не действует), "Доступы" к панелям старого
   * сервера (логины и пароли теперь его), адрес в ссылках MTProxyL - этого сервера.
   */
  async function restoreStep(id: string, bid: string, ctx: Ctx): Promise<string> {
    const { bk, comps } = backupSource(bid);
    ctx.say(`Копия ${bk.serverName} от ${bk.createdAt.slice(0, 16).replace('T', ' ')}`);
    await restorer.restore(id, bid, [], ctx.action.stream);
    await registry.refreshInventory(id);
    const notes: string[] = ['данные разложены'];
    if (comps.has('xui') && has(id, 'xui')) {
      const r = await registry.request<{ token: string }>(
        id,
        'xui.token',
        {},
        { timeoutMs: 60_000 },
      );
      await saveXuiToken(db, box, id, r.token);
      ctx.secrets.push(r.token);
      notes.push('токен API 3X-UI выпущен заново');
    }
    if (bk.serverId && bk.serverId !== id) {
      const kinds = ['xui', 'mtproxyl', 'wdtt'].filter((k) => comps.has(k));
      const rows = kinds.length
        ? db
            .select()
            .from(access)
            .where(and(eq(access.serverId, bk.serverId), inArray(access.kind, kinds)))
            .all()
        : [];
      for (const r of rows)
        await upsertAccess(db, box, id, {
          kind: r.kind,
          title: r.title,
          fields: r.fields.map((f) => ({ ...f, value: box.open(f.value) })),
          note: r.note,
        });
      if (rows.length) notes.push('доступы к панелям - как у старого сервера');
    }
    if (comps.has('mtproxyl') && has(id, 'mtproxyl')) {
      const res = await registry.request<{ exitCode: number }>(
        id,
        'command.run',
        {
          runId: ctx.action.id,
          script: MT_HOST_SCRIPT,
          env: { MT_HOST: row(id).clientHost ?? '' },
          files: {},
          cleanup: [],
          timeoutSec: 120,
        },
        { timeoutMs: 180_000, onStream: ctx.action.stream },
      );
      if (res.exitCode !== 0) throw new Error('MTProxyL: не удалось сменить адрес в ссылках');
    }
    return notes.join(', ');
  }

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
        const extra = s.id.startsWith('awg-extra');
        if (!extra && svc && has(id, svc.kind)) return null;
        // дополнительный AWG: порт и подсеть - из копии или свободные сейчас, когда основной
        // уже стоит
        const answers = extra
          ? {
              ...(await runner.defaults(id, 'awg')),
              AWG_VERSION: a.AWG_VERSION || '2.0',
              ...(a.AWG_SERVER_PORT ? { AWG_SERVER_PORT: a.AWG_SERVER_PORT } : {}),
              ...(a.AWG_SUBNET_IP ? { AWG_SUBNET_IP: a.AWG_SUBNET_IP } : {}),
              AWG_INSTANCE: 'extra',
            }
          : withPasswords(s);
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
        return restoreStep(id, a.BACKUP ?? '', ctx);
    }
  }

  return { plan, preflight, run, progress };
}

export type ServerSetup = ReturnType<typeof serverSetup>;
