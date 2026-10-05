/** Операции MTProxyL, чей вывод содержит секрет пользователя (ссылки tg://proxy). */
export const MT_SECRET_OUTPUT_OPS = ['secret.add', 'secret.rotate', 'secret.link'];

/** Что пишется в журнал вместо такого вывода. */
export const SECRET_OUTPUT_NOTE = '(вывод не сохраняется: в нём секрет пользователя)';
