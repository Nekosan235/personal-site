import { createHash, randomBytes } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

function randomToken(bytes = 32) {
  return randomBytes(bytes).toString('base64url');
}

export class SessionStore {
  constructor(databasePath) {
    this.db = new DatabaseSync(databasePath);
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS sessions (
        token_hash TEXT PRIMARY KEY,
        username TEXT NOT NULL,
        csrf TEXT NOT NULL,
        expires INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_sessions_expires ON sessions(expires);
    `);
  }

  create(username, ttlMs, now = Date.now()) {
    const token = randomToken();
    const csrf = randomToken(24);
    const expires = now + ttlMs;
    this.db
      .prepare('INSERT INTO sessions (token_hash, username, csrf, expires) VALUES (?, ?, ?, ?)')
      .run(sha256(token), username, csrf, expires);
    return { token, username, csrf, expires };
  }

  get(token, now = Date.now()) {
    if (!token) return null;
    const row = this.db
      .prepare('SELECT username, csrf, expires FROM sessions WHERE token_hash = ?')
      .get(sha256(token));
    if (!row) return null;
    if (Number(row.expires) <= now) {
      this.revoke(token);
      return null;
    }
    return { token, username: row.username, csrf: row.csrf, expires: Number(row.expires) };
  }

  rotate(oldToken, username, ttlMs, now = Date.now()) {
    if (oldToken) this.revoke(oldToken);
    return this.create(username, ttlMs, now);
  }

  revoke(token) {
    if (!token) return;
    this.db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(sha256(token));
  }

  prune(now = Date.now()) {
    this.db.prepare('DELETE FROM sessions WHERE expires <= ?').run(now);
  }

  close() {
    this.db.close();
  }
}
