/**
 * Администратор панели из консоли сервера (vps-panel install и vps-panel admin вызывают его в
 * контейнере панели: node server/dist/cli.js <команда>). Ответ - JSON в stdout, ошибка - текст в
 * stderr и код выхода 1 (2 - администратор уже есть, 3 - его ещё нет).
 *
 *   admin-init [логин]    создать администратора со случайным паролем (логин пустой - случайный)
 *   admin-show            логин, включена ли 2FA, сколько открытых сессий
 *   admin-password        новый случайный пароль; все сессии закрываются
 *   admin-2fa             сбросить 2FA: настраивается при следующем входе; сессии закрываются
 *   admin-login <логин>   сменить логин
 */
import { gt } from 'drizzle-orm';
import { createDb } from './db/index.js';
import { sessions } from './db/schema.js';
import {
  LOGIN_RE,
  deleteAllSessions,
  initAdmin,
  randomLogin,
  randomPassword,
  resetTotp,
  setLogin,
  setPassword,
  theAdmin,
} from './lib/auth.js';

class CliError extends Error {
  constructor(
    message: string,
    readonly code = 1,
  ) {
    super(message);
  }
}

function checkLogin(login: string) {
  if (!LOGIN_RE.test(login))
    throw new CliError(
      `логин "${login}": 3-32 символа, латиница, цифры, точка, дефис, подчёркивание`,
    );
  return login;
}

async function main(argv: string[]) {
  const [cmd = '', arg = ''] = argv;
  const db = createDb(process.env.DATA_DIR ?? './data');
  const need = async () => {
    const a = await theAdmin(db);
    if (!a) throw new CliError('администратора ещё нет: vps-panel admin init', 3);
    return a;
  };
  switch (cmd) {
    case 'admin-init': {
      const r = await initAdmin(db, arg ? checkLogin(arg) : randomLogin());
      if (!r)
        throw new CliError('администратор уже есть: сброс пароля - vps-panel admin password', 2);
      return r;
    }
    case 'admin-show': {
      const a = await need();
      const open = (
        await db
          .select({ id: sessions.id })
          .from(sessions)
          .where(gt(sessions.expiresAt, new Date().toISOString()))
      ).length;
      return { login: a.login, totpEnabled: a.totpEnabled, sessions: open };
    }
    case 'admin-password': {
      const a = await need();
      const password = randomPassword();
      await setPassword(db, a.id, password);
      await deleteAllSessions(db, a.id);
      return { login: a.login, password };
    }
    case 'admin-2fa': {
      const a = await need();
      await resetTotp(db, a.id);
      await deleteAllSessions(db, a.id);
      return { login: a.login };
    }
    case 'admin-login': {
      const a = await need();
      const login = checkLogin(arg);
      await setLogin(db, a.id, login);
      return { login };
    }
    default:
      throw new CliError(
        `неизвестная команда "${cmd}": admin-init, admin-show, admin-password, admin-2fa, admin-login`,
      );
  }
}

main(process.argv.slice(2)).then(
  (r) => {
    process.stdout.write(`${JSON.stringify(r)}\n`);
    process.exit(0);
  },
  (e: Error) => {
    process.stderr.write(`${e.message}\n`);
    process.exit(e instanceof CliError ? e.code : 1);
  },
);
