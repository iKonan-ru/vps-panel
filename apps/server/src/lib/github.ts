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
        left > 0 ? `, сбросится через ${left}\u00a0мин` : ''
      }, повтор при следующей проверке`,
    );
  }
  return new Error(`GitHub: ${r.status}`);
}

/** Релиз GitHub - поля, которые читает панель. */
export interface GithubRelease {
  tag_name: string;
  html_url: string;
  published_at: string;
  draft: boolean;
  prerelease: boolean;
  body: string | null;
  target_commitish: string;
  assets: { name: string; browser_download_url: string; size: number }[];
}

export type FetchOut = (url: string, init?: RequestInit) => Promise<Response>;

/**
 * Релизы репозитория, новые сверху. Ошибка - текстом githubError; исчерпанный лимит запросов -
 * с rateLimited: остальные репозитории спрашивать бесполезно.
 */
export async function githubReleases(
  fetchOut: FetchOut,
  repo: string,
  perPage: number,
): Promise<GithubRelease[]> {
  const r = await fetchOut(`https://api.github.com/repos/${repo}/releases?per_page=${perPage}`, {
    headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'vps-panel' },
  });
  if (r.ok) return (await r.json()) as GithubRelease[];
  const limited =
    (r.status === 403 || r.status === 429) && r.headers.get('x-ratelimit-remaining') === '0';
  throw Object.assign(githubError(r), { rateLimited: limited });
}
