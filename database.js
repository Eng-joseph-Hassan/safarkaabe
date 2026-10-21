const { AsyncLocalStorage } = require('node:async_hooks');
const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');

function postgresPlaceholders(sql) {
  let result = '';
  let parameter = 0;
  let quote = '';
  for (let index = 0; index < sql.length; index += 1) {
    const character = sql[index];
    if (quote) {
      result += character;
      if (character === quote && sql[index + 1] === quote) {
        result += sql[++index];
      } else if (character === quote) {
        quote = '';
      }
      continue;
    }
    if (character === "'" || character === '"') {
      quote = character;
      result += character;
    } else if (character === '?') {
      result += `$${++parameter}`;
    } else {
      result += character;
    }
  }
  return result
    .replace(/\bAS\s+([A-Za-z][A-Za-z0-9_]*)/g, (match, alias) =>
      /[a-z][A-Z]/.test(alias) ? `AS "${alias}"` : match)
    .replace(/\bCOLLATE\s+NOCASE\b/gi, '')
    .replace(/\bdate\s*\(\s*'now'\s*\)/gi, 'CURRENT_DATE::TEXT')
    .replace(/\browid\b/gi, 'id');
}

function createDatabase({ dataDir, databaseUrl = process.env.DATABASE_URL } = {}) {
  const transactionContext = new AsyncLocalStorage();
  const isPostgres = Boolean(databaseUrl);
  if (process.env.VERCEL && !isPostgres) {
    throw new Error('DATABASE_URL must point to the production PostgreSQL database on Vercel.');
  }
  let sqlite;
  let pool;
  let transactionQueue = Promise.resolve();

  if (isPostgres) {
    const { Pool, neonConfig } = require('@neondatabase/serverless');
    const WebSocket = require('ws');
    neonConfig.webSocketConstructor = WebSocket;
    pool = new Pool({ connectionString: databaseUrl, max: 5 });
    pool.on('error', error => console.error('Unexpected PostgreSQL pool error:', error));
  } else {
    fs.mkdirSync(dataDir, { recursive: true });
    sqlite = new DatabaseSync(path.join(dataDir, 'safar-kaabe.sqlite'));
    sqlite.exec('PRAGMA foreign_keys = ON; PRAGMA journal_mode = WAL;');
  }

  async function query(sql, values = []) {
    if (isPostgres) {
      const client = transactionContext.getStore() || pool;
      const result = await client.query(postgresPlaceholders(sql), values);
      for (const row of result.rows) {
        for (const [key, value] of Object.entries(row)) {
          if (/count$/i.test(key) && typeof value === 'string') row[key] = Number(value);
        }
      }
      return result;
    }
    return sqlite.prepare(sql);
  }

  const db = {
    isPostgres,
    async exec(sql) {
      if (!isPostgres) return sqlite.exec(sql);
      const statements = sql.split(';').map(statement => statement.trim()).filter(Boolean);
      for (const statement of statements) {
        if (!/^PRAGMA\b/i.test(statement)) {
          const postgresSql = postgresPlaceholders(statement)
            .replace(/\bINTEGER\s+PRIMARY\s+KEY\s+AUTOINCREMENT\b/gi, 'BIGSERIAL PRIMARY KEY')
            .replace(/\b(expires_at|created_at)\s+INTEGER\b/gi, '$1 BIGINT');
          await query(postgresSql);
        }
      }
    },
    prepare(sql) {
      return {
        async get(...values) {
          if (isPostgres) return (await query(sql, values)).rows[0];
          return (await query(sql)).get(...values);
        },
        async all(...values) {
          if (isPostgres) return (await query(sql, values)).rows;
          return (await query(sql)).all(...values);
        },
        async run(...values) {
          if (isPostgres) return { changes: (await query(sql, values)).rowCount };
          return (await query(sql)).run(...values);
        }
      };
    },
    async transaction(callback) {
      if (!isPostgres) {
        const previous = transactionQueue;
        let release;
        transactionQueue = new Promise(resolve => { release = resolve; });
        await previous;
        sqlite.exec('BEGIN IMMEDIATE');
        try {
          const result = await callback();
          sqlite.exec('COMMIT');
          return result;
        } catch (error) {
          sqlite.exec('ROLLBACK');
          throw error;
        } finally {
          release();
        }
      }

      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        const result = await transactionContext.run(client, callback);
        await client.query('COMMIT');
        return result;
      } catch (error) {
        await client.query('ROLLBACK');
        throw error;
      } finally {
        client.release();
      }
    },
    async close() {
      if (isPostgres) await pool.end();
      else sqlite.close();
    }
  };
  return db;
}

module.exports = { createDatabase, postgresPlaceholders };
