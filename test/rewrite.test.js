import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { createRewriter, insertTarget, jsonPathToArray, rewriteSql, unsupportedIdioms } from '../src/rewrite.js';

const keys = (table) =>
  ({
    users: { pk: ['id'], unique: [['email']], columns: ['id', 'email', 'name'] },
    settings: { pk: [], unique: [['user_id', 'key']], columns: ['user_id', 'key', 'value'] },
    nokeys: { pk: [], unique: [], columns: ['a'] },
  })[table];

const sql = (s, opts) => rewriteSql(s, opts).sql;

describe('INSERT OR IGNORE', () => {
  test('becomes ON CONFLICT DO NOTHING', () => {
    assert.equal(sql('INSERT OR IGNORE INTO t (a, b) VALUES (?, ?)'), 'INSERT INTO t (a, b) VALUES (?, ?) ON CONFLICT DO NOTHING');
  });
  test('keeps a RETURNING clause after the conflict action', () => {
    assert.equal(
      sql('insert or ignore into t (a) values (?) returning id'),
      'INSERT INTO t (a) values (?) ON CONFLICT DO NOTHING returning id',
    );
  });
  test('leaves an existing ON CONFLICT alone', () => {
    assert.equal(sql('insert or ignore into t (a) values (?) on conflict (a) do nothing'), 'INSERT INTO t (a) values (?) on conflict (a) do nothing');
  });
  test('a literal containing "returning" is not a clause', () => {
    assert.equal(
      sql("insert or ignore into t (a) values ('returning soon')"),
      "INSERT INTO t (a) values ('returning soon') ON CONFLICT DO NOTHING",
    );
  });
  test('INSERT OR ABORT / FAIL / ROLLBACK are plain inserts', () => {
    assert.equal(sql('insert or abort into t (a) values (1)'), 'INSERT INTO t (a) values (1)');
    assert.equal(sql('insert or fail into t (a) values (1)'), 'INSERT INTO t (a) values (1)');
  });
});

describe('INSERT OR REPLACE', () => {
  test('uses the primary key as the conflict target and updates the other listed columns', () => {
    assert.equal(
      sql('INSERT OR REPLACE INTO users (id, email, name) VALUES (?, ?, ?)', { keys }),
      'INSERT INTO users (id, email, name) VALUES (?, ?, ?) ON CONFLICT ("id") DO UPDATE SET "email" = EXCLUDED."email", "name" = EXCLUDED."name"',
    );
  });
  test('REPLACE INTO is the same statement', () => {
    assert.equal(
      sql('replace into users (id, name) values (1, ?)', { keys }),
      'INSERT INTO users (id, name) values (1, ?) ON CONFLICT ("id") DO UPDATE SET "name" = EXCLUDED."name"',
    );
  });
  test('falls back to the first unique index when there is no primary key', () => {
    assert.equal(
      sql('insert or replace into settings (user_id, key, value) values (?, ?, ?)', { keys }),
      'INSERT INTO settings (user_id, key, value) values (?, ?, ?) ON CONFLICT ("user_id", "key") DO UPDATE SET "value" = EXCLUDED."value"',
    );
  });
  test('only key columns listed: DO NOTHING', () => {
    assert.equal(sql('insert or replace into users (id) values (?)', { keys }), 'INSERT INTO users (id) values (?) ON CONFLICT ("id") DO NOTHING');
  });
  test('no column list: uses the table columns', () => {
    assert.equal(
      sql('insert or replace into users values (?, ?, ?)', { keys }),
      'INSERT INTO users values (?, ?, ?) ON CONFLICT ("id") DO UPDATE SET "email" = EXCLUDED."email", "name" = EXCLUDED."name"',
    );
  });
  test('a table without keys is an error that names the table', () => {
    assert.throws(() => sql('insert or replace into nokeys (a) values (1)', { keys }), /nokeys.*no primary key or unique index/);
  });
  test('works with a schema-qualified quoted table', () => {
    const t = insertTarget('insert or replace into "public"."users" ("id", name) values (1, 2)');
    assert.equal(t.table, 'public.users');
    assert.deepEqual(t.columns, ['id', 'name']);
  });
  test('a select-based insert is recognised too', () => {
    assert.equal(
      sql('insert or replace into users (id, name) select id, name from staging', { keys }),
      'INSERT INTO users (id, name) select id, name from staging ON CONFLICT ("id") DO UPDATE SET "name" = EXCLUDED."name"',
    );
  });
});

