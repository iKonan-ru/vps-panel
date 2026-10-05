export class ApiError extends Error {
  constructor(
    public status: number,
    message: string,
    /** Код ошибки панели, если она его дала (no-token и т.п.): по нему, а не по тексту. */
    public code?: string,
  ) {
    super(message);
  }
}

/** Единая точка запросов к панели. Cookie-сессия, JSON, ошибки в ApiError. */
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
    if (res.ok) throw new ApiError(res.status, 'Панель ответила не JSON');
  }
  if (!res.ok) {
    const msg =
      typeof data === 'object' && data !== null && 'error' in data && typeof data.error === 'string'
        ? data.error
        : `Ошибка ${res.status}`;
    const code =
      typeof data === 'object' && data !== null && 'code' in data && typeof data.code === 'string'
        ? data.code
        : undefined;
    throw new ApiError(res.status, msg, code);
  }
  return data as T;
}
