import { and, eq, inArray, sql } from 'drizzle-orm';
import { type AgentRegistry, requireOnline } from '../agents/registry.js';
import { defaultsFor, findCommand, stripSecrets, validateAnswers } from '../commands/index.js';
import type { CommandDef, RunContext } from '../commands/types.js';
import { type Env, panelDomain } from '../config.js';
import type { Db } from '../db/index.js';
import { access, commandDefaults, gclientBindings, servers } from '../db/schema.js';
import { upsertAccess } from './access.js';
import type { actionJournal } from './action-journal.js';
import { latestAgentVersion } from './agent-dist.js';
import { awgLiveDefaults } from './awg-alloc.js';
import { clientHost } from './client-host.js';
import { queued } from './gclients.js';
import type { PanelCerts } from './panel-certs.js';
import { isPanelHost, panelAddresses } from './panel-host.js';
import { slugify } from './panel-proxy.js';
import { redactOutput } from './redact.js';
import type { SecretBox } from './secret-box.js';

interface Check {
  level: 'ok' | 'warn' | 'fail';
  text: string;
}

/** Куда идёт вывод команды: своё действие (маршрут) или общее (настройка сервера). */
interface RunSink {
  runId: string;
  stream: (channel: string, chunk: string) => void;
  /** Вывод этого запуска: из него команда достаёт доступы (логин, пароль, ссылки). */
  output: () => string;
  /**
   * Удаление сервиса, который тут же вернётся с прежними записями (переустановка с данными
   * копии): привязки клиентов и доступы к панели не снимаются.
   */
  keepBindings?: boolean;
}

interface CatalogDeps {
  db: Db;
  env: Env;
  registry: AgentRegistry;
  box: SecretBox;
  certs?: PanelCerts | undefined;
  log: { warn: (o: unknown, m?: string) => void };
}

const err = (message: string, statusCode: number) =>
  Object.assign(new Error(message), { statusCode });

/** Список команды, который может зависеть от ответов формы (что именно удаляется). */
function byAnswers(
  v: string[] | ((answers: Record<string, string>) => string[]) | undefined,
  answers: Record<string, string>,
): string[] {
  return (typeof v === 'function' ? v(answers) : v) ?? [];
}

/**
 * Команды каталога на сервере: значения формы, проверки перед запуском и исполнение (агент
 * command.run, затем доступы, очередь синхронизации, снятие привязок). Исполнение не открывает
 * действие само: маршрут запуска открывает своё, настройка сервера пишет в общее.
 */
