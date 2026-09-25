import assert from 'node:assert/strict';
import { mkdir, rm } from 'node:fs/promises';
import { after, before, describe, test } from 'node:test';

import { createClient as createLibsql } from '@libsql/client';
import pg from 'pg';

import { connectionSettings, createClient } from '../src/client.js';
import { copyDatabase, verifyCopy } from '../src/copy.js';
import { convertSchema } from '../src/schema.js';
import { TEST_DATABASE_URL, createTestDatabase } from './helpers/testdb.js';

/**
 * End to end: a SQLite file made with @libsql/client, its schema converted
 * and applied, its rows copied, counts verified, then --upsert and
 * --truncate exercised the way a cutover uses them.
 */
const SQLITE_SCHEMA = `
CREATE TABLE users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  email TEXT NOT NULL UNIQUE,
  is_admin BOOLEAN NOT NULL DEFAULT 0,
  joined_at INTEGER,
  avatar BLOB,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE posts (
  id INTEGER PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id),
  title TEXT NOT NULL,
  score REAL,
  flags INTEGER DEFAULT 0,
  published_at DATETIME
);
CREATE TABLE tags (post_id INTEGER REFERENCES posts(id), tag TEXT, PRIMARY KEY (post_id, tag)) WITHOUT ROWID;
CREATE TABLE audit (id INTEGER PRIMARY KEY AUTOINCREMENT, what TEXT);
CREATE VIRTUAL TABLE posts_fts USING fts5(title, content='posts', content_rowid='id');
`;

