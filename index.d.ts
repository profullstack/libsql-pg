// Type declarations for @profullstack/libsql-pg. The runtime mirrors @libsql/client;
// values are typed loosely on purpose so a drop-in swap compiles.
export type InValue = null | string | number | bigint | boolean | Uint8Array | Date;
export type InArgs = InValue[] | Record<string, InValue>;
export type InStatement = string | { sql: string; args?: InArgs };
export interface Row { [column: string]: any; [index: number]: any; length: number }
export interface ResultSet {
  columns: string[];
  columnTypes: string[];
  rows: Row[];
  rowsAffected: number;
  lastInsertRowid: bigint | undefined;
}
export type TransactionMode = 'write' | 'read' | 'deferred';
export interface Transaction {
  execute(stmt: InStatement): Promise<ResultSet>;
  batch(stmts: InStatement[]): Promise<ResultSet[]>;
  executeMultiple(sql: string): Promise<void>;
  commit(): Promise<void>;
  rollback(): Promise<void>;
  close(): void;
  readonly closed: boolean;
}
export interface Client {
  execute(stmt: InStatement): Promise<ResultSet>;
  batch(stmts: InStatement[], mode?: TransactionMode): Promise<ResultSet[]>;
  transaction(mode?: TransactionMode): Promise<Transaction>;
  executeMultiple(sql: string): Promise<void>;
  sync(): Promise<void>;
  close(): void;
  readonly closed: boolean;
  readonly protocol: 'postgres';
}
export interface Config {
  url: string;
  authToken?: string;
  syncUrl?: string;
  dialect?: 'sqlite' | 'postgres';
  pool?: { max?: number; idleTimeoutMillis?: number; connectionTimeoutMillis?: number };
  ssl?: any;
}
export function createClient(config: Config): Client;
export function connectionSettings(url: string, explicit?: Record<string, any>): Record<string, any>;
export function rewriteSql(sql: string, opts?: Record<string, any>): string;
export function rewriteStatement(sql: string, opts?: Record<string, any>): { sql: string; [k: string]: any };
export function createRewriter(opts?: Record<string, any>): (sql: string) => { sql: string; [k: string]: any };
export function rewriteFunctions(sql: string): string;
export function insertTarget(sql: string): { table: string; columns: string[] } | null;
export function jsonPathToArray(path: string): string;
export function unsupportedIdioms(sql: string): string[];
export function convertSchema(sql: string, opts?: Record<string, any>): string;
export function convertStatement(stmt: string, ctx: any, opts?: Record<string, any>): string | null;
export function convertDdl(sql: string): string;
export function mapType(declared: string, opts?: Record<string, any>): string;
export function positional(sql: string, args?: InValue[]): { sql: string; values: InValue[] };
export function named(sql: string, args: Record<string, InValue>): { sql: string; values: InValue[] };
export function bind(stmt: InStatement): { sql: string; values: InValue[] };
export function prepare(stmt: InStatement, opts?: Record<string, any>): { sql: string; values: InValue[] };
export function translateError(err: any, info?: Record<string, any>): Error;
export function ftsError(table: string, sql: string): Error;
export function toResultSet(res: any, opts?: Record<string, any>): ResultSet;
export function makeRow(columns: string[], values: any[]): Row;
export function emptyResultSet(): ResultSet;
export function copyDatabase(opts: Record<string, any>): Promise<any>;
export function verifyCopy(opts: Record<string, any>): Promise<any>;
export function orderTables(tables: any[]): any[];
export function referencedTables(sql: string): string[];
export function userTables(master: any[]): any[];
export function coerce(value: any, dataType: string): any;
export function insertSql(table: string, cols: string[]): string;
export function splitStatements(sql: string): string[];
export function codeMask(sql: string): string;
export function stripComments(sql: string): string;
