import { ftsError } from './errors.js';
import {
  codeMask,
  findCall,
  literalValue,
  matchParen,
  quoteIdent,
  replaceCalls,
  replaceCode,
  splitTopLevel,
  unquote,
} from './sqlparse.js';

/**
 * SQLite-flavoured SQL rewritten for Postgres, one statement at a time.
 *
 * The rules are the idioms that turned up across the apps being ported: they
 * are textual, deliberately conservative (a call the rule does not recognise
 * is left as it was) and each is covered by a test that needs no database.
 * What is not rewritten is listed in the README's dialect table.
 *
 * @typedef {{ pk: string[], unique: string[][], columns: string[] }} TableKeys
 * @typedef {(table: string) => TableKeys | undefined} KeysLookup
 * @typedef {{ sql: string, noop: boolean, warnings: string[], kind: 'pragma' | 'ddl' | 'dml' | 'comment' }} Rewritten
 */

/** Function names SQLite has and Postgres does not, that nothing here rewrites. */
const UNSUPPORTED_FUNCTIONS = [
  'printf',
  'format',
  'typeof',
  'last_insert_rowid',
  'changes',
  'total_changes',
  'sqlite_version',
  'sqlite_source_id',
  'zeroblob',
  'quote',
  'char',
  'unicode',
  'likelihood',
  'likely',
  'unlikely',
  'load_extension',
  'json_each',
  'json_tree',
  'json_set',
  'json_insert',
  'json_replace',
  'json_remove',
  'json_patch',
  'json_type',
  'json_valid',
  'json_quote',
  'bm25',
  'highlight',
  'snippet',
];

