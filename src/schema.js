import { rewriteFunctions, rewriteStatement } from './rewrite.js';
import { codeMask, matchParen, quoteIdent, replaceCode, splitStatements, splitTopLevel, stripComments, unquote } from './sqlparse.js';

/**
 * SQLite DDL to Postgres DDL.
 *
 * The converter is a set of textual rules over a shallow parse of each
 * CREATE TABLE: column definitions and table constraints are split at the
 * top-level commas, types are mapped, the SQLite-only words are dropped and
 * the DEFAULT expressions go through the same function rewriter the client
 * uses at run time. Anything it does not understand is passed through
 * unchanged, or emitted as a commented TODO when Postgres would refuse it
 * (FTS5 virtual tables, triggers).
 *
 * @typedef {{ name: string, columns: Map<string, string> }} TableInfo
 * @typedef {{ tables: Map<string, TableInfo>, usesPgcrypto: boolean, notes: string[] }} ConvertContext
 * @typedef {{
 *   promoteTextTimestamps?: boolean,
 *   json?: 'text' | 'jsonb',
 *   searchColumn?: string,
 *   textSearchConfig?: string,
 * }} ConvertOptions
 */

const CONSTRAINT_START = /^(constraint|primary\s+key|unique|check|foreign\s+key)\b/i;
const COLUMN_CONSTRAINT_WORDS = /\b(constraint|not\s+null|null|primary\s+key|unique|check|default|collate|references|generated|as)\b/i;

/**
 * Map a SQLite declared type (or none) to a Postgres type.
 *
 * SQLite's type affinity rules are followed loosely: anything with INT in it
 * is an integer, CHAR/CLOB/TEXT are text, BLOB is bytea, REAL/FLOA/DOUB are
 * doubles. Names SQLite ignores but people write (BOOLEAN, DATETIME, DATE,
 * UUID) become the Postgres type they meant.
 *
 * @param {string} declared
 * @param {ConvertOptions} [opts]
 * @returns {string}
 */
export function mapType(declared, opts = {}) {
  const t = declared.trim().replace(/\s+/g, ' ').toUpperCase();
  if (!t) return 'text';
  // Postgres types already, so converting converted DDL is a no-op (the
  // client runs run-time DDL through here, and so does a second pass).
  if (/^(BYTEA|TSVECTOR|JSONB|BIGSERIAL|SERIAL|SMALLSERIAL|DOUBLE PRECISION|TIMESTAMPTZ|TIMESTAMP(TZ)? WITH(OUT)? TIME ZONE|CHARACTER VARYING(\(\d+\))?|INET|CIDR|MACADDR|INTERVAL|MONEY|POINT|XML|BIT(\(\d+\))?|VARBIT|BOX|LINE|PATH|POLYGON|CIRCLE|TSQUERY|OID|NAME|REGCLASS)$/.test(t)) {
    return t.toLowerCase();
  }
  if (/\[\]$/.test(t)) return t.toLowerCase(); // an array type
  if (/^BOOL/.test(t)) return 'boolean';
  if (/^(DATETIME|TIMESTAMP)/.test(t)) return 'timestamptz';
  if (/^DATE$/.test(t)) return 'date';
  if (/^TIME$/.test(t)) return 'time';
  if (/^UUID$/.test(t)) return 'uuid';
  if (/^JSON/.test(t)) return opts.json === 'jsonb' ? 'jsonb' : 'text';
  if (/INT/.test(t)) return 'bigint';
  if (/CHAR|CLOB|TEXT|STRING/.test(t)) return 'text';
  if (/BLOB|BINARY/.test(t)) return 'bytea';
  if (/^(NUMERIC|DECIMAL)/.test(t)) {
    const m = /\(([^)]*)\)/.exec(t);
    return m ? `numeric(${m[1].trim()})` : 'numeric';
  }
  if (/REAL|FLOA|DOUB/.test(t)) return 'double precision';
  return 'text';
}

/**
 * Split a column definition into name, declared type and the constraint tail.
 * @param {string} def
 */
