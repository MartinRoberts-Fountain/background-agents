import { describe, expect, it, vi, beforeEach } from "vitest";
import { escapeHtml, handleAgentSessionEvent, handleIssueStatusChange } from "./webhook-handler";
import { lookupIssueSession, storeIssueSession } from "./kv-store";
import { fetchIssueDetails } from "./utils/linear-client";

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
    reasoning: "LLM classification",
  })),
}));

vi.mock("./classifier/repos", () => ({
  getAvailableRepos: vi.fn(() => []),
}));

describe("escapeHtml", () => {
  it("escapes & to &amp;", () => {
    expect(escapeHtml("a&b")).toBe("a&amp;b");
  });

  it("escapes < to &lt;", () => {
    expect(escapeHtml("a<b")).toBe("a&lt;b");
  });

  it("escapes > to &gt;", () => {
    expect(escapeHtml("a>b")).toBe("a&gt;b");
  });

  it('escapes " to &quot;', () => {
    expect(escapeHtml('a"b')).toBe("a&quot;b");
  });

  it("returns safe strings unchanged", () => {
    expect(escapeHtml("hello world 123")).toBe("hello world 123");
  });

  it("returns empty string for empty input", () => {
    expect(escapeHtml("")).toBe("");
  });

  it("escapes multiple special chars in one string", () => {
    expect(escapeHtml('<div class="x">&</div>')).toBe(
      "&lt;div class=&quot;x&quot;&gt;&amp;&lt;/div&gt;"
    );
  });

  it("does not escape single quotes", () => {
    expect(escapeHtml("it's")).toBe("it's");
  });

  it("does not double-escape & in existing entities", () => {
    expect(escapeHtml("&lt;")).toBe("&amp;lt;");
  });
});

describe("Sandbox Selection Logic", () => {
  const env = {
    LINEAR_KV: {
      get: vi.fn(),
      put: vi.fn(),
      delete: vi.fn(),
    },
    CONTROL_PLANE: {
      fetch: vi.fn(async () => ({
        ok: true,
        json: async () => ({ sessionId: "sess-123" }),
      })),
    },
    LINEAR_CLIENT_ID: "client-id",
    LINEAR_CLIENT_SECRET: "client-secret",
    WORKER_URL: "https://worker.url",
    WEB_APP_URL: "https://web.app",
    DEFAULT_MODEL: "claude-sonnet-4-5",
    LINEAR_WEBHOOK_SECRET: "webhook-secret",
  } as any;

  beforeEach(() => {
    vi.clearAllMocks();
    (lookupIssueSession as any).mockResolvedValue(null);
  });

  it("selects helm and plan mode for triage status", async () => {
    const webhook = {
      action: "created",
      organizationId: "org-1",
      agentSession: {
        id: "as-1",
        issue: { id: "issue-1", identifier: "ENG-1", title: "Test issue", team: { id: "team-1" } },
      },
    } as any;

    (fetchIssueDetails as any).mockResolvedValue({
      id: "issue-1",
      identifier: "ENG-1",
      title: "Test issue",
      url: "https://linear.app/issue/ENG-1",
      state: { name: "Triage" },
      labels: [],
      comments: [],
      team: { id: "team-1" },
    });

    await handleAgentSessionEvent(webhook, env, "trace-1");

    expect(env.CONTROL_PLANE.fetch).toHaveBeenCalledWith(
      "https://internal/sessions",
      expect.objectContaining({
        body: expect.stringContaining('"sandboxProvider":"helm"'),
      })
    );
  });

  it("selects helm and plan mode for backlog status", async () => {
    const webhook = {
      action: "created",
      organizationId: "org-1",
      agentSession: {
        id: "as-1",
        issue: { id: "issue-1", identifier: "ENG-1", title: "Test issue", team: { id: "team-1" } },
      },
    } as any;

    (fetchIssueDetails as any).mockResolvedValue({
      id: "issue-1",
      identifier: "ENG-1",
      title: "Test issue",
      url: "https://linear.app/issue/ENG-1",
      state: { name: "Backlog" },
      labels: [],
      comments: [],
      team: { id: "team-1" },
    });

    await handleAgentSessionEvent(webhook, env, "trace-1");

    expect(env.CONTROL_PLANE.fetch).toHaveBeenCalledWith(
      "https://internal/sessions",
      expect.objectContaining({
        body: expect.stringContaining('"sandboxProvider":"helm"'),
      })
    );
  });

  it("selects ec2 and apply mode for other statuses (e.g., Todo)", async () => {
    const webhook = {
      action: "created",
      organizationId: "org-1",
      agentSession: {
        id: "as-1",
        issue: { id: "issue-1", identifier: "ENG-1", title: "Test issue", team: { id: "team-1" } },
      },
    } as any;

    (fetchIssueDetails as any).mockResolvedValue({
      id: "issue-1",
      identifier: "ENG-1",
      title: "Test issue",
      url: "https://linear.app/issue/ENG-1",
      state: { name: "Todo" },
      labels: [],
      comments: [],
      team: { id: "team-1" },
    });

    await handleAgentSessionEvent(webhook, env, "trace-1");

    expect(env.CONTROL_PLANE.fetch).toHaveBeenCalledWith(
      "https://internal/sessions",
      expect.objectContaining({
        body: expect.stringContaining('"sandboxProvider":"ec2"'),
      })
    );
  });

  it("skips new session when action is not created (e.g. prompted with no existing session)", async () => {
    const webhook = {
      action: "prompted",
      organizationId: "org-1",
      agentSession: {
        id: "as-1",
        issue: { id: "issue-1", identifier: "ENG-1", title: "Test issue", team: { id: "team-1" } },
      },
    } as any;

    await handleAgentSessionEvent(webhook, env, "trace-1");

    expect(env.CONTROL_PLANE.fetch).not.toHaveBeenCalledWith(
      "https://internal/sessions",
      expect.anything()
    );
  });

  it("skips new session when initial content is bot-originated", async () => {
    const webhook = {
      action: "created",
      organizationId: "org-1",
      agentSession: {
        id: "as-1",
        issue: { id: "issue-1", identifier: "ENG-1", title: "Test issue", team: { id: "team-1" } },
        comment: undefined,
      },
      agentActivity: { body: "Analyzing issue and resolving repository..." },
    } as any;

    await handleAgentSessionEvent(webhook, env, "trace-1");

    expect(env.CONTROL_PLANE.fetch).not.toHaveBeenCalledWith(
      "https://internal/sessions",
      expect.anything()
    );
  });
});

