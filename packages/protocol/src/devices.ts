/**
 * Устройство клиента VPN: от него зависят MTU конфига и приложение для подключения (os -
 * платформа в списке приложений). Список совпадает с reAwgDevice в агенте: меняются вместе.
 */
export const DEVICES = [
  { id: 'android', title: 'Android', mtu: 1280, os: 'android' },
  { id: 'ios', title: 'iPhone/iPad', mtu: 1280, os: 'ios' },
  { id: 'windows', title: 'Windows', mtu: 1376, os: 'windows' },
  { id: 'macos', title: 'macOS', mtu: 1376, os: 'macos' },
  { id: 'linux', title: 'Linux', mtu: 1376, os: 'linux' },
  { id: 'router', title: 'роутер', mtu: 1280, os: null },
  { id: 'other', title: 'другое', mtu: 1280, os: null },
] as const;

export type DeviceId = (typeof DEVICES)[number]['id'];
export const DEVICE_IDS = DEVICES.map((d) => d.id) as [DeviceId, ...DeviceId[]];

/** Устройство по коду; неизвестный или пустой код - undefined. */
export function deviceOf(id: string | undefined) {
  return DEVICES.find((d) => d.id === id);
}

/** Подпись устройства: "роутер: дача", без имени - тип, без типа - имя. */
export function deviceLabel(d: { type: string; name: string }): string {
  return [deviceOf(d.type)?.title, d.name].filter(Boolean).join(': ') || 'устройство';
}
