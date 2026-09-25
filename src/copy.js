import pg from 'pg';

import { connectionSettings } from './client.js';
import { codeMask, quoteIdent, splitTopLevel, unquote } from './sqlparse.js';

/**
 * Copy a Turso / libSQL / SQLite-file database into Postgres.
 *
 * Generalised from the loader that moved rssamplifier.com (46 GB, 15.5M
 * rows in one table) on 2026-09-25, with its lessons kept:
 *
 *   - rows are paged out of SQLite by rowid, the physical order, in batches;
 *   - the first and last rowid are two separate `order by rowid limit 1`
 *     lookups: `select min(rowid), max(rowid)` in one query makes SQLite scan
 *     the whole table, which over the network is a stall;
 *   - Turso drops the odd request under load, so every read has a deadline
 *     (600 s) and retries;
 *   - `truncate only`, never `cascade`: a cascade on a parent table silently
 *     empties every table that references it;
 *   - `--upsert` refreshes a parent in place through a temp table and
 *     `on conflict (pk) do update`, with identity columns kept out of the
 *     SET list (Postgres refuses to update a GENERATED ALWAYS identity) and
 *     rows the source deleted removed too;
 *   - identity/serial sequences are moved past the copied ids, or the app's
 *     first insert collides with a copied row;
 *   - `--verify` counts rows on both sides before anyone flips a switch.
 *
 * Postgres holds the schema already (run `libsql-pg convert-schema` first).
 * Values are coerced to the target column's type from information_schema,
 * because SQLite is dynamically typed: a text column can hold a number and
 * an integer column an empty string.
 *
 * @typedef {{
 *   from: string,
 *   token?: string,
 *   to: string,
 *   tables?: string[],
 *   exclude?: string[],
 *   truncate?: boolean,
 *   upsert?: boolean,
 *   batch?: number,
 *   workers?: number,
 *   readTimeoutMs?: number,
 *   retries?: number,
 *   dryRun?: boolean,
 *   log?: (line: string) => void,
 * }} CopyOptions
 *
 * @typedef {{ table: string, mode: string, rows: number, seconds: number, skipped?: string }} TableReport
 */

const SQLITE_INTERNAL = /^sqlite_/i;

/**
 * Tables listed in sqlite_master, minus SQLite's own and the FTS shadow
 * tables (`x_data`, `x_idx`, `x_content`, `x_docsize`, `x_config` for each
 * virtual table `x`, which are not tables the app wrote to).
 *
 * @param {Array<{ name: string, sql: string | null, type?: string }>} master rows of sqlite_master
 * @returns {Array<{ name: string, sql: string }>}
 */
export function userTables(master) {
  const virtual = new Set(
    master.filter((r) => r.sql && /^\s*create\s+virtual\s+table/i.test(r.sql)).map((r) => r.name),
  );
  const shadow = new Set();
  for (const v of virtual) for (const s of ['data', 'idx', 'content', 'docsize', 'config', 'segments', 'segdir', 'stat']) shadow.add(`${v}_${s}`);
  return master
    .filter((r) => (r.type ?? 'table') === 'table')
    .filter((r) => !SQLITE_INTERNAL.test(r.name) && !virtual.has(r.name) && !shadow.has(r.name) && r.sql)
    .map((r) => ({ name: r.name, sql: /** @type {string} */ (r.sql) }));
}

/**
 * Tables a CREATE TABLE references (its FK parents), from its SQL.
 * @param {string} sql
 * @returns {string[]}
 */
export function referencedTables(sql) {
  const mask = codeMask(sql);
  const out = new Set();
  const re = /\breferences\s+("[^"]*"|`[^`]*`|\[[^\]]*\]|[A-Za-z_][A-Za-z0-9_]*)/gi;
  // Quoted names are blanked in the mask; take them from the text by index.
  for (let m = re.exec(mask); m; m = re.exec(mask)) {
    const start = m.index + m[0].length - m[1].length;
    const raw = sql.slice(start, m.index + m[0].length);
    const q = raw[0];
    let name;
    if (q === '"' || q === '`' || q === '[') {
      const end = sql.indexOf(q === '[' ? ']' : q, start + 1);
      name = sql.slice(start + 1, end === -1 ? undefined : end);
    } else name = unquote(raw);
    out.add(name);
  }
  return [...out];
}

