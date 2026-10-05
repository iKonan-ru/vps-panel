/** Версия протокола панель-агент. Мажор меняется при несовместимых правках. */
export const PROTOCOL_VERSION = '1.0';

export function isCompatible(agentVersion: string): boolean {
  const [major] = agentVersion.split('.');
  const [ourMajor] = PROTOCOL_VERSION.split('.');
  return major === ourMajor;
}
