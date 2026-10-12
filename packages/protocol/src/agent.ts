import { z } from 'zod';

/**
 * Список из отчёта агента: пустой срез Go приходит как null - это пустой список, а не повод
 * выбросить весь снимок сервера. Отсутствующее поле (старый агент) - тоже пустой список.
 */
const list = <T extends z.ZodTypeAny>(item: T) =>
  z
    .array(item)
    .nullish()
    .transform((v): z.infer<T>[] => v ?? []);

/**
 * Ссылка от агента: только http(s). Другое значение (javascript:, data:, схемы ОС)
 * отбрасывается, а не роняет весь снимок сервера: вывод агента - данные недоверенного сервера.
 */
const webUrl = z
  .string()
  .regex(/^https?:\/\/\S+$/i)
  .optional()
  .catch(undefined);

/** Действие замечания аудита: ссылка http(s) или действие панели (fix:, cmd:, tab:, cleanup:). */
const findingUrl = z
  .string()
  .regex(/^(https?:\/\/\S+|(fix|cmd|tab|cleanup):[\w-]*)$/i)
  .optional()
  .catch(undefined);

/** Метрики хоста, шлются агентом раз в 30 секунд. */
export const MetricsSchema = z.object({
  cpuPercent: z.number().min(0).max(100),
  memTotalMb: z.number().int().nonnegative(),
  memUsedMb: z.number().int().nonnegative(),
  diskTotalGb: z.number().nonnegative(),
  diskUsedGb: z.number().nonnegative(),
  netRxBps: z.number().nonnegative(),
  netTxBps: z.number().nonnegative(),
  uptimeSec: z.number().int().nonnegative(),
  load1: z.number().nonnegative(),
});
export type Metrics = z.infer<typeof MetricsSchema>;

export const ServiceKindSchema = z.enum([
  'xui',
  'mtproxyl',
  'amnezia',
  'wdtt',
  'wireguard',
  'wg-easy',
  'openflux',
  'naive',
  'custom',
]);
export type ServiceKind = z.infer<typeof ServiceKindSchema>;

export const ServiceSchema = z.object({
  // неизвестный вид от агента новее панели - "custom" с его названием, а не отказ от снимка
  kind: ServiceKindSchema.catch('custom'),
  title: z.string(),
  version: z.string().optional(),
  ports: list(z.string()),
  panelUrl: webUrl,
  details: z.record(z.string(), z.unknown()).optional(),
});
export type Service = z.infer<typeof ServiceSchema>;

export const ContainerSchema = z.object({
  id: z.string(),
  name: z.string(),
  image: z.string(),
  // все состояния Docker: незнакомое значение выбросило бы весь снимок сервера
  state: z.enum(['running', 'exited', 'restarting', 'paused', 'created', 'removing', 'dead']),
  status: z.string(),
  networkMode: z.string(),
  published: list(z.string()),
  composeProject: z.string().optional(),
  cpuPercent: z.number().optional(),
  memMb: z.number().optional(),
});
export type Container = z.infer<typeof ContainerSchema>;

export const FirewallRuleSchema = z.object({
  port: z.string(),
  proto: z.enum(['tcp', 'udp', 'any']),
  source: z.string(),
  action: z.enum(['allow', 'deny']),
  origin: z.enum(['permanent', 'portsync', 'docker', 'deny-list', 'manual']),
  comment: z.string(),
  manualId: z.string().optional(),
});
export type FirewallRule = z.infer<typeof FirewallRuleSchema>;

export const ListenerSchema = z.object({
  proto: z.enum(['tcp', 'udp']),
  port: z.number().int(),
  process: z.string(),
  open: z.boolean(),
});
export type Listener = z.infer<typeof ListenerSchema>;

export const FirewallStateSchema = z.object({
  ufwActive: z.boolean(),
  defaultIncoming: z.string(),
  portsyncInstalled: z.boolean(),
  portsyncActive: z.boolean(),
  portsyncLastRun: z.string().optional(),
  dockerFiltered: z.boolean(),
  rules: list(FirewallRuleSchema),
  listeners: list(ListenerSchema),
});
export type FirewallState = z.infer<typeof FirewallStateSchema>;

export const FindingSchema = z.object({
  severity: z.enum(['high', 'medium', 'info']),
  text: z.string(),
  fix: z.string(),
  /** Куда перейти, чтобы исправить (например, раздел настроек 3x-ui). */
  url: findingUrl,
});
export type Finding = z.infer<typeof FindingSchema>;

export const AuditSchema = z.object({
  sshPort: z.number().int(),
  sshPasswordAuth: z.boolean(),
  sshPermitRootLogin: z.string(),
  fail2banRunning: z.boolean(),
  fail2banJails: list(z.string()),
  /** Статистика jail-ов fail2ban; у старых агентов поля нет. */
  jails: list(
    z.object({
      name: z.string(),
      banned: z.number().int(),
      totalBanned: z.number().int(),
      failed: z.number().int(),
      /** Кто в бане сейчас; у старых агентов поля нет. */
      bannedIps: list(z.string()),
    }),
  ),
  unattendedUpgrades: z.boolean(),
  pendingUpdates: z.number().int(),
  rebootRequired: z.boolean(),
  findings: list(FindingSchema),
});
export type Audit = z.infer<typeof AuditSchema>;

