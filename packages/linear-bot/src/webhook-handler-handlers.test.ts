/**
 * Tests for handleStop, handleFollowUp, and handleAgentSessionEvent dispatcher.
 */
import { describe, expect, it, vi, beforeEach } from "vitest";
import { handleAgentSessionEvent } from "./webhook-handler";
import { lookupIssueSession } from "./kv-store";
import { getLinearClient, emitAgentActivity } from "./utils/linear-client";

vi.mock("./kv-store", () => ({
  lookupIssueSession: vi.fn(),
  storeIssueSession: vi.fn(),
  getProjectRepoMapping: vi.fn(() => ({})),
  getTeamRepoMapping: vi.fn(() => ({})),
  getUserPreferences: vi.fn(() => ({})),
}));

vi.mock("./utils/linear-client", () => ({
  getLinearClient: vi.fn(() => ({ accessToken: "test-token" })),
  emitAgentActivity: vi.fn(),
  fetchIssueDetails: vi.fn(),
  updateAgentSession: vi.fn(),
  getRepoSuggestions: vi.fn(() => []),
}));

vi.mock("./utils/integration-config", () => ({
  getLinearConfig: vi.fn(() => ({
    enabledRepos: null,
    model: null,
    reasoningEffort: null,
    allowUserPreferenceOverride: true,
    allowLabelModelOverride: true,
  })),
}));

vi.mock("./classifier", () => ({
  classifyRepo: vi.fn(() => ({
    repo: { owner: "org", name: "repo", fullName: "org/repo" },
    confidence: 1,
    reasoning: "test",
  })),
}));

vi.mock("./classifier/repos", () => ({
  getAvailableRepos: vi.fn(() => []),
}));

function makeEnv() {
  return {
    LINEAR_KV: {
      get: vi.fn(),
      put: vi.fn(),
      delete: vi.fn(),
    },
    CONTROL_PLANE: {
      fetch: vi.fn(async () => ({ ok: true, json: async () => ({}), status: 200 })),
    },
    LINEAR_CLIENT_ID: "client-id",
    LINEAR_CLIENT_SECRET: "client-secret",
    WORKER_URL: "https://worker.url",
    WEB_APP_URL: "https://web.app",
    DEFAULT_MODEL: "claude-sonnet-4-5",
    LINEAR_WEBHOOK_SECRET: "webhook-secret",
  } as any;
}

const baseIssue = {
  id: "issue-1",
  identifier: "ENG-1",
  title: "Test issue",
  url: "https://linear.app/issue/ENG-1",
  priority: 1,
  priorityLabel: "Normal",
  team: { id: "team-1", key: "ENG", name: "Engineering" },
};

