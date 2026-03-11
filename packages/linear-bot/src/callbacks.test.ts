import { describe, expect, it, vi, beforeEach } from "vitest";
import { Hono } from "hono";
import { callbacksRouter } from "./callbacks";
import { removeIssueLabel, getLinearClient } from "./utils/linear-client";
import { extractAgentResponse } from "./completion/extractor";

vi.mock("./utils/linear-client", () => ({
  getLinearClient: vi.fn(),
  emitAgentActivity: vi.fn(),
  postIssueComment: vi.fn(),
  updateAgentSession: vi.fn(),
  removeIssueLabel: vi.fn(),
}));

vi.mock("./completion/extractor", () => ({
  extractAgentResponse: vi.fn(),
  formatAgentResponse: vi.fn((res) => res.textContent),
}));

vi.mock("./utils/crypto", () => ({
  computeHmacHex: vi.fn(() => "valid-signature"),
}));

describe("Completion Callback Label Removal", () => {
  const env = {
    INTERNAL_CALLBACK_SECRET: "secret",
    WEB_APP_URL: "https://web.app",
    LINEAR_API_KEY: "api-key",
  } as any;

  const mockExecutionCtx = {
    waitUntil: vi.fn((p) => p),
  };

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("removes the plan label when a session completes successfully", async () => {
    const payload = {
      sessionId: "sess-1",
      messageId: "msg-1",
      success: true,
      timestamp: Date.now(),
      signature: "valid-signature",
      context: {
        source: "linear",
        issueId: "issue-123",
        issueIdentifier: "ENG-1",
        agentSessionId: "as-1",
        organizationId: "org-1",
      },
    };

    (getLinearClient as any).mockResolvedValue({ accessToken: "token" });
    (extractAgentResponse as any).mockResolvedValue({
      textContent: "Done",
      toolCalls: [],
      artifacts: [],
      success: true,
    });

    const app = new Hono();
    // Wrap the router to inject the execution context
    app.use("*", async (c, next) => {
      Object.defineProperty(c, "executionCtx", {
        value: mockExecutionCtx,
        writable: true,
      });
      await next();
    });
    app.route("/callbacks", callbacksRouter);

    const res = await app.request(
      "/callbacks/complete",
      {
        method: "POST",
        body: JSON.stringify(payload),
        headers: { "Content-Type": "application/json" },
      },
      env
    );

    expect(res.status).toBe(200);

    // handleCompletionCallback is called via waitUntil
    const promise = mockExecutionCtx.waitUntil.mock.results[0].value;
    await promise;

    expect(removeIssueLabel).toHaveBeenCalledWith(expect.anything(), "issue-123", "plan");
  });
});
