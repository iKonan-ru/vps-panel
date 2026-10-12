import { z } from 'zod';
import { AuditSchema, FirewallStateSchema, MetricsSchema, ServiceSchema } from './agent.js';

/** Сервер в панели, как его видит интерфейс. */
export const ServerStatusSchema = z.enum(['online', 'offline', 'no-agent', 'rebooting']);
export type ServerStatus = z.infer<typeof ServerStatusSchema>;

export const HostingSchema = z.object({
  provider: z.string().default(''),
  providerServerName: z.string().default(''),
  providerUrl: z.string().default(''),
  country: z.string().default(''),
  price: z.number().nullable().default(null),
  currency: z.string().default('RUB'),
  /** За сколько месяцев вносится оплата: 1 - ежемесячно, 6 - раз в полгода, 12 - раз в год. */
  billingMonths: z.number().int().min(1).max(120).default(1),
  nextPaymentAt: z.string().nullable().default(null),
  notes: z.string().default(''),
});
export type Hosting = z.infer<typeof HostingSchema>;

export const ServerSummarySchema = z.object({
  id: z.string(),
  name: z.string(),
  host: z.string(),
  sshPort: z.number().int(),
  tags: z.array(z.string()),
  status: ServerStatusSchema,
  lastSeenAt: z.string().nullable(),
  agentVersion: z.string().nullable(),
  /** Есть более новая сборка агента в панели. */
  agentUpdateAvailable: z.boolean().default(false),
  /** Агент сейчас обновляется и перезапускается. */
  agentUpdating: z.boolean().default(false),
  hosting: HostingSchema,
  metrics: MetricsSchema.nullable(),
  services: z.array(ServiceSchema),
  audit: AuditSchema.nullable(),
  firewall: FirewallStateSchema.pick({ ufwActive: true, dockerFiltered: true }).nullable(),
  /** Версия docker, null - не установлен. */
  dockerVersion: z.string().nullable(),
  /**
   * На этом сервере стоит сама панель (jail vps-panel или его адрес - адрес домена панели):
   * глобальные клиенты на нём - только если владелец включил (80 и 443 держит панель).
   */
  panelHost: z.boolean().default(false),
  /**
   * Вход в панели сервисов через поддомены панели (вид сервиса -> адрес): есть, когда агент
   * умеет туннель (0.3.0+). Иначе - прямой panelUrl сервиса.
   */
  panelLinks: z.record(z.string(), z.string()).default({}),
});
export type ServerSummary = z.infer<typeof ServerSummarySchema>;
