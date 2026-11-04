import { z } from 'zod';

export const SshPortChangeSchema = z.object({
  port: z
    .number()
    .int()
    .refine((p) => p === 22 || (p >= 1024 && p <= 65535), 'порт: 1024-65535 или 22'),
  externalFirewallReady: z.literal(true),
});
export type SshPortChange = z.infer<typeof SshPortChangeSchema>;
export interface SshPortPrepared {
  token: string;
  port: number;
  oldPorts: number[];
  fingerprints: string[];
}
