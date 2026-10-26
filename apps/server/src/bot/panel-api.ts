import type { InjectOptions, LightMyRequestResponse } from 'fastify';
import { internalHeaders } from '../lib/internal-auth.js';

/** Ошибка API панели: статус и текст ответа. */
export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

/** Нет того, что открывают (сервер, клиент, контейнер): кнопка из старого сообщения. */
export class NotFound extends ApiError {
  constructor(readonly what: string) {
    super(404, 'не найдено: возможно, удалено');
  }
}

export const isNotFound = (e: unknown) => e instanceof ApiError && e.status === 404;

export type Inject = (o: InjectOptions) => Promise<LightMyRequestResponse>;

/** Запросы бота к API панели (изменения - с пометкой "из Telegram" в журнале действий). */
export interface PanelApi {
  get<T>(url: string): Promise<T>;
  post<T>(url: string, body?: unknown): Promise<T>;
  put<T>(url: string, body?: unknown): Promise<T>;
  patch<T>(url: string, body?: unknown): Promise<T>;
  delete<T>(url: string): Promise<T>;
}

function errorText(res: LightMyRequestResponse): string {
  try {
    return (JSON.parse(res.body) as { error?: string }).error ?? res.body.slice(0, 300);
  } catch {
    return res.body.slice(0, 300);
  }
}

/** API панели через app.inject: бот видит и делает то же, что интерфейс. */
export function panelApi(inject: Inject): PanelApi {
  const write = async <T>(
    method: 'POST' | 'PUT' | 'PATCH' | 'DELETE',
    url: string,
    body?: unknown,
  ): Promise<T> => {
    const res = await inject({
      method,
      url,
      ...(method === 'DELETE'
        ? { headers: internalHeaders('telegram') }
        : {
            headers: { ...internalHeaders('telegram'), 'content-type': 'application/json' },
            payload: JSON.stringify(body ?? {}),
          }),
    });
    if (res.statusCode >= 400) throw new ApiError(res.statusCode, errorText(res));
    return (res.body ? res.json() : {}) as T;
  };
  return {
    get: async <T>(url: string): Promise<T> => {
      const res = await inject({ method: 'GET', url, headers: internalHeaders() });
      if (res.statusCode === 404) throw new NotFound(url);
      if (res.statusCode !== 200)
        throw new ApiError(res.statusCode, `${url}: ${res.statusCode} ${res.body.slice(0, 200)}`);
      return res.json() as T;
    },
    post: (url, body) => write('POST', url, body),
    put: (url, body) => write('PUT', url, body),
    patch: (url, body) => write('PATCH', url, body),
    delete: (url) => write('DELETE', url),
  };
}
