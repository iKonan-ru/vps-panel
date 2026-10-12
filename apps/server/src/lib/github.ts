/**
 * Ошибка ответа GitHub API человеческим текстом. Без токена GitHub даёт 60 запросов в час с
 * одного адреса: исчерпанный лимит - 403 или 429 с x-ratelimit-remaining: 0 (голый код "403"
 * читался как запрет доступа).
 */
export function githubError(r: Response): Error {
  if ((r.status === 403 || r.status === 429) && r.headers.get('x-ratelimit-remaining') === '0') {
    const reset = Number(r.headers.get('x-ratelimit-reset'));
    const left = Number.isFinite(reset) ? Math.ceil((reset * 1000 - Date.now()) / 60_000) : 0;
    return new Error(
      `лимит запросов GitHub исчерпан (60 в час с адреса сервера)${
        left > 0 ? `, сбросится через ${left} мин` : ''
      } - повтор при следующей проверке`,
    );
  }
  return new Error(`GitHub: ${r.status}`);
}
