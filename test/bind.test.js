import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { bind, named, positional, prepare } from '../src/bind.js';

describe('positional placeholders', () => {
  test('? becomes $1..$n', () => {
    assert.equal(positional('select * from t where a = ? and b = ?'), 'select * from t where a = $1 and b = $2');
  });
  test('?NNN keeps its number', () => {
    assert.equal(positional('select ?2, ?1'), 'select $2, $1');
  });
  test('? inside literals and comments is left alone', () => {
    assert.equal(positional("select 'what?' from t where a = ? -- really?\n and b = ?"), "select 'what?' from t where a = $1 -- really?\n and b = $2");
    assert.equal(positional('select /* ? */ ? from t'), 'select /* ? */ $1 from t');
    assert.equal(positional('select "a?" from t where x = ?'), 'select "a?" from t where x = $1');
  });
  test("doubled quotes inside a literal do not end it", () => {
    assert.equal(positional("select 'it''s ?' , ?"), "select 'it''s ?' , $1");
  });
});

describe('named placeholders', () => {
  test(':name, @name and $name all bind, in first-use order', () => {
    const r = named('select :b, @a, $c, :b', { a: 1, b: 2, c: 3 });
    assert.equal(r.sql, 'select $1, $2, $3, $1');
    assert.deepEqual(r.values, [2, 1, 3]);
  });
  test('keys may carry their prefix, as libSQL allows', () => {
    const r = named('select :a, @b', { ':a': 1, '@b': 2 });
    assert.deepEqual(r.values, [1, 2]);
  });
  test('a ::cast is not a placeholder, nor is an existing $1', () => {
    const r = named('select :a::text, $1', { a: 'x' });
    assert.equal(r.sql, 'select $1::text, $1');
    assert.deepEqual(r.values, ['x']);
  });
  test('a missing name is an error that names it', () => {
    assert.throws(() => named('select :nope', { a: 1 }), /"nope"/);
  });
  test('names inside literals are not placeholders', () => {
    const r = named("select ':a', :a", { a: 1 });
    assert.equal(r.sql, "select ':a', $1");
  });
});

describe('bind', () => {
  test('undefined is null, booleans are 1/0, bigints are strings, dates are ISO, typed arrays are Buffers', () => {
    const out = bind([undefined, true, false, 10n, new Date('2026-01-02T03:04:05.000Z'), new Uint8Array([1, 2]), 'x', 1.5, null]);
    assert.equal(out[0], null);
    assert.equal(out[1], 1);
    assert.equal(out[2], 0);
    assert.equal(out[3], '10');
    assert.equal(out[4], '2026-01-02T03:04:05.000Z');
    assert.ok(Buffer.isBuffer(out[5]));
    assert.deepEqual([...out[5]], [1, 2]);
    assert.equal(out[6], 'x');
    assert.equal(out[7], 1.5);
    assert.equal(out[8], null);
  });
  test('nativeBooleans keeps true/false', () => {
    assert.deepEqual(bind([true], { nativeBooleans: true }), [true]);
  });
});

describe('prepare', () => {
  test('array args go positional, object args go named', () => {
    assert.deepEqual(prepare('select ?, ?', [1, 2]), { text: 'select $1, $2', values: [1, 2] });
    assert.deepEqual(prepare('select :a', { a: 1 }), { text: 'select $1', values: [1] });
    assert.deepEqual(prepare('select 1', undefined), { text: 'select 1', values: [] });
  });
});
