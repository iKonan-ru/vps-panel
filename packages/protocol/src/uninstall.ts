/** Ресурс полной очистки: owned подтверждает происхождение, иначе нужен явный выбор. */
export interface UninstallItem {
  id: string;
  title: string;
  owned: boolean;
  paths: string[];
  containers: string[];
  blockers: string[];
}

export interface UninstallPlan {
  revision: string;
  panelHost: boolean;
  items: UninstallItem[];
  preserved: string[];
  blockers: string[];
  connections?: UninstallConnections;
  detachServers?: { id: string; name: string; revision: string; ids: string[] }[];
}

/** Связи панели: предупреждение и подтверждение конкретного состава перед очисткой. */
export interface UninstallConnections {
  revision: string;
  items: { id: string; title: string; consequence: string; serverIds: string[] }[];
  blockers: string[];
}

export interface UninstallPrepared {
  token: string;
  fingerprints: string[];
  port: number;
}
