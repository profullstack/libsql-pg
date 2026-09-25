import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { coerce, insertSql, orderTables, referencedTables, userTables } from '../src/copy.js';
import { parseArgs } from '../src/cli.js';

describe('table discovery', () => {
  test('drops sqlite_* and FTS shadow tables', () => {
    const master = [
      { name: 'users', type: 'table', sql: 'CREATE TABLE users (id)' },
      { name: 'sqlite_sequence', type: 'table', sql: 'CREATE TABLE sqlite_sequence(name,seq)' },
      { name: 'posts_fts', type: 'table', sql: "CREATE VIRTUAL TABLE posts_fts USING fts5(title, content='posts')" },
      { name: 'posts_fts_data', type: 'table', sql: "CREATE TABLE 'posts_fts_data'(id INTEGER PRIMARY KEY, block BLOB)" },
      { name: 'posts_fts_idx', type: 'table', sql: "CREATE TABLE 'posts_fts_idx'(segid, term, pgno, PRIMARY KEY(segid, term)) WITHOUT ROWID" },
      { name: 'posts_fts_config', type: 'table', sql: "CREATE TABLE 'posts_fts_config'(k PRIMARY KEY, v) WITHOUT ROWID" },
      { name: 'posts', type: 'table', sql: 'CREATE TABLE posts (id, user_id REFERENCES users(id))' },
    ];
    assert.deepEqual(userTables(master).map((t) => t.name), ['users', 'posts']);
  });
});

describe('FK ordering', () => {
  test('referencedTables reads REFERENCES in column and table constraints, quoted or not', () => {
    assert.deepEqual(
      referencedTables('CREATE TABLE x (a INTEGER REFERENCES "users"(id), b INTEGER, FOREIGN KEY (b) REFERENCES `posts` (id), c REFERENCES [tags](id))'),
      ['users', 'posts', 'tags'],
    );
    assert.deepEqual(referencedTables("CREATE TABLE y (note TEXT DEFAULT 'references nothing')"), []);
  });
  test('parents come first, the rest alphabetical', () => {
    const { order, cyclic } = orderTables([
      { name: 'comments', sql: 'create table comments (post_id references posts(id), user_id references users(id))' },
      { name: 'posts', sql: 'create table posts (user_id references users(id))' },
      { name: 'users', sql: 'create table users (id)' },
      { name: 'tags', sql: 'create table tags (id)' },
    ]);
    assert.deepEqual(order, ['tags', 'users', 'posts', 'comments']);
    assert.deepEqual(cyclic, []);
  });
  test('a cycle is reported and placed last; a self-reference is not a cycle', () => {
    const { order, cyclic } = orderTables([
      { name: 'a', sql: 'create table a (b_id references b(id))' },
      { name: 'b', sql: 'create table b (a_id references a(id))' },
      { name: 'tree', sql: 'create table tree (parent references tree(id))' },
      { name: 'z', sql: 'create table z (id)' },
    ]);
    assert.deepEqual(order, ['tree', 'z', 'a', 'b']);
    assert.deepEqual(cyclic, ['a', 'b']);
  });
  test('a reference to a table not being copied is ignored', () => {
    const { order } = orderTables([{ name: 'a', sql: 'create table a (x references elsewhere(id))' }]);
    assert.deepEqual(order, ['a']);
  });
});

describe('value coercion to the target type', () => {
  test('integers: empty string and false are null, true is 1, floats truncate, bigint stays exact', () => {
    assert.equal(coerce('', 'bigint'), null);
    assert.equal(coerce(false, 'bigint'), null);
    assert.equal(coerce(true, 'bigint'), 1);
    assert.equal(coerce(3.7, 'bigint'), '3');
    assert.equal(coerce('42', 'integer'), '42');
    assert.equal(coerce(9007199254740993n, 'bigint'), '9007199254740993');
    assert.equal(coerce('abc', 'bigint'), null);
  });
  test('booleans from SQLite integers and strings', () => {
    assert.equal(coerce(1, 'boolean'), true);
    assert.equal(coerce(0, 'boolean'), false);
    assert.equal(coerce('1', 'boolean'), true);
    assert.equal(coerce('false', 'boolean'), false);
    assert.equal(coerce('', 'boolean'), null);
    assert.equal(coerce(true, 'boolean'), true);
  });
  test('timestamps: epoch seconds and milliseconds become ISO, text passes through, empty is null', () => {
    assert.equal(coerce(1700000000, 'timestamp with time zone'), '2023-11-14T22:13:20.000Z');
    assert.equal(coerce(1700000000000, 'timestamp with time zone'), '2023-11-14T22:13:20.000Z');
    assert.equal(coerce('1700000000', 'timestamp with time zone'), '2023-11-14T22:13:20.000Z');
    assert.equal(coerce('2024-01-02 03:04:05', 'timestamp with time zone'), '2024-01-02 03:04:05');
    assert.equal(coerce('', 'timestamp with time zone'), null);
    assert.equal(coerce(1700000000, 'date'), '2023-11-14');
  });
  test('bytea from ArrayBuffer, Uint8Array and string; text from a blob drops NUL', () => {
    assert.ok(Buffer.isBuffer(coerce(new Uint8Array([1, 2]).buffer, 'bytea')));
    assert.deepEqual([...coerce(new Uint8Array([1, 2]), 'bytea')], [1, 2]);
    assert.equal(coerce('hi', 'bytea').toString(), 'hi');
    assert.equal(coerce('a\0b', 'text'), 'ab');
    assert.equal(coerce(Buffer.from('x'), 'text'), 'x');
  });
  test('doubles and json', () => {
    assert.equal(coerce('', 'double precision'), null);
    assert.equal(coerce('1.5', 'double precision'), '1.5');
    assert.equal(coerce({ a: 1 }, 'jsonb'), '{"a":1}');
    assert.equal(coerce('{"a":1}', 'jsonb'), '{"a":1}');
    assert.equal(coerce('', 'jsonb'), null);
  });
  test('null and undefined are null for every type', () => {
    for (const t of ['bigint', 'text', 'boolean', 'bytea', 'timestamp with time zone']) {
      assert.equal(coerce(null, t), null);
      assert.equal(coerce(undefined, t), null);
    }
  });
});

describe('insert statement', () => {
  test('one typed array per column, unnested; identity columns override system value', () => {
    assert.equal(
      insertSql('posts', [
        { column_name: 'id', data_type: 'bigint', is_identity: 'YES' },
        { column_name: 'title', data_type: 'text', is_identity: 'NO' },
        { column_name: 'at', data_type: 'timestamp with time zone', is_identity: 'NO' },
        { column_name: 'ok', data_type: 'boolean', is_identity: 'NO' },
      ]),
      'insert into "posts" ("id", "title", "at", "ok") overriding system value select * from unnest($1::bigint[], $2::text[], $3::timestamptz[], $4::boolean[])',
    );
    assert.equal(insertSql('t', [{ column_name: 'a', data_type: 'character varying', is_identity: 'NO' }]), 'insert into "t" ("a") select * from unnest($1::text[])');
  });
});

describe('cli argument parsing', () => {
  test('flags, values, booleans and positionals', () => {
    const { flags, positional } = parseArgs(['copy', '--from', 'libsql://x', '--truncate', '--tables=a,b', '--batch', '500', '--verify', 'extra']);
    assert.deepEqual(positional, ['copy', 'extra']);
    assert.equal(flags.from, 'libsql://x');
    assert.equal(flags.truncate, true);
    assert.equal(flags.tables, 'a,b');
    assert.equal(flags.batch, '500');
    assert.equal(flags.verify, true);
  });
});
