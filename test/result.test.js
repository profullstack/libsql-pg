import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { emptyResultSet, makeRow, toResultSet } from '../src/result.js';

describe('rows', () => {
  test('a row answers to column names and to indexes, with a length', () => {
    const row = makeRow(['id', 'name'], [1, 'a']);
    assert.equal(row.id, 1);
    assert.equal(row.name, 'a');
    assert.equal(row[0], 1);
    assert.equal(row[1], 'a');
    assert.equal(row.length, 2);
  });
  test('only the names are enumerable, so JSON and spread show the object shape', () => {
    const row = makeRow(['id', 'name'], [1, 'a']);
    assert.deepEqual(Object.keys(row), ['id', 'name']);
    assert.equal(JSON.stringify(row), '{"id":1,"name":"a"}');
    assert.deepEqual({ ...row }, { id: 1, name: 'a' });
  });
  test('the first of two same-named columns wins, both stay reachable by index', () => {
    const row = makeRow(['id', 'id'], [1, 2]);
    assert.equal(row.id, 1);
    assert.equal(row[1], 2);
  });
});

describe('toResultSet', () => {
  const res = {
    fields: [
      { name: 'id', dataTypeID: 20 },
      { name: 'name', dataTypeID: 25 },
      { name: 'ok', dataTypeID: 16 },
    ],
    rows: [
      [1, 'a', true],
      [2, 'b', false],
    ],
    rowCount: 2,
  };
  test('columns, columnTypes, rows, rowsAffected, lastInsertRowid', () => {
    const rs = toResultSet(res);
    assert.deepEqual(rs.columns, ['id', 'name', 'ok']);
    assert.deepEqual(rs.columnTypes, ['INTEGER', 'TEXT', 'BOOLEAN']);
    assert.equal(rs.rows.length, 2);
    assert.equal(rs.rows[1].name, 'b');
    assert.equal(rs.rowsAffected, 2);
    assert.equal(rs.lastInsertRowid, undefined);
  });
  test('toJSON has arrays for rows and a string for the rowid, like libSQL', () => {
    const rs = toResultSet(res, { lastInsertRowid: 7n });
    assert.deepEqual(rs.toJSON(), {
      columns: ['id', 'name', 'ok'],
      columnTypes: ['INTEGER', 'TEXT', 'BOOLEAN'],
      rows: res.rows,
      rowsAffected: 2,
      lastInsertRowid: '7',
    });
  });
  test('hideRows drops the RETURNING the client added for lastInsertRowid', () => {
    const rs = toResultSet({ fields: [{ name: 'id', dataTypeID: 20 }], rows: [[5]], rowCount: 1 }, { lastInsertRowid: 5n, rowsAffected: 1, hideRows: true });
    assert.deepEqual(rs.columns, []);
    assert.deepEqual(rs.rows, []);
    assert.equal(rs.rowsAffected, 1);
    assert.equal(rs.lastInsertRowid, 5n);
  });
  test('the empty result has the shape too', () => {
    const rs = emptyResultSet();
    assert.deepEqual(rs.rows, []);
    assert.equal(rs.rowsAffected, 0);
  });
});
