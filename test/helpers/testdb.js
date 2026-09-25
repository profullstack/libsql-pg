import pg from 'pg';

import { connectionSettings } from '../../src/client.js';

/**
 * A throwaway Postgres database per test file on TEST_DATABASE_URL, dropped
 * on `drop()`. The integration tests are skipped when the variable is unset.
 */
export const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL ?? '';

export async function createTestDatabase() {
  const name = `libsqlpg_test_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
  const admin = new pg.Client(connectionSettings(TEST_DATABASE_URL, undefined));
  await admin.connect();
  await admin.query(`create database "${name}"`);
  await admin.end();
  const url = new URL(TEST_DATABASE_URL);
  url.pathname = `/${name}`;
  return {
    url: url.toString(),
    name,
    async drop() {
      const a = new pg.Client(connectionSettings(TEST_DATABASE_URL, undefined));
      await a.connect();
      await a.query(`drop database if exists "${name}" with (force)`);
      await a.end();
    },
  };
}
