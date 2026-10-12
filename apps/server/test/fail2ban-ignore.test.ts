import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { IGNORE_FILE, ignoreList, plainIp, writeIgnoreFile } from '../src/lib/fail2ban-ignore.js';

const dir = mkdtempSync(join(tmpdir(), 'f2b-'));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe('fail2ban панели: IP своих серверов не банятся', () => {
  it('адреса серверов, имена - в адреса, адреса агентов; без повторов', async () => {
    const list = await ignoreList(
      ['203.0.113.10', 'srv.example.com', 'bad name; rm -rf /', '2001:db8::1'],
      ['::ffff:198.51.100.7', '203.0.113.10', undefined, 'garbage'],
      async (name) => (name === 'srv.example.com' ? ['198.51.100.20'] : []),
    );
    expect(list).toEqual(['198.51.100.20', '198.51.100.7', '2001:db8::1', '203.0.113.10']);
  });

  it('имя не разрешилось - остальные адреса на месте', async () => {
    const list = await ignoreList(['nx.example.com', '203.0.113.5'], [], async () => {
      throw new Error('ENOTFOUND');
    });
    expect(list).toEqual(['203.0.113.5']);
  });

  it('файл - по адресу в строке (grep -qxF в ignorecommand), переписывается при изменении', () => {
    expect(writeIgnoreFile(dir, ['203.0.113.5', '203.0.113.6'])).toBe(true);
    expect(readFileSync(join(dir, IGNORE_FILE), 'utf8')).toBe('203.0.113.5\n203.0.113.6\n');
    expect(writeIgnoreFile(dir, ['203.0.113.5', '203.0.113.6'])).toBe(false);
    expect(writeIgnoreFile(dir, [])).toBe(true);
    expect(readFileSync(join(dir, IGNORE_FILE), 'utf8')).toBe('');
    expect(plainIp('::ffff:10.0.0.1')).toBe('10.0.0.1');
  });
});
