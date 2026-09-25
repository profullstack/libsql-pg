import { codeMask } from './sqlparse.js';

/**
 * Placeholder translation and value binding.
 *
 * libSQL accepts `?`, `?NNN`, `:name`, `@name` and `$name`; Postgres wants
 * `$1..$n`. Positional and named forms are handled here, outside literals and
 * comments, and the args are lined up with the numbers that come out.
 */

/**
 * Turn `?` and `?NNN` placeholders into `$1..$n`.
 *
 * `?` counts up; `?3` becomes `$3` (libSQL numbers from 1, as Postgres does).
 * A `?` that is a jsonb operator (`?`, `?|`, `?&`) cannot be told apart from
 * a placeholder; use `jsonb_exists()` in Postgres-native SQL instead.
 *
 * @param {string} sql
 * @returns {string}
 */
export function positional(sql) {
  const mask = codeMask(sql);
  let out = '';
  let n = 0;
  let i = 0;
  while (i < sql.length) {
    if (mask[i] === '?') {
      const num = /^\d+/.exec(mask.slice(i + 1, i + 8));
      if (num) {
        out += `$${num[0]}`;
        i += 1 + num[0].length;
      } else {
        n += 1;
        out += `$${n}`;
        i += 1;
      }
    } else {
      out += sql[i];
      i += 1;
    }
  }
  return out;
}

/**
 * Turn `:name`, `@name` and `$name` placeholders into `$1..$n` and line the
 * named values up with them. A name used twice gets one number. A `::` cast
 * and a `$1` that is already numeric are left alone.
 *
 * @param {string} sql
 * @param {Record<string, unknown>} named keys with or without their prefix
 * @returns {{ sql: string, values: unknown[] }}
 */
export function named(sql, named) {
  const lookup = new Map();
  for (const [k, v] of Object.entries(named)) lookup.set(k.replace(/^[:@$]/, ''), v);
  const mask = codeMask(sql);
  const order = [];
  const numbers = new Map();
  let out = '';
  let i = 0;
  while (i < sql.length) {
    const c = mask[i];
    if ((c === ':' || c === '@' || c === '$') && /[A-Za-z_]/.test(mask[i + 1] ?? '')) {
      const prev = i > 0 ? mask[i - 1] : '';
      if (c === ':' && prev === ':') {
        out += c;
        i++;
        continue;
      }
      // `::text` casts: the second colon is followed by a type name.
      if (c === ':' && mask[i + 1] === ':') {
        out += c;
        i++;
        continue;
      }
      const m = /^[A-Za-z_][A-Za-z0-9_]*/.exec(mask.slice(i + 1, i + 128));
      const name = m[0];
      // A `:` right after an identifier character is not a placeholder
      // (`a:b` never appears in SQL, but a cast `x::y` is handled above).
      if (c === ':' && /[A-Za-z0-9_)]/.test(prev)) {
        out += c;
        i++;
        continue;
      }
      if (!lookup.has(name)) {
        throw new Error(`named argument "${name}" was not supplied (have: ${[...lookup.keys()].join(', ') || 'none'})`);
      }
      if (!numbers.has(name)) {
        numbers.set(name, order.length + 1);
        order.push(lookup.get(name));
      }
      out += `$${numbers.get(name)}`;
      i += 1 + name.length;
    } else {
      out += sql[i];
      i++;
    }
  }
  return { sql: out, values: order };
}

/**
 * libSQL binds JS values loosely; pg is stricter. Undefined is null (the
 * local libSQL client does the same). Booleans go as 1/0: Postgres reads
 * `'1'` into a boolean column and into a bigint flag column kept from SQLite
 * alike, where `'true'` only fits the first (`nativeBooleans: true` sends
 * true/false). BigInts go as decimal strings. Dates become ISO strings. Typed
 * arrays become Buffers (bytea).
 *
 * @param {unknown[]} args
 * @param {{ nativeBooleans?: boolean }} [opts]
 */
export function bind(args, opts = {}) {
  return args.map((v) => {
    if (v === undefined) return null;
    if (typeof v === 'boolean') return opts.nativeBooleans ? v : v ? 1 : 0;
    if (typeof v === 'bigint') return v.toString();
    if (v instanceof Date) return v.toISOString();
    if (v instanceof ArrayBuffer) return Buffer.from(v);
    if (ArrayBuffer.isView(v) && !(v instanceof Buffer)) return Buffer.from(v.buffer, v.byteOffset, v.byteLength);
    return v;
  });
}

/**
 * Take a libSQL statement in any of its three shapes and produce the pg
 * `{ text, values }` pair.
 *
 * @param {string} sql already rewritten SQL
 * @param {unknown[] | Record<string, unknown> | undefined} args
 * @param {{ nativeBooleans?: boolean }} [opts]
 * @returns {{ text: string, values: unknown[] }}
 */
export function prepare(sql, args, opts = {}) {
  if (args && !Array.isArray(args) && typeof args === 'object') {
    const r = named(sql, args);
    return { text: r.sql, values: bind(r.values, opts) };
  }
  return { text: positional(sql), values: bind(args ?? [], opts) };
}
