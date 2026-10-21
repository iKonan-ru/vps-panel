export interface Account {
  login: string;
  displayName: string;
  totpEnabled: boolean;
  backupCodesLeft: number;
  createdAt: string;
}

export interface Security {
  failed24: number;
  failed7d: number;
  topIps: { ip: string; n: number; last: string }[];
  recent: { ip: string; login: string; ok: boolean; at: string }[];
  sessions: {
    id: string;
    ip: string;
    userAgent: string;
    createdAt: string;
    expiresAt: string;
    current: boolean;
  }[];
}
