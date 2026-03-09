import { describe, expect, it, vi } from "vitest";
import { AgentDefaultsStore } from "./agent-defaults";

function createMockDb() {
  const rows: Record<
    string,
    {
      user_id: string;
      repo_owner: string;
      repo_name: string;
      default_agent: string | null;
      updated_at: number;
    }
  > = {};

  function key(userId: string, owner: string, name: string) {
    return `${userId}|${owner}|${name}`;
  }

  return {
    prepare: vi.fn((sql: string) => ({
      bind: (...args: unknown[]) => ({
        first: async <T>(): Promise<T | null> => {
          if (sql.includes("SELECT default_agent FROM agent_defaults")) {
            const [userId, owner, name] = args as string[];
            const row = rows[key(userId, owner, name)];
            return (row ? { default_agent: row.default_agent } : null) as T | null;
          }
          return null;
        },
        all: async <T>(): Promise<{ results: T[] }> => {
          if (sql.includes("SELECT repo_owner, repo_name, default_agent")) {
            const userId = args[0] as string;
            const results = Object.values(rows)
              .filter((r) => r.user_id === userId)
              .map((r) => ({
                repo_owner: r.repo_owner,
                repo_name: r.repo_name,
                default_agent: r.default_agent,
              }));
            return { results: results as T[] };
          }
          return { results: [] };
        },
        run: async () => {
          if (sql.includes("INSERT INTO agent_defaults")) {
            const [userId, owner, name, agent, updatedAt] = args as [
              string,
              string,
              string,
              string | null,
              number,
            ];
            rows[key(userId, owner, name)] = {
              user_id: userId,
              repo_owner: owner,
              repo_name: name,
              default_agent: agent,
              updated_at: updatedAt,
            };
          }
          return { success: true };
        },
      }),
    })),
  } as unknown as D1Database;
}

describe("AgentDefaultsStore", () => {
  it("returns null when no default is set", async () => {
    const db = createMockDb();
    const store = new AgentDefaultsStore(db);

    const result = await store.get("user-1", "owner", "repo");
    expect(result).toBeNull();
  });

  it("sets and gets a default agent", async () => {
    const db = createMockDb();
    const store = new AgentDefaultsStore(db);

    await store.set("user-1", "Owner", "Repo", "my-agent");
    const result = await store.get("user-1", "owner", "repo");

    expect(result).toBe("my-agent");
  });

  it("lowercases owner and name for case-insensitive lookups", async () => {
    const db = createMockDb();
    const store = new AgentDefaultsStore(db);

    await store.set("user-1", "MyOrg", "MyRepo", "agent-1");
    const result = await store.get("user-1", "MYORG", "MYREPO");

    expect(result).toBe("agent-1");
  });

  it("clears default when setting null", async () => {
    const db = createMockDb();
    const store = new AgentDefaultsStore(db);

    await store.set("user-1", "owner", "repo", "agent-1");
    await store.set("user-1", "owner", "repo", null);

    const result = await store.get("user-1", "owner", "repo");
    expect(result).toBeNull();
  });

  it("clears default when setting empty string", async () => {
    const db = createMockDb();
    const store = new AgentDefaultsStore(db);

    await store.set("user-1", "owner", "repo", "agent-1");
    await store.set("user-1", "owner", "repo", "  ");

    const result = await store.get("user-1", "owner", "repo");
    expect(result).toBeNull();
  });

  it("returns all defaults for a user", async () => {
    const db = createMockDb();
    const store = new AgentDefaultsStore(db);

    await store.set("user-1", "org1", "repo1", "agent-a");
    await store.set("user-1", "org2", "repo2", "agent-b");
    await store.set("user-2", "org1", "repo1", "agent-c");

    const results = await store.getAllForUser("user-1");

    expect(results).toHaveLength(2);
    expect(results).toEqual(
      expect.arrayContaining([
        { repoOwner: "org1", repoName: "repo1", defaultAgent: "agent-a" },
        { repoOwner: "org2", repoName: "repo2", defaultAgent: "agent-b" },
      ])
    );
  });

  it("returns empty array when user has no defaults", async () => {
    const db = createMockDb();
    const store = new AgentDefaultsStore(db);

    const results = await store.getAllForUser("nonexistent");
    expect(results).toEqual([]);
  });

  it("overwrites existing default for same user/repo", async () => {
    const db = createMockDb();
    const store = new AgentDefaultsStore(db);

    await store.set("user-1", "owner", "repo", "agent-old");
    await store.set("user-1", "owner", "repo", "agent-new");

    const result = await store.get("user-1", "owner", "repo");
    expect(result).toBe("agent-new");
  });
});
