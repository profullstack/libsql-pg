import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { ftsError, translateError } from '../src/errors.js';

const pgError = (fields) => Object.assign(new Error(fields.message ?? 'pg error'), fields);

describe('translateError', () => {
  test('23505 reads like SQLite, with the constraint columns when known', () => {
    const e = translateError(pgError({ code: '23505', table: 'users', constraint: 'users_email_key', detail: 'Key (email)=(a@b) already exists.' }), {
      columns: ['email'],
    });
    assert.equal(e.message, 'UNIQUE constraint failed: users.email');
    assert.equal(e.code, '23505');
    assert.equal(e.sqliteCode, 'SQLITE_CONSTRAINT_UNIQUE');
    assert.equal(e.constraint, 'users_email_key');
    assert.equal(e.cause.code, '23505');
  });
  test('23505 with several columns lists them all, as SQLite did', () => {
    const e = translateError(pgError({ code: '23505', table: 'settings', constraint: 'settings_user_id_key_key' }), { columns: ['user_id', 'key'] });
    assert.equal(e.message, 'UNIQUE constraint failed: settings.user_id, settings.key');
  });
  test('23505 without resolved columns falls back to the detail, then the constraint name', () => {
    assert.equal(
      translateError(pgError({ code: '23505', table: 't', constraint: 'c', detail: 'Key (a, b)=(1, 2) already exists.' })).message,
      'UNIQUE constraint failed: t.a, t.b',
    );
    assert.equal(translateError(pgError({ code: '23505', constraint: 'only_name' })).message, 'UNIQUE constraint failed: only_name');
  });
  test('23503 and 23502', () => {
    assert.equal(translateError(pgError({ code: '23503' })).message, 'FOREIGN KEY constraint failed');
    const nn = translateError(pgError({ code: '23502', table: 'posts', column: 'title' }));
    assert.equal(nn.message, 'NOT NULL constraint failed: posts.title');
    assert.equal(nn.sqliteCode, 'SQLITE_CONSTRAINT_NOTNULL');
  });
  test('23514, 42P01, 42703', () => {
    assert.equal(translateError(pgError({ code: '23514', constraint: 'posts_check' })).message, 'CHECK constraint failed: posts_check');
    assert.equal(translateError(pgError({ code: '42P01', message: 'relation "nope" does not exist' })).message, 'no such table: nope');
    assert.equal(translateError(pgError({ code: '42703', message: 'column "x" does not exist' })).message, 'no such column: x');
  });
  test('anything else is returned as is', () => {
    const e = pgError({ code: '08006' });
    assert.equal(translateError(e), e);
    const plain = new Error('x');
    assert.equal(translateError(plain), plain);
  });
});

describe('ftsError', () => {
  test('names the table and the README section', () => {
    const e = ftsError('docs_fts', 'select 1');
    assert.match(e.message, /"docs_fts"/);
    assert.match(e.message, /FTS5 to tsvector/);
    assert.equal(e.code, 'FTS5_NOT_SUPPORTED');
  });
});