/**
 * Order tables so FK parents load before their children. Tables in a cycle
 * (or self-referencing) fall to the end in alphabetical order, and the
 * caller loads with constraints deferred.
 *
 * @param {Array<{ name: string, sql: string }>} tables
 * @returns {{ order: string[], cyclic: string[] }}
 */
export function orderTables(tables) {
  const byName = new Map(tables.map((t) => [t.name, t]));
  const lower = new Map(tables.map((t) => [t.name.toLowerCase(), t.name]));
  const deps = new Map();
  for (const t of tables) {
    const parents = referencedTables(t.sql)
      .map((p) => lower.get(p.toLowerCase()))
      .filter((p) => p && p !== t.name && byName.has(p));
    deps.set(t.name, new Set(parents));
  }
  const order = [];
  const placed = new Set();
  let remaining = [...tables.map((t) => t.name)].sort();
  for (;;) {
    const ready = remaining.filter((n) => [...deps.get(n)].every((p) => placed.has(p)));
    if (!ready.length) break;
    for (const n of ready) {
      order.push(n);
      placed.add(n);
    }
    remaining = remaining.filter((n) => !placed.has(n));
  }
  return { order: [...order, ...remaining], cyclic: remaining };
}

/**
 * Coerce a SQLite value to what Postgres will accept for the column type.
 *
 * @param {unknown} value
 * @param {string} dataType information_schema.columns.data_type
 * @returns {unknown} a value pg can send, or null
 */
export function coerce(value, dataType) {
  if (value === null || value === undefined) return null;
  if (value instanceof ArrayBuffer) value = Buffer.from(value);
  else if (ArrayBuffer.isView(value) && !(value instanceof Buffer)) value = Buffer.from(value.buffer, value.byteOffset, value.byteLength);
  switch (dataType) {
    case 'bigint':
    case 'integer':
    case 'smallint': {
      if (value === '' || value === false) return null;
      if (value === true) return 1;
      if (typeof value === 'bigint') return value.toString();
      const n = Number(value);
      return Number.isFinite(n) ? String(Math.trunc(n)) : null;
    }
    case 'double precision':
    case 'real':
    case 'numeric': {
      if (value === '') return null;
      if (typeof value === 'bigint') return value.toString();
      const n = Number(value);
      return Number.isFinite(n) ? String(n) : null;
    }
    case 'boolean': {
      if (typeof value === 'boolean') return value;
      if (typeof value === 'bigint') return value !== 0n;
      if (typeof value === 'number') return value !== 0;
      const s = String(value).trim().toLowerCase();
      if (s === '' ) return null;
      if (s === '1' || s === 'true' || s === 't' || s === 'yes' || s === 'y') return true;
      if (s === '0' || s === 'false' || s === 'f' || s === 'no' || s === 'n') return false;
      return null;
    }
    case 'timestamp with time zone':
    case 'timestamp without time zone':
    case 'date': {
      if (value === '') return null;
      if (typeof value === 'bigint') value = Number(value);
      if (typeof value === 'number' || (typeof value === 'string' && /^-?\d+(\.\d+)?$/.test(value.trim()))) {
        // A unix epoch: seconds unless it is clearly milliseconds.
        const n = Number(value);
        const ms = Math.abs(n) >= 1e11 ? n : n * 1000;
        const d = new Date(ms);
        if (Number.isNaN(d.getTime())) return null;
        return dataType === 'date' ? d.toISOString().slice(0, 10) : d.toISOString();
      }
      return typeof value === 'string' ? value : String(value);
    }
    case 'bytea': {
      if (Buffer.isBuffer(value)) return value;
      return Buffer.from(String(value), 'utf8');
    }
    case 'json':
    case 'jsonb': {
      if (typeof value === 'string') return value === '' ? null : value;
      if (Buffer.isBuffer(value)) return value.toString('utf8');
      return JSON.stringify(value);
    }
    default: {
      // text, uuid, character varying, ...: Postgres text cannot hold NUL.
      if (Buffer.isBuffer(value)) return value.toString('utf8').replace(/\0/g, '');
      if (typeof value === 'string') return value.includes('\0') ? value.replace(/\0/g, '') : value;
      if (typeof value === 'bigint') return value.toString();
      return String(value);
    }
  }
}

