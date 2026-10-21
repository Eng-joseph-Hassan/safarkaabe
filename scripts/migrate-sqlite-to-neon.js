const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');

if (!process.env.DATABASE_URL) {
  throw new Error('Set DATABASE_URL to the Neon PostgreSQL connection string before running this migration.');
}

const { database, databaseReady } = require('../server');
const sourcePath = path.resolve(process.env.SAFAR_KAABE_DATA_DIR || path.join(__dirname, '..', 'data'), 'safar-kaabe.sqlite');
const tables = [
  'agencies',
  'users',
  'agency_clients',
  'catalog_products',
  'bookings',
  'audit_logs',
  'conversations',
  'messages'
];

async function migrate() {
  if (!fs.existsSync(sourcePath)) throw new Error(`Local SQLite database was not found at ${sourcePath}.`);
  await databaseReady;
  const source = new DatabaseSync(sourcePath, { readOnly: true });
  try {
    const existingTables = new Set(source.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all().map(row => row.name));
    for (const table of tables) {
      if (!existingTables.has(table)) throw new Error(`The local SQLite database is missing the ${table} table.`);
      const targetCount = Number((await database.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get()).count);
      if (targetCount !== 0) throw new Error(`Neon table ${table} is not empty; migration stopped to prevent overwriting data.`);
    }

    await database.transaction(async () => {
      for (const table of tables) {
        const rows = source.prepare(`SELECT * FROM "${table}"`).all();
        for (const row of rows) {
          const columns = Object.keys(row);
          const columnList = columns.map(column => `"${column.replaceAll('"', '""')}"`).join(', ');
          const placeholders = columns.map(() => '?').join(', ');
          await database.prepare(`INSERT INTO "${table}" (${columnList}) VALUES (${placeholders})`)
            .run(...columns.map(column => row[column]));
        }
        console.log(`Migrated ${rows.length} ${table} rows.`);
      }
      await database.prepare(`
        SELECT setval(pg_get_serial_sequence('audit_logs', 'id'), COALESCE(MAX(id), 1), MAX(id) IS NOT NULL)
        FROM audit_logs
      `).get();
    });
  } finally {
    source.close();
    await database.close();
  }
  console.log('Migration complete. Existing sign-in sessions and password-reset codes were not copied; users must sign in again.');
}

migrate().catch(error => {
  console.error('SQLite-to-Neon migration failed:', error);
  process.exitCode = 1;
});
