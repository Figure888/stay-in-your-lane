#!/usr/bin/env node
/*
 * Run a .sql file against your database from Termux. No SQL editor needed.
 *
 *   export DATABASE_URL='postgres://...'
 *   node db/migrate.js db/supabase_referrals.sql
 *
 * Prints NOTICE messages and any result rows as they come back, so the
 * verification queries at the end of a migration are readable in the terminal.
 *
 * Uses the pg package you already installed. Nothing else.
 */

import fs from 'fs';
import { Client } from 'pg';

const file = process.argv[2];
const url = process.env.DATABASE_URL;

if (!file) {
  console.error('usage: node db/migrate.js <file.sql>');
  process.exit(1);
}

if (!url) {
  console.error('DATABASE_URL is not set.\n');
  console.error("  export DATABASE_URL='postgres://user:pass@host/db?sslmode=require'\n");
  console.error('Use the DIRECT (unpooled) connection string — pooled');
  console.error('connections sometimes choke on schema changes.');
  process.exit(1);
}

if (!fs.existsSync(file)) {
  console.error(`No such file: ${file}`);
  process.exit(1);
}

const sql = fs.readFileSync(file, 'utf8');
const client = new Client({ connectionString: url });

// Postgres RAISE NOTICE output — this is how the migration reports what it did.
client.on('notice', (msg) => console.log('  ·', msg.message));

function printTable(rows) {
  if (!rows || rows.length === 0) {
    console.log('  (no rows)');
    return;
  }

  const cols = Object.keys(rows[0]);
  const width = {};
  for (const c of cols) {
    width[c] = Math.max(c.length, ...rows.map((r) => String(r[c] ?? '').length));
  }

  const line = (cells) => '  ' + cols.map((c, i) => String(cells[i] ?? '').padEnd(width[c])).join('  ');

  console.log(line(cols));
  console.log('  ' + cols.map((c) => '-'.repeat(width[c])).join('  '));
  for (const r of rows) console.log(line(cols.map((c) => r[c])));
}

try {
  await client.connect();
  console.log(`Connected. Running ${file}\n`);

  // pg returns an array of results when the script has multiple statements.
  const result = await client.query(sql);
  const results = Array.isArray(result) ? result : [result];

  let shown = 0;
  for (const r of results) {
    if (r.command === 'SELECT' && r.rows) {
      shown++;
      console.log(`\n--- result ${shown} ---`);
      printTable(r.rows);
    }
  }

  console.log('\nDone.');
} catch (err) {
  console.error('\nFAILED:', err.message);
  if (err.hint) console.error('hint:', err.hint);
  if (err.position) console.error('at character', err.position);
  process.exitCode = 1;
} finally {
  await client.end();
}