describe('date and time functions', () => {
  test("datetime('now') -> now()", () => {
    assert.equal(sql("update t set updated_at = datetime('now') where id = ?"), 'update t set updated_at = now() where id = ?');
  });
  test("datetime('now','localtime') -> now()", () => {
    assert.equal(sql("select datetime('now', 'localtime')"), 'select now()');
  });
  test('datetime with a modifier becomes an interval', () => {
    assert.equal(sql("select * from t where created_at > datetime('now', '-7 days')"), "select * from t where created_at > (now() - interval '7 days')");
    assert.equal(sql("select datetime('now', '+1 hour')"), "select (now() + interval '1 hour')");
    assert.equal(sql("select datetime('now', 'start of day')"), "select (date_trunc('day', now()))");
  });
  test('datetime of a column is left alone (no single Postgres spelling)', () => {
    assert.equal(sql('select datetime(created_at) from t'), 'select datetime(created_at) from t');
  });
  test("date('now') -> current_date", () => {
    assert.equal(sql("select date('now')"), 'select current_date');
    assert.equal(sql("select date('now', '-1 day')"), "select (now() - interval '1 day')::date");
  });
  test("strftime('%s','now') and unixepoch() -> extract(epoch ...)", () => {
    assert.equal(sql("select strftime('%s', 'now')"), 'select extract(epoch from now())::bigint');
    assert.equal(sql("select strftime('%s','now')"), 'select extract(epoch from now())::bigint');
    assert.equal(sql('select unixepoch()'), 'select extract(epoch from now())::bigint');
    assert.equal(sql("select unixepoch('now')"), 'select extract(epoch from now())::bigint');
    assert.equal(sql('select unixepoch(created_at)'), 'select extract(epoch from (created_at)::timestamptz)::bigint');
  });
  test('strftime with a format becomes to_char in UTC', () => {
    assert.equal(
      sql("select strftime('%Y-%m-%dT%H:%M:%fZ', 'now')"),
      `select to_char(now() at time zone 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')`,
    );
    assert.equal(sql("select strftime('%Y-%m-%d', created_at)"), "select to_char((created_at)::timestamptz at time zone 'utc', 'YYYY-MM-DD')");
  });
  test('strftime with an unknown specifier is left alone', () => {
    assert.equal(sql("select strftime('%w', 'now')"), "select strftime('%w', 'now')");
  });
  test('julianday becomes an epoch expression', () => {
    assert.equal(sql("select julianday('now') - julianday(c)"), 'select (extract(epoch from now()) / 86400.0 + 2440587.5) - (extract(epoch from (c)::timestamptz) / 86400.0 + 2440587.5)');
  });
  test('CURRENT_TIMESTAMP in DML is untouched (Postgres has it)', () => {
    assert.equal(sql('update t set a = CURRENT_TIMESTAMP'), 'update t set a = CURRENT_TIMESTAMP');
  });
});

describe('json', () => {
  test('json_extract with a simple path -> #>>', () => {
    assert.equal(sql("select json_extract(meta, '$.a.b[0]') from t"), "select ((meta)::jsonb #>> '{a,b,0}') from t");
    assert.equal(sql("select json_extract(meta, '$.name') from t"), "select ((meta)::jsonb #>> '{name}') from t");
    assert.equal(sql("select json_extract(meta, '$') from t"), "select ((meta)::jsonb #>> '{}') from t");
  });
  test('json_extract with a non-literal or odd path is left alone', () => {
    assert.equal(sql('select json_extract(meta, ?) from t'), 'select json_extract(meta, ?) from t');
    assert.equal(sql("select json_extract(meta, '$.a[#-1]') from t"), "select json_extract(meta, '$.a[#-1]') from t");
  });
  test('jsonPathToArray handles quoted keys', () => {
    assert.equal(jsonPathToArray('$."a key".b'), '{"a key",b}');
    assert.equal(jsonPathToArray('name'), null);
  });
  test('json_array_length, json_object, json_array, json_group_array', () => {
    assert.equal(sql('select json_array_length(tags) from t'), 'select jsonb_array_length((tags)::jsonb) from t');
    assert.equal(sql("select json_object('a', 1), json_array(1, 2)"), "select json_build_object('a', 1), json_build_array(1, 2)");
    assert.equal(sql('select json_group_array(id) from t'), 'select json_agg(id) from t');
    assert.equal(sql('select json_group_object(k, v) from t'), 'select json_object_agg(k, v) from t');
  });
});

