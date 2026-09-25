/**
 * Small, dependency-free helpers for looking at SQL text without a parser.
 *
 * Everything here works on a *code mask*: a string the same length as the
 * SQL in which every character inside a string literal, quoted identifier or
 * comment has been replaced by a space. Regexes run on the mask and the
 * indexes they return are valid in the original text, so a rewrite never
 * touches the inside of a literal such as `'$.a[0]'` or `'-- not a comment'`.
 */

/**
 * @param {string} sql
 * @returns {string} the same length as `sql`; literals, quoted identifiers
 *   and comments blanked to spaces, everything else preserved.
 */
export function codeMask(sql) {
  const out = new Array(sql.length);
  const len = sql.length;
  let i = 0;
  const blank = (from, to) => {
    for (let k = from; k < to; k++) out[k] = sql[k] === '\n' ? '\n' : ' ';
  };
  while (i < len) {
    const c = sql[i];
    if (c === "'") {
      let j = i + 1;
      while (j < len) {
        if (sql[j] === "'") {
          if (sql[j + 1] === "'") {
            j += 2;
            continue;
          }
          break;
        }
        j++;
      }
      blank(i, Math.min(j + 1, len));
      i = j + 1;
    } else if (c === '"' || c === '`') {
      // Quoted identifier. Kept visible as the quote character itself so a
      // caller can still find the identifier's extent; the inside is blanked.
      const j = sql.indexOf(c, i + 1);
      const end = j === -1 ? len - 1 : j;
      out[i] = c;
      blank(i + 1, end);
      if (end < len) out[end] = c;
      i = end + 1;
    } else if (c === '[' && /[A-Za-z_]/.test(sql[i + 1] ?? '')) {
      // `[name]` identifier (SQLite accepts the MS Access style).
      const j = sql.indexOf(']', i + 1);
      const end = j === -1 ? len - 1 : j;
      out[i] = '[';
      blank(i + 1, end);
      if (end < len) out[end] = ']';
      i = end + 1;
    } else if (c === '-' && sql[i + 1] === '-') {
      const j = sql.indexOf('\n', i);
      const end = j === -1 ? len : j;
      blank(i, end);
      i = end;
    } else if (c === '/' && sql[i + 1] === '*') {
      const j = sql.indexOf('*/', i + 2);
      const end = j === -1 ? len : j + 2;
      blank(i, end);
      i = end;
    } else {
      out[i] = c;
      i++;
    }
  }
  return out.join('');
}

/**
 * Split a script into statements at `;` outside literals and comments.
 * A `CREATE TRIGGER ... BEGIN ... END;` body, which carries its own
 * semicolons, is kept as one statement.
 *
 * @param {string} sql
 * @returns {string[]} trimmed statements, empty ones dropped
 */
export function splitStatements(sql) {
  const mask = codeMask(sql);
  const out = [];
  let start = 0;
  let i = 0;
  const len = sql.length;
  while (i < len) {
    // Skip leading whitespace so we can look at the first keywords.
    while (i < len && /\s/.test(mask[i])) i++;
    start = i;
    const head = mask.slice(i, i + 64);
    const isTrigger = /^create\s+(temp(orary)?\s+)?trigger\b/i.test(head);
    let depth = 0;
    let seenBegin = false;
    while (i < len) {
      if (isTrigger) {
        const word = /^[A-Za-z_]+/.exec(mask.slice(i, i + 12));
        if (word && (i === 0 || !/[A-Za-z0-9_]/.test(mask[i - 1]))) {
          const w = word[0].toLowerCase();
          if (w === 'begin' || w === 'case') {
            depth++;
            seenBegin = true;
          } else if (w === 'end') depth--;
          i += word[0].length;
          continue;
        }
      }
      if (mask[i] === ';' && (!isTrigger || (seenBegin && depth <= 0))) break;
      i++;
    }
    const stmt = sql.slice(start, i).trim();
    if (stmt) out.push(stmt);
    i++;
  }
  return out;
}

/**
 * Split text at top-level commas (depth 0 in parentheses, outside literals).
 *
 * @param {string} text
 * @returns {string[]} trimmed parts
 */
export function splitTopLevel(text, separator = ',') {
  const mask = codeMask(text);
  const parts = [];
  let depth = 0;
  let last = 0;
  for (let i = 0; i < text.length; i++) {
    const c = mask[i];
    if (c === '(') depth++;
    else if (c === ')') depth--;
    else if (c === separator && depth === 0) {
      parts.push(text.slice(last, i).trim());
      last = i + 1;
    }
  }
  parts.push(text.slice(last).trim());
  return parts.filter((p) => p.length);
}

