import { buildApp } from './app.js';
import { loadEnv } from './config.js';

const env = loadEnv();
const { app } = await buildApp({ env });
await app.listen({ host: env.PANEL_HOST, port: env.PANEL_PORT });
app.log.info(`Панель: ${env.PANEL_PUBLIC_URL} (данные в ${env.DATA_DIR})`);