describe("Follow-up bot content skip", () => {
  const env = {
    LINEAR_KV: { get: vi.fn(), put: vi.fn(), delete: vi.fn() },
    CONTROL_PLANE: { fetch: vi.fn() },
    LINEAR_CLIENT_ID: "client-id",
    LINEAR_CLIENT_SECRET: "client-secret",
    WORKER_URL: "https://worker.url",
    WEB_APP_URL: "https://web.app",
    DEFAULT_MODEL: "claude-sonnet-4-5",
    LINEAR_WEBHOOK_SECRET: "webhook-secret",
  } as any;

  beforeEach(() => {
    vi.clearAllMocks();
    (lookupIssueSession as any).mockResolvedValue({
      sessionId: "sess-1",
      issueId: "issue-1",
      mode: "apply",
    });
  });

  it("skips follow-up when agentActivity body is bot-originated", async () => {
    const webhook = {
      action: "prompted",
      organizationId: "org-1",
      appUserId: "user-1",
      agentSession: {
        id: "as-1",
        issue: { id: "issue-1", identifier: "ENG-1", title: "Test", team: { id: "t1" } },
      },
      agentActivity: { body: "Processing follow-up message..." },
    } as any;

    await handleAgentSessionEvent(webhook, env, "trace-1");

    expect(env.CONTROL_PLANE.fetch).not.toHaveBeenCalled();
  });
});