/** Statement-level things that are also unsupported and worth a warning. */
const UNSUPPORTED_PATTERNS = [
  [/\bcollate\s+nocase\b/i, 'COLLATE NOCASE has no Postgres equivalent: use lower()/ilike or the citext extension'],
  [/\bglob\b/i, 'GLOB: use LIKE with % and _ or a ~ regex'],
  [/\bis\s+not\s+(?!null\b|true\b|false\b|distinct\b)/i, 'IS NOT <value>: Postgres only has IS NOT NULL/TRUE/FALSE; use IS DISTINCT FROM'],
  [/->>?\s*'\$/i, "-> / ->> with a '$.path': Postgres takes a key or index, use #>> '{a,b}'"],
  [/\brandom\s*\(\s*\)/i, 'random(): Postgres returns a double in [0,1), SQLite a 64-bit integer'],
];

/**
 * Where the top-level RETURNING clause starts in the mask, or -1.
 * @param {string} mask
 */
function returningIndex(mask) {
  const re = /\breturning\b/gi;
  let depth = 0;
  let found = -1;
  let last = 0;
  for (let m = re.exec(mask); m; m = re.exec(mask)) {
    for (let i = last; i < m.index; i++) {
      if (mask[i] === '(') depth++;
      else if (mask[i] === ')') depth--;
    }
    last = m.index;
    if (depth === 0) found = m.index;
  }
  return found;
}

/**
 * The INSERT verb at parenthesis depth 0 (so a `WITH (...)` prefix or a
 * subquery does not fool it).
 * @param {string} mask
 * @returns {{ index: number, length: number, verb: string } | null}
 */
function locateInsertVerb(mask) {
  const re = /\b(insert\s+or\s+(?:ignore|replace|abort|fail|rollback)|replace|insert)\s+into\s+/gi;
  let depth = 0;
  let last = 0;
  for (let m = re.exec(mask); m; m = re.exec(mask)) {
    for (let i = last; i < m.index; i++) {
      if (mask[i] === '(') depth++;
      else if (mask[i] === ')') depth--;
    }
    last = m.index;
    if (depth === 0) return { index: m.index, length: m[0].length, verb: m[1].toLowerCase().replace(/\s+/g, ' ') };
  }
  return null;
}

/**
 * Split a statement into the part before a top-level RETURNING and the
 * RETURNING clause itself (with a leading space), or ''.
 * @param {string} sql
 */
export function splitReturning(sql) {
  const mask = codeMask(sql);
  const at = returningIndex(mask);
  if (at === -1) return { body: sql.trimEnd(), returning: '' };
  return { body: sql.slice(0, at).trimEnd(), returning: ` ${sql.slice(at).trim()}` };
}

/**
 * The table an INSERT targets, in Postgres-folded form, and its column list.
 *
 * @param {string} sql
 * @returns {{ table: string, tableSql: string, columns: string[] | null, verb: string, verbIndex: number, verbLength: number, prefixEnd: number } | null}
 */
export function insertTarget(sql) {
  const mask = codeMask(sql);
  if (!/^\s*(insert|replace|with)\b/i.test(mask)) return null;
  const at = locateInsertVerb(mask);
  if (!at) return null;
  const i = at.index + at.length;
  // Table name: a quoted or bare identifier, possibly schema-qualified. In
  // the mask a quoted identifier keeps its quotes and blanks its inside, so a
  // quote jumps to its partner.
  let j = i;
  while (j < mask.length) {
    const c = mask[j];
    if (c === '"' || c === '`' || c === '[') {
      const end = mask.indexOf(c === '[' ? ']' : c, j + 1);
      j = end === -1 ? mask.length : end + 1;
    } else if (/[A-Za-z0-9_.$]/.test(c)) j++;
    else break;
  }
  const tableSql = sql.slice(i, j);
  if (!tableSql) return null;
  const table = tableSql.split('.').map(unquote).join('.');
  // Optional column list.
  let k = j;
  while (k < mask.length && /\s/.test(mask[k])) k++;
  let columns = null;
  let prefixEnd = k;
  if (mask[k] === '(') {
    const close = matchParen(mask, k);
    if (close !== -1) {
      const inner = sql.slice(k + 1, close);
      // `(select ...)` after the table is not a column list.
      if (!/^\s*select\b/i.test(codeMask(inner))) {
        columns = splitTopLevel(inner).map(unquote);
        prefixEnd = close + 1;
      }
    }
  }
  return { table, tableSql, columns, verb: at.verb, verbIndex: at.index, verbLength: at.length, prefixEnd };
}

/**
 * `INSERT OR IGNORE` / `INSERT OR REPLACE` / `REPLACE INTO` to Postgres
 * ON CONFLICT forms.
 *
 * @param {string} sql
 * @param {KeysLookup | undefined} keys
 * @returns {string}
 */
function rewriteInsert(sql, keys) {
  const target = insertTarget(sql);
  if (!target) return sql;
  const verb = target.verb;
  if (verb === 'insert') return sql;
  const mask = codeMask(sql);
  const hasConflict = /\bon\s+conflict\b/i.test(mask);
  // Drop the OR xxx / REPLACE verb.
  const out = `${sql.slice(0, target.verbIndex)}INSERT INTO ${sql.slice(target.verbIndex + target.verbLength)}`;
  if (verb === 'insert or abort' || verb === 'insert or fail' || verb === 'insert or rollback') return out;
  if (hasConflict) return out;
  const { body, returning } = splitReturning(out);
  if (verb === 'insert or ignore') return `${body} ON CONFLICT DO NOTHING${returning}`;

  // INSERT OR REPLACE / REPLACE INTO.
  const info = keys?.(target.table);
  const conflictCols = info?.pk?.length ? info.pk : info?.unique?.[0];
  if (!conflictCols?.length) {
    throw new Error(
      `cannot rewrite INSERT OR REPLACE for "${target.table}": no primary key or unique index found ` +
        '(the table must exist in Postgres with a primary key or a unique index).',
    );
  }
  const listed = target.columns ?? info?.columns;
  if (!listed?.length) {
    throw new Error(
      `cannot rewrite INSERT OR REPLACE for "${target.table}": the statement lists no columns and the table's columns are unknown.`,
    );
  }
  const updates = listed.filter((c) => !conflictCols.includes(c));
  const action = updates.length
    ? `DO UPDATE SET ${updates.map((c) => `${quoteIdent(c)} = EXCLUDED.${quoteIdent(c)}`).join(', ')}`
    : 'DO NOTHING';
  return `${body} ON CONFLICT (${conflictCols.map(quoteIdent).join(', ')}) ${action}${returning}`;
}

/** SQLite date modifier (`'-7 days'`, `'+1 month'`) to a Postgres interval expression. */
function modifierToInterval(mod) {
  const m = /^\s*([+-]?)\s*(\d+(?:\.\d+)?)\s+(second|minute|hour|day|month|year)s?\s*$/i.exec(mod);
  if (!m) return null;
  const sign = m[1] === '-' ? '-' : '+';
  return ` ${sign} interval '${m[2]} ${m[3].toLowerCase()}${m[2] === '1' ? '' : 's'}'`;
}

/**
 * Apply SQLite date modifiers (`'-7 days'`, `'start of day'`, `'localtime'`)
 * to a timestamptz expression. Null when a modifier is not understood.
 * @param {string} expr
 * @param {string[]} modifiers raw SQL arguments
 * @returns {{ expr: string, shifted: boolean } | null}
 */
function applyModifiers(expr, modifiers) {
  let shifted = false;
  for (const mod of modifiers) {
    const v = literalValue(mod);
    if (v === null) return null;
    const lower = v.toLowerCase();
    if (lower === 'localtime' || lower === 'utc') continue;
    const unit = /^start of (day|month|year)$/.exec(lower);
    if (unit) {
      expr = `date_trunc('${unit[1]}', ${expr})`;
      shifted = true;
      continue;
    }
    const interval = modifierToInterval(v);
    if (!interval) return null;
    expr += interval;
    shifted = true;
  }
  return { expr, shifted };
}

/**
 * A SQLite time value plus modifiers as a timestamptz expression: `'now'`
 * becomes now(), anything else is cast. Null when not understood.
 * @param {string[]} args the time argument followed by modifiers
 */
function timeExpr(args) {
  if (!args.length) return { expr: 'now()', shifted: false };
  const first = literalValue(args[0]);
  const base = first !== null && first.toLowerCase() === 'now' ? 'now()' : `(${args[0].trim()})::timestamptz`;
  const out = applyModifiers(base, args.slice(1));
  if (!out) return null;
  return out.shifted ? { expr: `(${out.expr})`, shifted: true } : out;
}

/**
 * `datetime('now', ...)` and `date('now', ...)`. Only the 'now' forms are
 * rewritten: `datetime(col)` in SQLite reformats a stored text, which has no
 * one Postgres spelling.
 * @param {string[]} args
 * @param {'timestamptz' | 'date'} as
 */
function nowExpression(args, as) {
  if (!args.length) return as === 'date' ? 'current_date' : 'now()';
  const first = literalValue(args[0]);
  if (first === null || first.toLowerCase() !== 'now') return null;
  const t = timeExpr(args);
  if (!t) return null;
  if (as === 'date') return t.shifted ? `${t.expr}::date` : 'current_date';
  return t.expr;
}

/** strftime format specifiers to to_char() patterns; null when one is unknown. */
function strftimeToChar(format) {
  const map = {
    Y: 'YYYY',
    m: 'MM',
    d: 'DD',
    H: 'HH24',
    M: 'MI',
    S: 'SS',
    f: 'SS.MS',
    j: 'DDD',
    e: 'FMDD',
    I: 'HH12',
    p: 'AM',
    W: 'IW',
  };
  let out = '';
  let literal = '';
  const flush = () => {
    if (!literal) return;
    // Letters are patterns to to_char; quote any run that carries one.
    out += /[A-Za-z]/.test(literal) ? `"${literal.replace(/"/g, '')}"` : literal;
    literal = '';
  };
  for (let i = 0; i < format.length; i++) {
    const c = format[i];
    if (c === '%') {
      const spec = format[i + 1];
      if (spec === '%') {
        literal += '%';
        i++;
        continue;
      }
      if (!(spec in map)) return null;
      flush();
      out += map[spec];
      i++;
    } else literal += c;
  }
  flush();
  return out;
}

/** `'$.a.b[0]'` to `'{a,b,0}'`, or null for a path this does not understand. */
export function jsonPathToArray(path) {
  if (path === '$') return '{}';
  if (!path.startsWith('$')) return null;
  const parts = [];
  let i = 1;
  while (i < path.length) {
    const c = path[i];
    if (c === '.') {
      i++;
      if (path[i] === '"') {
        const j = path.indexOf('"', i + 1);
        if (j === -1) return null;
        parts.push(path.slice(i + 1, j));
        i = j + 1;
      } else {
        const m = /^[^.\[]+/.exec(path.slice(i));
        if (!m) return null;
        parts.push(m[0]);
        i += m[0].length;
      }
    } else if (c === '[') {
      const j = path.indexOf(']', i);
      if (j === -1) return null;
      const idx = path.slice(i + 1, j);
      if (!/^\d+$/.test(idx)) return null; // '#-1' and friends are not handled
      parts.push(idx);
      i = j + 1;
    } else return null;
  }
  const quoted = parts.map((p) => (/^[A-Za-z0-9_]+$/.test(p) ? p : `"${p.replace(/"/g, '\\"')}"`));
  return `{${quoted.join(',')}}`;
}

/**
 * The function-level rewrites; also used on DEFAULT expressions and view
 * bodies by the schema converter.
 *
 * @param {string} sql
 * @returns {string}
 */
export function rewriteFunctions(sql) {
  // lower(hex(randomblob(N))) is the SQLite idiom for a random hex id.
  sql = replaceCalls(sql, 'lower', ({ args }) => {
    if (args.length !== 1) return null;
    const m = /^\s*hex\s*\(\s*randomblob\s*\(\s*(\d+)\s*\)\s*\)\s*$/i.exec(args[0]);
    return m ? `encode(gen_random_bytes(${m[1]}), 'hex')` : null;
  });
  sql = replaceCalls(sql, 'hex', ({ args }) => {
    if (args.length !== 1) return null;
    const m = /^\s*randomblob\s*\(\s*(\d+)\s*\)\s*$/i.exec(args[0]);
    if (m) return `upper(encode(gen_random_bytes(${m[1]}), 'hex'))`;
    return `upper(encode((${args[0].trim()})::bytea, 'hex'))`;
  });
  sql = replaceCalls(sql, 'randomblob', ({ args }) => (args.length === 1 ? `gen_random_bytes(${args[0].trim()})` : null));

  sql = replaceCalls(sql, 'datetime', ({ args }) => nowExpression(args, 'timestamptz'));
  sql = replaceCalls(sql, 'date', ({ args }) => nowExpression(args, 'date'));
  sql = replaceCalls(sql, 'unixepoch', ({ args }) => {
    const t = timeExpr(args);
    return t ? `extract(epoch from ${t.expr})::bigint` : null;
  });
  sql = replaceCalls(sql, 'strftime', ({ args }) => {
    if (args.length < 1) return null;
    const format = literalValue(args[0]);
    if (format === null) return null;
    const t = timeExpr(args.slice(1));
    if (!t) return null;
    if (format === '%s') return `extract(epoch from ${t.expr})::bigint`;
    const pattern = strftimeToChar(format);
    if (pattern === null) return null;
    // SQLite formats in UTC; to_char formats in the session zone.
    return `to_char(${t.expr} at time zone 'utc', '${pattern.replace(/'/g, "''")}')`;
  });
  sql = replaceCalls(sql, 'julianday', ({ args }) => {
    const t = timeExpr(args);
    return t ? `(extract(epoch from ${t.expr}) / 86400.0 + 2440587.5)` : null;
  });

  sql = replaceCalls(sql, 'json_extract', ({ args }) => {
    if (args.length !== 2) return null;
    const path = literalValue(args[1]);
    if (path === null) return null;
    const arr = jsonPathToArray(path);
    if (arr === null) return null;
    return `((${args[0].trim()})::jsonb #>> '${arr}')`;
  });
  sql = replaceCalls(sql, 'json_array_length', ({ args }) => {
    if (args.length === 1) return `jsonb_array_length((${args[0].trim()})::jsonb)`;
    if (args.length === 2) {
      const path = literalValue(args[1]);
      const arr = path === null ? null : jsonPathToArray(path);
      if (arr === null) return null;
      return `jsonb_array_length((${args[0].trim()})::jsonb #> '${arr}')`;
    }
    return null;
  });
  sql = replaceCode(sql, /\bjson_object\s*\(/gi, 'json_build_object(');
  sql = replaceCode(sql, /\bjson_array\s*\(/gi, 'json_build_array(');
  sql = replaceCode(sql, /\bjson_group_array\s*\(/gi, 'json_agg(');
  sql = replaceCode(sql, /\bjson_group_object\s*\(/gi, 'json_object_agg(');

  sql = replaceCalls(sql, 'group_concat', ({ args, argsText }) => {
    const distinct = /^\s*distinct\b/i.test(argsText);
    const first = args[0]?.replace(/^\s*distinct\s+/i, '').trim();
    if (!first) return null;
    const sep = args.length > 1 ? args[1].trim() : "','";
    if (args.length > 2) return null;
    return `string_agg(${distinct ? 'distinct ' : ''}(${first})::text, ${sep})`;
  });
  sql = replaceCode(sql, /\bifnull\s*\(/gi, 'coalesce(');
  sql = replaceCalls(sql, 'instr', ({ args }) => (args.length === 2 ? `position(${args[1].trim()} in ${args[0].trim()})` : null));
  sql = replaceCalls(sql, 'max', ({ args }) => (args.length >= 2 ? `greatest(${args.map((a) => a.trim()).join(', ')})` : null));
  sql = replaceCalls(sql, 'min', ({ args }) => (args.length >= 2 ? `least(${args.map((a) => a.trim()).join(', ')})` : null));
  sql = replaceCalls(sql, 'total', ({ args }) => (args.length === 1 ? `coalesce(sum(${args[0].trim()}), 0)` : null));

  // CAST(x AS INTEGER): Postgres's integer is 32-bit; SQLite's is 64.
  sql = replaceCode(sql, /\bas\s+(integer|int|real|blob)\s*\)/gi, (_m, type) => {
    const t = type.toLowerCase();
    return `as ${t === 'real' ? 'double precision' : t === 'blob' ? 'bytea' : 'bigint'})`;
  });
  sql = replaceCode(sql, /\bregexp\b/gi, '~');
  return sql;
}

/**
 * Warnings for things the rewriter leaves alone and Postgres will refuse.
 * @param {string} sql
 */
export function unsupportedIdioms(sql) {
  const mask = codeMask(sql);
  const out = [];
  for (const name of UNSUPPORTED_FUNCTIONS) {
    if (findCall(sql, mask, name)) out.push(`${name}() has no direct Postgres equivalent; see the README dialect table`);
  }
  for (const [re, message] of UNSUPPORTED_PATTERNS) if (re.test(mask)) out.push(message);
  if (/\browid\b/i.test(mask)) out.push('rowid: Postgres tables have no implicit rowid; give the table an identity column named rowid or use the primary key');
  return out;
}

/**
 * The table named on the left of `MATCH`, for the FTS5 error.
 * @param {string} sql
 * @param {string} mask
 */
function matchTable(sql, mask) {
  const m = /([A-Za-z_][A-Za-z0-9_]*|"[^"]*")\s*(?:\.\s*(?:[A-Za-z_][A-Za-z0-9_]*|"[^"]*"))?\s+match\b/i.exec(mask);
  if (!m) return 'unknown';
  return unquote(sql.slice(m.index, m.index + m[1].length));
}

/**
 * Rewrite one statement.
 *
 * @param {string} sql
 * @param {{ keys?: KeysLookup, ddl?: (sql: string) => string }} [opts]
 *   `keys` answers INSERT OR REPLACE's conflict target; `ddl` converts a
 *   CREATE/ALTER statement (the schema converter, wired in by the client).
 * @returns {Rewritten}
 */
export function rewriteStatement(sql, opts = {}) {
  let text = sql.trim().replace(/;\s*$/, '');
  const mask = codeMask(text);
  if (!text) return { sql: '', noop: true, warnings: [], kind: 'comment' };
  if (!/\S/.test(mask)) return { sql: text, noop: true, warnings: [], kind: 'comment' };
  if (/^\s*pragma\b/i.test(mask)) return { sql: text, noop: true, warnings: [], kind: 'pragma' };
  if (/\bmatch\b/i.test(mask)) throw ftsError(matchTable(text, mask), text);
  if (/^\s*(create\s+(virtual\s+|unique\s+|temp(orary)?\s+)?(table|index|trigger|view)|alter\s+table|drop\s+(table|index|view|trigger))\b/i.test(mask)) {
    const converted = opts.ddl ? opts.ddl(text) : rewriteFunctions(text);
    const onlyComments = !/\S/.test(codeMask(converted));
    return { sql: converted, noop: onlyComments, warnings: [], kind: 'ddl' };
  }

  // Backticked identifiers are fine in SQLite and MySQL, not Postgres.
  text = replaceCode(text, /`([^`]*)`/g, (_m, name) => quoteIdent(name));
  text = replaceCode(text, /\s+(not\s+indexed|indexed\s+by\s+[A-Za-z0-9_"]+)\b/gi, '');
  text = replaceCode(text, /\blimit\s+-1\b/gi, 'LIMIT ALL');
  text = rewriteInsert(text, opts.keys);
  text = rewriteFunctions(text);
  return { sql: text, noop: false, warnings: unsupportedIdioms(text), kind: 'dml' };
}

/**
 * A rewriter with a cache keyed by statement text. INSERT OR REPLACE needs the
 * target's keys, which `needsKeys()` announces so the caller can fetch them
 * (asynchronously) before calling `rewrite()`.
 *
 * @param {{ keys?: KeysLookup, ddl?: (sql: string) => string, cacheSize?: number }} [opts]
 */
export function createRewriter(opts = {}) {
  const cache = new Map();
  const max = opts.cacheSize ?? 2000;
  return {
    /**
     * The table whose keys an INSERT OR REPLACE / REPLACE INTO needs, or null.
     * @param {string} sql
     */
    needsKeys(sql) {
      if (cache.has(sql)) return null;
      if (!/^\s*(insert\s+or\s+replace|replace)\s+into\b/i.test(codeMask(sql))) return null;
      return insertTarget(sql)?.table ?? null;
    },
    /**
     * @param {string} sql
     * @returns {Rewritten}
     */
    rewrite(sql) {
      const hit = cache.get(sql);
      if (hit) return hit;
      const out = rewriteStatement(sql, opts);
      if (cache.size >= max) cache.clear();
      cache.set(sql, out);
      return out;
    },
    clear() {
      cache.clear();
    },
  };
}

/**
 * Convenience: rewrite one statement with optional keys, no cache.
 * @param {string} sql
 * @param {{ keys?: KeysLookup, ddl?: (sql: string) => string }} [opts]
 */
export function rewriteSql(sql, opts = {}) {
  return rewriteStatement(sql, opts);
}
