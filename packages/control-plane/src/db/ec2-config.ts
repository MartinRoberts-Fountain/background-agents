/**
 * Global EC2 image builder configuration store.
 *
 * Single-row table holding the setup script and the currently active AMI ID
 * shared across all repositories.
 */

export interface Ec2Config {
  setupScript: string | null;
  currentAmiId: string | null;
  /** 'idle' | 'building' | 'ready' | 'failed' */
  status: string;
  buildId: string | null;
  lastBuiltAt: number | null;
  createdAt: number;
  updatedAt: number;
}

interface Ec2ConfigRow {
  setup_script: string | null;
  current_ami_id: string | null;
  status: string;
  build_id: string | null;
  last_built_at: number | null;
  created_at: number;
  updated_at: number;
}

function toConfig(row: Ec2ConfigRow): Ec2Config {
  return {
    setupScript: row.setup_script,
    currentAmiId: row.current_ami_id,
    status: row.status,
    buildId: row.build_id,
    lastBuiltAt: row.last_built_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export class Ec2ConfigStore {
  constructor(private readonly db: D1Database) {}

  async getConfig(): Promise<Ec2Config | null> {
    const row = await this.db
      .prepare("SELECT * FROM ec2_config WHERE id = 1")
      .first<Ec2ConfigRow>();

    return row ? toConfig(row) : null;
  }

  async setSetupScript(script: string | null): Promise<void> {
    const now = Date.now();
    await this.db
      .prepare(
        `INSERT INTO ec2_config (id, setup_script, created_at, updated_at)
         VALUES (1, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           setup_script = excluded.setup_script,
           updated_at = excluded.updated_at`
      )
      .bind(script, now, now)
      .run();
  }

  async markBuilding(buildId: string): Promise<void> {
    const now = Date.now();
    await this.db
      .prepare(
        `INSERT INTO ec2_config (id, status, build_id, created_at, updated_at)
         VALUES (1, 'building', ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           status = 'building',
           build_id = excluded.build_id,
           updated_at = excluded.updated_at`
      )
      .bind(buildId, now, now)
      .run();
  }

  async markReady(amiId: string, buildDurationSeconds: number): Promise<string | null> {
    const now = Date.now();
    const existing = await this.getConfig();
    const replacedAmiId = existing?.currentAmiId ?? null;

    await this.db
      .prepare(
        `INSERT INTO ec2_config (id, current_ami_id, status, build_id, last_built_at, created_at, updated_at)
         VALUES (1, ?, 'ready', NULL, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           current_ami_id = excluded.current_ami_id,
           status = 'ready',
           build_id = NULL,
           last_built_at = excluded.last_built_at,
           updated_at = excluded.updated_at`
      )
      .bind(amiId, buildDurationSeconds, now, now)
      .run();

    return replacedAmiId !== amiId ? replacedAmiId : null;
  }

  async markFailed(): Promise<void> {
    const now = Date.now();
    await this.db
      .prepare(
        `INSERT INTO ec2_config (id, status, build_id, created_at, updated_at)
         VALUES (1, 'failed', NULL, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           status = 'failed',
           build_id = NULL,
           updated_at = excluded.updated_at`
      )
      .bind(now, now)
      .run();
  }
}