describe("Issue Status Change → Apply Trigger", () => {
  const env = {
    LINEAR_KV: {
      get: vi.fn(),
      put: vi.fn(),
      delete: vi.fn(),
    },
    CONTROL_PLANE: {
      fetch: vi.fn(),
    },
    LINEAR_CLIENT_ID: "client-id",
    LINEAR_CLIENT_SECRET: "client-secret",
    WORKER_URL: "https://worker.url",
    WEB_APP_URL: "https://web.app",
    DEFAULT_MODEL: "claude-sonnet-4-5",
    LINEAR_WEBHOOK_SECRET: "webhook-secret",
  } as any;

  const baseIssueUpdateWebhook = {
    type: "Issue" as const,
    action: "update" as const,
    organizationId: "org-1",
    data: {
      id: "issue-1",
      identifier: "ENG-1",
      title: "Test issue",
      url: "https://linear.app/issue/ENG-1",
      priority: 1,
      priorityLabel: "Urgent",
      state: { id: "state-todo", name: "Todo", type: "started" },
      teamId: "team-1",
      team: { id: "team-1", key: "ENG", name: "Engineering" },
    },
    updatedFrom: { stateId: "state-backlog" },
  };

  beforeEach(() => {
    vi.clearAllMocks();
    (lookupIssueSession as any).mockResolvedValue(null);
    env.CONTROL_PLANE.fetch.mockImplementation(async (url: string) => {
      if (url === "https://internal/sessions") {
        return { ok: true, json: async () => ({ sessionId: "sess-apply-1" }) };
      }
      if (url.includes("/prompt")) {
        return { ok: true };
      }
      if (url.includes("/stop")) {
        return { ok: true };
      }
      if (url.includes("/integration-settings")) {
        return {
          ok: true,
          json: async () => ({
            config: {
              model: null,
              reasoningEffort: null,
              allowUserPreferenceOverride: true,
              allowLabelModelOverride: true,
              emitToolProgressActivities: true,
              enabledRepos: null,
            },
          }),
        };
      }
      return { ok: true };
    });
  });

  it("triggers apply session when status changes to Todo with existing plan session", async () => {
    (lookupIssueSession as any).mockResolvedValue({
      sessionId: "sess-plan-1",
      issueId: "issue-1",
      issueIdentifier: "ENG-1",
      repoOwner: "org",
      repoName: "repo",
      model: "claude-sonnet-4-5",
      agentSessionId: "as-1",
      mode: "plan",
      createdAt: Date.now(),
    });

    (fetchIssueDetails as any).mockResolvedValue({
      id: "issue-1",
      identifier: "ENG-1",
      title: "Test issue",
      url: "https://linear.app/issue/ENG-1",
      state: { name: "Todo" },
      labels: [],
      comments: [],
      team: { id: "team-1", key: "ENG", name: "Engineering" },
    });

    await handleIssueStatusChange(baseIssueUpdateWebhook, env, "trace-1");

    // Should create a new session in apply mode
    expect(env.CONTROL_PLANE.fetch).toHaveBeenCalledWith(
      "https://internal/sessions",
      expect.objectContaining({
        body: expect.stringContaining('"mode":"apply"'),
      })
    );

    // Should use ec2 sandbox
    expect(env.CONTROL_PLANE.fetch).toHaveBeenCalledWith(
      "https://internal/sessions",
      expect.objectContaining({
        body: expect.stringContaining('"sandboxProvider":"ec2"'),
      })
    );

    // Should store the new session
    expect(storeIssueSession).toHaveBeenCalledWith(
      env,
      "issue-1",
      expect.objectContaining({
        sessionId: "sess-apply-1",
        mode: "apply",
      })
    );

    // Should send prompt to the new session
    expect(env.CONTROL_PLANE.fetch).toHaveBeenCalledWith(
      "https://internal/sessions/sess-apply-1/prompt",
      expect.objectContaining({
        body: expect.stringContaining("APPLY mode"),
      })
    );

    // Should stop the old plan session
    expect(env.CONTROL_PLANE.fetch).toHaveBeenCalledWith(
      "https://internal/sessions/sess-plan-1/stop",
      expect.objectContaining({ method: "POST" })
    );
  });

  it("skips when status changes to non-Todo state", async () => {
    const webhook = {
      ...baseIssueUpdateWebhook,
      data: {
        ...baseIssueUpdateWebhook.data,
        state: { id: "state-ip", name: "In Progress", type: "started" },
      },
    };

    await handleIssueStatusChange(webhook, env, "trace-1");

    expect(env.CONTROL_PLANE.fetch).not.toHaveBeenCalledWith(
      "https://internal/sessions",
      expect.anything()
    );
  });

  it("skips when no stateId in updatedFrom", async () => {
    const webhook = {
      ...baseIssueUpdateWebhook,
      updatedFrom: { title: "Old title" },
    };

    await handleIssueStatusChange(webhook, env, "trace-1");

    expect(env.CONTROL_PLANE.fetch).not.toHaveBeenCalledWith(
      "https://internal/sessions",
      expect.anything()
    );
  });

  it("skips when no existing plan session", async () => {
    (lookupIssueSession as any).mockResolvedValue(null);

    await handleIssueStatusChange(baseIssueUpdateWebhook, env, "trace-1");

    expect(env.CONTROL_PLANE.fetch).not.toHaveBeenCalledWith(
      "https://internal/sessions",
      expect.anything()
    );
  });

  it("skips when existing session is apply mode (not plan)", async () => {
    (lookupIssueSession as any).mockResolvedValue({
      sessionId: "sess-apply-old",
      issueId: "issue-1",
      mode: "apply",
      repoOwner: "org",
      repoName: "repo",
    });

    await handleIssueStatusChange(baseIssueUpdateWebhook, env, "trace-1");

    expect(env.CONTROL_PLANE.fetch).not.toHaveBeenCalledWith(
      "https://internal/sessions",
      expect.anything()
    );
  });

  it("handles 'To Do' with space as valid trigger status", async () => {
    const webhook = {
      ...baseIssueUpdateWebhook,
      data: {
        ...baseIssueUpdateWebhook.data,
        state: { id: "state-todo", name: "To Do", type: "started" },
      },
    };

    (lookupIssueSession as any).mockResolvedValue({
      sessionId: "sess-plan-1",
      issueId: "issue-1",
      issueIdentifier: "ENG-1",
      repoOwner: "org",
      repoName: "repo",
      model: "claude-sonnet-4-5",
      agentSessionId: "as-1",
      mode: "plan",
      createdAt: Date.now(),
    });

    (fetchIssueDetails as any).mockResolvedValue({
      id: "issue-1",
      identifier: "ENG-1",
      title: "Test issue",
      url: "https://linear.app/issue/ENG-1",
      state: { name: "To Do" },
      labels: [],
      comments: [],
      team: { id: "team-1", key: "ENG", name: "Engineering" },
    });

    await handleIssueStatusChange(webhook, env, "trace-1");

    expect(env.CONTROL_PLANE.fetch).toHaveBeenCalledWith(
      "https://internal/sessions",
      expect.objectContaining({
        body: expect.stringContaining('"mode":"apply"'),
      })
    );
  });
});
