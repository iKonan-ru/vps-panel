import { randomBytes } from 'node:crypto';
import type {
  SetupCheck,
  SetupMode,
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
import { keyFingerprint, loadPanelKey } from './ssh.js';
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

/** Команда удаления сервиса каталога (для "Переустановить"). */
const UNINSTALL: Record<string, string> = {
  xui: 'xui-uninstall',
  mtproxyl: 'mtproxyl-uninstall',
  wdtt: 'wdtt-uninstall',
  openflux: 'openflux-uninstall',
  naive: 'naive-uninstall',
};

/** Компонент архива копии по команде сервиса. */
const COMPONENT: Record<string, string> = {
  xui: 'xui',
  mtproxyl: 'mtproxyl',
  wdtt: 'wdtt',
  awg: 'amnezia',
};

/** Контейнер AWG на сервере (awg.status): имя, порт UDP, подсеть 10.8.N.0. */
interface AwgHere {
  container: string;
  port: number;
  subnet: string;
}

const subnetOf = (address: string) => {
  const m = /(\d+)\.(\d+)\.(\d+)\.\d+\/\d+/.exec(address);
  return m ? `${m[1]}.${m[2]}.${m[3]}.0` : '';
};

/** Режим шага с уже стоящим сервисом; без выбора - обычная установка. */
const modeOf = (s: SetupStep) => (s.modes ? (s.answers?.MODE ?? s.modes[0]) : 'install');

/** Шаг поставит сервис (или контейнер): новый, переустановка или удаление мешающего. */
const willInstall = (s: SetupStep) =>
  s.enabled && s.kind === 'service' && (modeOf(s) === 'install' || modeOf(s) === 'reinstall');

const isAwgStep = (s: SetupStep) => s.id === 'awg' || s.id.startsWith('awg-extra');

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

  /** Что на сервере уже сделано; null - агент не ответил (шаг остаётся включённым). */
  interface Probe {
    panelKey: boolean | null;
    /** Что исправит шаг безопасности; пусто - проблем нет. */
    baseline: string[] | null;
    /** Свои inbound VLESS в 3X-UI. */
    ownVless: number | null;
  }
  const PROBE_TTL = 30_000;
  const probes = new Map<string, { at: number; p: Promise<Probe> }>();

  /**
   * Опрос сервера перед планом: лишние шаги выключаются заранее. Кэш короткий - план, проверки
   * и запуск идут друг за другом и опрашивать сервер трижды незачем.
   */
  function probe(id: string): Promise<Probe> {
    const c = probes.get(id);
    if (c && Date.now() - c.at < PROBE_TTL) return c.p;
    const p = (async (): Promise<Probe> => {
      const fp = keyFingerprint(loadPanelKey(env.DATA_DIR).publicKey);
      const [panelKey, baseline, ownVless] = await Promise.all([
        registry
          .request<{ keys: { fingerprint: string }[] }>(
            id,
            'ssh.keys.list',
            {},
            { timeoutMs: 30_000 },
          )
          .then((r) => r.keys.some((k) => k.fingerprint === fp))
          .catch(() => null),
        registry
          .request<{ steps: { title: string; needed: boolean }[] }>(
            id,
            'baseline.plan',
            {},
            { timeoutMs: 120_000 },
          )
          .then((r) => r.steps.filter((x) => x.needed).map((x) => x.title))
          .catch(() => null),
        has(id, 'xui')
          ? xuiToken(db, box, registry, id)
              .then((t) => inboundList(xuiApi(registry, id, t)))
              .then((l) => ownVlessInbounds(l).length)
              .catch(() => null)
          : Promise.resolve(null),
      ]);
      return { panelKey, baseline, ownVless };
    })();
    probes.set(id, { at: Date.now(), p });
    return p;
  }

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
    const pr = await probe(id);
    const pending = inventory(id)?.audit.pendingUpdates;
    // нечего делать - шаг выключен и сказано почему; включить можно, вреда не будет
    const off = (cond: boolean, note: string) => (cond ? { enabled: false, note } : {});
    const steps: SetupStep[] = [
      {
        id: 'key',
        kind: 'key',
        title: 'Ключ панели в root',
        enabled: true,
        ...off(pr.panelKey === true, 'ключ панели уже есть'),
      },
      {
        id: 'baseline',
        kind: 'baseline',
        title: 'Исправление проблем безопасности',
        enabled: true,
        ...(pr.baseline?.length ? { note: `исправит: ${pr.baseline.join('; ')}` } : {}),
        ...off(pr.baseline?.length === 0, 'проблем не найдено'),
      },
      {
        id: 'upgrade',
        kind: 'upgrade',
        title: 'Обновление пакетов',
        enabled: true,
        ...(pending ? { note: `доступно обновлений: ${pending}` } : {}),
        ...off(pending === 0, 'обновлений нет'),
      },
      {
        id: 'client-host',
        kind: 'client-host',
        title: 'Адрес для клиентов',
        enabled: true,
        answers: { NAME: r.clientHost ?? '' },
      },
    ];
    for (const s of SERVICES) {
      // AWG: "уже стоит" - основной контейнер; дополнительные основному не мешают
      const installed =
        s.command === 'awg'
          ? (inventory(id)?.containers ?? []).some((c) => c.name === AWG_MAIN)
          : has(id, s.kind);
      const answers = await screenAnswers(id, s.command);
      steps.push({
        id: s.command,
        kind: 'service',
        title: s.title,
        command: s.command,
        ...(installed
          ? {
              enabled: false,
              note: 'уже установлен',
              modes: ['skip', 'reinstall'] as SetupMode[],
              answers: { ...answers, MODE: 'skip' },
            }
          : { enabled: true, answers }),
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
      ...(xuiThere && pr.ownVless === null ? { note: 'если своих inbound VLESS ещё нет' } : {}),
      ...off(Boolean(pr.ownVless), 'свои inbound VLESS уже есть'),
    });
    steps.push(
      { id: 'gclients', kind: 'gclients', title: 'Синхронизация клиентов', enabled: true },
      { id: 'reboot', kind: 'reboot', title: 'Перезагрузка, если нужна', enabled: true },
      { id: 'reach', kind: 'reach', title: 'Проверка доступности из России', enabled: true },
    );
    return { steps, progress: progress(id) };
  }

  /** Контейнеры AWG на сервере живым опросом; агент не ответил - null (проверят команды). */
  async function awgHere(id: string): Promise<AwgHere[] | null> {
    try {
      const st = await registry.request<{
        instances?: { container: string; port: number; address: string }[];
      }>(id, 'awg.status', {}, { timeoutMs: 30_000 });
      return (st.instances ?? []).map((i) => ({
        container: i.container,
        port: i.port,
        subnet: subnetOf(i.address),
      }));
    } catch {
      return null;
    }
  }

  /**
   * Шаги AWG из копии: по контейнеру на каждый в копии. Нет такого на сервере - ставится
   * обязательно; есть - выбор (оставить и заменить данными, переустановить, не трогать).
   * Контейнеры сервера, которых нет в копии, но которые заняли её порт или подсеть, - шаги
   * удаления (выключены: их клиенты потеряют доступ, решает владелец).
   */
  function awgBackupSteps(base: SetupStep, snap: BackupSetup, here: AwgHere[] | null): SetupStep[] {
    if (!snap.services.includes('amnezia') || !snap.awg.length) {
      // в копии AWG нет: стоящий основной - не трогать, иначе выключен
      return [base.modes ? base : { ...base, enabled: false }];
    }
    const out: SetupStep[] = [];
    const names = new Set(snap.awg.map((a) => a.container));
    for (const t of here ?? []) {
      if (names.has(t.container)) continue;
      const clash = snap.awg.find((a) => a.port === t.port || (a.subnet && a.subnet === t.subnet));
      if (!clash) continue;
      const what = clash.port === t.port ? `порт UDP ${t.port}` : `подсеть ${t.subnet}`;
      out.push({
        id: `awg-remove:${t.container}`,
        kind: 'service',
        title: `Удалить контейнер ${t.container}`,
        command: 'awg-uninstall',
        enabled: false,
        note: `занял ${what}, нужную копии; его клиенты потеряют доступ`,
        answers: { AWG_CONTAINER: t.container, CONFIRM: 'yes' },
      });
    }
    const ordered = [...snap.awg].sort((a, b) =>
      a.container === AWG_MAIN ? -1 : b.container === AWG_MAIN ? 1 : 0,
    );
    for (const x of ordered) {
      const main = x.container === AWG_MAIN;
      const exists = here?.some((t) => t.container === x.container) ?? false;
      const answers = {
        ...(main ? (base.answers ?? {}) : {}),
        ...(main ? (snap.answers.awg ?? {}) : {}),
        AWG_INSTANCE: main ? 'main' : 'extra',
        AWG_VERSION: x.version || (main ? '3.1' : '2.0'),
        ...(x.port ? { AWG_SERVER_PORT: String(x.port) } : {}),
        ...(x.subnet ? { AWG_SUBNET_IP: x.subnet } : {}),
      };
      const step: SetupStep = {
        id: main ? 'awg' : `awg-extra:${x.port}`,
        kind: 'service',
        title: main ? 'AmneziaWG' : `AmneziaWG ${x.version || '2.0'}: дополнительный контейнер`,
        command: 'awg',
        enabled: true,
        answers,
      };
      out.push(
        exists
          ? {
              ...step,
              modes: ['keep', 'reinstall', 'skip'],
              note: `контейнер ${x.container} уже есть`,
              answers: { ...answers, MODE: 'keep' },
            }
          : { ...step, locked: true, note: 'контейнер из копии, с её портом и подсетью' },
      );
    }
    return out;
  }

  /**
   * План восстановления на чистый сервер: сервисы - как на старом сервере, с его портами;
   * контейнеры AWG из копии - обязательно; затем раскладка данных архива. Пароли сервисов,
   * чьи данные в архиве, не спрашиваются: их заменит копия.
   */
  async function backupPlan(id: string, bid: string): Promise<SetupPlan> {
    const { bk, snap, comps } = backupSource(bid);
    const base = (await plan(id)).steps;
    const here = await awgHere(id);
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
        steps.push(...awgBackupSteps(s, snap, here));
        continue;
      }
      if (s.id === 'awg-extra') {
        // дополнительные контейнеры копии уже в awgBackupSteps; свой - только без них
        if (!snap.awg.some((a) => a.container !== AWG_MAIN)) steps.push(s);
        continue;
      }
      if (s.kind === 'service' && s.command) {
        const kind = SERVICES.find((x) => x.command === s.command)?.kind ?? '';
        const inSnap = snap.services.includes(kind);
        const answers = { ...(s.answers ?? {}), ...(snap.answers[s.command] ?? {}) };
        const fromBackup = comps.has(s.command) ? { fromBackup: true } : {};
        if (s.modes) {
          // уже стоит: из копии - оставить и заменить данными; в копии его нет - не трогать
          const modes: SetupMode[] = inSnap ? ['keep', 'reinstall', 'skip'] : ['skip', 'reinstall'];
          steps.push({
            ...s,
            ...fromBackup,
            modes,
            enabled: inSnap,
            note: inSnap ? 'уже установлен' : 'уже установлен, в копии его нет',
            answers: { ...answers, MODE: modes[0] as string },
          });
          continue;
        }
        steps.push({ ...s, ...fromBackup, enabled: inSnap, answers });
        continue;
      }
      if (s.id === 'inbounds') {
        steps.push({
          id: 'restore',
          kind: 'restore',
          title: 'Данные из резервной копии',
          enabled: true,
          locked: true,
          note: 'ключи, пользователи и inbound-ы старого сервера',
          answers: { BACKUP: bid },
        });
        // нужны ли свои inbound-ы, решает копия: после раскладки шаг проверит сам
        steps.push({ ...s, enabled: true, note: 'если в копии нет своих inbound VLESS' });
        continue;
      }
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
      const answers = { ...(s.answers ?? {}), ...(q.answers ?? {}) };
      // уже стоящий сервис: идёт, если выбрано не "не трогать"
      if (s.modes) {
        const mode = (s.modes as string[]).includes(answers.MODE ?? '')
          ? (answers.MODE as string)
          : (s.modes[0] as string);
        return { ...s, enabled: mode !== 'skip', answers: { ...answers, MODE: mode } };
      }
      return { ...s, enabled: s.locked ? true : q.enabled, answers };
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
      if (s.kind === 'service' && s.command && willInstall(s)) {
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
    // AWG из копии раскладывается целиком: "не трогать" - для всех контейнеров копии сразу
    const awgCopy = steps.filter((x) => isAwgStep(x) && x.modes?.includes('keep'));
    const awgSkip = awgCopy.filter((x) => modeOf(x) === 'skip');
    const awgGo = steps.filter(
      (x) => isAwgStep(x) && x.enabled && (x.locked || x.modes?.includes('keep')),
    );
    if (awgSkip.length && awgGo.length)
      for (const x of awgSkip)
        out.push({
          step: x.id,
          level: 'fail',
          text: '\u00abНе трогать\u00bb для AWG - только для всех контейнеров копии сразу',
        });
    // мешающий контейнер: либо удалить, либо не трогать AWG из копии
    for (const r of steps.filter((x) => x.id.startsWith('awg-remove:') && !x.enabled))
      if (awgGo.length)
        out.push({
          step: r.id,
          level: 'fail',
          text: `${r.note ?? ''}: нужно отметить удаление или выбрать \u00abНе трогать\u00bb для AWG`,
        });
    return out;
  }

  /** Проверки перед запуском: поля, порты, проверки команд каталога на сервере. */
  async function preflight(id: string, req: SetupRunRequest) {
    if (!registry.isOnline(id)) throw err('сервер не в сети', 409);
    const steps = await resolve(id, req);
    const checks = localChecks(steps);
    // проверки команд - для того, что поставится на нынешнее состояние; переустановку и AWG
    // из копии (порты и подсети уже сверены с контейнерами сервера) команды проверили бы против
    // того, что сейчас удалится
    const awgChecked = Boolean(req.backupId);
    for (const s of steps.filter((x) => willInstall(x) && x.command)) {
      if (s.id.startsWith('awg-extra') || modeOf(s) === 'reinstall') continue;
      if (awgChecked && isAwgStep(s)) continue;
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
    const all = await resolve(id, req);
    const steps = all.filter((s) => (keep ? keep.has(s.id) : s.enabled));
    if (!steps.length) throw err('не выбрано ни одного шага', 400);
    const bad = localChecks(all).filter((c) => c.level === 'fail');
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
    probes.delete(id);
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
    // компоненты копии, которые не раскладываются: "не трогать" у их сервиса
    const exclude = new Set<string>();
    for (const x of all)
      if (x.modes && modeOf(x) === 'skip' && x.command && COMPONENT[x.command])
        exclude.add(COMPONENT[x.command] as string);
    void (async () => {
      let exit = 0;
      for (const [i, s] of steps.entries()) {
        const st = state.steps[i];
        if (!st || st.state === 'done') continue;
        st.state = 'running';
        save();
        say(`\n== ${s.title}`);
        try {
          const note = await exec(id, s, { action, say, secrets, exclude });
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
      probes.delete(id);
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
    /** Компоненты копии, которые не раскладывать. */
    exclude: Set<string>;
  };

  /**
   * Раскладка архива на поставленные сервисы, затем то, что после неё стало другим: токен API
   * 3X-UI (база заменена - прежний токен в ней не действует), "Доступы" к панелям старого
   * сервера (логины и пароли теперь его), адрес в ссылках MTProxyL - этого сервера.
   */
  async function restoreStep(id: string, bid: string, ctx: Ctx): Promise<string> {
    const { bk, comps } = backupSource(bid);
    ctx.say(`Копия ${bk.serverName} от ${bk.createdAt.slice(0, 16).replace('T', ' ')}`);
    // "не трогать" у сервиса - его данные из копии не раскладываются
    const parts = [...comps].filter(
      (c): c is string => Boolean(c) && !ctx.exclude.has(c as string),
    );
    if (ctx.exclude.size) ctx.say(`Не раскладываются: ${[...ctx.exclude].join(', ')}`);
    await restorer.restore(id, bid, ctx.exclude.size ? parts : [], ctx.action.stream);
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

  /** Команда каталога в выводе настройки; код не 0 - исключение. */
  async function runCommand(id: string, cmd: string, answers: Record<string, string>, ctx: Ctx) {
    const p = await runner.prepare(id, cmd, answers);
    const from = ctx.action.output.length;
    const r = await runner.execute(id, p, {
      runId: ctx.action.id,
      stream: ctx.action.stream,
      output: () => ctx.action.output.slice(from),
    });
    ctx.secrets.push(...r.secrets);
    if (r.exitCode !== 0) throw new Error(`${cmd}: команда завершилась с кодом ${r.exitCode}`);
    await registry.refreshInventory(id);
  }

  /**
   * "Оставить" для контейнера AWG из копии: порт и подсеть те же - ничего не делать (данные
   * заменит копия), иначе пересоздать контейнер с параметрами копии: восстановленным
   * пользователям нужны именно они.
   */
  async function awgKeep(id: string, s: SetupStep, ctx: Ctx): Promise<string> {
    const a = s.answers ?? {};
    const name = s.id === 'awg' ? AWG_MAIN : `${AWG_MAIN}-${a.AWG_SERVER_PORT ?? ''}`;
    const t = (await awgHere(id))?.find((x) => x.container === name);
    const same =
      t &&
      (!a.AWG_SERVER_PORT || String(t.port) === a.AWG_SERVER_PORT) &&
      (!a.AWG_SUBNET_IP || t.subnet === a.AWG_SUBNET_IP);
    if (same) return `контейнер ${name} оставлен, данные заменит копия`;
    ctx.say(`Контейнер ${name}: порт или подсеть не как в копии - пересоздаю`);
    const answers = {
      ...(await runner.defaults(id, 'awg')),
      ...a,
      AWG_INSTANCE: s.id === 'awg' ? 'main' : 'extra',
      AWG_REPLACE: 'replace',
    };
    await runCommand(id, 'awg', answers, ctx);
    return `контейнер ${name} пересоздан с портом и подсетью копии`;
  }

  /** Один шаг; итог для журнала, null - шаг пропущен (делать было нечего). */
  async function exec(id: string, s: SetupStep, ctx: Ctx): Promise<string | null> {
    const { action, say } = ctx;
    const a = s.answers ?? {};
    switch (s.kind) {
      case 'key': {
        const key = loadPanelKey(env.DATA_DIR).publicKey;
        const r = await registry.request<{ added?: number }>(
          id,
          'ssh.keys.add',
          { keys: [key] },
          { timeoutMs: 30_000 },
        );
        return r?.added === 0
          ? 'ключ панели уже был'
          : 'ключ панели добавлен в authorized_keys root';
      }
      case 'baseline':
        try {
          await registry.request(
            id,
            'baseline.apply',
            { steps: [] },
            { timeoutMs: 20 * 60_000, onStream: action.stream },
          );
        } catch (e) {
          // агент: все проблемы уже исправлены - это не ошибка
          if ((e as Error).message.includes('исправлять нечего')) return 'проблем не найдено';
          throw e;
        }
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
        const mode = modeOf(s);
        if (mode === 'skip') return null;
        if (mode === 'keep') {
          if (cmd !== 'awg') return 'оставлен, данные заменит копия';
          return awgKeep(id, s, ctx);
        }
        if (mode === 'reinstall' && cmd !== 'awg' && UNINSTALL[cmd]) {
          say(`Удаление: ${s.title}`);
          await runCommand(id, UNINSTALL[cmd] as string, { CONFIRM: 'yes' }, ctx);
        }
        if (mode === 'install' && !extra && svc && cmd !== 'awg' && has(id, svc.kind)) return null;
        // дополнительный AWG: порт и подсеть - из копии или свободные сейчас, когда основной
        // уже стоит
        const answers = extra
          ? {
              ...(await runner.defaults(id, 'awg')),
              AWG_VERSION: a.AWG_VERSION || '2.0',
              ...(a.AWG_SERVER_PORT ? { AWG_SERVER_PORT: a.AWG_SERVER_PORT } : {}),
              ...(a.AWG_SUBNET_IP ? { AWG_SUBNET_IP: a.AWG_SUBNET_IP } : {}),
              AWG_INSTANCE: 'extra',
              ...(mode === 'reinstall' ? { AWG_REPLACE: 'replace' } : {}),
            }
          : cmd === 'awg' && mode === 'reinstall'
            ? { ...withPasswords(s), AWG_REPLACE: 'replace' }
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