/** The pg array element type for an information_schema data_type. */
function arrayType(dataType) {
  switch (dataType) {
    case 'character varying':
      return 'text';
    case 'timestamp with time zone':
      return 'timestamptz';
    case 'timestamp without time zone':
      return 'timestamp';
    case 'double precision':
    case 'bigint':
    case 'integer':
    case 'smallint':
    case 'real':
    case 'numeric':
    case 'boolean':
    case 'date':
    case 'bytea':
    case 'json':
    case 'jsonb':
    case 'uuid':
    case 'text':
      return dataType;
    case 'ARRAY':
    case 'USER-DEFINED':
      return 'text';
    default:
      return 'text';
  }
}

/**
 * Build the batched insert: one array parameter per column, unnested.
 *
 * @param {string} table
 * @param {Array<{ column_name: string, data_type: string, is_identity: string }>} cols
 * @returns {string}
 */
export function insertSql(table, cols) {
  const names = cols.map((c) => quoteIdent(c.column_name)).join(', ');
  const arrays = cols.map((c, i) => `$${i + 1}::${arrayType(c.data_type)}[]`).join(', ');
  const overriding = cols.some((c) => c.is_identity === 'YES') ? ' overriding system value' : '';
  return `insert into ${quoteIdent(table)} (${names})${overriding} select * from unnest(${arrays})`;
}

/**
 * @param {CopyOptions} opts
 */
