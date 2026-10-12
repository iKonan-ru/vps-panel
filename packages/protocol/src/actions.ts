/** Человеческие названия действий для журнала. */
export const actionTitles: Record<string, string> = {
  'baseline.apply': 'Исправление проблем',
  'firewall.enable': 'Включить firewall',
  'firewall.disable': 'Выключить firewall',
  'portsync.run': 'Пересчитать port-sync',
  'portsync.config': 'Настройки port-sync',
  'firewall.rules': 'Правила firewall',
  'docker.start': 'Docker: запуск',
  'docker.stop': 'Docker: остановка',
  'docker.restart': 'Docker: перезапуск',
  'docker.remove': 'Docker: удаление',
  'system.reboot': 'Перезагрузка',
  'system.upgrade': 'Обновление пакетов',
  'ssh.keys.add': 'Добавление SSH-ключей root',
  'panel.backup': 'Бэкап панели',
  'gclients.sync': 'Глобальные клиенты: сверка',
  'ssh.keys.remove': 'Удаление SSH-ключа root',
  'ssh.keys.comment': 'Комментарий SSH-ключа root',
  'agent.install': 'Установка агента',
  'backup.create': 'Создание бэкапа',
  'backup.restore': 'Восстановление бэкапа',
  'cert.issue': 'Выпуск сертификата',
  'cert.renew': 'Продление сертификата',
  'cert.consumers': 'Применение сертификата',
  'cert.remove': 'Удаление сертификата',
  'agent.update': 'Обновление агента',
  terminal: 'Терминал',
  cleanup: 'Очистка диска',
  'xui:set': '3X-UI: настройки',
  'xui:restart': '3X-UI: перезапуск',
  'xui:restart-xray': '3X-UI: перезапуск Xray',
  'xui:start': '3X-UI: запуск',
  'xui:stop': '3X-UI: остановка',
  'xui:enable': '3X-UI: автозапуск',
  'xui:disable': '3X-UI: без автозапуска',
  'xui:update': '3X-UI: обновление',
  'xui:xray': '3X-UI: обновление Xray',
  'server:ip': 'Смена IP-адреса сервера',
  'xui:token': '3X-UI: API-токен',
  'awg:client.add': 'AWG: новый клиент',
  'wdtt:password.add': 'WDTT: новый пароль',
  'wdtt:password.update': 'WDTT: изменение пароля',
  'wdtt:password.activate': 'WDTT: пароль включён',
  'wdtt:password.deactivate': 'WDTT: пароль выключен',
  'wdtt:password.delete': 'WDTT: пароль удалён',
  'wdtt:password.unbind-device': 'WDTT: отвязка устройства',
  'awg:client.remove': 'AWG: удаление клиента',
  'awg:client.disable': 'AWG: выключение клиента',
  'awg:client.enable': 'AWG: включение клиента',
  'awg:client.rename': 'AWG: переименование клиента',
  'awg:instance.setparams': 'AWG: смена версии и параметров',
  // действий больше нет (переход с Amnezia Web Panel), названия - для истории журнала
  'awg:import': 'AWG: перенос ключей клиентов AWP в панель',
  'awg:table.stripkeys': 'AWG: ключи клиентов AWP убраны с сервера',
  'awp:key.remove': 'Снятие ключа Amnezia Web Panel',
  'mtproxyl:update': 'MTProxyL: обновление',
  'mtproxyl:restart': 'MTProxyL: перезапуск',
  'mtproxyl:port.set': 'MTProxyL: порт',
  'mtproxyl:settings.set': 'MTProxyL: настройка',
  'mtproxyl:panel.update': 'MTProxyL: обновление панели',
  'mtproxyl:panel.restart': 'MTProxyL: перезапуск панели',
  'mtproxyl:engine.versions': 'MTProxyL: версии движка',
  'mtproxyl:engine.update': 'MTProxyL: обновление движка',
};

/**
 * Действия, которые не занимают сервер: терминал и чтения (ссылка и версии движка MTProxyL,
 * токен 3X-UI).
 */
const NON_BLOCKING = new Set([
  'terminal',
  'mtproxyl:secret.link',
  'mtproxyl:engine.versions',
  'xui:token',
]);

/**
 * Занимает ли действие сервер: пока идёт такое действие, другие изменения на этом сервере
 * не запускаются (кнопки неактивны, панель отвечает 409).
 */
export function isBlockingAction(kind: string): boolean {
  return !NON_BLOCKING.has(kind);
}

/** Название действия для человека; у команд каталога - её заголовок из параметров. */
/** Строка журнала действий в списках (без вывода: он - в /api/actions/:id). */
export interface ActionListRow {
  id: string;
  serverId: string | null;
  kind: string;
  params: Record<string, unknown>;
  startedAt: string;
  finishedAt: string | null;
  exitCode: number | null;
}

export function actionTitle(kind: string, params?: Record<string, unknown>): string {
  if (kind.startsWith('command:') && typeof params?.title === 'string')
    return `команда "${params.title}"`;
  return actionTitles[kind] ?? kind.replace('command:', 'Команда ');
}
