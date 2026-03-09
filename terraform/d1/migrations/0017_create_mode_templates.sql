-- Mode templates: configurable prompt and default model per session mode.
CREATE TABLE IF NOT EXISTS mode_templates (
  mode TEXT PRIMARY KEY,
  system_prompt TEXT NOT NULL DEFAULT '',
  default_model TEXT,
  updated_at INTEGER NOT NULL DEFAULT 0
);
