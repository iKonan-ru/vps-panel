import { isIP } from 'node:net';
import type { PortsyncConfig as PortsyncConfigT } from '@vps/protocol';
import { z } from 'zod';

/**
 * Проверки параметров, которые панель передаёт агенту. Агент проверяет их сам теми же
 * регулярками, здесь - вторая линия: регрессия в агенте не должна открыть путь к инъекции, а
 * ошибка видна сразу с понятным текстом.
 */

/** Контейнер docker: id или имя. */
export const DockerRef = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/, 'контейнер');

/** Публичный ключ WireGuard/AWG: 32 байта в base64 (как reWgKey агента). */
export const WgKey = z.string().regex(/^[A-Za-z0-9+/]{42}[AEIMQUYcgkosw048]=$/, 'ключ WireGuard');

/** Открытый ключ ssh одной строкой: тип, тело base64, комментарий без переводов строки. */
export const SshPublicKey = z
  .string()
  .regex(
    /^(ssh-(ed25519|rsa|dss)|ecdsa-sha2-nistp(256|384|521)|sk-[A-Za-z0-9@.-]+) [A-Za-z0-9+/]+=*( [^\r\n]*)?$/,
    'открытый ключ ssh: "ssh-ed25519 AAAA... комментарий"',
  );

/** MTProxyL (как reLabel, reHex, reTag агента). */
const MtLabel = /^[a-zA-Z0-9_][a-zA-Z0-9_-]{0,31}$/;
const MtArgs: Record<string, RegExp> = {
  label: MtLabel,
  new: MtLabel,
  secret: /^[0-9a-fA-F]{32}$/,
  version: /^v?[0-9][0-9A-Za-z.+-]{0,40}$/,
};
/** Аргументы операций MTProxyL: только известные ключи, каждый по своей регулярке. */
export const MtproxylArgs = z.record(z.string(), z.string().max(300)).superRefine((a, ctx) => {
  for (const [k, v] of Object.entries(a)) {
    const re = MtArgs[k];
    if (!re) ctx.addIssue({ code: 'custom', message: `неизвестный аргумент ${k}` });
    else if (!(k === 'secret' && v === '') && !re.test(v))
      ctx.addIssue({ code: 'custom', message: `аргумент ${k}: недопустимое значение` });
  }
});

/** port-sync (как CheckPortsyncConfig агента). */
const PortSpec = z
  .string()
  .regex(/^[0-9]{1,5}(\/(tcp|udp))?$/, 'порт: 443 или 443/tcp')
  .refine((p) => {
    const n = Number(p.split('/')[0]);
    return n >= 1 && n <= 65535;
  }, 'порт вне 1-65535');
const IpOrCidr = z.string().refine((s) => {
  const [ip, bits, extra] = s.split('/');
  if (extra !== undefined || !ip) return false;
  const v = isIP(ip);
  if (!v) return false;
  if (bits === undefined) return true;
  const b = Number(bits);
  return /^[0-9]{1,3}$/.test(bits) && b <= (v === 4 ? 32 : 128);
}, 'не IP и не подсеть');
export const PortsyncConfig = z.object({
  admin_ips: z.array(IpOrCidr).max(200).default([]),
  deny_public_ports: z.array(PortSpec).max(500).default([]),
  extra_allow: z.array(PortSpec).max(500).default([]),
  known_processes: z
    .array(z.string().regex(/^[A-Za-z0-9._*-]{1,32}$/, 'имя процесса'))
    .max(200)
    .default([]),
  docker_policy: z.enum(['published', 'explicit']).default('published'),
  allow_ping: z.boolean().default(true),
  wan_interface: z
    .string()
    .regex(/^([A-Za-z0-9._-]{1,15})?$/, 'интерфейс')
    .refine((s) => s !== 'lo', 'lo - не внешний интерфейс')
    .default(''),
  ssh_port: z.number().int().min(0).max(65535).default(0),
});

/** Схема и тип протокола - одно и то же: расхождение не соберётся. */
const _portsync: z.ZodType<PortsyncConfigT, z.ZodTypeDef, unknown> = PortsyncConfig;
void _portsync;