export function parseColumnDef(def) {
  const text = def.trim();
  const mask = codeMask(text);
  // Name: quoted or bare.
  let i = 0;
  if (mask[0] === '"' || mask[0] === '`' || mask[0] === '[') {
    const end = mask.indexOf(mask[0] === '[' ? ']' : mask[0], 1);
    i = end === -1 ? text.length : end + 1;
  } else {
    const m = /^[^\s(]+/.exec(text);
    i = m ? m[0].length : text.length;
  }
  const name = unquote(text.slice(0, i));
  const rest = text.slice(i);
  const restMask = codeMask(rest);
  // Type: everything up to the first constraint keyword (a type may carry a
  // parenthesised length and several words, e.g. `UNSIGNED BIG INT`).
  const kw = COLUMN_CONSTRAINT_WORDS.exec(restMask);
  const typeEnd = kw ? kw.index : rest.length;
  const declared = rest.slice(0, typeEnd).trim();
  const constraints = rest.slice(typeEnd).trim();
  return { name, declared, constraints };
}

/**
 * Rewrite the constraint tail of one column.
 *
 * @param {string} constraints
 * @param {{ type: string, ctx: ConvertContext, opts: ConvertOptions }} info
 * @returns {{ constraints: string, type: string, identity: boolean, notes: string[] }}
 */
function convertColumnConstraints(constraints, { type, ctx, opts }) {
  let c = ` ${constraints} `;
  const notes = [];
  let identity = false;

  // Column-level ON CONFLICT clauses have no Postgres form.
  c = replaceCode(c, /\son\s+conflict\s+(rollback|abort|fail|ignore|replace)\b/gi, (m) => {
    notes.push(`dropped column conflict clause "${m.trim()}"`);
    return ' ';
  });
  c = replaceCode(c, /\sautoincrement\b/gi, ' ');
  c = replaceCode(c, /\sprimary\s+key(\s+(asc|desc))?\b/gi, ' PRIMARY KEY ');
  // COLLATE NOCASE and friends.
  c = replaceCode(c, /\scollate\s+(nocase|binary|rtrim|[A-Za-z_]+)\b/gi, (_m, name) => {
    if (/^(nocase|binary|rtrim)$/i.test(name)) notes.push(`dropped COLLATE ${name.toUpperCase()}`);
    else return ` COLLATE ${name}`;
    return ' ';
  });

  const alreadyIdentity = /\bgenerated\s+(always|by\s+default)\s+as\s+identity\b/i.test(codeMask(c));
  if (/\sPRIMARY KEY\s/.test(c) && type === 'bigint' && !alreadyIdentity) {
    identity = true;
    c = c.replace(/\sPRIMARY KEY\s/, ' ');
  }

  // DEFAULT expression.
  c = rewriteDefault(c, type, ctx, notes);

  // Generated columns must be STORED in Postgres.
  c = replaceCode(c, /\b(generated\s+always\s+)?as\s*\(/gi, 'GENERATED ALWAYS AS (');
  if (/GENERATED ALWAYS AS \(/.test(c)) {
    const mask = codeMask(c);
    const open = mask.indexOf('(', mask.indexOf('GENERATED ALWAYS AS'));
    const close = matchParen(mask, open);
    if (close !== -1) {
      const after = c.slice(close + 1).replace(/^\s*(virtual|stored)\b/i, ' STORED');
      c = `${c.slice(0, close + 1)}${/^\s*STORED/.test(after) ? after : ` STORED${after}`}`;
    }
  }

  // A `check (flag in (0, 1))` on a column that became boolean is now wrong.
  if (type === 'boolean') {
    c = replaceCode(c, /\scheck\s*\(\s*[A-Za-z_"][^()]*\s+in\s*\(\s*[01]\s*,\s*[01]\s*\)\s*\)/gi, ' ');
  }

  if (identity) {
    // Identity columns take no DEFAULT.
    c = stripDefault(c);
    c = ` GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY${c}`;
  }
  return { constraints: c.replace(/\s+/g, ' ').trim(), type, identity, notes };
}

/** Remove a DEFAULT clause (a literal or a parenthesised expression). */
function stripDefault(c) {
  const mask = codeMask(c);
  const m = /(?<!\bby)\sdefault(?=\s)/i.exec(mask);
  if (!m) return c;
  // The mask blanks string literals to spaces, so the gap after DEFAULT is
  // measured on the text: `default 'x' check (...)` must not skip past 'x'.
  let end = m.index + m[0].length;
  end += /^\s*/.exec(c.slice(end))[0].length;
  if (mask[end] === '(') end = matchParen(mask, end) + 1;
  else {
    const rest = /^('[^']*(?:''[^']*)*'|[^\s]+)/.exec(c.slice(end));
    // A literal string may contain spaces; the mask blanked it, so measure on the text.
    end += rest ? rest[0].length : 0;
  }
  return `${c.slice(0, m.index)} ${c.slice(end)}`;
}

/**
 * Rewrite the DEFAULT clause of a column's constraint tail in place.
 * @param {string} c
 * @param {string} type mapped Postgres type
 * @param {ConvertContext} ctx
 * @param {string[]} notes
 */
function rewriteDefault(c, type, ctx, notes) {
  const mask = codeMask(c);
  const m = /(?<!\bby)\sdefault(?=\s)/i.exec(mask);
  if (!m) return c;
  let start = m.index + m[0].length;
  start += /^\s*/.exec(c.slice(start))[0].length; // see stripDefault: literals are blank in the mask
  let end;
  if (mask[start] === '(') end = matchParen(mask, start) + 1;
  else {
    const rest = /^('[^']*(?:''[^']*)*'|[^\s]+)/.exec(c.slice(start));
    end = start + (rest ? rest[0].length : 0);
  }
  let expr = c.slice(start, end).trim();
  const bare = /^\((.*)\)$/s.test(expr) ? expr.slice(1, -1).trim() : expr;
  let out = bare;
  const lower = bare.toLowerCase().replace(/\s+/g, '');
  if (type === 'boolean' && /^[01]$/.test(bare)) out = bare === '1' ? 'true' : 'false';
  else if (lower === 'current_timestamp' || lower === "datetime('now')") out = 'now()';
  else if (/^strftime\('%y-%m-%dt%h:%m:%[fs]z?','now'\)$/.test(lower)) out = 'now()';
  // datetime('now', '+7 days') and friends keep their modifiers: the function
  // rewriter turns them into now() + interval '7 days'.
  else out = rewriteFunctions(bare);
  if (/gen_random_bytes/.test(out)) ctx.usesPgcrypto = true;
  // to_char(...) as a default on a text column is fine; on timestamptz it is not.
  if (type === 'timestamptz' && /^to_char\(/.test(out)) out = 'now()';
  if (/^[A-Za-z_]/.test(out) && !/^(true|false|null|now\(\)|current_date|current_time|current_timestamp)$/i.test(out) && !/^\(/.test(out)) {
    out = `(${out})`;
  }
  if (out !== bare) notes.push(`default ${expr} -> ${out}`);
  return `${c.slice(0, start)}${out}${c.slice(end)}`;
}

/** Is the DEFAULT a "current time" expression (used to promote text columns)? */
function isNowDefault(constraints) {
  const lower = constraints.toLowerCase().replace(/\s+/g, '');
  return /default\(?(current_timestamp|datetime\('now'|strftime\('%y-%m-%dt%h:%m:%[fs]z?','now'\))/.test(lower);
}

/**
 * Convert a table-level constraint.
 * @param {string} def
 * @param {string[]} notes
 */
function convertTableConstraint(def, notes) {
  let c = def;
  c = replaceCode(c, /\sautoincrement\b/gi, '');
  c = replaceCode(c, /\s+collate\s+(nocase|binary|rtrim)\b/gi, (_m, name) => {
    notes.push(`dropped COLLATE ${name.toUpperCase()} in a table constraint`);
    return '';
  });
  c = replaceCode(c, /\son\s+conflict\s+(rollback|abort|fail|ignore|replace)\b/gi, (m) => {
    notes.push(`dropped conflict clause "${m.trim()}"`);
    return '';
  });
  c = replaceCode(c, /\b(asc|desc)\b(?=\s*[,)])/gi, '');
  return c.replace(/\s+/g, ' ').trim();
}

/**
 * Convert one CREATE TABLE statement.
 *
 * @param {string} sql
 * @param {ConvertContext} ctx
 * @param {ConvertOptions} opts
 * @returns {string}
 */
export function convertCreateTable(sql, ctx, opts) {
  const mask = codeMask(sql);
  const head = /^\s*create\s+(temp(?:orary)?\s+)?table\s+(if\s+not\s+exists\s+)?/i.exec(mask);
  if (!head) return sql;
  let i = head[0].length;
  // Table name.
  let j = i;
  while (j < mask.length) {
    const c = mask[j];
    if (c === '"' || c === '`' || c === '[') {
      const end = mask.indexOf(c === '[' ? ']' : c, j + 1);
      j = end === -1 ? mask.length : end + 1;
    } else if (/[A-Za-z0-9_.$]/.test(c)) j++;
    else break;
  }
  const rawName = sql.slice(i, j);
  const name = rawName.split('.').map(unquote).join('.');
  const nameSql = rawName
    .split('.')
    .map((p) => (/^[A-Za-z_][A-Za-z0-9_]*$/.test(p) ? p.toLowerCase() === p ? p : quoteIdent(p) : quoteIdent(unquote(p))))
    .join('.');
  const open = mask.indexOf('(', j);
  if (open === -1 || /^\s*as\b/i.test(mask.slice(j))) {
    // CREATE TABLE ... AS SELECT: pass the select through the DML rewriter.
    return rewriteFunctions(sql);
  }
  const close = matchParen(mask, open);
  if (close === -1) return sql;
  const body = sql.slice(open + 1, close);
  const tail = sql.slice(close + 1);
  const defs = splitTopLevel(body);
  const notes = [];
  const columns = new Map();
  const out = [];
  const parsed = [];
  for (const def of defs) {
    if (CONSTRAINT_START.test(codeMask(def).trim())) {
      parsed.push({ constraint: def });
      continue;
    }
    const col = parseColumnDef(def);
    let type = mapType(col.declared, opts);
    if (type === 'text' && opts.promoteTextTimestamps !== false && isNowDefault(col.constraints)) {
      type = 'timestamptz';
      notes.push(`${col.name}: text column with a current-time default became timestamptz`);
    }
    if (col.declared && mapType(col.declared, opts) === 'text' && !/CHAR|CLOB|TEXT|STRING|JSON/i.test(col.declared)) {
      notes.push(`${col.name}: unknown type "${col.declared}" mapped to text`);
    }
    parsed.push({ column: col, type });
  }
  // A single-column table-level PRIMARY KEY on an integer column is SQLite's
  // rowid alias too, so it becomes an identity column.
  const tablePk = parsed.find((p) => p.constraint && /^\s*(constraint\s+\S+\s+)?primary\s+key\s*\(/i.test(codeMask(p.constraint)));
  let identityFromTablePk = null;
  if (tablePk) {
    const m = /\(([^)]*)\)/.exec(tablePk.constraint);
    const cols = m ? splitTopLevel(m[1]).map((c) => unquote(c.replace(/\s+(asc|desc|autoincrement)\b/gi, ''))) : [];
    if (cols.length === 1) {
      const target = parsed.find((p) => p.column && p.column.name === cols[0]);
      if (target && target.type === 'bigint') identityFromTablePk = target;
    }
  }
  for (const p of parsed) {
    if (p.constraint) {
      if (p === tablePk && identityFromTablePk) continue;
      out.push(convertTableConstraint(p.constraint, notes));
      continue;
    }
    const col = p.column;
    let constraints = col.constraints;
    if (p === identityFromTablePk) constraints = `${constraints} PRIMARY KEY`;
    const conv = convertColumnConstraints(constraints, { type: p.type, ctx, opts });
    for (const n of conv.notes) notes.push(`${col.name}: ${n}`);
    columns.set(col.name, p.type);
    const ident = /^[a-z_][a-z0-9_]*$/.test(col.name) && !RESERVED.has(col.name) ? col.name : quoteIdent(col.name);
    out.push(`${ident} ${p.type}${conv.constraints ? ` ${conv.constraints}` : ''}`.trim());
  }
  ctx.tables.set(name, { name, columns });
  let tailOut = replaceCode(tail, /\s*(without\s+rowid|strict)\b/gi, (m) => {
    notes.push(`dropped ${m.trim().toUpperCase()}`);
    return '';
  });
  tailOut = tailOut.replace(/;\s*$/, '').trim();
  const temp = head[1] ? 'temporary ' : '';
  const ifNot = head[2] ? 'if not exists ' : '';
  const lines = [`create ${temp}table ${ifNot}${nameSql} (`, out.map((d) => `  ${d}`).join(',\n'), `)${tailOut ? ` ${tailOut}` : ''};`];
  const comments = notes.map((n) => `-- ${n}`);
  return [...comments, ...lines].join('\n');
}

/** Column names that need quoting in Postgres but were fine in SQLite. */
const RESERVED = new Set([
  'user', 'order', 'group', 'limit', 'offset', 'from', 'to', 'select', 'where', 'table', 'column', 'default',
  'check', 'references', 'primary', 'foreign', 'key', 'index', 'constraint', 'end', 'case', 'when', 'then', 'else',
  'and', 'or', 'not', 'in', 'is', 'null', 'true', 'false', 'all', 'any', 'some', 'as', 'on', 'using', 'join',
  'left', 'right', 'full', 'inner', 'outer', 'cross', 'natural', 'union', 'except', 'intersect', 'having',
  'distinct', 'into', 'values', 'returning', 'with', 'only', 'for', 'do', 'grant', 'session_user', 'current_user',
  'current_date', 'current_time', 'current_timestamp', 'localtime', 'localtimestamp', 'desc', 'asc', 'both',
  'leading', 'trailing', 'window', 'over', 'partition', 'fetch', 'lateral', 'cast', 'collate', 'array', 'analyse',
  'analyze', 'authorization', 'binary', 'concurrently', 'create', 'current_catalog', 'current_role',
  'current_schema', 'deferrable', 'else', 'except', 'freeze', 'ilike', 'initially', 'isnull', 'like', 'notnull',
  'placing', 'similar', 'symmetric', 'tablesample', 'unique', 'variadic', 'verbose',
]);

/**
 * CREATE INDEX: keep it; `col COLLATE NOCASE` becomes `lower(col)`.
 * @param {string} sql
 */
export function convertCreateIndex(sql) {
  let out = sql.replace(/;\s*$/, '');
  out = replaceCode(out, /("[^"]+"|[A-Za-z_][A-Za-z0-9_]*)\s+collate\s+nocase\b/gi, (_m, col) => `lower(${col})`);
  out = replaceCode(out, /\s+collate\s+(binary|rtrim)\b/gi, '');
  out = replaceCode(out, /`([^`]*)`/g, (_m, n) => quoteIdent(n));
  return `${rewriteFunctions(out)};`;
}

/**
 * CREATE VIRTUAL TABLE ... USING fts5(...): a tsvector column plus a GIN
 * index on the content table when it can be found, else a TODO.
 *
 * @param {string} sql
 * @param {ConvertContext} ctx
 * @param {ConvertOptions} opts
 */
export function convertVirtualTable(sql, ctx, opts) {
  const mask = codeMask(sql);
  const m = /^\s*create\s+virtual\s+table\s+(if\s+not\s+exists\s+)?(\S+)\s+using\s+([A-Za-z0-9_]+)\s*\(/i.exec(mask);
  const commented = sql
    .trim()
    .split('\n')
    .map((l) => `-- ${l}`)
    .join('\n');
  if (!m) return `-- TODO: virtual table not understood\n${commented}`;
  const name = unquote(sql.slice(m.index + m[0].indexOf(m[2]), m.index + m[0].indexOf(m[2]) + m[2].length));
  const module = m[3].toLowerCase();
  if (module !== 'fts5' && module !== 'fts4' && module !== 'fts3') {
    return `-- TODO: virtual table "${name}" uses ${module}, which has no Postgres counterpart\n${commented}`;
  }
  const open = m[0].length - 1;
  const close = matchParen(mask, open);
  const args = splitTopLevel(sql.slice(open + 1, close));
  const options = new Map();
  const ftsColumns = [];
  for (const a of args) {
    const kv = /^([A-Za-z_]+)\s*=\s*(.+)$/s.exec(a.trim());
    if (kv) {
      options.set(kv[1].toLowerCase(), kv[2].trim().replace(/^['"]|['"]$/g, ''));
      continue;
    }
    if (/\bunindexed\b/i.test(a)) continue;
    ftsColumns.push(unquote(a.trim().split(/\s+/)[0]));
  }
  let contentTable = options.get('content') || null;
  if (contentTable === '') contentTable = null;
  if (!contentTable) {
    const guesses = [name.replace(/_?fts\d?$/i, ''), name.replace(/^fts\d?_/i, ''), name.replace(/_(search|index|idx)$/i, '')];
    contentTable = guesses.find((g) => g && g !== name && ctx.tables.has(g)) ?? null;
  }
  const search = opts.searchColumn ?? 'search';
  const config = opts.textSearchConfig ?? 'english';
  const header = `-- FTS5 table "${name}" (${ftsColumns.join(', ')}) has no Postgres counterpart; it is replaced below.\n${commented}`;
  if (!contentTable) {
    return `${header}\n-- TODO: could not find the content table for "${name}". Add a tsvector column to it:\n` +
      `--   alter table <content_table> add column ${search} tsvector generated always as (to_tsvector('${config}', coalesce(${ftsColumns.map((c) => `${c}, ''`).join(") || ' ' || coalesce(")}))) stored;\n` +
      `--   create index on <content_table> using gin (${search});`;
  }
  const info = ctx.tables.get(contentTable);
  const cols = info ? ftsColumns.filter((c) => info.columns.has(c)) : ftsColumns;
  const missing = info ? ftsColumns.filter((c) => !info.columns.has(c)) : [];
  if (!cols.length) {
    return `${header}\n-- TODO: none of the FTS5 columns exist on "${contentTable}"; add a tsvector column by hand.`;
  }
  const expr = cols
    .map((c) => {
      const type = info?.columns.get(c) ?? 'text';
      const ref = /^[a-z_][a-z0-9_]*$/.test(c) && !RESERVED.has(c) ? c : quoteIdent(c);
      return `coalesce(${type === 'text' ? ref : `${ref}::text`}, '')`;
    })
    .join(" || ' ' || ");
  const tableSql = /^[a-z_][a-z0-9_]*$/.test(contentTable) ? contentTable : quoteIdent(contentTable);
  const lines = [
    header,
    ...(missing.length ? [`-- (columns not on ${contentTable}, skipped: ${missing.join(', ')})`] : []),
    `alter table ${tableSql} add column if not exists ${search} tsvector`,
    `  generated always as (to_tsvector('${config}', ${expr})) stored;`,
    `create index if not exists ${contentTable.replace(/[^A-Za-z0-9_]/g, '_')}_${search}_idx on ${tableSql} using gin (${search});`,
    `-- query: where ${search} @@ websearch_to_tsquery('${config}', ?) order by ts_rank_cd(${search}, websearch_to_tsquery('${config}', ?)) desc`,
  ];
  return lines.join('\n');
}

/**
 * Triggers are emitted commented out with a TODO; a Postgres trigger needs a
 * function and different NEW/OLD spelling, and most SQLite triggers only
 * maintained an FTS5 shadow table, which the tsvector column makes redundant.
 * @param {string} sql
 */
export function convertTrigger(sql) {
  const mask = codeMask(sql);
  const m = /create\s+(temp(?:orary)?\s+)?trigger\s+(if\s+not\s+exists\s+)?(\S+)/i.exec(mask);
  const name = m ? unquote(sql.slice(m.index + m[0].length - m[3].length, m.index + m[0].length)) : 'unknown';
  const fts = /_fts\b|fts5|fts4/i.test(mask);
  const why = fts
    ? 'it maintained an FTS5 table, which the generated tsvector column replaces; probably drop it'
    : 'rewrite as a Postgres trigger function (create function ... returns trigger, then create trigger ... execute function)';
  const body = sql
    .trim()
    .split('\n')
    .map((l) => `-- ${l}`)
    .join('\n');
  return `-- TODO: trigger "${name}": ${why}\n${body}`;
}

/**
 * Convert one DDL/DML statement from a SQLite schema file.
 *
 * @param {string} stmt
 * @param {ConvertContext} ctx
 * @param {ConvertOptions} [opts]
 * @returns {string | null} Postgres SQL, or null to drop the statement
 */
export function convertStatement(stmt, ctx, opts = {}) {
  const mask = codeMask(stmt);
  const text = stmt.trim();
  if (!/\S/.test(mask)) return text || null; // comment-only
  if (/^\s*(pragma|begin|commit|end|rollback|vacuum)\b/i.test(mask)) return null;
  if (/\bsqlite_(sequence|stat\d|master)\b/i.test(mask)) return null;
  if (/^\s*create\s+virtual\s+table\b/i.test(mask)) return convertVirtualTable(text, ctx, opts);
  if (/^\s*create\s+(temp(orary)?\s+)?trigger\b/i.test(mask)) return convertTrigger(text);
  if (/^\s*create\s+(temp(orary)?\s+)?table\b/i.test(mask)) return convertCreateTable(text, ctx, opts);
  if (/^\s*create\s+(unique\s+)?index\b/i.test(mask)) return convertCreateIndex(text);
  if (/^\s*create\s+(temp(orary)?\s+)?view\b/i.test(mask)) return `${rewriteFunctions(text.replace(/;\s*$/, ''))};`;
  if (/^\s*alter\s+table\b/i.test(mask)) return convertAlterTable(text, ctx, opts);
  if (/^\s*drop\s+(table|index|view)\b/i.test(mask)) return `${text.replace(/;\s*$/, '')};`;
  if (/^\s*drop\s+trigger\b/i.test(mask)) return `-- ${text}`;
  // Seed data and anything else: the run-time rewriter.
  try {
    const r = rewriteStatement(text, {
      keys: (table) => {
        const info = ctx.tables.get(table);
        return info ? { pk: [], unique: [], columns: [...info.columns.keys()] } : undefined;
      },
    });
    return r.noop ? (r.sql ? `-- ${r.sql}` : null) : `${r.sql};`;
  } catch (err) {
    return `-- TODO: ${err.message}\n${text
      .split('\n')
      .map((l) => `-- ${l}`)
      .join('\n')}`;
  }
}

/**
 * ALTER TABLE t ADD COLUMN def / RENAME / DROP COLUMN.
 * @param {string} sql
 * @param {ConvertContext} ctx
 * @param {ConvertOptions} opts
 */
function convertAlterTable(sql, ctx, opts) {
  const mask = codeMask(sql);
  const m = /^\s*alter\s+table\s+(if\s+exists\s+)?(\S+)\s+add\s+(column\s+)?(if\s+not\s+exists\s+)?/i.exec(mask);
  if (!m) return `${sql.replace(/;\s*$/, '')};`;
  const table = unquote(sql.slice(m.index + m[0].indexOf(m[2]), m.index + m[0].indexOf(m[2]) + m[2].length));
  const def = sql.slice(m[0].length).replace(/;\s*$/, '');
  const col = parseColumnDef(def);
  let type = mapType(col.declared, opts);
  if (type === 'text' && opts.promoteTextTimestamps !== false && isNowDefault(col.constraints)) type = 'timestamptz';
  const conv = convertColumnConstraints(col.constraints, { type, ctx, opts });
  ctx.tables.get(table)?.columns.set(col.name, type);
  const ident = /^[a-z_][a-z0-9_]*$/.test(col.name) && !RESERVED.has(col.name) ? col.name : quoteIdent(col.name);
  const tableSql = /^[a-z_][a-z0-9_]*$/.test(table) ? table : quoteIdent(table);
  const notes = conv.notes.map((n) => `-- ${col.name}: ${n}`);
  return [...notes, `alter table ${tableSql} add column if not exists ${ident} ${type}${conv.constraints ? ` ${conv.constraints}` : ''};`].join('\n');
}

/**
 * Convert a whole SQLite schema script to a Postgres one.
 *
 * @param {string} sql
 * @param {ConvertOptions} [opts]
 * @returns {string}
 */
export function convertSchema(sql, opts = {}) {
  /** @type {ConvertContext} */
  const ctx = { tables: new Map(), usesPgcrypto: false, notes: [] };
  const out = [];
  for (const stmt of splitStatements(stripComments(sql))) {
    const converted = convertStatement(stmt, ctx, opts);
    if (converted !== null) out.push(converted);
  }
  const header = [
    '-- Converted from SQLite by @profullstack/libsql-pg. Review every TODO before applying.',
    '-- Types: INTEGER -> bigint, REAL -> double precision, BLOB -> bytea, BOOLEAN -> boolean,',
    '-- DATETIME/TIMESTAMP -> timestamptz, TEXT -> text; INTEGER PRIMARY KEY -> identity.',
  ].join('\n');
  const parts = [header];
  const hasPgcrypto = out.some((o) => /create\s+extension\s+if\s+not\s+exists\s+pgcrypto/i.test(o));
  if (ctx.usesPgcrypto && !hasPgcrypto) parts.push('create extension if not exists pgcrypto;');
  return `${[...parts, ...out].join('\n\n').replace(/\n{3,}/g, '\n\n')}\n`;
}

/**
 * Convert a single DDL statement issued at run time through the client.
 * @param {string} sql
 */
export function convertDdl(sql) {
  const ctx = { tables: new Map(), usesPgcrypto: false, notes: [] };
  const r = convertStatement(sql, ctx);
  return r ?? '';
}