describe("handleStop", () => {
  let env: ReturnType<typeof makeEnv>;

  beforeEach(() => {
    vi.clearAllMocks();
    env = makeEnv();
  });

  it("stops existing session and deletes KV entry", async () => {
    (lookupIssueSession as any).mockResolvedValue({
      sessionId: "sess-1",
      issueId: "issue-1",
      mode: "apply",
    });

    const webhook = {
      action: "stopped",
      organizationId: "org-1",
      agentSession: {
        id: "as-1",
        issue: baseIssue,
      },
    } as any;

    await handleAgentSessionEvent(webhook, env, "trace-1");

    // Should call stop on control plane
    expect(env.CONTROL_PLANE.fetch).toHaveBeenCalledWith(
      "https://internal/sessions/sess-1/stop",
      expect.objectContaining({ method: "POST" })
    );

    // Should delete KV entry
    expect(env.LINEAR_KV.delete).toHaveBeenCalledWith("issue:issue-1");
  });

  it("handles stop when no existing session exists", async () => {
    (lookupIssueSession as any).mockResolvedValue(null);

    const webhook = {
      action: "stopped",
      organizationId: "org-1",
      agentSession: {
        id: "as-1",
        issue: baseIssue,
      },
    } as any;

    await handleAgentSessionEvent(webhook, env, "trace-1");

    // Should not call stop
    expect(env.CONTROL_PLANE.fetch).not.toHaveBeenCalled();
    // Should not delete KV
    expect(env.LINEAR_KV.delete).not.toHaveBeenCalled();
  });

  it("handles stop when no issue is present", async () => {
    const webhook = {
      action: "stopped",
      organizationId: "org-1",
      agentSession: {
        id: "as-1",
        // No issue
      },
    } as any;

    await handleAgentSessionEvent(webhook, env, "trace-1");

    // Should not look up or stop anything
    expect(lookupIssueSession).not.toHaveBeenCalled();
    expect(env.CONTROL_PLANE.fetch).not.toHaveBeenCalled();
  });

  it("handles cancelled action same as stopped", async () => {
    (lookupIssueSession as any).mockResolvedValue({
      sessionId: "sess-1",
      issueId: "issue-1",
      mode: "apply",
    });

    const webhook = {
      action: "cancelled",
      organizationId: "org-1",
      agentSession: {
        id: "as-1",
        issue: baseIssue,
      },
    } as any;

    await handleAgentSessionEvent(webhook, env, "trace-1");

    expect(env.CONTROL_PLANE.fetch).toHaveBeenCalledWith(
      "https://internal/sessions/sess-1/stop",
      expect.objectContaining({ method: "POST" })
    );
  });

  it("handles control plane stop failure gracefully", async () => {
    (lookupIssueSession as any).mockResolvedValue({
      sessionId: "sess-1",
      issueId: "issue-1",
      mode: "apply",
    });

    env.CONTROL_PLANE.fetch.mockRejectedValue(new Error("network error"));

    const webhook = {
      action: "stopped",
      organizationId: "org-1",
      agentSession: {
        id: "as-1",
        issue: baseIssue,
      },
    } as any;

    // Should not throw
    await expect(handleAgentSessionEvent(webhook, env, "trace-1")).resolves.toBeUndefined();

    // Should still delete KV entry even after stop failure
    expect(env.LINEAR_KV.delete).toHaveBeenCalledWith("issue:issue-1");
  });
});

