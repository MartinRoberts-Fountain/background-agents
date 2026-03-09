/**
 * Diagnostic tests for Linear bot failure scenarios.
 */

import { describe, expect, it, vi, beforeEach } from "vitest";
import { app } from "./index";
import { computeHmacHex } from "./utils/crypto";
import { postIssueComment } from "./utils/linear-client";

vi.mock("./kv-store", () => ({
  lookupIssueSession: vi.fn(() => Promise.resolve(null)),
  storeIssueSession: vi.fn(() => Promise.resolve()),
  getProjectRepoMapping: vi.fn(() => ({})),
  getTeamRepoMapping: vi.fn(() => ({})),
  getUserPreferences: vi.fn(() => ({})),
  getTriggerConfig: vi.fn(() => ({ triggerLabel: "", autoTriggerOnCreate: false })),
  isDuplicateEvent: vi.fn(() => Promise.resolve(false)),
}));

vi.mock("./utils/linear-client", async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return {
    ...actual,
    getLinearClient: vi.fn((env, orgId) => {
      if (orgId === "no-token-org") return Promise.resolve(null);
      return Promise.resolve({ accessToken: "test-token" });
    }),
    emitAgentActivity: vi.fn(() => Promise.resolve()),
    fetchIssueDetails: vi.fn(() =>
      Promise.resolve({
        id: "issue-1",
        identifier: "ENG-1",
        title: "Test issue",
        url: "https://linear.app/issue/ENG-1",
        state: { name: "Todo" },
        labels: [],
        comments: [],
        team: { id: "team-1", key: "ENG", name: "Engineering" },
      })
    ),
    updateAgentSession: vi.fn(() => Promise.resolve()),
    getRepoSuggestions: vi.fn(() => Promise.resolve([])),
    postIssueComment: vi.fn((apiKey, issueId, body) => {
      console.log(`MOCK postIssueComment called: ${issueId}, ${body.slice(0, 20)}...`);
      return Promise.resolve({ success: true });
    }),
  };
});

vi.mock("./utils/integration-config", () => ({
  getLinearConfig: vi.fn(() =>
    Promise.resolve({
      enabledRepos: null,
      model: null,
      reasoningEffort: null,
      allowUserPreferenceOverride: true,
      allowLabelModelOverride: true,
      emitToolProgressActivities: true,
    })
  ),
}));

vi.mock("./classifier", () => ({
  classifyRepo: vi.fn(() =>
    Promise.resolve({
      repo: { owner: "org", name: "repo", fullName: "org/repo" },
      confidence: 1,
      reasoning: "LLM classification",
      needsClarification: false,
      alternatives: [],
    })
  ),
}));

vi.mock("./classifier/repos", () => ({
  getAvailableRepos: vi.fn(() => Promise.resolve([])),
}));

const WEBHOOK_SECRET = "test-webhook-secret";

function buildAgentSessionEventPayload(overrides: Record<string, unknown> = {}) {
  return {
    type: "AgentSessionEvent",
    action: "created",
    organizationId: "org-1",
    appUserId: "user-1",
    agentSession: {
      id: "agent-session-1",
      issue: {
        id: "issue-1",
        identifier: "ENG-1",
        title: "Test issue",
        description: "Do something",
        url: "https://linear.app/issue/ENG-1",
        priority: 0,
        priorityLabel: "None",
        team: { id: "team-1", key: "ENG", name: "Engineering" },
      },
    },
    ...overrides,
  };
}

