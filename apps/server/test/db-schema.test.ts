import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { is } from 'drizzle-orm';
import { SQLiteTable, getTableConfig } from 'drizzle-orm/sqlite-core';
import { describe, expect, it } from 'vitest';
import { createDb } from '../src/db/index.js';
import * as schema from '../src/db/schema.js';

const tables = Object.values(schema).filter((v) => is(v, SQLiteTable)) as SQLiteTable[];

function columnsOf(file: string, table: string): string[] {
  const db = new Database(file, { readonly: true });
  const cols = (db.prepare(`pragma table_info(${table})`).all() as { name: string }[]).map(
    (c) => c.name,
  );
  db.close();
  return cols;
}

describe('database schema', () => {
  it('a fresh database has every column of schema.ts', () => {
    const dir = mkdtempSync(join(tmpdir(), 'vps-schema-'));
    try {
      createDb(dir);
      const file = join(dir, 'panel.db');
      expect(tables.length).toBeGreaterThan(5);
      for (const t of tables) {
        const cfg = getTableConfig(t);
        const have = columnsOf(file, cfg.name);
        for (const c of cfg.columns) expect(have, `${cfg.name}.${c.name}`).toContain(c.name);
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('новая база - сразу итоговой версии; повторный запуск ничего не ломает', () => {
    const dir = mkdtempSync(join(tmpdir(), 'vps-ver-'));
    try {
      createDb(dir);
      createDb(dir);
      const db = new Database(join(dir, 'panel.db'), { readonly: true });
      expect(db.pragma('user_version', { simple: true })).toBe(22);
      db.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('шаг 22: база версии 21 получает таблицу каскадов', () => {
    const dir = mkdtempSync(join(tmpdir(), 'vps-s22-'));
    try {
      createDb(dir);
      const raw = new Database(join(dir, 'panel.db'));
      raw.exec('drop table vless_cascade');
      raw.pragma('user_version = 21');
      raw.close();
      createDb(dir);
      const db = new Database(join(dir, 'panel.db'), { readonly: true });
      expect(db.pragma('user_version', { simple: true })).toBe(22);
      expect(columnsOf(join(dir, 'panel.db'), 'vless_cascade')).toContain('exit_inbound_id');
      db.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('шаг 20: база версии 19 получает client_host, данные на месте', () => {
    const dir = mkdtempSync(join(tmpdir(), 'vps-s20-'));
    try {
      createDb(dir);
      const raw = new Database(join(dir, 'panel.db'));
      // база как до шага: без столбца и с версией 19
      raw.exec("insert into server (id, name, host) values ('s', 's', '203.0.113.1')");
      raw.exec('alter table server drop column client_host');
      raw.pragma('user_version = 19');
      raw.close();
      createDb(dir);
      const db = new Database(join(dir, 'panel.db'), { readonly: true });
      expect(db.pragma('user_version', { simple: true })).toBe(22);
      expect(db.prepare('select host, client_host from server').get()).toEqual({
        host: '203.0.113.1',
        client_host: null,
      });
      db.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('база старее итоговой версии не поднимается - понятная ошибка, данные не тронуты', () => {
    const dir = mkdtempSync(join(tmpdir(), 'vps-old-'));
    try {
      const file = join(dir, 'panel.db');
      const old = new Database(file);
      old.exec('create table server (id text primary key, name text not null, host text not null)');
      old.pragma('user_version = 7');
      old.close();
      expect(() => createDb(dir)).toThrow(/версии 7 старее поддерживаемой \(19\)/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
