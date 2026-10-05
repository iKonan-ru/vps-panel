import type { Metrics } from '@vps/protocol';
import type { WebSocket } from 'ws';

/** События для интерфейса: браузер по ним обновляет данные. */
export type UiEvent =
  | { type: 'server.online'; serverId: string }
  | { type: 'server.offline'; serverId: string }
  | { type: 'server.metrics'; serverId: string; metrics: Metrics }
  | { type: 'server.inventory'; serverId: string }
  | { type: 'server.changed'; serverId?: string }
  | { type: 'action.started'; serverId: string; actionId: string; kind: string }
  | { type: 'action.stream'; serverId: string; actionId: string; channel: string; chunk: string }
  | { type: 'action.finished'; serverId: string; actionId: string; exitCode: number }
  | { type: 'agents.rollout' };

export class UiHub {
  private clients = new Set<WebSocket>();
  private watchers = new Set<(count: number) => void>();

  add(ws: WebSocket) {
    this.clients.add(ws);
    this.changed();
    const drop = () => {
      if (this.clients.delete(ws)) this.changed();
    };
    ws.on('close', drop);
    ws.on('error', drop);
  }

  /** Сколько вкладок панели на связи; onCount - при каждом изменении (частота метрик). */
  get count(): number {
    return this.clients.size;
  }
  onCount(fn: (count: number) => void) {
    this.watchers.add(fn);
  }
  private changed() {
    for (const fn of this.watchers) fn(this.clients.size);
  }

  broadcast(ev: UiEvent) {
    const msg = JSON.stringify(ev);
    for (const ws of this.clients) {
      if (ws.readyState === ws.OPEN) ws.send(msg);
    }
  }
}