describe("Linear Bot Diagnostics", () => {
  let controlPlaneFetch: ReturnType<typeof vi.fn>;
  let waitUntilPromises: Promise<void>[] = [];

  beforeEach(() => {
    vi.clearAllMocks();
    waitUntilPromises = [];
    controlPlaneFetch = vi.fn(async (url: string, init?: RequestInit) => {
      if (url === "https://internal/sessions" && init?.method === "POST") {
        return new Response(JSON.stringify({ sessionId: "sess-123" }), { status: 201 });
      }
      return new Response(JSON.stringify({ error: "Not found" }), { status: 404 });
    });
  });

  function createEnv(overrides: Record<string, unknown> = {}) {
    return {
      LINEAR_KV: {} as KVNamespace,
      CONTROL_PLANE: { fetch: controlPlaneFetch } as unknown as Fetcher,
      DEPLOYMENT_NAME: "test",
      CONTROL_PLANE_URL: "https://control.test",
      WEB_APP_URL: "https://web.test",
      DEFAULT_MODEL: "claude-sonnet-4-6",
      LINEAR_CLIENT_ID: "client-id",
      LINEAR_CLIENT_SECRET: "secret",
      WORKER_URL: "https://linear-bot.test",
      LINEAR_WEBHOOK_SECRET: WEBHOOK_SECRET,
      INTERNAL_CALLBACK_SECRET: "internal-secret",
      LINEAR_API_KEY: "test-api-key",
      ...overrides,
    };
  }

  function executionCtx(): ExecutionContext {
    return {
      waitUntil: (p: Promise<unknown>) => {
        waitUntilPromises.push(p as Promise<void>);
      },
      passThroughOnException: () => {},
      props: {},
    } as unknown as ExecutionContext;
  }

  it("posts a fallback comment when OAuth token is missing", async () => {
    const payload = buildAgentSessionEventPayload({ organizationId: "no-token-org" });
    const body = JSON.stringify(payload);
    const signature = await computeHmacHex(body, WEBHOOK_SECRET);

    const res = await app.fetch(
      new Request("https://test/webhook", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "linear-signature": signature,
        },
        body,
      }),
      createEnv(),
      executionCtx()
    );

    expect(res.status).toBe(200);
    await Promise.all(waitUntilPromises);

    expect(postIssueComment).toHaveBeenCalledWith(
      "test-api-key",
      "issue-1",
      expect.stringContaining("Failed to initialize Linear client")
    );
  });

  it("posts a fallback comment when control plane returns 401 and activity emission fails", async () => {
    controlPlaneFetch.mockResolvedValue(new Response("Unauthorized", { status: 401 }));
    const { emitAgentActivity } = await import("./utils/linear-client");
    // Mock successful calls for the early emissions, then fail for the one we're testing
    vi.mocked(emitAgentActivity)
      .mockResolvedValueOnce(undefined) // thought: Analyzing...
      .mockResolvedValueOnce(undefined) // thought: Classifying... (if it reaches)
      .mockResolvedValueOnce(undefined) // thought: Creating session...
      .mockRejectedValueOnce(new Error("Linear API error")); // The error one

    const payload = buildAgentSessionEventPayload();
    const body = JSON.stringify(payload);
    const signature = await computeHmacHex(body, WEBHOOK_SECRET);

    const res = await app.fetch(
      new Request("https://test/webhook", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "linear-signature": signature,
        },
        body,
      }),
      createEnv(),
      executionCtx()
    );

    expect(res.status).toBe(200);
    await Promise.all(waitUntilPromises);

    expect(postIssueComment).toHaveBeenCalledWith(
      "test-api-key",
      "issue-1",
      expect.stringContaining("Failed to create a coding session")
    );
    expect(postIssueComment).toHaveBeenCalledWith(
      "test-api-key",
      "issue-1",
      expect.stringContaining("HTTP 401")
    );
  });

  it("posts a fallback comment when control plane returns 500 and activity emission fails", async () => {
    controlPlaneFetch.mockResolvedValue(new Response("Internal Server Error", { status: 500 }));
    const { emitAgentActivity } = await import("./utils/linear-client");
    vi.mocked(emitAgentActivity)
      .mockResolvedValueOnce(undefined) // thought: Analyzing...
      .mockResolvedValueOnce(undefined) // thought: Classifying...
      .mockResolvedValueOnce(undefined) // thought: Creating session...
      .mockRejectedValueOnce(new Error("Linear API error")); // The error one

    const payload = buildAgentSessionEventPayload();
    const body = JSON.stringify(payload);
    const signature = await computeHmacHex(body, WEBHOOK_SECRET);

    const res = await app.fetch(
      new Request("https://test/webhook", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "linear-signature": signature,
        },
        body,
      }),
      createEnv(),
      executionCtx()
    );

    expect(res.status).toBe(200);
    await Promise.all(waitUntilPromises);

    expect(postIssueComment).toHaveBeenCalledWith(
      "test-api-key",
      "issue-1",
      expect.stringContaining("Failed to create a coding session")
    );
    expect(postIssueComment).toHaveBeenCalledWith(
      "test-api-key",
      "issue-1",
      expect.stringContaining("HTTP 500")
    );
  });
});
