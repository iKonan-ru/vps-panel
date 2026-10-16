export class ApiError extends Error {
  constructor(
    public status: number,
    message: string,
    /** Код ошибки панели (no-token и т.п.): проверять по нему, а не по тексту. */
    public code?: string,
  ) {
    super(message);
  }
}

/**
 * Ответ POST /api/servers/<id>/... с actionId: кнопки сервера блокируются сразу, не дожидаясь
 * свежей карточки с activeActions.
 */
let actionStarted: ((serverId: string, actionId: string) => void) | null = null;
export function onActionStarted(fn: (serverId: string, actionId: string) => void) {
  actionStarted = fn;
}

/** Запрос к панели: cookie-сессия, JSON, ошибки - ApiError. */
export async function api<T>(path: string, init?: RequestInit & { json?: unknown }): Promise<T> {
  const { json, ...rest } = init ?? {};
  const headers = new Headers(rest.headers);
  const req: RequestInit = { ...rest, headers, credentials: 'same-origin' };
  if (json !== undefined) {
    headers.set('content-type', 'application/json');
    req.body = JSON.stringify(json);
  }
  const res = await fetch(path, req);
  const text = await res.text();
  let data: unknown = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    // не JSON: страница прокси (502 во время выкладки) - ошибка с кодом ниже
    if (res.ok) throw new ApiError(res.status, 'ответ панели не в формате JSON');
  }
  if (!res.ok) {
    const msg =
      typeof data === 'object' && data !== null && 'error' in data && typeof data.error === 'string'
        ? data.error
        : `ошибка ${res.status}`;
    const code =
      typeof data === 'object' && data !== null && 'code' in data && typeof data.code === 'string'
        ? data.code
        : undefined;
    throw new ApiError(res.status, msg, code);
  }
  const m = /^\/api\/servers\/([^/?]+)\//.exec(path);
  if (m?.[1] && (rest.method ?? 'GET') !== 'GET' && typeof data === 'object' && data !== null) {
    const id = (data as { actionId?: unknown }).actionId;
    if (typeof id === 'string') actionStarted?.(decodeURIComponent(m[1]), id);
  }
  return data as T;
}