describe('ids, strings and aggregates', () => {
  test('lower(hex(randomblob(16))) -> encode(gen_random_bytes(16), hex)', () => {
    assert.equal(sql('insert into t (id) values (lower(hex(randomblob(16))))'), "insert into t (id) values (encode(gen_random_bytes(16), 'hex'))");
  });
  test('hex(x) keeps SQLite upper case', () => {
    assert.equal(sql('select hex(randomblob(8))'), "select upper(encode(gen_random_bytes(8), 'hex'))");
    assert.equal(sql('select hex(data) from t'), "select upper(encode((data)::bytea, 'hex')) from t");
  });
  test('randomblob alone', () => {
    assert.equal(sql('select randomblob(4)'), 'select gen_random_bytes(4)');
  });
  test('group_concat -> string_agg with a text cast', () => {
    assert.equal(sql('select group_concat(name) from t'), "select string_agg((name)::text, ',') from t");
    assert.equal(sql("select group_concat(name, ' | ') from t"), "select string_agg((name)::text, ' | ') from t");
    assert.equal(sql("select group_concat(distinct name, ', ') from t"), "select string_agg(distinct (name)::text, ', ') from t");
  });
  test('LIKE -> ILIKE (SQLite LIKE is case-insensitive), literals untouched', () => {
    assert.equal(sql("select 1 from t where a like ? and b not like 'x%' escape '\\'"), "select 1 from t where a ILIKE ? and b not ILIKE 'x%' escape '\\'");
    assert.equal(sql("select 'I like it' from t where c ilike ?"), "select 'I like it' from t where c ilike ?");
  });
  test('ifnull -> coalesce, instr -> position', () => {
    assert.equal(sql('select ifnull(a, b), instr(a, b) from t'), 'select coalesce(a, b), position(b in a) from t');
  });
  test('scalar max/min with two arguments -> greatest/least; aggregates untouched', () => {
    assert.equal(sql('select max(a, b), min(a, b, c), max(a) from t'), 'select greatest(a, b), least(a, b, c), max(a) from t');
  });
  test('total -> coalesce(sum)', () => {
    assert.equal(sql('select total(x) from t'), 'select coalesce(sum(x), 0) from t');
  });
  test('CAST AS INTEGER -> bigint, REAL -> double precision, BLOB -> bytea', () => {
    assert.equal(sql('select cast(a as integer), cast(b as real), cast(c as blob), cast(d as text)'), 'select cast(a as bigint), cast(b as double precision), cast(c as bytea), cast(d as text)');
  });
  test('REGEXP -> ~', () => {
    assert.equal(sql("select * from t where a regexp '^x'"), "select * from t where a ~ '^x'");
  });
  test('LIMIT -1 -> LIMIT ALL; LIMIT ? OFFSET ? untouched; LIKE untouched', () => {
    assert.equal(sql('select * from t limit -1'), 'select * from t LIMIT ALL');
    assert.equal(sql("select * from t where a like ? limit ? offset ?"), "select * from t where a like ? limit ? offset ?");
  });
  test('INDEXED BY hints are dropped', () => {
    assert.equal(sql('select * from t indexed by t_idx where a = ?'), 'select * from t where a = ?');
    assert.equal(sql('select * from t not indexed where a = ?'), 'select * from t where a = ?');
  });
  test('backticked identifiers become double quotes', () => {
    assert.equal(sql('select `name` from `users`'), 'select "name" from "users"');
  });
  test('functions inside string literals are not touched', () => {
    assert.equal(sql("select 'datetime(''now'') and hex(x)' from t"), "select 'datetime(''now'') and hex(x)' from t");
  });
  test('functions inside comments are not touched', () => {
    assert.equal(sql("select a -- ifnull(a,b)\nfrom t"), "select a -- ifnull(a,b)\nfrom t");
  });
});

