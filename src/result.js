/**
 * libSQL's ResultSet shape, built from a pg array-mode result.
 *
 * libSQL rows are objects with an enumerable property per column name AND a
 * non-enumerable numeric index per position, plus a non-enumerable `length`,
 * so both `row.id` and `row[0]` work and `JSON.stringify(row)` shows only
 * the names. The first of two same-named columns wins, as in libSQL.
 */

/** pg type oids to the declared-type words libSQL reports (SQLite's). */
const OID_TYPES = new Map([
  [16, 'BOOLEAN'],
  [17, 'BLOB'],
  [20, 'INTEGER'],
  [21, 'INTEGER'],
  [23, 'INTEGER'],
  [25, 'TEXT'],
  [114, 'TEXT'],
  [3802, 'TEXT'],
  [700, 'REAL'],
  [701, 'REAL'],
  [1700, 'REAL'],
  [1042, 'TEXT'],
  [1043, 'TEXT'],
  [1082, 'DATE'],
  [1083, 'TIME'],
  [1114, 'DATETIME'],
  [1184, 'DATETIME'],
  [2950, 'TEXT'],
]);

/**
 * @param {string[]} names
 * @param {unknown[]} values
 */
export function makeRow(names, values) {
  const row = {};
  Object.defineProperty(row, 'length', { value: values.length });
  for (let i = 0; i < values.length; i++) {
    Object.defineProperty(row, i, { value: values[i] });
    const name = names[i];
    if (name !== undefined && !Object.hasOwn(row, name)) {
      Object.defineProperty(row, name, {
        value: values[i],
        enumerable: true,
        configurable: true,
        writable: true,
      });
    }
  }
  return row;
}

/**
 * @param {import('pg').QueryArrayResult} res result of a `rowMode: 'array'` query
 * @param {{ lastInsertRowid?: bigint, rowsAffected?: number, hideRows?: boolean }} [extra]
 */
export function toResultSet(res, extra = {}) {
  const fields = res.fields ?? [];
  const columns = extra.hideRows ? [] : fields.map((f) => f.name);
  const columnTypes = extra.hideRows ? [] : fields.map((f) => OID_TYPES.get(f.dataTypeID) ?? '');
  const raw = extra.hideRows ? [] : (res.rows ?? []);
  const rows = raw.map((values) => makeRow(columns, /** @type {unknown[]} */ (values)));
  const rowsAffected = extra.rowsAffected ?? res.rowCount ?? 0;
  const lastInsertRowid = extra.lastInsertRowid;
  return {
    columns,
    columnTypes,
    rows,
    rowsAffected,
    lastInsertRowid,
    toJSON() {
      return {
        columns,
        columnTypes,
        rows: raw,
        rowsAffected,
        lastInsertRowid: lastInsertRowid === undefined ? undefined : lastInsertRowid.toString(),
      };
    },
  };
}

/** An empty result, for PRAGMA and other statements Postgres has no use for. */
export function emptyResultSet() {
  return toResultSet({ fields: [], rows: [], rowCount: 0, command: '', oid: 0 });
}
