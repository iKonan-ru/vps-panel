import { readFileSync, writeFileSync } from 'node:fs';
import { decryptBackup } from './lib/panel-backup.js';

/** stdin: зашифрованная копия панели, stdout: tar.gz; пароль - BACKUP_PASSWORD. */
const pass = process.env.BACKUP_PASSWORD;
if (!pass) {
  console.error('BACKUP_PASSWORD не задан');
  process.exit(1);
}
try {
  const data = readFileSync(0);
  writeFileSync(1, decryptBackup(data, pass));
} catch (e) {
  console.error((e as Error).message);
  process.exit(1);
}
