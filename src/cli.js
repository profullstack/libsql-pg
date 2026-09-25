import { readFile, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';

import { commaList, copyDatabase, verifyCopy } from './copy.js';
import { convertSchema } from './schema.js';

const require = createRequire(import.meta.url);
const { version } = require('../package.json');

const USAGE = `libsql-pg ${version}

  libsql-pg convert-schema <sqlite-schema.sql> [-o out.sql] [--json jsonb] [--search-column name] [--ts-config english]
      Convert SQLite DDL to Postgres DDL (stdout unless -o).

  libsql-pg copy --from <libsql://...|file:...> [--token ...] --to <postgres://...>
      [--tables a,b] [--exclude x,y] [--truncate] [--upsert] [--batch N] [--workers N] [--verify] [--dry-run]
      Copy every user table from the source into Postgres. Postgres must
      already hold the schema. Default: skip a table that already has rows.
        --truncate   TRUNCATE ONLY each table first (a parent with children errors; use --upsert)
        --upsert     refresh in place by primary key, mirroring deletes
        --verify     after loading (or alone), compare count(*) per table; exit 1 on a difference
      Env fallbacks: TURSO_DATABASE_URL / LIBSQL_URL, TURSO_AUTH_TOKEN, DATABASE_URL.

  libsql-pg verify --from ... --to ...     Only the count comparison.
`;

/** Flags that never take a value. */
const BOOLEAN_FLAGS = new Set(['truncate', 'upsert', 'verify', 'dry-run', 'help', 'version']);

/** @param {string[]} argv */
export function parseArgs(argv) {
  const flags = {};
  const positional = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const [k, inline] = a.slice(2).split('=', 2);
      if (inline !== undefined) flags[k] = inline;
      else if (BOOLEAN_FLAGS.has(k)) flags[k] = true;
      else if (argv[i + 1] !== undefined && !argv[i + 1].startsWith('-')) flags[k] = argv[++i];
      else flags[k] = true;
    } else if (a === '-o') flags.out = argv[++i];
    else if (a === '-h') flags.help = true;
    else positional.push(a);
  }
  return { flags, positional };
}

/**
 * @param {string[]} argv
 * @param {{ stdout?: (s: string) => void, stderr?: (s: string) => void }} [io]
 * @returns {Promise<number>} exit code
 */
export async function main(argv, io = {}) {
  const out = io.stdout ?? ((s) => process.stdout.write(s));
  const err = io.stderr ?? ((s) => process.stderr.write(s));
  const { flags, positional } = parseArgs(argv);
  const command = positional[0];
  if (flags.version) {
    out(`${version}\n`);
    return 0;
  }
  if (!command || flags.help) {
    out(USAGE);
    return command ? 0 : 1;
  }

  if (command === 'convert-schema') {
    const file = positional[1];
    if (!file) {
      err('convert-schema: a SQLite schema file is required\n');
      return 1;
    }
    const sql = await readFile(file, 'utf8');
    const converted = convertSchema(sql, {
      json: flags.json === 'jsonb' ? 'jsonb' : 'text',
      searchColumn: typeof flags['search-column'] === 'string' ? flags['search-column'] : undefined,
      textSearchConfig: typeof flags['ts-config'] === 'string' ? flags['ts-config'] : undefined,
    });
    if (typeof flags.out === 'string') {
      await writeFile(flags.out, converted);
      err(`wrote ${flags.out} (${converted.split('\n').filter((l) => /TODO/.test(l)).length} TODO line(s))\n`);
    } else out(converted);
    return 0;
  }

  if (command === 'copy' || command === 'verify') {
    const env = process.env;
    const from = typeof flags.from === 'string' ? flags.from : env.TURSO_DATABASE_URL ?? env.LIBSQL_URL;
    const token = typeof flags.token === 'string' ? flags.token : env.TURSO_AUTH_TOKEN;
    const to = typeof flags.to === 'string' ? flags.to : env.DATABASE_URL;
    if (!from || !to) {
      err(`${command}: --from and --to are required (or TURSO_DATABASE_URL and DATABASE_URL)\n`);
      return 1;
    }
    const common = {
      from,
      token,
      to,
      tables: commaList(typeof flags.tables === 'string' ? flags.tables : undefined),
      exclude: commaList(typeof flags.exclude === 'string' ? flags.exclude : undefined),
      log: (line) => err(`${new Date().toISOString().slice(11, 19)} ${line}\n`),
    };
    if (command === 'copy') {
      const reports = await copyDatabase({
        ...common,
        truncate: flags.truncate === true,
        upsert: flags.upsert === true,
        batch: typeof flags.batch === 'string' ? Number(flags.batch) : undefined,
        workers: typeof flags.workers === 'string' ? Number(flags.workers) : undefined,
        dryRun: flags['dry-run'] === true,
      });
      out(`\n${'table'.padEnd(32)} ${'mode'.padEnd(9)} ${'rows'.padStart(12)} ${'secs'.padStart(6)}\n`);
      for (const r of reports) out(`${r.table.padEnd(32)} ${r.mode.padEnd(9)} ${String(r.rows).padStart(12)} ${String(r.seconds).padStart(6)}${r.skipped ? `  ${r.skipped}` : ''}\n`);
      if (flags['dry-run'] === true || flags.verify !== true) return 0;
    }
    const v = await verifyCopy({ ...common, log: (line) => out(`${line}\n`) });
    return v.ok ? 0 : 1;
  }

  err(`unknown command "${command}"\n\n${USAGE}`);
  return 1;
}
