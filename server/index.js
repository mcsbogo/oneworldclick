import express from 'express';
import cors from 'cors';
import { createServer } from 'node:http';
import { Server } from 'socket.io';
import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import bcrypt from 'bcryptjs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const dist = path.join(__dirname, '..', 'dist');
const PORT = process.env.PORT || 3001;
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL ? { rejectUnauthorized: false } : undefined
});
const milestones = new Set([100, 500, 1000, 5000, 10000, 50000, 100000, 500000, 1000000]);
const clickLimits = new Map();

async function initializeDatabase() {
  if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL fehlt. PostgreSQL muss eingerichtet sein.');
  await pool.query(`
    CREATE TABLE IF NOT EXISTS app_stats (
      id BOOLEAN PRIMARY KEY DEFAULT TRUE CHECK (id),
      total BIGINT NOT NULL DEFAULT 0,
      day DATE NOT NULL DEFAULT CURRENT_DATE,
      day_clicks BIGINT NOT NULL DEFAULT 0
    );
    CREATE TABLE IF NOT EXISTS users (
      id UUID PRIMARY KEY,
      name VARCHAR(20) NOT NULL,
      country VARCHAR(40) NOT NULL,
      clicks BIGINT NOT NULL DEFAULT 0,
      password_hash TEXT,
      is_guest BOOLEAN NOT NULL DEFAULT FALSE,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS clicks (
      id UUID PRIMARY KEY,
      user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      name VARCHAR(20) NOT NULL,
      country VARCHAR(40) NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      milestone BOOLEAN NOT NULL DEFAULT FALSE
    );
    ALTER TABLE users ADD COLUMN IF NOT EXISTS password_hash TEXT;
    ALTER TABLE users ADD COLUMN IF NOT EXISTS is_guest BOOLEAN NOT NULL DEFAULT FALSE;
    CREATE INDEX IF NOT EXISTS clicks_created_at_idx ON clicks (created_at DESC);
    CREATE UNIQUE INDEX IF NOT EXISTS users_name_unique_idx ON users (LOWER(name));
    INSERT INTO app_stats (id) VALUES (TRUE) ON CONFLICT (id) DO NOTHING;
  `);
}

async function snapshot() {
  const [stats, leaders, feed] = await Promise.all([
    pool.query('SELECT total, day_clicks FROM app_stats WHERE id = TRUE'),
    pool.query('SELECT id, name, country, clicks FROM users ORDER BY clicks DESC, created_at ASC LIMIT 10'),
    pool.query(`SELECT id, user_id AS "userId", name, country, milestone,
      to_char(created_at AT TIME ZONE 'Europe/Berlin', 'HH24:MI:SS') AS at
      FROM clicks ORDER BY created_at DESC LIMIT 25`)
  ]);
  return { total: Number(stats.rows[0].total), dayClicks: Number(stats.rows[0].day_clicks), leaders: leaders.rows.map(u => ({ ...u, clicks: Number(u.clicks) })), feed: feed.rows };
}

const app = express();
app.use(cors());
app.get('/health', async (_, res) => {
  try { await pool.query('SELECT 1'); res.json({ ok: true }); }
  catch { res.status(503).json({ ok: false }); }
});
app.use(express.static(dist));
const httpServer = createServer(app);
const io = new Server(httpServer, { cors: { origin: '*' } });

