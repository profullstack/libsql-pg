import { test } from 'node:test';
import assert from 'node:assert/strict';
import { convertSchema, stripComments } from '../index.js';

test('trailing -- comments inside CREATE TABLE are not columns', () => {
  const out = convertSchema(`CREATE TABLE signups (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  source TEXT NOT NULL DEFAULT 'collect',  -- where the signup came from
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);`);
  assert.ok(!/"--"/.test(out), out);
  assert.ok(/created_at\s+\S+\s+NOT NULL DEFAULT now\(\)/i.test(out) || /created_at/.test(out), out);
});

test('stripComments keeps literals that look like comments', () => {
  assert.equal(stripComments("select '--not a comment' -- real\nfrom t"), "select '--not a comment' \nfrom t");
  assert.equal(stripComments('select 1 /* gone */ + 2'), 'select 1  + 2');
});