describe("handleFollowUp", () => {
  let env: ReturnType<typeof makeEnv>;

  beforeEach(() => {
    vi.clearAllMocks();
    env = makeEnv();
    (getLinearClient as any).mockResolvedValue({ accessToken: "test-token" });
    env.CONTROL_PLANE.fetch.mockImplementation(async (url: string) => {
      if (url.includes("/events")) {
        return {
          ok: true,
          json: async () => ({ events: [] }),
        };
      }
      if (url.includes("/prompt")) {
        return { ok: true };
      }
      return { ok: true };
    });
  });

  it("sends follow-up prompt to existing apply-mode session", async () => {
    (lookupIssueSession as any).mockResolvedValue({
      sessionId: "sess-1",
      issueId: "issue-1",
      mode: "apply",
    });

    const webhook = {
      action: "prompted",
      organizationId: "org-1",
      appUserId: "user-1",
      agentSession: {
        id: "as-1",
        issue: baseIssue,
        comment: { body: "Please also fix the tests" },
      },
    } as any;

    await handleAgentSessionEvent(webhook, env, "trace-1");

    // Should send prompt
    expect(env.CONTROL_PLANE.fetch).toHaveBeenCalledWith(
      "https://internal/sessions/sess-1/prompt",
      expect.objectContaining({ method: "POST" })
    );

    // Prompt should contain the follow-up content
    const promptCall = env.CONTROL_PLANE.fetch.mock.calls.find(([url]: [string]) =>
      url.includes("/prompt")
    );
    const promptBody = JSON.parse(promptCall[1].body);
    expect(promptBody.content).toContain("Please also fix the tests");
    expect(promptBody.content).toContain("Follow-up on ENG-1");
  });

  it("sends plan revision for plan-mode session", async () => {
    (lookupIssueSession as any).mockResolvedValue({
      sessionId: "sess-1",
      issueId: "issue-1",
      mode: "plan",
    });

    const webhook = {
      action: "prompted",
      organizationId: "org-1",
      appUserId: "user-1",
      agentSession: {
        id: "as-1",
        issue: baseIssue,
        comment: { body: "Add more detail to step 3" },
      },
    } as any;

    await handleAgentSessionEvent(webhook, env, "trace-1");

    // Should send prompt containing plan mode instruction
    const promptCall = env.CONTROL_PLANE.fetch.mock.calls.find(([url]: [string]) =>
      url.includes("/prompt")
    );
    const promptBody = JSON.parse(promptCall[1].body);
    expect(promptBody.content).toContain("PLAN mode");
    expect(promptBody.content).toContain("Add more detail to step 3");
    expect(promptBody.content).toContain("revise the plan");
  });

  it("emits thought activity when processing follow-up", async () => {
    (lookupIssueSession as any).mockResolvedValue({
      sessionId: "sess-1",
      issueId: "issue-1",
      mode: "apply",
    });

    const webhook = {
      action: "prompted",
      organizationId: "org-1",
      appUserId: "user-1",
      agentSession: {
        id: "as-1",
        issue: baseIssue,
        comment: { body: "Fix it" },
      },
    } as any;

    await handleAgentSessionEvent(webhook, env, "trace-1");

    expect(emitAgentActivity).toHaveBeenCalledWith(
      expect.anything(),
      "as-1",
      expect.objectContaining({
        type: "thought",
        body: "Processing follow-up message...",
      }),
      true
    );
  });

  it("emits plan revision thought for plan mode", async () => {
    (lookupIssueSession as any).mockResolvedValue({
      sessionId: "sess-1",
      issueId: "issue-1",
      mode: "plan",
    });

    const webhook = {
      action: "prompted",
      organizationId: "org-1",
      appUserId: "user-1",
      agentSession: {
        id: "as-1",
        issue: baseIssue,
        comment: { body: "Revise" },
      },
    } as any;

    await handleAgentSessionEvent(webhook, env, "trace-1");

    expect(emitAgentActivity).toHaveBeenCalledWith(
      expect.anything(),
      "as-1",
      expect.objectContaining({
        type: "thought",
        body: "Processing feedback to revise the plan...",
      }),
      true
    );
  });

  it("returns early when no OAuth token", async () => {
    (getLinearClient as any).mockResolvedValue(null);
    (lookupIssueSession as any).mockResolvedValue({
      sessionId: "sess-1",
      issueId: "issue-1",
      mode: "apply",
    });

    const webhook = {
      action: "prompted",
      organizationId: "org-1",
      agentSession: {
        id: "as-1",
        issue: baseIssue,
        comment: { body: "Fix it" },
      },
    } as any;

    await handleAgentSessionEvent(webhook, env, "trace-1");

    expect(env.CONTROL_PLANE.fetch).not.toHaveBeenCalled();
  });

  it("returns early when no existing session", async () => {
    (lookupIssueSession as any).mockResolvedValue(null);

    const webhook = {
      action: "prompted",
      organizationId: "org-1",
      agentSession: {
        id: "as-1",
        issue: baseIssue,
        comment: { body: "Fix it" },
      },
    } as any;

    await handleAgentSessionEvent(webhook, env, "trace-1");

    // With no existing session and action=prompted, it should skip
    // (the dispatcher skips new session for "prompted" action)
    expect(env.CONTROL_PLANE.fetch).not.toHaveBeenCalled();
  });

  it("uses default follow-up content when no comment", async () => {
    (lookupIssueSession as any).mockResolvedValue({
      sessionId: "sess-1",
      issueId: "issue-1",
      mode: "apply",
    });

    env.CONTROL_PLANE.fetch.mockImplementation(async (url: string) => {
      if (url.includes("/events")) {
        return { ok: true, json: async () => ({ events: [] }) };
      }
      if (url.includes("/prompt")) {
        return { ok: true };
      }
      return { ok: true };
    });

    const webhook = {
      action: "prompted",
      organizationId: "org-1",
      appUserId: "user-1",
      agentSession: {
        id: "as-1",
        issue: baseIssue,
        // No comment
      },
    } as any;

    await handleAgentSessionEvent(webhook, env, "trace-1");

    const promptCall = env.CONTROL_PLANE.fetch.mock.calls.find(([url]: [string]) =>
      url.includes("/prompt")
    );
    expect(promptCall).toBeDefined();
    const promptBody = JSON.parse(promptCall[1].body);
    expect(promptBody.content).toContain("Follow-up on the issue.");
  });

  it("emits error activity when prompt fails", async () => {
    (lookupIssueSession as any).mockResolvedValue({
      sessionId: "sess-1",
      issueId: "issue-1",
      mode: "apply",
    });

    env.CONTROL_PLANE.fetch.mockImplementation(async (url: string) => {
      if (url.includes("/events")) {
        return { ok: true, json: async () => ({ events: [] }) };
      }
      if (url.includes("/prompt")) {
        return { ok: false, status: 500 };
      }
      return { ok: true };
    });

    const webhook = {
      action: "prompted",
      organizationId: "org-1",
      appUserId: "user-1",
      agentSession: {
        id: "as-1",
        issue: baseIssue,
        comment: { body: "Fix it" },
      },
    } as any;

    await handleAgentSessionEvent(webhook, env, "trace-1");

    expect(emitAgentActivity).toHaveBeenCalledWith(
      expect.anything(),
      "as-1",
      expect.objectContaining({
        type: "error",
        body: "Failed to send follow-up to the existing session.",
      })
    );
  });

  it("includes session context from previous events", async () => {
    (lookupIssueSession as any).mockResolvedValue({
      sessionId: "sess-1",
      issueId: "issue-1",
      mode: "apply",
    });

    env.CONTROL_PLANE.fetch.mockImplementation(async (url: string) => {
      if (url.includes("/events")) {
        return {
          ok: true,
          json: async () => ({
            events: [{ type: "token", data: { content: "Previous agent output" } }],
          }),
        };
      }
      if (url.includes("/prompt")) {
        return { ok: true };
      }
      return { ok: true };
    });

    const webhook = {
      action: "prompted",
      organizationId: "org-1",
      appUserId: "user-1",
      agentSession: {
        id: "as-1",
        issue: baseIssue,
        comment: { body: "Continue" },
      },
    } as any;

    await handleAgentSessionEvent(webhook, env, "trace-1");

    const promptCall = env.CONTROL_PLANE.fetch.mock.calls.find(([url]: [string]) =>
      url.includes("/prompt")
    );
    expect(promptCall).toBeDefined();
    const promptBody = JSON.parse(promptCall[1].body);
    expect(promptBody.content).toContain("Previous agent output");
  });
});