io.on('connection', async socket => {
  try { socket.emit('state', await snapshot()); } catch { socket.emit('error-message', 'Datenbank nicht erreichbar.'); }

  socket.on('register', async ({ name, country, password }, done) => {
    if (!/^[\p{L}\p{N}_ -]{3,20}$/u.test(name || '') || String(country || '').length > 40 || String(password || '').length < 6) return done?.({ ok: false, error: 'Nickname: 3–20 Zeichen. Passwort: mindestens 6 Zeichen.' });
    try {
      const id = randomUUID();
      const hash = await bcrypt.hash(password, 12);
      await pool.query('INSERT INTO users (id, name, country, password_hash) VALUES ($1, $2, $3, $4)', [id, name.trim(), country || 'Unbekannt', hash]);
      socket.data.userId = id;
      done?.({ ok: true, user: { id, name: name.trim(), country } });
      io.emit('state', await snapshot());
    } catch (error) {
      if (error.code === '23505') {
        const claimed = await pool.query(`UPDATE users SET password_hash = $1, country = $2
          WHERE LOWER(name) = LOWER($3) AND password_hash IS NULL RETURNING id, name, country`, [hash, country || 'Unbekannt', name.trim()]);
        if (claimed.rowCount) {
          const account = claimed.rows[0]; socket.data.userId = account.id;
          return done?.({ ok: true, user: account });
        }
        return done?.({ ok: false, error: 'Dieser Benutzername ist bereits vergeben.' });
      }
      done?.({ ok: false, error: 'Registrierung fehlgeschlagen.' });
    }
  });

  socket.on('login', async ({ name, password }, done) => {
    try {
      const result = await pool.query('SELECT id, name, country, password_hash FROM users WHERE LOWER(name) = LOWER($1) AND is_guest = FALSE', [String(name || '').trim()]);
      const account = result.rows[0];
      if (!account?.password_hash || !(await bcrypt.compare(String(password || ''), account.password_hash))) return done?.({ ok: false, error: 'Nickname oder Passwort ist falsch.' });
      socket.data.userId = account.id;
      done?.({ ok: true, user: { id: account.id, name: account.name, country: account.country } });
    } catch { done?.({ ok: false, error: 'Anmeldung fehlgeschlagen.' }); }
  });

  socket.on('click', async () => {
    const id = socket.data.userId;
    if (!id) return socket.emit('error-message', 'Bitte zuerst anmelden.');
    const now = Date.now();
    const timestamps = (clickLimits.get(socket.id) || []).filter(t => now - t < 60000);
    const lastSecond = timestamps.filter(t => now - t < 1000);
    if (timestamps.length >= 200 || lastSecond.length >= 8 || (timestamps.at(-1) && now - timestamps.at(-1) < 120)) {
      socket.emit('blocked', { seconds: 3 }); return;
    }
    timestamps.push(now); clickLimits.set(socket.id, timestamps);

    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const statResult = await client.query(`UPDATE app_stats
        SET total = total + 1, day_clicks = CASE WHEN day = CURRENT_DATE THEN day_clicks + 1 ELSE 1 END, day = CURRENT_DATE
        WHERE id = TRUE RETURNING total, day_clicks`);
      const userResult = await client.query('UPDATE users SET clicks = clicks + 1 WHERE id = $1 RETURNING name, country', [id]);
      if (!userResult.rowCount) { await client.query('ROLLBACK'); return; }
      const total = Number(statResult.rows[0].total);
      const click = { id: randomUUID(), userId: id, name: userResult.rows[0].name, country: userResult.rows[0].country, milestone: milestones.has(total) };
      const inserted = await client.query(`INSERT INTO clicks (id, user_id, name, country, milestone)
        VALUES ($1,$2,$3,$4,$5) RETURNING to_char(created_at AT TIME ZONE 'Europe/Berlin', 'HH24:MI:SS') AS at`, [click.id, click.userId, click.name, click.country, click.milestone]);
      await client.query('COMMIT');
      io.emit('click', { ...click, at: inserted.rows[0].at, total, dayClicks: Number(statResult.rows[0].day_clicks) });
      io.emit('state', await snapshot());
    } catch (error) {
      await client.query('ROLLBACK');
      console.error('click transaction failed', error.message);
      socket.emit('error-message', 'Klick konnte nicht gespeichert werden.');
    } finally { client.release(); }
  });
  socket.on('disconnect', () => clickLimits.delete(socket.id));
});

app.use((req, res, next) => {
  if (req.method === 'GET' && req.accepts('html')) return res.sendFile(path.join(dist, 'index.html'));
  next();
});

initializeDatabase()
  .then(() => httpServer.listen(PORT, '0.0.0.0', () => console.log(`One World Click läuft auf Port ${PORT}`)))
  .catch(error => { console.error(error.message); process.exit(1); });
