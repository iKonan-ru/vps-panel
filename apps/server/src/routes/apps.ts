import type { FastifyInstance } from 'fastify';
import type { AppReleases } from '../lib/apps.js';

/** Ссылки на клиентские приложения: последние релизы GitHub. */
export async function appRoutes(app: FastifyInstance, opts: { apps: AppReleases }) {
  const { apps } = opts;

  app.get('/api/apps', async () => apps.list());

  app.post('/api/apps/refresh', async () => {
    await apps.refresh(false);
    return apps.list();
  });
}