/**
 * Index of the `)` matching the `(` at `open`, or -1.
 *
 * @param {string} mask
 * @param {number} open
 */
export function matchParen(mask, open) {
  let depth = 0;
  for (let i = open; i < mask.length; i++) {
    if (mask[i] === '(') depth++;
    else if (mask[i] === ')') {
      depth--;
      if (depth === 0) return i;
    }
  }
  return -1;
}

/**
 * Find the next call of a function by name, e.g. `datetime(` at depth
 * anywhere, starting at `from`.
 *
 * @param {string} sql
 * @param {string} mask
 * @param {string} name case-insensitive function name
 * @param {number} [from]
 * @returns {{ start: number, open: number, close: number, args: string[], argsText: string } | null}
 */
export function findCall(sql, mask, name, from = 0) {
  const re = new RegExp(`(?<![A-Za-z0-9_."\`])${name}\\s*\\(`, 'ig');
  re.lastIndex = from;
  const m = re.exec(mask);
  if (!m) return null;
  const open = m.index + m[0].length - 1;
  const close = matchParen(mask, open);
  if (close === -1) return null;
  const argsText = sql.slice(open + 1, close);
  return { start: m.index, open, close, args: splitTopLevel(argsText), argsText };
}

/**
 * Rewrite every call of `name`, innermost calls after outer ones have been
 * handled (the text is re-scanned after each edit). `fn` receives the parsed
 * call and returns replacement text, or null to leave that call alone.
 *
 * @param {string} sql
 * @param {string} name
 * @param {(call: { args: string[], argsText: string }) => string | null} fn
 * @returns {string}
 */
export function replaceCalls(sql, name, fn) {
  let from = 0;
  for (let guard = 0; guard < 10_000; guard++) {
    const mask = codeMask(sql);
    const call = findCall(sql, mask, name, from);
    if (!call) return sql;
    const out = fn(call);
    if (out == null) {
      from = call.open + 1;
      continue;
    }
    sql = sql.slice(0, call.start) + out + sql.slice(call.close + 1);
    from = call.start;
  }
  return sql;
}

/**
 * Replace a regex on the code mask, keeping literals intact. The regex is
 * applied to the mask; the replacement is spliced into the SQL at the same
 * indexes. Groups in `replacement` (via a function) receive the *original*
 * text of each match, not the masked one.
 *
 * @param {string} sql
 * @param {RegExp} re must carry the `g` flag
 * @param {string | ((match: string, ...groups: string[]) => string)} replacement
 */
export function replaceCode(sql, re, replacement) {
  const mask = codeMask(sql);
  let out = '';
  let last = 0;
  re.lastIndex = 0;
  for (let m = re.exec(mask); m; m = re.exec(mask)) {
    const original = sql.slice(m.index, m.index + m[0].length);
    out += sql.slice(last, m.index);
    if (typeof replacement === 'function') {
      // Re-run the regex on the original slice so groups carry real text.
      const local = new RegExp(re.source, re.flags.replace('g', ''));
      const lm = local.exec(original);
      out += replacement(original, ...(lm ? lm.slice(1) : []));
    } else {
      out += original.replace(new RegExp(re.source, re.flags.replace('g', '')), replacement);
    }
    last = m.index + m[0].length;
    if (m[0].length === 0) re.lastIndex++;
  }
  return out + sql.slice(last);
}

/**
 * Strip the quotes off an identifier and fold an unquoted one to lower case,
 * the way Postgres will.
 *
 * @param {string} ident
 */
export function unquote(ident) {
  const t = ident.trim();
  if (/^".*"$/.test(t)) return t.slice(1, -1).replace(/""/g, '"');
  if (/^`.*`$/.test(t) || /^\[.*\]$/.test(t)) return t.slice(1, -1);
  return t.toLowerCase();
}

/**
 * Quote an identifier for Postgres.
 *
 * @param {string} name
 */
export function quoteIdent(name) {
  return `"${String(name).replace(/"/g, '""')}"`;
}

/**
 * Quote an identifier only when it needs it, keeping schema qualification.
 * @param {string} name possibly `schema.table`, possibly already quoted
 */
export function identSql(name) {
  return name
    .split('.')
    .map((part) => (/^[a-z_][a-z0-9_]*$/.test(part) ? part : quoteIdent(part)))
    .join('.');
}

/**
 * Is this a plain single-quoted string literal? Returns its value or null.
 * @param {string} text
 */
export function literalValue(text) {
  const t = text.trim();
  if (!/^'.*'$/s.test(t)) return null;
  return t.slice(1, -1).replace(/''/g, "'");
}
