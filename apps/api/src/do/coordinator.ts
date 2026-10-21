import { DurableObject } from 'cloudflare:workers';
import type { Env } from '../env';
import type { Coordination, JobRun, SessionRecord, SessionStore } from '../ports';

/**
 * Coordination state only (ADR-003): sessions with encrypted Microsoft tokens, rate-limit
 * counters, leases, short-lived idempotency keys and a job-run ledger. No business record lives
 * here; losing this storage signs users out and resets counters, nothing more.
 * A single named instance is sufficient for an internal employee population.
 */
export class Coordinator extends DurableObject<Env> {
  private sql: SqlStorage;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.sql = ctx.storage.sql;
    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS sessions (id TEXT PRIMARY KEY, user_id TEXT NOT NULL, data TEXT NOT NULL, expires_at INTEGER NOT NULL);
      CREATE INDEX IF NOT EXISTS sessions_user ON sessions(user_id);
      CREATE TABLE IF NOT EXISTS counters (k TEXT PRIMARY KEY, n INTEGER NOT NULL, expires_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS leases (name TEXT PRIMARY KEY, owner TEXT NOT NULL, expires_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS memo (k TEXT PRIMARY KEY, v TEXT NOT NULL, expires_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS job_runs (id TEXT PRIMARY KEY, started_at TEXT NOT NULL, data TEXT NOT NULL);
    `);
  }

  private now() {
    return Date.now();
  }

  // Sessions
  sessionCreate(r: SessionRecord) {
    this.sql.exec(
      'INSERT OR REPLACE INTO sessions (id, user_id, data, expires_at) VALUES (?, ?, ?, ?)',
      r.id,
      r.userId,
      JSON.stringify(r),
      r.expiresAt,
    );
  }
  sessionGet(id: string): SessionRecord | null {
    const row = this.sql
      .exec<{
        data: string;
        expires_at: number;
      }>('SELECT data, expires_at FROM sessions WHERE id = ?', id)
      .toArray()[0];
    if (!row) return null;
    if (row.expires_at < this.now()) {
      this.sql.exec('DELETE FROM sessions WHERE id = ?', id);
      return null;
    }
    return JSON.parse(row.data) as SessionRecord;
  }
  sessionUpdate(id: string, patch: Partial<SessionRecord>) {
    const cur = this.sessionGet(id);
    if (!cur) return;
    this.sql.exec(
      'UPDATE sessions SET data = ? WHERE id = ?',
      JSON.stringify({ ...cur, ...patch }),
      id,
    );
  }
  sessionDelete(id: string) {
    this.sql.exec('DELETE FROM sessions WHERE id = ?', id);
  }
  sessionDeleteForUser(userId: string): number {
    const n = this.sql
      .exec<{ c: number }>('SELECT COUNT(*) AS c FROM sessions WHERE user_id = ?', userId)
      .one().c;
    this.sql.exec('DELETE FROM sessions WHERE user_id = ?', userId);
    return n;
  }

  // Coordination
  rateLimit(key: string, limit: number, windowSeconds: number): boolean {
    const now = this.now();
    const window = Math.floor(now / (windowSeconds * 1000));
    const k = `${key}:${window}`;
    this.sql.exec(
      'INSERT INTO counters (k, n, expires_at) VALUES (?, 1, ?) ON CONFLICT(k) DO UPDATE SET n = n + 1',
      k,
      (window + 1) * windowSeconds * 1000,
    );
    const n = this.sql.exec<{ n: number }>('SELECT n FROM counters WHERE k = ?', k).one().n;
    return n <= limit;
  }
  acquireLease(name: string, owner: string, ttlSeconds: number): boolean {
    const now = this.now();
    const cur = this.sql
      .exec<{
        owner: string;
        expires_at: number;
      }>('SELECT owner, expires_at FROM leases WHERE name = ?', name)
      .toArray()[0];
    if (cur && cur.expires_at > now && cur.owner !== owner) return false;
    this.sql.exec(
      'INSERT OR REPLACE INTO leases (name, owner, expires_at) VALUES (?, ?, ?)',
      name,
      owner,
      now + ttlSeconds * 1000,
    );
    return true;
  }
  releaseLease(name: string, owner: string) {
    this.sql.exec('DELETE FROM leases WHERE name = ? AND owner = ?', name, owner);
  }
  remember(key: string, value: string, ttlSeconds: number): string | null {
    const now = this.now();
    const cur = this.sql
      .exec<{ v: string; expires_at: number }>('SELECT v, expires_at FROM memo WHERE k = ?', key)
      .toArray()[0];
    if (cur && cur.expires_at > now) return cur.v;
    this.sql.exec(
      'INSERT OR REPLACE INTO memo (k, v, expires_at) VALUES (?, ?, ?)',
      key,
      value,
      now + ttlSeconds * 1000,
    );
    return null;
  }
  store(key: string, value: string, ttlSeconds: number) {
    this.sql.exec(
      'INSERT OR REPLACE INTO memo (k, v, expires_at) VALUES (?, ?, ?)',
      key,
      value,
      this.now() + ttlSeconds * 1000,
    );
  }
  forget(key: string) {
    this.sql.exec('DELETE FROM memo WHERE k = ?', key);
  }
  recordJobRun(run: JobRun) {
    this.sql.exec(
      'INSERT OR REPLACE INTO job_runs (id, started_at, data) VALUES (?, ?, ?)',
      run.id,
      run.startedAt,
      JSON.stringify(run),
    );
    this.sql.exec(
      'DELETE FROM job_runs WHERE id NOT IN (SELECT id FROM job_runs ORDER BY started_at DESC LIMIT 500)',
    );
  }
  recentJobRuns(limit: number): JobRun[] {
    return this.sql
      .exec<{ data: string }>(
        'SELECT data FROM job_runs ORDER BY started_at DESC LIMIT ?',
        Math.min(limit, 200),
      )
      .toArray()
      .map((r) => JSON.parse(r.data) as JobRun);
  }

  /** Daily housekeeping of expired rows, scheduled by the maintenance job. */
  purgeExpired() {
    const now = this.now();
    for (const t of ['sessions', 'counters', 'leases', 'memo'])
      this.sql.exec(`DELETE FROM ${t} WHERE expires_at < ?`, now);
  }
}

type Stub = DurableObjectStub<Coordinator>;

/**
 * Returns a factory, not a stub: Workers forbid using an I/O object (a Durable Object stub)
 * created while handling one request from another request, and these adapters live for the
 * whole isolate. Getting a stub is cheap; the object id is stable.
 */
export function coordinatorStub(ns: DurableObjectNamespace<Coordinator>): () => Stub {
  return () => ns.get(ns.idFromName('global'));
}

export class DurableSessionStore implements SessionStore {
  constructor(private readonly getStub: () => Stub) {}
  private get stub() {
    return this.getStub();
  }
  async create(r: SessionRecord) {
    await this.stub.sessionCreate(r);
  }
  async get(id: string) {
    return (await this.stub.sessionGet(id)) as SessionRecord | null;
  }
  async touch(id: string, now: number) {
    await this.stub.sessionUpdate(id, { lastSeenAt: now });
  }
  async setTokens(id: string, tokens: string, scopes: string) {
    await this.stub.sessionUpdate(id, { tokens, scopes });
  }
  async delete(id: string) {
    await this.stub.sessionDelete(id);
  }
  async deleteForUser(userId: string) {
    return this.stub.sessionDeleteForUser(userId);
  }
}

export class DurableCoordination implements Coordination {
  constructor(private readonly getStub: () => Stub) {}
  private get stub() {
    return this.getStub();
  }
  rateLimit(key: string, limit: number, windowSeconds: number) {
    return this.stub.rateLimit(key, limit, windowSeconds);
  }
  acquireLease(name: string, owner: string, ttl: number) {
    return this.stub.acquireLease(name, owner, ttl);
  }
  async releaseLease(name: string, owner: string) {
    await this.stub.releaseLease(name, owner);
  }
  remember(key: string, value: string, ttl: number) {
    return this.stub.remember(key, value, ttl);
  }
  async store(key: string, value: string, ttl: number) {
    await this.stub.store(key, value, ttl);
  }
  async forget(key: string) {
    await this.stub.forget(key);
  }
  async recordJobRun(run: JobRun) {
    await this.stub.recordJobRun(run);
  }
  async recentJobRuns(limit: number) {
    return (await this.stub.recentJobRuns(limit)) as JobRun[];
  }
  async purgeExpired() {
    await this.stub.purgeExpired();
  }
}
