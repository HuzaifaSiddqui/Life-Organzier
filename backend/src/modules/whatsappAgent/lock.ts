import crypto from "node:crypto";
import { PrismaClient } from "@prisma/client";

/**
 * One poller per key across server instances: a Postgres session advisory lock per connection id. Session
 * locks belong to one database session, so they are taken on a dedicated Prisma client with exactly one
 * connection (the main pool would hand the unlock to a different session). If the process dies, the session
 * ends and Postgres releases its locks; another instance then takes over on its next scan. `held` is checked
 * before every poll, so a lock lost to a dropped connection stops that poller instead of letting two run.
 */

export interface AgentLock {
  tryAcquire(connectionId: string): Promise<boolean>;
  held(connectionId: string): Promise<boolean>;
  release(connectionId: string): Promise<void>;
  close(): Promise<void>;
}

/** "WAAG": the lock namespace, so these never collide with other advisory locks. */
const NAMESPACE = 0x57414147 & 0x7fffffff;

export function lockKey(connectionId: string): number {
  return crypto.createHash("sha256").update(connectionId).digest().readUInt32BE(0) & 0x7fffffff;
}

function singleConnectionUrl(url: string): string {
  const u = new URL(url);
  u.searchParams.set("connection_limit", "1");
  // Keep the session (and its locks) alive while idle; every poll touches it anyway.
  u.searchParams.set("max_idle_connection_lifetime", "86400");
  return u.href;
}

export class PgAdvisoryLock implements AgentLock {
  private readonly db: PrismaClient;

  constructor(url = process.env.DATABASE_URL ?? "") {
    this.db = new PrismaClient({ datasourceUrl: singleConnectionUrl(url) });
  }

  async tryAcquire(connectionId: string): Promise<boolean> {
    if (await this.held(connectionId)) return true; // session locks stack; take it once only
    const rows = await this.db.$queryRaw<Array<{ ok: boolean }>>`SELECT pg_try_advisory_lock(${NAMESPACE}::int4, ${lockKey(connectionId)}::int4) AS ok`;
    return Boolean(rows[0]?.ok);
  }

  async held(connectionId: string): Promise<boolean> {
    const rows = await this.db.$queryRaw<Array<{ held: boolean }>>`
      SELECT EXISTS (
        SELECT 1 FROM pg_locks
        WHERE locktype = 'advisory' AND granted AND pid = pg_backend_pid()
          AND classid::bigint = ${NAMESPACE}::bigint AND objid::bigint = ${lockKey(connectionId)}::bigint AND objsubid = 2
      ) AS held`;
    return Boolean(rows[0]?.held);
  }

  async release(connectionId: string): Promise<void> {
    await this.db.$queryRaw`SELECT pg_advisory_unlock(${NAMESPACE}::int4, ${lockKey(connectionId)}::int4)`;
  }

  async close(): Promise<void> {
    await this.db.$disconnect();
  }
}
