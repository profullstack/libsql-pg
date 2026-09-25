import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';

import { createClient } from '../src/client.js';
import { convertSchema } from '../src/schema.js';
import { TEST_DATABASE_URL, createTestDatabase } from './helpers/testdb.js';

const SCHEMA = `
CREATE TABLE users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  email TEXT NOT NULL UNIQUE,
  name TEXT,
  is_admin BOOLEAN NOT NULL DEFAULT 0,
  meta TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE posts (
  id INTEGER PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  slug TEXT NOT NULL,
  title TEXT NOT NULL,
  body TEXT,
  published_at DATETIME,
  UNIQUE (user_id, slug)
);
CREATE TABLE kv (k TEXT PRIMARY KEY, v TEXT);
CREATE TABLE settings (user_id INTEGER, key TEXT, value TEXT, UNIQUE (user_id, key));
CREATE VIRTUAL TABLE posts_fts USING fts5(title, body, content='posts', content_rowid='id');
`;

describe('createClient against Postgres', { skip: TEST_DATABASE_URL ? false : 'TEST_DATABASE_URL not set' }, () => {
  let db;
  let client;
  before(async () => {
    db = await createTestDatabase();
    client = createClient({ url: db.url, pool: { max: 4 } });
    await client.executeMultiple(convertSchema(SCHEMA));
  });
  after(async () => {
    await client?.close();
    await db?.drop();
  });

  test('url validation', () => {
    assert.throws(() => createClient({ url: 'libsql://x.turso.io' }), /postgres:\/\/ or postgresql:\/\/.*libsql-pg copy/s);
    assert.throws(() => createClient({ url: 'file:local.db' }), /file:/);
    assert.throws(() => createClient({}), /url/);
    const c = createClient({ url: db.url.replace('postgres://', 'postgresql://') });
    assert.equal(c.protocol, 'postgres');
    c.close();
  });

  test('execute with positional args, named args and { sql, args }', async () => {
    const r1 = await client.execute('insert into users (email, name) values (?, ?)', ['a@x.io', 'A']);
    assert.equal(r1.rowsAffected, 1);
    assert.equal(typeof r1.lastInsertRowid, 'bigint');
    assert.deepEqual(r1.rows, []);
    const r2 = await client.execute({ sql: 'insert into users (email, name) values (:email, :name)', args: { email: 'b@x.io', name: 'B' } });
    assert.equal(r2.lastInsertRowid, r1.lastInsertRowid + 1n);
    const r3 = await client.execute({ sql: 'select id, email, name from users where email = $email', args: { $email: 'a@x.io' } });
    assert.equal(r3.rows.length, 1);
    assert.equal(r3.rows[0].email, 'a@x.io');
    assert.equal(r3.rows[0][1], 'a@x.io');
    assert.equal(r3.rows[0].length, 3);
    assert.deepEqual(r3.columns, ['id', 'email', 'name']);
    assert.deepEqual(r3.columnTypes, ['INTEGER', 'TEXT', 'TEXT']);
    assert.equal(typeof r3.rows[0].id, 'number');
  });

  test('lastInsertRowid is undefined for a text primary key and when RETURNING is the app’s own', async () => {
    const r = await client.execute("insert into kv (k, v) values ('a', '1')");
    assert.equal(r.lastInsertRowid, undefined);
    const r2 = await client.execute("insert into users (email) values ('ret@x.io') returning id, email");
    assert.equal(r2.rows[0].email, 'ret@x.io');
    assert.equal(r2.lastInsertRowid, undefined);
  });

  test('booleans bind to boolean and to bigint columns, timestamps come back as ISO text', async () => {
    await client.execute('update users set is_admin = ? where email = ?', [true, 'a@x.io']);
    const r = await client.execute('select is_admin, created_at from users where email = ?', ['a@x.io']);
    assert.equal(r.rows[0].is_admin, true);
    assert.match(r.rows[0].created_at, /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/);
    const n = await client.execute('select count(*) as n from users where is_admin = ?', [true]);
    assert.equal(n.rows[0].n, 1);
  });

  test('UNIQUE, NOT NULL and FOREIGN KEY errors read like SQLite and keep the pg code', async () => {
    await assert.rejects(client.execute("insert into users (email) values ('a@x.io')"), (err) => {
      assert.equal(err.message, 'UNIQUE constraint failed: users.email');
      assert.equal(err.code, '23505');
      assert.equal(err.sqliteCode, 'SQLITE_CONSTRAINT_UNIQUE');
      return true;
    });
    await assert.rejects(client.execute("insert into posts (user_id, slug) values (1, 's')"), /NOT NULL constraint failed: posts.title/);
    await assert.rejects(client.execute("insert into posts (user_id, slug, title) values (9999, 's', 't')"), (err) => {
      assert.equal(err.message, 'FOREIGN KEY constraint failed');
      assert.equal(err.code, '23503');
      return true;
    });
    await assert.rejects(client.execute('select * from nope'), /no such table: nope/);
  });

  test('a multi-column unique index names every column', async () => {
    const u = (await client.execute("select id from users where email = 'a@x.io'")).rows[0].id;
    await client.execute("insert into posts (user_id, slug, title) values (?, 'hello', 'Hello')", [u]);
    await assert.rejects(client.execute("insert into posts (user_id, slug, title) values (?, 'hello', 'Again')", [u]), /UNIQUE constraint failed: posts.user_id, posts.slug/);
  });

  test('INSERT OR IGNORE and INSERT OR REPLACE', async () => {
    const ignored = await client.execute("insert or ignore into kv (k, v) values ('a', 'other')");
    assert.equal(ignored.rowsAffected, 0);
    await client.execute("insert or replace into kv (k, v) values ('a', 'replaced')");
    assert.equal((await client.execute("select v from kv where k = 'a'")).rows[0].v, 'replaced');
    // Unique index, no primary key.
    await client.execute("insert or replace into settings (user_id, key, value) values (1, 'theme', 'dark')");
    await client.execute("replace into settings (user_id, key, value) values (1, 'theme', 'light')");
    const s = await client.execute("select value, count(*) over () as n from settings where user_id = 1 and key = 'theme'");
    assert.equal(s.rows[0].value, 'light');
    assert.equal(s.rows[0].n, 1);
  });

  test('SQLite functions run through Postgres', async () => {
    await client.execute("update users set meta = '{\"plan\":\"pro\",\"tags\":[\"a\",\"b\"]}' where email = 'a@x.io'");
    const r = await client.execute(
      "select json_extract(meta, '$.plan') as plan, json_extract(meta, '$.tags[1]') as tag, lower(hex(randomblob(4))) as id, strftime('%s','now') as epoch, ifnull(name, 'none') as name from users where email = 'a@x.io'",
    );
    assert.equal(r.rows[0].plan, 'pro');
    assert.equal(r.rows[0].tag, 'b');
    assert.match(r.rows[0].id, /^[0-9a-f]{8}$/);
    assert.ok(Math.abs(r.rows[0].epoch - Date.now() / 1000) < 60);
    const g = await client.execute("select group_concat(email, ';') as all_emails from (select email from users order by email) x");
    assert.equal(g.rows[0].all_emails, 'a@x.io;b@x.io;ret@x.io');
    const recent = await client.execute("select count(*) as n from users where created_at > datetime('now', '-1 day')");
    assert.equal(recent.rows[0].n, 3);
    const dt = await client.execute("update posts set published_at = datetime('now') where slug = 'hello' returning published_at");
    assert.match(dt.rows[0].published_at, /^\d{4}-/);
  });

  test('PRAGMA is a no-op with an empty result', async () => {
    const r = await client.execute('PRAGMA foreign_keys = ON');
    assert.deepEqual(r.rows, []);
    assert.equal(r.rowsAffected, 0);
  });

  test('MATCH against the FTS5 table throws before reaching Postgres', async () => {
    await assert.rejects(client.execute('select rowid from posts_fts where posts_fts match ?', ['hello']), /"posts_fts".*FTS5 to tsvector/s);
  });

  test('the tsvector column the converter made works instead', async () => {
    const r = await client.execute("select title from posts where search @@ websearch_to_tsquery('english', ?)", ['hello']);
    assert.equal(r.rows[0].title, 'Hello');
  });

  test('batch runs in one transaction and rolls back as a whole', async () => {
    const results = await client.batch(
      [
        { sql: "insert into kv (k, v) values (?, ?)", args: ['b1', '1'] },
        "insert into kv (k, v) values ('b2', '2')",
        { sql: 'select count(*) as n from kv where k like ?', args: ['b%'] },
      ],
      'write',
    );
    assert.equal(results.length, 3);
    assert.equal(results[2].rows[0].n, 2);
    await assert.rejects(client.batch(["insert into kv (k, v) values ('b3', '3')", "insert into kv (k, v) values ('b1', 'dup')"]), /UNIQUE constraint failed: kv.k/);
    assert.equal((await client.execute("select count(*) as n from kv where k = 'b3'")).rows[0].n, 0);
    const reads = await client.batch(['select 1 as a', 'select 2 as b'], 'read');
    assert.equal(reads[1].rows[0].b, 2);
  });

  test('transaction: execute, batch, commit, rollback, closed', async () => {
    const tx = await client.transaction('write');
    await tx.execute("insert into kv (k, v) values ('t1', 'x')");
    await tx.batch(["insert into kv (k, v) values ('t2', 'x')"]);
    assert.equal(tx.closed, false);
    await tx.commit();
    assert.equal(tx.closed, true);
    assert.equal((await client.execute("select count(*) as n from kv where k in ('t1','t2')")).rows[0].n, 2);

    const tx2 = await client.transaction();
    await tx2.execute("insert into kv (k, v) values ('t3', 'x')");
    await tx2.rollback();
    assert.equal((await client.execute("select count(*) as n from kv where k = 't3'")).rows[0].n, 0);

    const tx3 = await client.transaction();
    await tx3.execute("insert into kv (k, v) values ('t4', 'x')");
    await tx3.close();
    assert.equal(tx3.closed, true);
    assert.equal((await client.execute("select count(*) as n from kv where k = 't4'")).rows[0].n, 0);
  });

  test('executeMultiple runs several statements, skipping PRAGMAs and converting DDL', async () => {
    await client.executeMultiple(`
      PRAGMA journal_mode = WAL;
      CREATE TABLE IF NOT EXISTS notes (id INTEGER PRIMARY KEY AUTOINCREMENT, body TEXT, at TEXT DEFAULT (datetime('now')));
      INSERT OR IGNORE INTO notes (body) VALUES ('one');
      INSERT INTO notes (body) VALUES ('two');
    `);
    const r = await client.execute('select body, at from notes order by id');
    assert.equal(r.rows.length, 2);
    assert.match(r.rows[0].at, /^\d{4}-/);
    const ins = await client.execute("insert into notes (body) values ('three')");
    assert.equal(ins.lastInsertRowid, 3n);
  });

  test('bare BEGIN through execute is refused with a pointer to transaction()', async () => {
    await assert.rejects(client.execute('BEGIN'), /transaction\(\)/);
  });

  test('sync() is a no-op; close() ends the pool; explainRewrite shows the SQL', async () => {
    await client.sync();
    const r = await client.explainRewrite("insert or replace into kv (k, v) values (?, ?)");
    assert.equal(r.sql, 'INSERT INTO kv (k, v) values (?, ?) ON CONFLICT ("k") DO UPDATE SET "v" = EXCLUDED."v"');
    const c = createClient({ url: db.url, pool: { max: 1 } });
    await c.execute('select 1');
    await c.close();
    assert.equal(c.closed, true);
    await c.close();
  });

  test('dialect: postgres skips the rewriter but keeps ? binding and error translation', async () => {
    const c = createClient({ url: db.url, dialect: 'postgres', pool: { max: 1 } });
    try {
      const r = await c.execute("select ?::text || ? as s, now() - interval '1 day' < now() as ok", ['a', 'b']);
      assert.equal(r.rows[0].s, 'ab');
      assert.equal(r.rows[0].ok, true);
      await assert.rejects(c.execute("insert into kv (k, v) values ('a', 'x')"), /UNIQUE constraint failed: kv.k/);
    } finally {
      await c.close();
    }
  });

  test('intMode bigint and timestamps date', async () => {
    const c = createClient({ url: db.url, intMode: 'bigint', timestamps: 'date', pool: { max: 1 } });
    try {
      const r = await c.execute('select count(*) as n, max(created_at) as at from users');
      assert.equal(typeof r.rows[0].n, 'bigint');
      assert.ok(r.rows[0].at instanceof Date);
    } finally {
      await c.close();
    }
  });

  test('onWarning reports unsupported idioms once per statement text', async () => {
    const seen = [];
    const c = createClient({ url: db.url, pool: { max: 1 }, onWarning: (m, s) => seen.push([m, s]) });
    try {
      await c.execute('select typeof(k) from kv limit 1').catch(() => {});
      await c.execute('select typeof(k) from kv limit 1').catch(() => {});
      assert.equal(seen.length, 1);
      assert.match(seen[0][0], /typeof/);
    } finally {
      await c.close();
    }
  });
});
