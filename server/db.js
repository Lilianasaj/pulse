import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import pg from 'pg';
export async function openDB({url=process.env.DATABASE_URL, file=process.env.SQLITE_PATH||'data/pulse.db'}={}) {
  let pool, sqlite;
  if(url) pool=new pg.Pool({connectionString:url,max:20});
  else { const {DatabaseSync}=await import('node:sqlite'); if(file!==':memory:') mkdirSync(dirname(file),{recursive:true}); sqlite=new DatabaseSync(file); sqlite.exec('PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;'); }
  const db={
    async query(sql,args=[]) { if(pool) return (await pool.query(sql,args)).rows; const s=sqlite.prepare(sql); return args.length?s.all(Object.fromEntries(args.map((v,i)=>['$'+(i+1),v]))):s.all(); },
    async exec(sql,args=[]) { if(pool) return pool.query(sql,args); return args.length?sqlite.prepare(sql).run(Object.fromEntries(args.map((v,i)=>['$'+(i+1),v]))):sqlite.prepare(sql).run(); },
    async close(){if(pool)await pool.end();else sqlite.close();}, postgres:!!pool
  };
  // Versioned, additive migrations; startup is serialized by a PostgreSQL advisory lock.
  const migrationClient=pool?await pool.connect():null;
  if(migrationClient) await migrationClient.query('SELECT pg_advisory_lock(729541)');
  try {
    const schema=`
CREATE TABLE IF NOT EXISTS schema_migrations(version INTEGER PRIMARY KEY);
CREATE TABLE IF NOT EXISTS users(id TEXT PRIMARY KEY, username TEXT NOT NULL UNIQUE, display_name TEXT NOT NULL, password_hash TEXT NOT NULL, bio TEXT NOT NULL DEFAULT '', created_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS sessions(token_hash TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE, expires_at TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS sessions_expiry ON sessions(expires_at);
CREATE TABLE IF NOT EXISTS channels(id TEXT PRIMARY KEY, name TEXT NOT NULL, description TEXT NOT NULL DEFAULT '', owner_id TEXT REFERENCES users(id), created_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS messages(id ${pool?'BIGSERIAL':'INTEGER'} PRIMARY KEY${pool?'':' AUTOINCREMENT'}, channel_id TEXT NOT NULL REFERENCES channels(id) ON DELETE CASCADE, user_id TEXT NOT NULL REFERENCES users(id), text TEXT NOT NULL, client_id TEXT NOT NULL, created_at TEXT NOT NULL, UNIQUE(user_id,client_id));
CREATE INDEX IF NOT EXISTS messages_channel_cursor ON messages(channel_id,id DESC);
CREATE TABLE IF NOT EXISTS search_outbox(message_id BIGINT PRIMARY KEY REFERENCES messages(id) ON DELETE CASCADE);
INSERT INTO schema_migrations(version) VALUES(1) ON CONFLICT DO NOTHING;`;
    if(pool) await migrationClient.query(schema); else sqlite.exec(schema);
    // Transactional outbox trigger keeps messages and indexing work atomic.
    if(pool) await migrationClient.query(`CREATE OR REPLACE FUNCTION pulse_enqueue_search() RETURNS trigger AS $$ BEGIN INSERT INTO search_outbox(message_id) VALUES(NEW.id) ON CONFLICT DO NOTHING; RETURN NEW; END; $$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS pulse_search_trigger ON messages;
CREATE TRIGGER pulse_search_trigger AFTER INSERT ON messages FOR EACH ROW EXECUTE FUNCTION pulse_enqueue_search();`);
    else sqlite.exec('CREATE TRIGGER IF NOT EXISTS pulse_search_trigger AFTER INSERT ON messages BEGIN INSERT INTO search_outbox(message_id) VALUES(NEW.id); END;');
    const now=new Date().toISOString();
    for(const [id,name,description] of [['general','Общий','Знакомимся, обсуждаем и делимся новостями'],['development','Разработка','Код, идеи и вопросы по проекту'],['random','Флудилка','Место для всего остального']])
      await db.exec('INSERT INTO channels(id,name,description,created_at) VALUES($1,$2,$3,$4) ON CONFLICT DO NOTHING',[id,name,description,now]);
  } finally {if(migrationClient){await migrationClient.query('SELECT pg_advisory_unlock(729541)');migrationClient.release();}}
  return db;
}