export function catalogRunner(deps: CatalogDeps) {
  const { db, env, registry, box, certs, log } = deps;

  const command = (cmd: string): CommandDef => {
    const c = findCommand(cmd);
    if (!c) throw err('команда не найдена', 404);
    return c;
  };

  async function serverRow(id: string) {
    const r = (
      await db
        .select({
          id: servers.id,
          name: servers.name,
          host: servers.host,
          clientHost: servers.clientHost,
          sshPort: servers.sshPort,
          agentVersion: servers.agentVersion,
          cache: servers.statusCache,
        })
        .from(servers)
        .where(eq(servers.id, id))
        .limit(1)
    )[0];
    if (!r) throw err('сервер не найден', 404);
    const latest = latestAgentVersion(env.AGENT_DIR);
    const { cache, ...row } = r;
    const inv = cache?.inventory;
    return {
      ...row,
      panelHost: isPanelHost(r.host, inv, await panelAddresses(env.PANEL_PUBLIC_URL)),
      agentUpdateAvailable: Boolean(latest && r.agentVersion && r.agentVersion !== latest),
    };
  }
  type Row = Awaited<ReturnType<typeof serverRow>>;

  function baseEnv(
    row: Row,
    answers: Record<string, string>,
    extra: Record<string, string>,
    params: { name: string; type: string }[] = [],
  ) {
    // Только объявленные параметры (лишний ключ из запроса мог бы задать PATH или BASH_ENV) и
    // такими, какими их проверил validateAnswers - без пробелов по краям; пароли - как есть.
    // Скрипты идут под set -u: каждый объявленный параметр есть в окружении, хотя бы пустым.
    const declared: Record<string, string> = {};
    for (const p of params) {
      const v = answers[p.name] ?? '';
      declared[p.name] = p.type === 'password' ? v : v.trim();
    }
    return {
      ...declared,
      ...extra,
      PANEL_URL: env.PANEL_PUBLIC_URL,
      SERVER_HOST: row.host,
      // адрес сервера в конфигах людей (имя из "Адреса для клиентов" или IP)
      CLIENT_HOST: clientHost(row),
      SERVER_NAME: row.name,
      SERVER_SSH_PORT: String(row.sshPort),
      // сервер, на котором стоит сама панель: 443 и 80 держит её Caddy
      PANEL_HOST: row.panelHost ? '1' : '',
    };
  }

  /** Имя прокси для браузера: <слаг сервера>.<домен панели>. */
  async function naiveLiveDefaults(id: string): Promise<Record<string, string>> {
    const row = (
      await db.select({ name: servers.name }).from(servers).where(eq(servers.id, id))
    )[0];
    // панель без домена: подставить нечего, имя вводят сами
    const domain = panelDomain(env);
    if (!row || !domain) return {};
    return { NAIVE_DOMAIN: `${slugify(row.name)}.${domain}` };
  }

  /**
   * MTProxyL уже установлен - "с панелью": команда тогда ставит только её. Порт MTProxyL: 443
   * лучше всего для маскировки, но если его (или сохранённый порт) уже слушает
   * другой процесс (Xray 3X-UI, Caddy сервера панели), форма сразу предлагает свободный. 443
   * прокси для браузера (caddy на хосте) занятым не считается: MTProxyL забирает его сам.
   */
  async function mtproxylLiveDefaults(id: string, want: string): Promise<Record<string, string>> {
    const row = (
      await db.select({ cache: servers.statusCache }).from(servers).where(eq(servers.id, id))
    )[0];
    const inv = row?.cache?.inventory;
    if (!inv) return {};
    // MTProxyL уже стоит: команда ставит только панель - выбор "без панели" не имеет смысла
    if (inv.services.some((s) => s.kind === 'mtproxyl')) return { MT_PANEL: 'yes' };
    const naive = inv.services.some((s) => s.kind === 'naive');
    const busy = (port: number) =>
      inv.firewall.listeners.some(
        (l) => l.proto === 'tcp' && l.port === port && !(naive && l.process === 'caddy'),
      );
    if (!busy(Number(want))) return {};
    const free = [443, 993, 8443, 2083, 2087].find((p) => !busy(p));
    return free ? { MT_PORT: String(free) } : {};
  }

  /** Значения по умолчанию для формы: сохранённые ответы для сервера поверх default/generate. */
  async function defaults(id: string, cmd: string): Promise<Record<string, string>> {
    const c = command(cmd);
    const saved = (
      await db
        .select()
        .from(commandDefaults)
        .where(and(eq(commandDefaults.serverId, id), eq(commandDefaults.commandId, cmd)))
        .limit(1)
    )[0];
    // выбор контейнера AWG не запоминается: по нему удаляют, и прошлый выбор (или уже
    // удалённый контейнер) не должен подставляться в следующий раз
    const remembered = Object.fromEntries(
      Object.entries(saved?.answers ?? {}).filter(
        ([k]) => !c.params.some((p) => p.name === k && p.type === 'awg-container'),
      ),
    );
    const base = { ...defaultsFor(c), ...remembered };
    const live =
      c.liveDefaults === 'awg'
        ? await awgLiveDefaults(db, registry, id)
        : c.liveDefaults === 'naive'
          ? await naiveLiveDefaults(id)
          : c.liveDefaults === 'mtproxyl'
            ? await mtproxylLiveDefaults(id, base.MT_PORT ?? '443')
            : {};
    return { ...base, ...live };
  }

  /** Быстрые проверки на сервере: ошибки ответов и строки OK|, WARN|, FAIL| скрипта. */
  async function preflight(
    id: string,
    cmd: string,
    answers: Record<string, string>,
  ): Promise<{ checks: Check[]; canRun: boolean }> {
    const c = command(cmd);
    requireOnline(registry, id);
    const checks: Check[] = validateAnswers(c, answers).map((e) => ({ level: 'fail', text: e }));
    const row = await serverRow(id);
    const certName = c.panelCertParam ? answers[c.panelCertParam]?.trim() : '';
    if (row.panelHost && certName) certs?.allow(certName);
    checks.push(
      row.agentUpdateAvailable
        ? { level: 'warn', text: 'агент устарел: перед запуском нужно обновить агент' }
        : { level: 'ok', text: 'сервер в сети' },
    );
    if (c.preflight) {
      const res = await registry.request<{ exitCode: number; tail: string }>(
        id,
        'command.run',
        {
          script: c.preflight,
          env: baseEnv(
            row,
            answers,
            c.env?.({ panelUrl: env.PANEL_PUBLIC_URL, server: row, answers }) ?? {},
            c.params,
          ),
          timeoutSec: 60,
        },
        { timeoutMs: 90_000 },
      );
      for (const line of res.tail.split('\n')) {
        const m = /^(OK|WARN|FAIL)\|(.*)$/.exec(line.trim());
        if (m) checks.push({ level: m[1]?.toLowerCase() as Check['level'], text: m[2] ?? '' });
      }
      if (res.exitCode !== 0 && !checks.some((ch) => ch.level === 'fail'))
        checks.push({ level: 'warn', text: `скрипт проверок завершился с кодом ${res.exitCode}` });
    }
    return { checks, canRun: !checks.some((ch) => ch.level === 'fail') };
  }

  /**
   * Подготовка запуска: проверка ответов, сохранение ответов без секретов, окружение и файлы.
   * Ошибка - исключение со statusCode (до открытия действия).
   */
  async function prepare(id: string, cmd: string, answers: Record<string, string>) {
    const c = command(cmd);
    requireOnline(registry, id);
    const errors = validateAnswers(c, answers);
    if (errors.length) throw err(errors.join('; '), 400);
    const row = await serverRow(id);
    const certName = c.panelCertParam ? answers[c.panelCertParam]?.trim() : '';
    if (row.panelHost && certName) certs?.allow(certName);
    const ctx: RunContext = { panelUrl: env.PANEL_PUBLIC_URL, server: row, answers };
    const extraEnv = c.env?.(ctx) ?? {};
    const files = c.files?.(ctx) ?? {};
    const publicAnswers = stripSecrets(c, answers);
    await db
      .insert(commandDefaults)
      .values({ serverId: id, commandId: cmd, answers: publicAnswers })
      .onConflictDoUpdate({
        target: [commandDefaults.serverId, commandDefaults.commandId],
        set: { answers: publicAnswers },
      });
    // секреты, известные до запуска (пароли из формы, токены панели): не уходят даже в живой
    // вывод в браузер; в журнале они заменяются ещё раз целиком (кусок мог разрезать значение)
    const known = [
      ...c.params.filter((p) => p.secret || p.type === 'password').map((p) => answers[p.name]),
      ...Object.entries(extraEnv)
        .filter(([k]) => /(TOKEN|SECRET|PASSWORD)$/.test(k))
        .map(([, v]) => v),
    ].filter((v): v is string => Boolean(v));
    return { c, row, ctx, extraEnv, files, publicAnswers, known };
  }

  /**
   * Исполнение подготовленного запуска: command.run со стримом (секреты вырезаны), затем при
   * успехе доступы, очередь синхронизации, снятие привязок. Возвращает код выхода и секреты,
   * которые нужно вырезать из вывода перед записью в журнал.
   */
  async function execute(
    id: string,
    p: Awaited<ReturnType<typeof prepare>>,
    sink: RunSink,
  ): Promise<{ exitCode: number; secrets: string[] }> {
    const { c, row, ctx, extraEnv, files, known } = p;
    const onStream = (channel: string, chunk: string) =>
      sink.stream(channel, redactOutput(chunk, known));
    let exitCode = 1;
    try {
      const r = await registry.request<{ exitCode: number; killed: boolean }>(
        id,
        'command.run',
        {
          runId: sink.runId,
          script: c.script,
          env: baseEnv(row, ctx.answers, extraEnv, c.params),
          files,
          cleanup: c.cleanup ?? [],
          timeoutSec: c.timeoutSec,
        },
        { timeoutMs: (c.timeoutSec + 60) * 1000, onStream },
      );
      exitCode = r.exitCode;
    } catch (e) {
      onStream('stderr', `\nОШИБКА: ${(e as Error).message}\n`);
    }
    // доступы к установленной панели: логин, пароль, ссылки - в "Доступы" сервера
    let entries: Parameters<typeof upsertAccess>[3][] = [];
    if (exitCode === 0 && c.access) {
      try {
        entries = [c.access({ ...ctx, output: sink.output() }) ?? []].flat();
      } catch (e) {
        log.warn({ err: (e as Error).message }, 'access: не удалось сохранить доступы');
      }
    }
    // секреты в журнал не пишутся: в "Доступах" они зашифрованы, а журнал - открытым текстом
    const secrets = [
      // включая переменные-секреты, которые панель генерирует сама (токен admin API WDTT)
      ...known,
      ...entries.flatMap((e) => e.fields.filter((f) => f.secret).map((f) => f.value)),
    ].filter((v): v is string => Boolean(v));
    if (exitCode === 0 && c.resync?.length)
      db.update(gclientBindings)
        .set(queued())
        .where(and(eq(gclientBindings.serverId, id), inArray(gclientBindings.service, c.resync)))
        .run();
    const drops = byAnswers(c.dropsBindings, ctx.answers);
    if (exitCode === 0 && drops.length && !sink.keepBindings) {
      const refPart = c.dropsBindingsRef?.(ctx.answers);
      db.delete(gclientBindings)
        .where(
          and(
            eq(gclientBindings.serverId, id),
            inArray(gclientBindings.service, drops),
            refPart ? sql`instr(${gclientBindings.ref}, ${refPart}) > 0` : undefined,
          ),
        )
        .run();
    }
    const forgets = byAnswers(c.forgetsAccess, ctx.answers);
    if (exitCode === 0 && forgets.length && !sink.keepBindings)
      db.delete(access)
        .where(and(eq(access.serverId, id), inArray(access.kind, forgets)))
        .run();
    for (const e of entries) {
      try {
        await upsertAccess(db, box, id, e);
      } catch (e) {
        log.warn({ err: (e as Error).message }, 'access: не удалось сохранить доступы');
      }
    }
    return { exitCode, secrets };
  }

  /** Запуск своим действием command:<id> (маршрут): id действия сразу, исполнение в фоне. */
  async function start(
    journal: ReturnType<typeof actionJournal>,
    id: string,
    cmd: string,
    answers: Record<string, string>,
  ): Promise<string> {
    const p = await prepare(id, cmd, answers);
    const action = journal.open(id, `command:${cmd}`, {
      title: p.c.title,
      answers: p.publicAnswers,
    });
    void execute(id, p, {
      runId: action.id,
      stream: action.stream,
      output: () => action.output,
    }).then(({ exitCode, secrets }) =>
      action.finish(exitCode, redactOutput(action.output, secrets)),
    );
    return action.id;
  }

  return { defaults, preflight, prepare, execute, start };
}

export type CatalogRunner = ReturnType<typeof catalogRunner>;
