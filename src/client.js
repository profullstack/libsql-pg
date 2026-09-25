import pg from 'pg';

import { prepare } from './bind.js';
import { translateError } from './errors.js';
import { emptyResultSet, toResultSet } from './result.js';
import { createRewriter } from './rewrite.js';
import { convertDdl } from './schema.js';
import { codeMask, splitStatements } from './sqlparse.js';

/**
 * Postgres behind the @libsql/client surface.
 *
 * `execute`, `batch`, `transaction`, `executeMultiple`, `close`, `sync` and
 * the ResultSet shape are libSQL's; the SQL is rewritten from SQLite's
 * dialect on the way through (see ./rewrite.js) and `?` / `:name`
 * placeholders become `$n`. The approach is the one rssamplifier.com shipped
 * on 2026-09-25, generalised.
 *
 * @typedef {'sqlite' | 'postgres'} Dialect
 * @typedef {'write' | 'read' | 'deferred'} TransactionMode
 * @typedef {{
 *   url: string,
 *   authToken?: string,
 *   syncUrl?: string,
 *   dialect?: Dialect,
 *   pool?: { max?: number, idleTimeoutMillis?: number, connectionTimeoutMillis?: number },
 *   intMode?: 'number' | 'bigint' | 'string',
 *   timestamps?: 'iso' | 'date',
 *   nativeBooleans?: boolean,
 *   statementTimeoutMs?: number,
 *   applicationName?: string,
 *   ssl?: boolean | object,
 *   onWarning?: (message: string, sql: string) => void,
 * }} Config
 */

const { Pool, types } = pg;

/**
 * Read `sslmode=` out of the URL. pg lets the parameter override its `ssl`
 * option and its `require` verifies the certificate, which a self-signed
 * cert on your own box fails; libpq's `require` never verified. So the
 * parameter is honoured here and removed from the string.
 *
 * @param {string} url
 * @param {boolean | object | undefined} explicit
 */
export function connectionSettings(url, explicit) {
  const parsed = new URL(url);
  const mode = parsed.searchParams.get('sslmode');
  parsed.searchParams.delete('sslmode');
  let ssl = explicit;
  if (ssl === undefined) {
    if (mode === 'require' || mode === 'prefer') ssl = { rejectUnauthorized: false };
    else if (mode === 'verify-ca' || mode === 'verify-full') ssl = true;
    else ssl = undefined;
  }
  return { connectionString: parsed.toString(), ssl };
}

/**
 * @param {string} url
 */
function assertPostgresUrl(url) {
  if (typeof url !== 'string' || !url) throw new TypeError('createClient: `url` is required (postgres://user:pass@host:5432/db)');
  const scheme = url.split(':')[0].toLowerCase();
  if (scheme === 'postgres' || scheme === 'postgresql') return;
  const hint =
    scheme === 'libsql' || scheme === 'file' || scheme === 'http' || scheme === 'https' || scheme === 'ws' || scheme === 'wss'
      ? ' This client speaks Postgres only; move the data first with `libsql-pg copy --from <that url> --to postgres://...` and point `url` at Postgres.'
      : '';
  throw new Error(`createClient: url must be postgres:// or postgresql://, got "${scheme}:".${hint}`);
}

/**
 * Per-client type parsing: int8 as number (libSQL's default), or bigint or
 * string via `intMode`; timestamps as ISO text (what a SQLite app stored and
 * compared) unless `timestamps: 'date'`.
 *
 * @param {Config} config
 */
function typeParsers(config) {
  const intMode = config.intMode ?? 'number';
  const int8 =
    intMode === 'bigint' ? (v) => (v === null ? null : BigInt(v)) : intMode === 'string' ? (v) => v : (v) => (v === null ? null : Number(v));
  const numeric = intMode === 'string' ? (v) => v : (v) => (v === null ? null : Number(v));
  const iso = (v) => {
    if (v === null) return null;
    const d = new Date(v.includes('+') || v.endsWith('Z') || /[+-]\d\d(:\d\d)?$/.test(v) ? v : `${v}Z`);
    return Number.isNaN(d.getTime()) ? v : d.toISOString();
  };
  const overrides = new Map([
    [20, int8],
    [1700, numeric],
  ]);
  if ((config.timestamps ?? 'iso') === 'iso') {
    overrides.set(1184, iso);
    overrides.set(1114, iso);
    overrides.set(1082, (v) => v); // date: keep 'YYYY-MM-DD'
  }
  return {
    getTypeParser(oid, format) {
      if (format !== 'binary' && overrides.has(oid)) return overrides.get(oid);
      return types.getTypeParser(oid, format);
    },
  };
}

