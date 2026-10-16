import type { ServiceKind } from './agent.js';
import type { GService } from './clients.js';

/** Сервис каталога панели: как он называется в отчёте агента, у клиентов, в командах и копиях. */
export interface ServiceDef {
  /** Вид в отчёте агента. */
  kind: ServiceKind;
  /** Ключ привязки глобального клиента и доступа. */
  binding: GService;
  title: string;
  /** Команда каталога, которая ставит сервис. */
  install: string;
  /** Команда, которая его удаляет; у AWG - по контейнеру (AWG_CONTAINER). */
  uninstall: string;
  /** Компонент архива резервной копии; нет - данных сервиса в копии нет. */
  component?: string;
  /** Запись клиента в сервисе - одна на человека или на каждое устройство. */
  per: 'client' | 'device';
  /** Вкладка сервиса на странице сервера. */
  tab?: string;
}

/** Сервисы, которые ставит и ведёт панель, в порядке установки. */
export const SERVICES: readonly ServiceDef[] = [
  {
    kind: 'xui',
    binding: 'xui',
    title: '3X-UI',
    install: 'xui',
    uninstall: 'xui-uninstall',
    component: 'xui',
    per: 'client',
    tab: 'xui',
  },
  {
    kind: 'mtproxyl',
    binding: 'mtproxyl',
    title: 'MTProxyL',
    install: 'mtproxyl',
    uninstall: 'mtproxyl-uninstall',
    component: 'mtproxyl',
    per: 'client',
    tab: 'mtproxyl',
  },
  {
    kind: 'amnezia',
    binding: 'awg',
    title: 'AmneziaWG',
    install: 'awg',
    uninstall: 'awg-uninstall',
    component: 'amnezia',
    per: 'device',
    tab: 'awg',
  },
  {
    kind: 'wdtt',
    binding: 'wdtt',
    title: 'WDTT',
    install: 'wdtt',
    uninstall: 'wdtt-uninstall',
    component: 'wdtt',
    per: 'client',
    tab: 'wdtt',
  },
  {
    kind: 'openflux',
    binding: 'openflux',
    title: 'OpenFlux',
    install: 'openflux',
    uninstall: 'openflux-uninstall',
    per: 'device',
    tab: 'openflux',
  },
  {
    kind: 'naive',
    binding: 'naive',
    title: 'Прокси для браузера',
    install: 'naive',
    uninstall: 'naive-uninstall',
    per: 'client',
  },
];

export const serviceByKind = (kind: string) => SERVICES.find((s) => s.kind === kind);
export const serviceByBinding = (binding: string) => SERVICES.find((s) => s.binding === binding);
export const serviceByCommand = (command: string) => SERVICES.find((s) => s.install === command);

/** Основной контейнер AWG; дополнительные - amnezia-awg2-<порт>. */
export const AWG_MAIN = 'amnezia-awg2';
export const awgContainerName = (extraPort?: number | string) =>
  extraPort ? `${AWG_MAIN}-${extraPort}` : AWG_MAIN;
