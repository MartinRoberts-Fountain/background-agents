import { describe, it, expect } from "vitest";
import { runInDurableObject } from "cloudflare:test";
import type { SessionDO } from "../../src/session/durable-object";
import { initSession, queryDO, seedSandboxAuthHash } from "./helpers";

describe("GET /internal/state", () => {
  it("state includes sandbox after init", async () => {
    const { stub } = await initSession();

    const res = await stub.fetch("http://internal/internal/state");
    expect(res.status).toBe(200);

    const state = await res.json<{
      id: string;
      status: string;
      sandbox: { id: string; status: string } | null;
    }>();

    expect(state.sandbox).not.toBeNull();
    expect(state.sandbox!.id).toEqual(expect.any(String));
    // Status may be "pending" or "spawning" depending on whether warmSandbox()
    // has begun the spawn attempt (it fires via ctx.waitUntil).
    expect(["pending", "spawning"]).toContain(state.sandbox!.status);
  });

  it("state reflects custom model", async () => {
    const { stub } = await initSession({ model: "anthropic/claude-sonnet-4-5" });

    const res = await stub.fetch("http://internal/internal/state");
    const state = await res.json<{ model: string }>();

    expect(state.model).toBe("anthropic/claude-sonnet-4-5");
  });
});

describe("POST /internal/archive", () => {
  it("archive sets status to archived", async () => {
    const { stub } = await initSession({ userId: "user-1" });

    const res = await stub.fetch("http://internal/internal/archive", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ userId: "user-1" }),
    });

    expect(res.status).toBe(200);
    const body = await res.json<{ status: string }>();
    expect(body.status).toBe("archived");

    // Verify via state endpoint
    const stateRes = await stub.fetch("http://internal/internal/state");
    const state = await stateRes.json<{ status: string }>();
    expect(state.status).toBe("archived");
  });

  it("archive rejects non-participant", async () => {
    const { stub } = await initSession({ userId: "user-1" });

    const res = await stub.fetch("http://internal/internal/archive", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ userId: "stranger" }),
    });

    expect(res.status).toBe(403);
  });
});

describe("POST /internal/unarchive", () => {
  it("unarchive restores to active", async () => {
    const { stub } = await initSession({ userId: "user-1" });

    // First archive
    await stub.fetch("http://internal/internal/archive", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ userId: "user-1" }),
    });

    // Then unarchive
    const res = await stub.fetch("http://internal/internal/unarchive", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ userId: "user-1" }),
    });

    expect(res.status).toBe(200);
    const body = await res.json<{ status: string }>();
    expect(body.status).toBe("active");

    // Verify via state endpoint
    const stateRes = await stub.fetch("http://internal/internal/state");
    const state = await stateRes.json<{ status: string }>();
    expect(state.status).toBe("active");
  });
});

describe("POST /internal/prompt", () => {
  it.each(["completed", "failed", "archived", "cancelled"])(
    "reopens %s session back to active",
    async (status) => {
      const { stub } = await initSession({ userId: "user-1" });

      await runInDurableObject(stub, (instance: SessionDO) => {
        instance.ctx.storage.sql.exec("UPDATE session SET status = ?", status);
      });

      const promptRes = await stub.fetch("http://internal/internal/prompt", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          content: "Re-open session",
          authorId: "user-1",
          source: "web",
        }),
      });
      expect(promptRes.status).toBe(200);

      const stateRes = await stub.fetch("http://internal/internal/state");
      const state = await stateRes.json<{ status: string }>();
      expect(state.status).toBe("active");
    }
  );
});

