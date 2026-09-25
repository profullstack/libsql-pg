/**
 * Postgres errors reshaped so code that matched on SQLite's wording keeps
 * working. The original pg error rides along as `cause`; `code` (the
 * SQLSTATE) is preserved and `sqliteCode` carries the SQLite name that the
 * libSQL client used to expose.
 */

/** @typedef {Error & { code?: string, sqliteCode?: string, cause?: unknown, constraint?: string, table?: string, column?: string, detail?: string }} LibsqlPgError */

/**
 * @param {string} message
 * @param {any} err the pg error
 * @param {string} sqliteCode
 * @returns {LibsqlPgError}
 */
function wrap(message, err, sqliteCode) {
  const e = /** @type {LibsqlPgError} */ (new Error(message, { cause: err }));
  e.name = 'LibsqlError';
  e.code = err.code;
  e.sqliteCode = sqliteCode;
  e.constraint = err.constraint;
  e.table = err.table;
  e.column = err.column;
  e.detail = err.detail;
  return e;
}

/**
 * Translate a pg error. `columnsOf(constraint)` may be supplied to name the
 * columns of a unique constraint the way SQLite did (`t.a, t.b`); without it,
 * or when it has nothing, the constraint name is used.
 *
 * @param {any} err
 * @param {{ columns?: string[] }} [info] resolved constraint columns, if any
 * @returns {any}
 */
export function translateError(err, info = {}) {
  if (!err || typeof err.code !== 'string') return err;
  const table = err.table ?? '';
  switch (err.code) {
    case '23505': {
      const cols = info.columns?.length
        ? info.columns.map((c) => (table ? `${table}.${c}` : c)).join(', ')
        : detailColumns(err.detail, table) ?? err.constraint ?? '';
      return wrap(`UNIQUE constraint failed: ${cols}`.trim(), err, 'SQLITE_CONSTRAINT_UNIQUE');
    }
    case '23503':
      return wrap('FOREIGN KEY constraint failed', err, 'SQLITE_CONSTRAINT_FOREIGNKEY');
    case '23502': {
      const col = err.column ? `${table ? `${table}.` : ''}${err.column}` : table;
      return wrap(`NOT NULL constraint failed: ${col}`.trim(), err, 'SQLITE_CONSTRAINT_NOTNULL');
    }
    case '23514':
      return wrap(`CHECK constraint failed: ${err.constraint ?? ''}`.trim(), err, 'SQLITE_CONSTRAINT_CHECK');
    case '42P01':
      return wrap(`no such table: ${tableFromMessage(err.message)}`, err, 'SQLITE_ERROR');
    case '42703':
      return wrap(`no such column: ${columnFromMessage(err.message)}`, err, 'SQLITE_ERROR');
    case '42P07':
      // The migration runners that test for "already exists" get the same words.
      return wrap(err.message, err, 'SQLITE_ERROR');
    default:
      return err;
  }
}

/**
 * pg puts `Key (a, b)=(1, 2) already exists.` in `detail`; the column list
 * inside it is the same information SQLite printed.
 * @param {string | undefined} detail
 * @param {string} table
 */
function detailColumns(detail, table) {
  const m = /^Key \((.+?)\)=\(/.exec(detail ?? '');
  if (!m) return null;
  return m[1]
    .split(',')
    .map((c) => c.trim())
    .map((c) => (table ? `${table}.${c}` : c))
    .join(', ');
}

function tableFromMessage(message) {
  const m = /relation "([^"]+)" does not exist/.exec(message ?? '');
  return m ? m[1] : '';
}

function columnFromMessage(message) {
  const m = /column "?([^"\s]+)"? (?:of relation "[^"]+" )?does not exist/.exec(message ?? '');
  return m ? m[1] : '';
}

/**
 * The error thrown when a statement runs `MATCH` against an FTS5 table.
 * @param {string} table
 * @param {string} sql
 */
export function ftsError(table, sql) {
  const e = /** @type {LibsqlPgError} */ (
    new Error(
      `FTS5 MATCH is not available in Postgres (statement queries "${table}"). ` +
        'Replace the FTS5 table with a tsvector column and query it with ' +
        "`search @@ websearch_to_tsquery('english', ?)`; see the README section " +
        '"Full-text search: FTS5 to tsvector". Statement: ' +
        sql.slice(0, 160),
    )
  );
  e.name = 'LibsqlError';
  e.code = 'FTS5_NOT_SUPPORTED';
  return e;
}
