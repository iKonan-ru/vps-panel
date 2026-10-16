import { z } from 'zod';
import { HostInfoSchema, InventorySchema, MetricsSchema } from './agent.js';

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