export const HostInfoSchema = z.object({
  hostname: z.string(),
  os: z.string(),
  kernel: z.string(),
  arch: z.string(),
  agentVersion: z.string(),
  dockerVersion: z.string().optional(),
});
export type HostInfo = z.infer<typeof HostInfoSchema>;

/** TLS-сертификат на сервере. */
export const CertSchema = z.object({
  name: z.string(),
  // неизвестный источник от другой версии агента - "other", а не отказ от всего снимка
  source: z
    .enum(['acme.sh', 'certbot', 'xui', 'mtproxyl', 'caddy', 'naive', 'other'])
    .catch('other'),
  path: z.string(),
  keyPath: z.string(),
  subjects: list(z.string()),
  issuer: z.string(),
  notBefore: z.string(),
  notAfter: z.string(),
  daysLeft: z.number().int(),
  autoRenew: z.boolean(),
  usedBy: list(z.string()),
});
export type Cert = z.infer<typeof CertSchema>;

/** Полный снимок состояния сервера. */
export const InventorySchema = z.object({
  host: HostInfoSchema,
  services: list(ServiceSchema),
  containers: list(ContainerSchema),
  firewall: FirewallStateSchema,
  audit: AuditSchema,
  /** У старых агентов поля нет. */
  certs: list(CertSchema),
  collectedAt: z.string(),
});
export type Inventory = z.infer<typeof InventorySchema>;

// ---- Сообщения агент -> панель ----

export const AgentHelloSchema = z.object({
  type: z.literal('hello'),
  protocol: z.string(),
  host: HostInfoSchema,
  /** Операции агента: панель не зовёт того, чего агент не умеет. */
  methods: z.array(z.string()),
});
export type AgentHello = z.infer<typeof AgentHelloSchema>;
export const AgentHeartbeatSchema = z.object({ type: z.literal('heartbeat'), ts: z.string() });
export const AgentMetricsSchema = z.object({ type: z.literal('metrics'), metrics: MetricsSchema });
export const AgentInventorySchema = z.object({
  type: z.literal('inventory'),
  inventory: InventorySchema,
});
export const AgentStreamSchema = z.object({
  type: z.literal('stream'),
  id: z.string(),
  // data - двоичный вывод веб-терминала (base64)
  channel: z.enum(['stdout', 'stderr', 'log', 'data']),
  chunk: z.string(),
});
export const AgentResultSchema = z.object({
  type: z.literal('result'),
  id: z.string(),
  ok: z.boolean(),
  data: z.unknown().optional(),
  error: z.string().optional(),
});

export const AgentMessageSchema = z.discriminatedUnion('type', [
  AgentHelloSchema,
  AgentHeartbeatSchema,
  AgentMetricsSchema,
  AgentInventorySchema,
  AgentStreamSchema,
  AgentResultSchema,
]);
export type AgentMessage = z.infer<typeof AgentMessageSchema>;

// ---- Сообщения панель -> агент ----

export const AgentMethodSchema = z.enum([
  'inventory.get',
  'panel.url',
  'metrics.interval',
  'baseline.plan',
  'baseline.apply',
  'firewall.rules.set',
  'firewall.portsync.config',
  'firewall.portsync.run',
  'firewall.enable',
  'firewall.disable',
  'system.reboot',
  'system.upgrade',
  'ssh.keys.add',
  'ssh.keys.list',
  'ssh.keys.remove',
  'ssh.keys.comment',
  'command.run',
  'command.cancel',
  'backup.detect',
  'backup.create',
  'backup.restore',
  'disk.cleanup.scan',
  'disk.cleanup.run',
  'docker.action',
  'docker.logs',
  'agent.update',
  'agent.update.cancel',
  'telegram.send',
  'reach.check',
  'telegram.updates',
  'term.open',
  'term.input',
  'term.resize',
  'term.close',
  'tunnel.open',
  'tunnel.write',
  'tunnel.close',
  'awg.status',
  'awg.exec',
  'awg.config',
  'openflux.status',
  'openflux.logs',
  'openflux.link',
  'openflux.exec',
  'naive.status',
  'naive.exec',
  'mtproxyl.status',
  'mtproxyl.exec',
  'xui.info',
  'xui.set',
  'xui.service',
  'xui.update',
  'xui.token',
  'xui.api',
  'wdtt.api',
  'clients.stats',
]);
export type AgentMethod = z.infer<typeof AgentMethodSchema>;

export const PanelRequestSchema = z.object({
  type: z.literal('request'),
  id: z.string(),
  method: AgentMethodSchema,
  params: z.record(z.string(), z.unknown()).default({}),
});
export const PanelWelcomeSchema = z.object({
  type: z.literal('welcome'),
  serverId: z.string(),
  protocol: z.string(),
  /** Постоянный токен: приходит один раз, когда агент подключился по одноразовому (канал v1). */
  token: z.string().optional(),
  /** Канал v2: панель доказывает агенту знание его токена (HMAC по стенограмме рукопожатия). */
  proof: z.string().optional(),
});
export const PanelMessageSchema = z.discriminatedUnion('type', [
  PanelRequestSchema,
  PanelWelcomeSchema,
]);
export type PanelMessage = z.infer<typeof PanelMessageSchema>;