/**
 * @param {string} sql
 * @returns {string | null} the INSERT's target table, lower-cased, when the
 *   statement is a plain INSERT without RETURNING
 */
function insertWithoutReturning(sql) {
  const mask = codeMask(sql);
  const m = /^\s*insert\s+into\s+("[^"]+"|[A-Za-z_][A-Za-z0-9_.]*)/i.exec(mask);
  if (!m) return null;
  if (/\breturning\b/i.test(mask)) return null;
  const raw = sql.slice(m.index + m[0].length - m[1].length, m.index + m[0].length);
  return raw.startsWith('"') ? raw.slice(1, -1) : raw.toLowerCase();
}

/**
 * @param {Config} config
 */
export function createClient(config) {
  if (!config || typeof config !== 'object') throw new TypeError('createClient(config): config object required');
  assertPostgresUrl(config.url);
  const dialect = config.dialect ?? 'sqlite';
  if (dialect !== 'sqlite' && dialect !== 'postgres') throw new RangeError(`dialect must be 'sqlite' or 'postgres', got ${dialect}`);
  const { connectionString, ssl } = connectionSettings(config.url, config.ssl);
  const pool = new Pool({
    connectionString,
    ssl,
    max: config.pool?.max ?? 10,
    idleTimeoutMillis: config.pool?.idleTimeoutMillis,
    connectionTimeoutMillis: config.pool?.connectionTimeoutMillis,
    application_name: config.applicationName ?? 'libsql-pg',
    statement_timeout: config.statementTimeoutMs,
    allowExitOnIdle: true,
    types: typeParsers(config),
  });
  pool.on('error', () => {
    /* an idle connection dropped by the server; the next query reconnects */
  });
  const bindOpts = { nativeBooleans: config.nativeBooleans ?? false };

  /** @type {Map<string, import('./rewrite.js').TableKeys | undefined>} */
  const keysCache = new Map();
  /** @type {Map<string, string | null>} table -> identity/serial pk column */
  const pkCache = new Map();
  /** @type {Map<string, string[]>} constraint -> columns */
  const constraintCache = new Map();
  const warned = new Set();
  let pgcryptoEnsured = false;

  const rewriter = createRewriter({
    keys: (table) => keysCache.get(table),
    ddl: (sql) => convertDdl(sql),
  });

  /** Primary key, unique indexes and columns of a table, cached. */
  async function loadKeys(table) {
    if (keysCache.has(table)) return keysCache.get(table);
    let info;
    try {
      const { rows } = await pool.query(
        `select i.indisprimary as pk, array_agg(a.attname::text order by x.ord) as cols
           from pg_index i
           join lateral unnest(i.indkey) with ordinality as x(attnum, ord) on true
           join pg_attribute a on a.attrelid = i.indrelid and a.attnum = x.attnum
          where i.indrelid = to_regclass($1) and (i.indisprimary or i.indisunique) and i.indpred is null
          group by i.indexrelid, i.indisprimary
          order by i.indisprimary desc, min(x.ord)`,
        [table.includes('"') || /^[a-z_][a-z0-9_.]*$/.test(table) ? table : `"${table}"`],
      );
      const cols = await pool.query(
        `select attname from pg_attribute where attrelid = to_regclass($1) and attnum > 0 and not attisdropped order by attnum`,
        [table.includes('"') || /^[a-z_][a-z0-9_.]*$/.test(table) ? table : `"${table}"`],
      );
      const pk = rows.find((r) => r.pk)?.cols ?? [];
      const unique = rows.filter((r) => !r.pk).map((r) => r.cols);
      info = { pk, unique, columns: cols.rows.map((r) => r.attname) };
    } catch {
      info = undefined;
    }
    keysCache.set(table, info);
    return info;
  }

  /** The identity or serial primary-key column of a table, if it has one. */
  async function loadPk(table) {
    if (pkCache.has(table)) return pkCache.get(table);
    let col = null;
    try {
      const { rows } = await pool.query(
        `select a.attname
           from pg_index i
           join pg_attribute a on a.attrelid = i.indrelid and a.attnum = any(i.indkey)
           left join pg_attrdef d on d.adrelid = a.attrelid and d.adnum = a.attnum
          where i.indrelid = to_regclass($1) and i.indisprimary and array_length(i.indkey, 1) = 1
            and (a.attidentity <> '' or pg_get_expr(d.adbin, d.adrelid) like 'nextval(%')`,
        [/^[a-z_][a-z0-9_.]*$/.test(table) ? table : `"${table}"`],
      );
      col = rows[0]?.attname ?? null;
    } catch {
      col = null;
    }
    pkCache.set(table, col);
    return col;
  }

  /** Columns of a unique constraint or index, for the SQLite-style message. */
  async function constraintColumns(name) {
    if (!name) return undefined;
    if (constraintCache.has(name)) return constraintCache.get(name);
    let cols;
    try {
      const { rows } = await pool.query(
        `select a.attname
           from pg_class c
           join pg_index i on i.indexrelid = c.oid
           join lateral unnest(i.indkey) with ordinality as x(attnum, ord) on true
           join pg_attribute a on a.attrelid = i.indrelid and a.attnum = x.attnum
          where c.relname = $1
          order by x.ord`,
        [name],
      );
      cols = rows.map((r) => r.attname);
    } catch {
      cols = undefined;
    }
    constraintCache.set(name, cols);
    return cols;
  }

  async function translate(err) {
    if (err?.code === '23505') {
      const columns = await constraintColumns(err.constraint);
      return translateError(err, { columns });
    }
    return translateError(err);
  }

  /**
   * @param {string | { sql: string, args?: unknown[] | Record<string, unknown> }} statement
   * @param {unknown[] | Record<string, unknown>} [args]
   */
  function normalize(statement, args) {
    if (typeof statement === 'string') return { sql: statement, args };
    if (statement && typeof statement === 'object' && typeof statement.sql === 'string') return { sql: statement.sql, args: statement.args };
    throw new TypeError('execute() takes a SQL string or { sql, args }');
  }

  /**
   * Rewrite (resolving any table keys the rewrite needs) and bind.
   * @param {{ sql: string, args?: unknown[] | Record<string, unknown> }} st
   */
  async function compile(st) {
    let rewritten;
    if (dialect === 'sqlite') {
      const need = rewriter.needsKeys(st.sql);
      if (need) await loadKeys(need);
      rewritten = rewriter.rewrite(st.sql);
      if (config.onWarning && rewritten.warnings.length && !warned.has(st.sql)) {
        warned.add(st.sql);
        for (const w of rewritten.warnings) config.onWarning(w, st.sql);
      }
    } else {
      rewritten = { sql: st.sql, noop: false, warnings: [], kind: 'dml' };
    }
    if (rewritten.noop) return { noop: true };
    let text = rewritten.sql;
    // randomblob() became gen_random_bytes(), which lives in pgcrypto. Ask
    // for the extension once; if the role may not, the real error follows.
    if (!pgcryptoEnsured && /\bgen_random_bytes\s*\(/i.test(text)) {
      pgcryptoEnsured = true;
      await pool.query('create extension if not exists pgcrypto').catch(() => {});
    }
    // lastInsertRowid: ask for the identity/serial primary key when the
    // statement is an INSERT without its own RETURNING.
    let rowidColumn = null;
    const table = insertWithoutReturning(text);
    if (table) {
      rowidColumn = await loadPk(table);
      if (rowidColumn) text = `${text.replace(/;\s*$/, '')} RETURNING "${rowidColumn}"`;
    }
    const prepared = prepare(text, st.args, bindOpts);
    return { noop: false, text: prepared.text, values: prepared.values, rowidColumn };
  }

  /**
   * Run one statement on a pool or a checked-out connection.
   * @param {{ query: Function }} target
   * @param {{ sql: string, args?: unknown[] | Record<string, unknown> }} st
   */
  async function run(target, st) {
    const c = await compile(st);
    if (c.noop) return emptyResultSet();
    let res;
    try {
      res = await target.query({ text: c.text, values: c.values, rowMode: 'array' });
    } catch (err) {
      throw await translate(err);
    }
    if (c.rowidColumn) {
      const value = res.rows?.[0]?.[0];
      const lastInsertRowid = value === undefined || value === null ? undefined : BigInt(value);
      return toResultSet(res, { lastInsertRowid, rowsAffected: res.rowCount ?? 0, hideRows: true });
    }
    return toResultSet(res);
  }

  function beginSql(mode) {
    if (mode === 'read') return 'begin read only';
    if (mode === 'write' || mode === 'deferred' || mode === undefined) return 'begin';
    throw new RangeError('Unknown transaction mode, supported values are "write", "read" and "deferred"');
  }

  /** Statements a pooled client cannot honour: each execute may land on another connection. */
  function rejectBareTransactionControl(sql) {
    if (/^\s*(begin|commit|rollback|end)\b/i.test(codeMask(sql))) {
      throw new Error(`"${sql.trim().split(/\s+/)[0].toUpperCase()}" through execute() runs on one pooled connection and the next statement on another; use client.transaction() or client.batch() instead`);
    }
  }

  const client = {
    /** @type {'postgres'} */
    protocol: 'postgres',
    closed: false,

    async execute(statement, args) {
      const st = normalize(statement, args);
      rejectBareTransactionControl(st.sql);
      return run(pool, st);
    },

    /**
     * One transaction on one connection, one result per statement, in order.
     * @param {Array<string | { sql: string, args?: unknown[] | Record<string, unknown> }>} statements
     * @param {TransactionMode} [mode]
     */
    async batch(statements, mode = 'deferred') {
      const begin = beginSql(mode);
      const conn = await pool.connect();
      try {
        await conn.query(begin);
        const results = [];
        for (const s of statements) results.push(await run(conn, normalize(s)));
        await conn.query('commit');
        return results;
      } catch (err) {
        try {
          await conn.query('rollback');
        } catch {
          /* connection already gone */
        }
        throw err;
      } finally {
        conn.release();
      }
    },

    /**
     * An interactive transaction held across awaits; libSQL's Transaction surface.
     * @param {TransactionMode} [mode]
     */
    async transaction(mode = 'deferred') {
      const begin = beginSql(mode);
      const conn = await pool.connect();
      let open = true;
      try {
        await conn.query(begin);
      } catch (err) {
        conn.release();
        throw await translate(err);
      }
      const finish = async (verb) => {
        if (!open) return;
        open = false;
        try {
          await conn.query(verb);
        } catch (err) {
          throw await translate(err);
        } finally {
          conn.release();
        }
      };
      return {
        execute: (statement, args) => run(conn, normalize(statement, args)),
        async batch(statements) {
          const out = [];
          for (const s of statements) out.push(await run(conn, normalize(s)));
          return out;
        },
        async executeMultiple(sql) {
          for (const s of splitStatements(sql)) await run(conn, { sql: s });
        },
        commit: () => finish('commit'),
        rollback: () => finish('rollback'),
        close: () => finish('rollback'),
        get closed() {
          return !open;
        },
      };
    },

    /**
     * Several statements in one string, run in order on one connection with
     * no transaction around them (libSQL's behaviour). PRAGMAs are skipped
     * and DDL goes through the schema converter.
     * @param {string} sql
     */
    async executeMultiple(sql) {
      const conn = await pool.connect();
      try {
        for (const s of splitStatements(sql)) {
          rejectBareTransactionControl(s);
          await run(conn, { sql: s });
        }
      } finally {
        conn.release();
      }
    },

    /** Embedded-replica sync has no meaning here. */
    async sync() {},

    close() {
      if (client.closed) return Promise.resolve();
      client.closed = true;
      return pool.end();
    },

    /**
     * Rewrite a statement without running it: what Postgres will be sent.
     * @param {string} sql
     */
    async explainRewrite(sql) {
      const need = rewriter.needsKeys(sql);
      if (need) await loadKeys(need);
      return rewriter.rewrite(sql);
    },

    /** The pg pool, for COPY, LISTEN/NOTIFY and anything else libSQL never had. */
    pool,
  };
  return client;
}