describe('libsql-pg copy', { skip: TEST_DATABASE_URL ? false : 'TEST_DATABASE_URL not set' }, () => {
  const dir = new URL('./.tmp/', import.meta.url);
  const file = new URL(`./copy-${process.pid}.db`, dir);
  let db;
  let src;
  const logs = [];
  const log = (l) => logs.push(l);

  before(async () => {
    await mkdir(dir, { recursive: true });
    await rm(file, { force: true });
    src = createLibsql({ url: `file:${file.pathname}` });
    await src.executeMultiple(SQLITE_SCHEMA);
    const users = [];
    for (let i = 1; i <= 250; i++) users.push({ sql: 'insert into users (email, is_admin, joined_at, avatar) values (?, ?, ?, ?)', args: [`u${i}@x.io`, i % 7 === 0 ? 1 : 0, 1700000000 + i, i === 1 ? new Uint8Array([1, 2, 3]) : null] });
    await src.batch(users, 'write');
    const posts = [];
    for (let i = 1; i <= 1000; i++) posts.push({ sql: 'insert into posts (user_id, title, score, flags, published_at) values (?, ?, ?, ?, ?)', args: [((i - 1) % 250) + 1, `Post ${i}\twith tab\nand newline`, i / 10, i % 3, i % 2 ? '2024-01-01 10:00:00' : 1705000000 + i] });
    await src.batch(posts, 'write');
    await src.batch(
      [1, 2, 3].flatMap((p) => ['a', 'b'].map((t) => ({ sql: 'insert into tags (post_id, tag) values (?, ?)', args: [p, t] }))),
      'write',
    );
    await src.execute("insert into audit (what) values ('boot'), ('tick')");
    db = await createTestDatabase();
    const target = createClient({ url: db.url, pool: { max: 2 } });
    await target.executeMultiple(convertSchema(SQLITE_SCHEMA));
    await target.close();
  });
  after(async () => {
    src?.close();
    await db?.drop();
    await rm(file, { force: true });
  });

  const opts = () => ({ from: `file:${file.pathname}`, to: db.url, log, batch: 100 });

  test('copies every user table, FK parents first, with types coerced', async () => {
    const reports = await copyDatabase(opts());
    assert.deepEqual(
      reports.map((r) => r.table),
      ['audit', 'users', 'posts', 'tags'],
    );
    assert.deepEqual(reports.map((r) => r.rows), [2, 250, 1000, 6]);
    assert.ok(!reports.some((r) => r.table.includes('fts')), 'FTS shadow tables are not copied');

    const pool = new pg.Pool({ ...connectionSettings(db.url, undefined), max: 1 });
    try {
      const u = await pool.query("select is_admin, joined_at, avatar, created_at from users where email = 'u7@x.io'");
      assert.equal(u.rows[0].is_admin, true);
      assert.equal(u.rows[0].joined_at, '1700000007');
      const a = await pool.query("select avatar from users where email = 'u1@x.io'");
      assert.deepEqual([...a.rows[0].avatar], [1, 2, 3]);
      const p = await pool.query('select title, score, published_at from posts where id in (1, 2) order by id');
      assert.equal(p.rows[0].title, 'Post 1\twith tab\nand newline');
      assert.equal(p.rows[0].score, 0.1);
      assert.ok(p.rows[0].published_at instanceof Date);
      assert.equal(p.rows[1].published_at.toISOString(), new Date((1705000000 + 2) * 1000).toISOString());
      // Sequences moved past the copied ids: the app's next insert works.
      const next = await pool.query("insert into users (email) values ('new@x.io') returning id");
      assert.equal(Number(next.rows[0].id), 251);
      const nextAudit = await pool.query("insert into audit (what) values ('after') returning id");
      assert.equal(Number(nextAudit.rows[0].id), 3);
      await pool.query("delete from users where email = 'new@x.io'");
      await pool.query("delete from audit where what = 'after'");
    } finally {
      await pool.end();
    }
  });

  test('a second plain run skips tables that already have rows', async () => {
    const reports = await copyDatabase(opts());
    assert.ok(reports.every((r) => r.mode === 'skipped'));
  });

  test('--verify compares counts', async () => {
    const v = await verifyCopy({ ...opts() });
    assert.equal(v.ok, true);
    assert.deepEqual(v.rows.map((r) => r.table), ['audit', 'posts', 'tags', 'users']);
  });

  test('--truncate on a parent with children errors instead of cascading', async () => {
    await assert.rejects(copyDatabase({ ...opts(), tables: ['users'], truncate: true }), /cannot truncate a table referenced in a foreign key constraint|violates foreign key/);
    const v = await verifyCopy({ ...opts(), tables: ['posts'] });
    assert.equal(v.ok, true, 'children were not wiped');
  });

  test('--truncate on a leaf table reloads it', async () => {
    const reports = await copyDatabase({ ...opts(), tables: ['audit'], truncate: true });
    assert.equal(reports[0].mode, 'truncate');
    assert.equal(reports[0].rows, 2);
  });

  test('--upsert refreshes a parent in place: changed rows updated, deleted rows removed, sequences reset, identity kept out of SET', async () => {
    await src.execute("update users set email = 'changed@x.io' where id = 5");
    await src.execute("insert into users (email) values ('u251@x.io'), ('u252@x.io')");
    // Copy the two new rows first, then delete one at the source so the
    // upsert has a stale row to remove (252 has no posts, so SQLite allows it).
    await copyDatabase({ ...opts(), tables: ['users'], upsert: true });
    await src.execute('delete from users where id = 252');
    const reports = await copyDatabase({ ...opts(), tables: ['users'], upsert: true });
    assert.equal(reports[0].mode, 'upsert');
    const pool = new pg.Pool({ ...connectionSettings(db.url, undefined), max: 1 });
    try {
      assert.equal((await pool.query('select email from users where id = 5')).rows[0].email, 'changed@x.io');
      assert.equal((await pool.query('select count(*)::int as n from users where id = 252')).rows[0].n, 0);
      assert.equal((await pool.query("select id from users where email = 'u251@x.io'")).rows[0].id, '251');
      const next = await pool.query("insert into users (email) values ('n@x.io') returning id");
      assert.equal(Number(next.rows[0].id), 252);
    } finally {
      await pool.end();
    }
    const v = await verifyCopy({ ...opts(), tables: ['users'] });
    assert.equal(v.ok, false, 'the extra local insert shows up in verify');
  });

  test('--upsert on a table without a primary key is refused with a hint', async () => {
    const pool = new pg.Pool({ ...connectionSettings(db.url, undefined), max: 1 });
    await pool.query('create table nopk (a bigint)');
    await pool.end();
    await src.execute('create table nopk (a integer)');
    await assert.rejects(copyDatabase({ ...opts(), tables: ['nopk'], upsert: true }), /nopk: no primary key, cannot --upsert/);
  });

  test('dry run only plans', async () => {
    const reports = await copyDatabase({ ...opts(), dryRun: true });
    assert.ok(reports.every((r) => r.mode === 'dry-run'));
    assert.ok(logs.some((l) => /table\(s\):/.test(l)));
  });

  test('a table missing from Postgres is skipped with a message', async () => {
    await src.execute('create table only_here (a integer)');
    const reports = await copyDatabase({ ...opts(), tables: ['only_here'] });
    assert.equal(reports[0].mode, 'skipped');
    assert.match(reports[0].skipped, /not in Postgres/);
  });
});
