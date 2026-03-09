-- Global EC2 image builder configuration.
-- Single-row table (enforced by CHECK on id) storing the setup script
-- and the currently active AMI ID shared across all repositories.
CREATE TABLE IF NOT EXISTS ec2_config (
  id INTEGER PRIMARY KEY DEFAULT 1 CHECK(id = 1),
  setup_script TEXT,
  current_ami_id TEXT,
  status TEXT NOT NULL DEFAULT 'idle',
  build_id TEXT,
  last_built_at INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