describe('statements Postgres has no use for', () => {
  test('PRAGMA is a no-op', () => {
    const r = rewriteSql('PRAGMA journal_mode = WAL;');
    assert.equal(r.noop, true);
    assert.equal(r.kind, 'pragma');
  });
  test('a comment-only statement is a no-op', () => {
    assert.equal(rewriteSql('-- nothing here').noop, true);
  });
  test('MATCH against an FTS5 table throws, naming the table and the README section', () => {
    assert.throws(() => rewriteSql('select rowid from posts_fts where posts_fts match ?'), (err) => {
      assert.match(err.message, /"posts_fts"/);
      assert.match(err.message, /FTS5 to tsvector/);
      assert.equal(err.code, 'FTS5_NOT_SUPPORTED');
      return true;
    });
    assert.throws(() => rewriteSql("select * from docs d join docs_fts f on f.rowid = d.id where docs_fts.body MATCH 'x'"), /"docs_fts"/);
  });
  test('DDL through the client goes to the schema converter', () => {
    const r = rewriteSql('CREATE TABLE IF NOT EXISTS t (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT, created_at TEXT DEFAULT (datetime(\'now\')))', {
      ddl: (s) => `converted:${s.length}`,
    });
    assert.equal(r.kind, 'ddl');
    assert.match(r.sql, /^converted:/);
  });
  test('DDL without a converter still gets the function rewrites', () => {
    assert.equal(sql("create index i on t (strftime('%s', c))"), 'create index i on t (extract(epoch from (c)::timestamptz)::bigint)');
  });
  test('BEGIN/COMMIT are passed through by the rewriter (the client refuses them on a pool)', () => {
    assert.equal(sql('BEGIN'), 'BEGIN');
  });
});

describe('warnings for what is not rewritten', () => {
  test('lists unsupported functions and idioms', () => {
    const w = unsupportedIdioms("select printf('%d', a), typeof(a), last_insert_rowid() from t where b glob 'x*' and c is not 'y'");
    assert.ok(w.some((m) => /printf/.test(m)));
    assert.ok(w.some((m) => /typeof/.test(m)));
    assert.ok(w.some((m) => /last_insert_rowid/.test(m)));
    assert.ok(w.some((m) => /GLOB/.test(m)));
    assert.ok(w.some((m) => /IS NOT/.test(m)));
  });
  test('IS NOT NULL is fine', () => {
    assert.deepEqual(unsupportedIdioms('select * from t where a is not null'), []);
  });
  test('rowid and COLLATE NOCASE are flagged', () => {
    const w = unsupportedIdioms('select rowid from t where a = ? collate nocase');
    assert.ok(w.some((m) => /rowid/.test(m)));
    assert.ok(w.some((m) => /NOCASE/.test(m)));
  });
  test('the rewrite result carries them', () => {
    assert.ok(rewriteSql('select json_each(x) from t').warnings.some((m) => /json_each/.test(m)));
  });
});

describe('createRewriter cache', () => {
  test('caches by SQL text and announces the table INSERT OR REPLACE needs', () => {
    const r = createRewriter({ keys });
    assert.equal(r.needsKeys('insert or replace into users (id, name) values (?, ?)'), 'users');
    assert.equal(r.needsKeys('select 1'), null);
    const a = r.rewrite("select datetime('now')");
    const b = r.rewrite("select datetime('now')");
    assert.equal(a, b);
    assert.equal(a.sql, 'select now()');
    assert.equal(r.needsKeys("select datetime('now')"), null);
  });
  test('the cache is bounded', () => {
    const r = createRewriter({ cacheSize: 2 });
    r.rewrite('select 1');
    r.rewrite('select 2');
    r.rewrite('select 3');
    assert.equal(r.rewrite('select 3').sql, 'select 3');
  });
});

describe('dialect: postgres SQL passes through the same helpers', () => {
  test('a Postgres-native statement is not damaged by the rules', () => {
    const q = "select id, coalesce(a, b) from t where created_at > now() - interval '1 day' and meta @> '{\"a\":1}' limit $1";
    assert.equal(sql(q), q);
  });
});
