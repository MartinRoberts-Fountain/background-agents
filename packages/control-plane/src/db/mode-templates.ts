import { SESSION_MODES, type ModeTemplate, type SessionMode } from "@open-inspect/shared";

export class ModeTemplateStore {
  constructor(private readonly db: D1Database) {}

  async get(mode: SessionMode): Promise<ModeTemplate | null> {
    const row = await this.db
      .prepare(
        "SELECT mode, system_prompt, default_model, updated_at FROM mode_templates WHERE mode = ?"
      )
      .bind(mode)
      .first<{
        mode: string;
        system_prompt: string;
        default_model: string | null;
        updated_at: number;
      }>();

    if (!row) return null;

    return {
      mode: row.mode as SessionMode,
      systemPrompt: row.system_prompt,
      defaultModel: row.default_model,
      updatedAt: row.updated_at,
    };
  }

  async list(): Promise<ModeTemplate[]> {
    const result = await this.db
      .prepare(
        "SELECT mode, system_prompt, default_model, updated_at FROM mode_templates ORDER BY mode"
      )
      .all<{
        mode: string;
        system_prompt: string;
        default_model: string | null;
        updated_at: number;
      }>();

    return (result.results || []).map((row) => ({
      mode: row.mode as SessionMode,
      systemPrompt: row.system_prompt,
      defaultModel: row.default_model,
      updatedAt: row.updated_at,
    }));
  }

  async upsert(
    mode: SessionMode,
    systemPrompt: string,
    defaultModel: string | null
  ): Promise<void> {
    if (!SESSION_MODES.includes(mode)) {
      throw new Error(`Invalid mode: ${mode}`);
    }

    const now = Date.now();
    await this.db
      .prepare(
        `INSERT INTO mode_templates (mode, system_prompt, default_model, updated_at)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(mode) DO UPDATE SET
           system_prompt = excluded.system_prompt,
           default_model = excluded.default_model,
           updated_at = excluded.updated_at`
      )
      .bind(mode, systemPrompt, defaultModel, now)
      .run();
  }
}