describe("handleAgentSessionEvent dispatcher", () => {
  let env: ReturnType<typeof makeEnv>;

  beforeEach(() => {
    vi.clearAllMocks();
    env = makeEnv();
    (lookupIssueSession as any).mockResolvedValue(null);
  });

  it("dispatches to stop handler for stopped action", async () => {
    (lookupIssueSession as any).mockResolvedValue({
      sessionId: "sess-1",
      issueId: "issue-1",
    });

    const webhook = {
      action: "stopped",
      organizationId: "org-1",
      agentSession: { id: "as-1", issue: baseIssue },
    } as any;

    await handleAgentSessionEvent(webhook, env, "trace-1");

    // Should have called stop endpoint
    expect(env.CONTROL_PLANE.fetch).toHaveBeenCalledWith(
      expect.stringContaining("/stop"),
      expect.any(Object)
    );
  });

  it("warns and returns when no issue is present (non-stop action)", async () => {
    const webhook = {
      action: "created",
      organizationId: "org-1",
      agentSession: { id: "as-1" },
    } as any;

    // Should not throw
    await expect(handleAgentSessionEvent(webhook, env, "trace-1")).resolves.toBeUndefined();
  });

  it("skips prompted action with no existing session (race condition)", async () => {
    (lookupIssueSession as any).mockResolvedValue(null);

    const webhook = {
      action: "prompted",
      organizationId: "org-1",
      agentSession: {
        id: "as-1",
        issue: baseIssue,
        comment: { body: "hello" },
      },
    } as any;

    await handleAgentSessionEvent(webhook, env, "trace-1");

    // Should not create a new session
    expect(env.CONTROL_PLANE.fetch).not.toHaveBeenCalledWith(
      "https://internal/sessions",
      expect.anything()
    );
  });
});