describe("POST /internal/init — mode and sandboxProvider persistence", () => {
  it("persists mode and sandboxProvider to DO SQLite when both are provided", async () => {
    const { stub } = await initSession({ mode: "apply", sandboxProvider: "ec2" });

    const rows = await queryDO<{ mode: string | null; sandbox_provider: string | null }>(
      stub,
      "SELECT mode, sandbox_provider FROM session"
    );

    expect(rows).toHaveLength(1);
    expect(rows[0].mode).toBe("apply");
    expect(rows[0].sandbox_provider).toBe("ec2");
  });

  it("persists mode:plan and sandboxProvider:helm to DO SQLite", async () => {
    const { stub } = await initSession({ mode: "plan", sandboxProvider: "helm" });

    const rows = await queryDO<{ mode: string | null; sandbox_provider: string | null }>(
      stub,
      "SELECT mode, sandbox_provider FROM session"
    );

    expect(rows[0].mode).toBe("plan");
    expect(rows[0].sandbox_provider).toBe("helm");
  });

  it("persists mode:code_review with no sandboxProvider to DO SQLite", async () => {
    const { stub } = await initSession({ mode: "code_review" });

    const rows = await queryDO<{ mode: string | null; sandbox_provider: string | null }>(
      stub,
      "SELECT mode, sandbox_provider FROM session"
    );

    expect(rows[0].mode).toBe("code_review");
    expect(rows[0].sandbox_provider).toBeNull();
  });

  it("stores NULL for both mode and sandboxProvider when neither is provided", async () => {
    const { stub } = await initSession();

    const rows = await queryDO<{ mode: string | null; sandbox_provider: string | null }>(
      stub,
      "SELECT mode, sandbox_provider FROM session"
    );

    expect(rows[0].mode).toBeNull();
    expect(rows[0].sandbox_provider).toBeNull();
  });

  it("stores NULL for mode and sandboxProvider when explicitly set to null", async () => {
    const { stub } = await initSession({ mode: null, sandboxProvider: null });

    const rows = await queryDO<{ mode: string | null; sandbox_provider: string | null }>(
      stub,
      "SELECT mode, sandbox_provider FROM session"
    );

    expect(rows[0].mode).toBeNull();
    expect(rows[0].sandbox_provider).toBeNull();
  });

  it("persists sandboxProvider:modal to DO SQLite", async () => {
    const { stub } = await initSession({ sandboxProvider: "modal" });

    const rows = await queryDO<{ sandbox_provider: string | null }>(
      stub,
      "SELECT sandbox_provider FROM session"
    );

    expect(rows[0].sandbox_provider).toBe("modal");
  });

  it("mode and sandboxProvider are independent — mode without provider stores NULL provider", async () => {
    const { stub } = await initSession({ mode: "apply" });

    const rows = await queryDO<{ mode: string | null; sandbox_provider: string | null }>(
      stub,
      "SELECT mode, sandbox_provider FROM session"
    );

    expect(rows[0].mode).toBe("apply");
    expect(rows[0].sandbox_provider).toBeNull();
  });

  it("sandboxProvider without mode stores NULL mode", async () => {
    const { stub } = await initSession({ sandboxProvider: "ec2" });

    const rows = await queryDO<{ mode: string | null; sandbox_provider: string | null }>(
      stub,
      "SELECT mode, sandbox_provider FROM session"
    );

    expect(rows[0].mode).toBeNull();
    expect(rows[0].sandbox_provider).toBe("ec2");
  });
});

describe("POST /internal/verify-sandbox-token", () => {
  it("validates token using hashed sandbox auth token", async () => {
    const { stub } = await initSession();

    const authToken = "test-sandbox-auth-token-hashed";
    await seedSandboxAuthHash(stub, { authToken, sandboxId: "sb-hashed-token" });

    const validRes = await stub.fetch("http://internal/internal/verify-sandbox-token", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token: authToken }),
    });
    expect(validRes.status).toBe(200);
    const validBody = await validRes.json<{ valid: boolean }>();
    expect(validBody.valid).toBe(true);

    const invalidRes = await stub.fetch("http://internal/internal/verify-sandbox-token", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token: "wrong-token" }),
    });
    expect(invalidRes.status).toBe(401);
    const invalidBody = await invalidRes.json<{ valid: boolean; error: string }>();
    expect(invalidBody.valid).toBe(false);
  });

  it("validates correct token and rejects wrong token", async () => {
    const { stub } = await initSession();

    // Seed auth_token on the sandbox directly
    const authToken = "test-sandbox-auth-token-12345";
    await runInDurableObject(stub, (instance: SessionDO) => {
      instance.ctx.storage.sql.exec(
        "UPDATE sandbox SET auth_token = ?, auth_token_hash = NULL WHERE id = (SELECT id FROM sandbox LIMIT 1)",
        authToken
      );
    });

    // Correct token
    const validRes = await stub.fetch("http://internal/internal/verify-sandbox-token", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token: authToken }),
    });
    expect(validRes.status).toBe(200);
    const validBody = await validRes.json<{ valid: boolean }>();
    expect(validBody.valid).toBe(true);

    // Wrong token
    const invalidRes = await stub.fetch("http://internal/internal/verify-sandbox-token", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token: "wrong-token" }),
    });
    expect(invalidRes.status).toBe(401);
    const invalidBody = await invalidRes.json<{ valid: boolean; error: string }>();
    expect(invalidBody.valid).toBe(false);
  });
});
