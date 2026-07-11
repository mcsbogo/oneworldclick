import express from 'express';
import cors from 'cors';
import { createServer } from 'node:http';
import { Server } from 'socket.io';
import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
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
    CREATE INDEX IF NOT EXISTS clicks_created_at_idx ON clicks (created_at DESC);
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

  socket.on('join', async user => {
    if (!user?.id || !/^[\p{L}\p{N}_ -]{3,20}$/u.test(user.name || '') || String(user.country || '').length > 40) return;
    try {
      await pool.query(`INSERT INTO users (id, name, country) VALUES ($1, $2, $3)
        ON CONFLICT (id) DO UPDATE SET name = EXCLUDED.name, country = EXCLUDED.country`, [user.id, user.name, user.country || 'Unbekannt']);
      io.emit('state', await snapshot());
    } catch { socket.emit('error-message', 'Anmeldung fehlgeschlagen.'); }
  });

  socket.on('click', async ({ id }) => {
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