export async function copyDatabase(opts) {
  const log = opts.log ?? ((line) => console.log(`${new Date().toISOString().slice(11, 19)} ${line}`));
  const BATCH = Math.max(1, opts.batch ?? 2000);
  const WORKERS = Math.max(1, opts.workers ?? 1);
  const RETRIES = opts.retries ?? 5;
  const TIMEOUT = opts.readTimeoutMs ?? 600_000;

  let libsql;
  try {
    libsql = await import('@libsql/client');
  } catch {
    throw new Error('`libsql-pg copy` reads the source with @libsql/client; install it next to this package: npm i @libsql/client');
  }
  const src = libsql.createClient({
    url: opts.from,
    authToken: opts.token,
    intMode: 'number',
    fetch: (input, init = {}) =>
      fetch(input, { ...init, signal: AbortSignal.any([init.signal, AbortSignal.timeout(TIMEOUT)].filter(Boolean)) }),
  });
  /** A source read with retries: Turso drops the odd request under load. */
  async function read(statement) {
    for (let i = 1; ; i++) {
      try {
        return await src.execute(statement);
      } catch (err) {
        if (i > RETRIES) throw err;
        log(`read failed (${String(err?.message ?? err).slice(0, 80)}); retry ${i}/${RETRIES}`);
        await new Promise((r) => setTimeout(r, 2_000 * i));
      }
    }
  }

  const { connectionString, ssl } = connectionSettings(opts.to, undefined);
  const dst = new pg.Pool({ connectionString, ssl, max: WORKERS + 2 });
  /** @type {TableReport[]} */
  const reports = [];

  try {
    const master = (await read("select name, type, sql from sqlite_master where type = 'table' order by name")).rows.map((r) => ({
      name: String(r.name),
      type: String(r.type),
      sql: r.sql === null ? null : String(r.sql),
    }));
    let tables = userTables(master);
    if (opts.tables?.length) {
      const want = new Set(opts.tables.map((t) => t.toLowerCase()));
      tables = tables.filter((t) => want.has(t.name.toLowerCase()));
      for (const w of opts.tables) if (!tables.some((t) => t.name.toLowerCase() === w.toLowerCase())) log(`${w}: not found in the source, skipped`);
    }
    if (opts.exclude?.length) {
      const skip = new Set(opts.exclude.map((t) => t.toLowerCase()));
      tables = tables.filter((t) => !skip.has(t.name.toLowerCase()));
    }
    const { order, cyclic } = orderTables(tables);
    if (cyclic.length) log(`FK cycle or self-reference among: ${cyclic.join(', ')} (loaded last, constraints deferred)`);
    log(`${order.length} table(s): ${order.join(', ')}`);
    if (opts.dryRun) {
      for (const t of order) reports.push({ table: t, mode: 'dry-run', rows: 0, seconds: 0 });
      return reports;
    }

    // Loading with FK checks off needs a superuser (session_replication_role);
    // without one, parents-first ordering plus deferred constraints must do.
    const probe = await dst.connect();
    let replica = false;
    try {
      await probe.query("set session_replication_role = 'replica'");
      replica = true;
    } catch {
      log('no permission for session_replication_role = replica; relying on table order and deferred constraints');
    } finally {
      probe.release();
    }

    for (const table of order) {
      const t0 = Date.now();
      try {
        const r = await loadTable(table);
        reports.push({ ...r, seconds: Math.round((Date.now() - t0) / 1000) });
      } catch (err) {
        reports.push({ table, mode: 'error', rows: 0, seconds: Math.round((Date.now() - t0) / 1000), skipped: String(err?.message ?? err) });
        log(`${table}: FAILED ${String(err?.message ?? err)}`);
        throw err;
      }
    }
    log('all tables loaded');
    return reports;

    // ---------------------------------------------------------------- tables

    async function pgColumns(table) {
      const { rows } = await dst.query(
        `select column_name, data_type, is_generated, is_identity, column_default
           from information_schema.columns
          where table_schema = current_schema() and table_name = $1
          order by ordinal_position`,
        [table],
      );
      return rows.filter((r) => r.is_generated !== 'ALWAYS');
    }

    async function sqliteColumns(table) {
      const { rows } = await read(`pragma table_info(${quoteIdent(table)})`);
      return rows.map((r) => String(r.name));
    }

    async function primaryKey(table) {
      const { rows } = await dst.query(
        `select a.attname
           from pg_index i
           join lateral unnest(i.indkey) with ordinality as x(attnum, ord) on true
           join pg_attribute a on a.attrelid = i.indrelid and a.attnum = x.attnum
          where i.indrelid = to_regclass($1) and i.indisprimary
          order by x.ord`,
        [quoteIdent(table)],
      );
      return rows.map((r) => r.attname);
    }

    async function session(conn) {
      if (replica) await conn.query("set session_replication_role = 'replica'");
      else await conn.query('set constraints all deferred').catch(() => {});
    }

    /** Insert rows in one batch, coerced to the target types. */
    async function insertBatch(conn, table, cols, rows) {
      if (!rows.length) return 0;
      const arrays = cols.map((c) => rows.map((r) => coerce(r[c.column_name], c.data_type)));
      const res = await conn.query({ text: insertSql(table, cols), values: arrays });
      return res.rowCount ?? rows.length;
    }

    async function resetSequences(conn, table, pgCols) {
      const serial = pgCols.filter((c) => c.is_identity === 'YES' || /^nextval\(/.test(c.column_default ?? ''));
      for (const c of serial) {
        await conn.query(
          `select setval(pg_get_serial_sequence($1, $2), greatest(coalesce((select max(${quoteIdent(c.column_name)}) from ${quoteIdent(table)}), 0), 1), coalesce((select max(${quoteIdent(c.column_name)}) from ${quoteIdent(table)}), 0) > 0)`,
          [quoteIdent(table), c.column_name],
        );
      }
    }

    /** Does the source table have a rowid we can page on? */
    async function hasRowid(table) {
      try {
        await read(`select rowid from ${quoteIdent(table)} limit 1`);
        return true;
      } catch {
        return false; // WITHOUT ROWID table
      }
    }

    /**
     * Stream a table's rows in rowid order, calling `sink(rows)` per batch.
     * Two lookups for the bounds, never `min(rowid), max(rowid)` together.
     */
    async function streamRows(table, sink, { workers = 1 } = {}) {
      const q = quoteIdent(table);
      if (!(await hasRowid(table))) {
        let offset = 0;
        for (;;) {
          const { rows } = await read({ sql: `select * from ${q} limit ? offset ?`, args: [BATCH, offset] });
          if (!rows.length) break;
          await sink(rows, 0);
          offset += rows.length;
          if (rows.length < BATCH) break;
        }
        return;
      }
      const first = (await read(`select rowid as r from ${q} order by rowid limit 1`)).rows[0];
      if (!first) return;
      const last = (await read(`select rowid as r from ${q} order by rowid desc limit 1`)).rows[0];
      const lo = Number(first.r);
      const hi = Number(last.r);
      const span = hi - lo + 1;
      const n = Math.max(1, Math.min(workers, Math.ceil(span / BATCH)));
      const slice = Math.ceil(span / n);
      const select = `select rowid as __rowid, * from ${q} where rowid > ? and rowid <= ? order by rowid limit ?`;
      const runSlice = async (from, to, idx) => {
        let cursor = from - 1;
        for (;;) {
          const { rows } = await read({ sql: select, args: [cursor, to, BATCH] });
          if (!rows.length) break;
          await sink(rows, idx);
          cursor = Number(rows[rows.length - 1].__rowid);
          if (rows.length < BATCH) break;
        }
      };
      const jobs = [];
      for (let i = 0; i < n; i++) jobs.push(runSlice(lo + i * slice, Math.min(hi, lo + (i + 1) * slice - 1), i));
      await Promise.all(jobs);
    }

    /** @returns {Promise<TableReport>} */
    async function loadTable(table) {
      const pgCols = await pgColumns(table);
      if (!pgCols.length) {
        log(`${table}: not in Postgres, skipped (run convert-schema and apply it first)`);
        return { table, mode: 'skipped', rows: 0, seconds: 0, skipped: 'not in Postgres' };
      }
      const srcCols = new Set(await sqliteColumns(table));
      // Columns present on both sides. A Postgres identity column named rowid
      // takes SQLite's implicit rowid so cursors that page on it keep working.
      const cols = pgCols.filter((c) => srcCols.has(c.column_name) || c.column_name === 'rowid');
      const takesRowid = !srcCols.has('rowid') && cols.some((c) => c.column_name === 'rowid');
      const missing = pgCols.filter((c) => !cols.includes(c)).map((c) => c.column_name);
      if (missing.length) log(`${table}: Postgres columns not in the source, left to their defaults: ${missing.join(', ')}`);

      const conn = await dst.connect();
      try {
        await session(conn);
        if (opts.upsert) return await upsertTable(conn, table, cols, pgCols, takesRowid);
        const existing = Number((await conn.query(`select count(*) from ${quoteIdent(table)}`)).rows[0].count);
        if (opts.truncate) {
          // `only`, never `cascade`: a cascade on a parent silently empties
          // every table referencing it. A parent is refreshed with --upsert.
          await conn.query(`truncate only ${quoteIdent(table)}`);
        } else if (existing > 0) {
          log(`${table}: ${existing} rows already there, skipped (use --truncate or --upsert)`);
          return { table, mode: 'skipped', rows: existing, seconds: 0, skipped: 'already has rows' };
        }
        let total = 0;
        const started = Date.now();
        const conns = [conn];
        const sink = async (rows, idx) => {
          const c = conns[idx] ?? (conns[idx] = await dst.connect().then(async (x) => (await session(x), x)));
          const mapped = takesRowid ? rows.map((r) => ({ ...r, rowid: r.__rowid })) : rows;
          await insertBatch(c, table, cols, mapped);
          total += rows.length;
          if (total % (BATCH * 10) < rows.length) log(`${table}: ${total} rows (${Math.round(total / Math.max(1, (Date.now() - started) / 1000))}/s)`);
        };
        try {
          await streamRows(table, sink, { workers: WORKERS });
        } finally {
          for (const c of conns.slice(1)) c.release();
        }
        await resetSequences(conn, table, pgCols);
        log(`${table}: ${total} rows`);
        return { table, mode: opts.truncate ? 'truncate' : 'load', rows: total, seconds: 0 };
      } finally {
        conn.release();
      }
    }

    /**
     * Refresh in place: everything into a temp table, then insert-or-update by
     * primary key, delete what the source no longer has, reset sequences.
     * @returns {Promise<TableReport>}
     */
    async function upsertTable(conn, table, cols, pgCols, takesRowid) {
      const pk = await primaryKey(table);
      if (!pk.length) throw new Error(`${table}: no primary key, cannot --upsert (use --truncate for a leaf table)`);
      const tmp = `libsql_pg_tmp_${table}`.slice(0, 63);
      const q = quoteIdent;
      await conn.query('begin');
      try {
        if (replica) await conn.query("set local session_replication_role = 'replica'");
        await conn.query(
          `create temp table ${q(tmp)} (like ${q(table)} including defaults excluding identity excluding generated excluding indexes excluding constraints) on commit drop`,
        );
        const tmpCols = cols.map((c) => ({ ...c, is_identity: 'NO' }));
        let total = 0;
        await streamRows(table, async (rows) => {
          const mapped = takesRowid ? rows.map((r) => ({ ...r, rowid: r.__rowid })) : rows;
          await insertBatch(conn, tmp, tmpCols, mapped);
          total += rows.length;
        });
        // Identity columns take their value on insert (OVERRIDING SYSTEM
        // VALUE) but may not appear in the update branch.
        const identity = new Set(pgCols.filter((c) => c.is_identity === 'YES').map((c) => c.column_name));
        const nonPk = cols.map((c) => c.column_name).filter((c) => !pk.includes(c) && !identity.has(c));
        const set = nonPk.length ? `do update set ${nonPk.map((c) => `${q(c)} = excluded.${q(c)}`).join(', ')}` : 'do nothing';
        const list = cols.map((c) => q(c.column_name)).join(', ');
        const res = await conn.query(
          `insert into ${q(table)} (${list}) overriding system value select ${list} from ${q(tmp)} on conflict (${pk.map(q).join(', ')}) ${set}`,
        );
        // Mirror deletes: rows the source purged must not linger, or verify never matches.
        const gone = await conn.query(
          `delete from ${q(table)} t where not exists (select 1 from ${q(tmp)} s where (${pk.map((c) => `s.${q(c)}`).join(', ')}) = (${pk.map((c) => `t.${q(c)}`).join(', ')}))`,
        );
        await resetSequences(conn, table, pgCols);
        await conn.query('commit');
        log(`${table}: upserted ${res.rowCount} of ${total} rows, removed ${gone.rowCount} stale`);
        return { table, mode: 'upsert', rows: total, seconds: 0 };
      } catch (err) {
        await conn.query('rollback').catch(() => {});
        throw err;
      }
    }
  } finally {
    src.close();
    await dst.end();
  }
}

/**
 * Compare count(*) per table on both sides.
 *
 * @param {{ from: string, token?: string, to: string, tables?: string[], exclude?: string[], readTimeoutMs?: number, log?: (line: string) => void }} opts
 * @returns {Promise<{ ok: boolean, rows: Array<{ table: string, source: number, target: number | null, ok: boolean }> }>}
 */
export async function verifyCopy(opts) {
  const log = opts.log ?? ((line) => console.log(line));
  const libsql = await import('@libsql/client');
  const TIMEOUT = opts.readTimeoutMs ?? 600_000;
  const src = libsql.createClient({
    url: opts.from,
    authToken: opts.token,
    intMode: 'number',
    fetch: (input, init = {}) => fetch(input, { ...init, signal: AbortSignal.any([init.signal, AbortSignal.timeout(TIMEOUT)].filter(Boolean)) }),
  });
  const { connectionString, ssl } = connectionSettings(opts.to, undefined);
  const dst = new pg.Pool({ connectionString, ssl, max: 2 });
  const out = [];
  try {
    const master = (await src.execute("select name, type, sql from sqlite_master where type = 'table' order by name")).rows.map((r) => ({
      name: String(r.name),
      type: String(r.type),
      sql: r.sql === null ? null : String(r.sql),
    }));
    let tables = userTables(master).map((t) => t.name);
    if (opts.tables?.length) {
      const want = new Set(opts.tables.map((t) => t.toLowerCase()));
      tables = tables.filter((t) => want.has(t.toLowerCase()));
    }
    if (opts.exclude?.length) {
      const skip = new Set(opts.exclude.map((t) => t.toLowerCase()));
      tables = tables.filter((t) => !skip.has(t.toLowerCase()));
    }
    log(`${'table'.padEnd(32)} ${'source'.padStart(12)} ${'target'.padStart(12)}`);
    for (const table of tables) {
      const s = Number((await src.execute(`select count(*) as n from ${quoteIdent(table)}`)).rows[0].n);
      let d = null;
      try {
        d = Number((await dst.query(`select count(*) as n from ${quoteIdent(table)}`)).rows[0].n);
      } catch {
        d = null;
      }
      const ok = d !== null && s === d;
      out.push({ table, source: s, target: d, ok });
      log(`${table.padEnd(32)} ${String(s).padStart(12)} ${String(d ?? 'missing').padStart(12)} ${ok ? 'ok' : 'DIFF'}`);
    }
  } finally {
    src.close();
    await dst.end();
  }
  const ok = out.every((r) => r.ok);
  log(ok ? `verify: ${out.length} table(s) match` : `verify: ${out.filter((r) => !r.ok).length} of ${out.length} table(s) DIFFER`);
  return { ok, rows: out };
}

/**
 * Split a comma list from the command line.
 * @param {string | undefined} value
 */
export function commaList(value) {
  return value ? value.split(',').map((s) => s.trim()).filter(Boolean) : [];
}

// Re-exported for tests of the FK ordering without a database.
export { splitTopLevel };
