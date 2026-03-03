import { afterEach, describe, expect, it, vi } from "vitest";
import { CoderApiClient, CoderSandboxProvider } from "./coder-provider";

describe("CoderApiClient", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  const config = {
    baseUrl: "https://coder.example.com",
    token: "test-token",
    organizationId: "org-123",
    templateId: "tpl-123",
  };

  it("normalizes baseUrl", () => {
    const client = new CoderApiClient({ ...config, baseUrl: "coder.example.com/" });
    // @ts-ignore - accessing private property for test
    expect(client.config.baseUrl).toBe("https://coder.example.com");
  });

  it("creates a workspace", async () => {
    const fetchMock = vi.fn(async () => {
      return new Response(
        JSON.stringify({
          id: "ws-123",
          name: "test-workspace",
          latest_build: { status: "running", job: { status: "running" } },
        }),
        { status: 201 }
      );
    });
    vi.stubGlobal("fetch", fetchMock);

    const client = new CoderApiClient(config);
    const result = await client.createWorkspace("test-workspace", [{ name: "foo", value: "bar" }]);

    expect(result.id).toBe("ws-123");
    expect(fetchMock).toHaveBeenCalledWith(
      "https://coder.example.com/api/v2/organizations/org-123/members/me/workspaces",
      expect.objectContaining({
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Coder-Session-Token": "test-token",
        },
        body: JSON.stringify({
          name: "test-workspace",
          template_id: "tpl-123",
          rich_parameter_values: [{ name: "foo", value: "bar" }],
        }),
      })
    );
  });

  it("deletes a workspace", async () => {
    const fetchMock = vi.fn(async () => {
      return new Response(null, { status: 204 });
    });
    vi.stubGlobal("fetch", fetchMock);

    const client = new CoderApiClient(config);
    await client.deleteWorkspace("ws-123");

    expect(fetchMock).toHaveBeenCalledWith(
      "https://coder.example.com/api/v2/workspaces/ws-123",
      expect.objectContaining({
        method: "DELETE",
        headers: {
          "Content-Type": "application/json",
          "Coder-Session-Token": "test-token",
        },
      })
    );
  });
});

describe("CoderSandboxProvider", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  const config = {
    baseUrl: "https://coder.example.com",
    token: "test-token",
    organizationId: "org-123",
    templateId: "tpl-123",
  };

  it("creates a sandbox via Coder workspace", async () => {
    const fetchMock = vi.fn(async () => {
      return new Response(
        JSON.stringify({
          id: "ws-123",
          name: "ws-sandbox-123",
          latest_build: { status: "running", job: { status: "running" } },
        }),
        { status: 201 }
      );
    });
    vi.stubGlobal("fetch", fetchMock);

    const client = new CoderApiClient(config);
    const provider = new CoderSandboxProvider(client);

    const result = await provider.createSandbox({
      sessionId: "session-123",
      sandboxId: "sandbox-123",
      repoOwner: "owner",
      repoName: "repo",
      controlPlaneUrl: "https://control-plane.example.com",
      sandboxAuthToken: "auth-token",
      provider: "anthropic",
      model: "claude-3-5-sonnet",
      userEnvVars: { "FOO": "BAR" },
    });

    expect(result.sandboxId).toBe("sandbox-123");
    expect(result.providerObjectId).toBe("ws-123");
    expect(result.status).toBe("spawning");

    expect(fetchMock).toHaveBeenCalledWith(
      expect.stringContaining("/workspaces"),
      expect.objectContaining({
        body: expect.stringContaining('"name":"ws-sandbox-123"'),
      })
    );

    const body = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(body.rich_parameter_values).toContainEqual({ name: "sandbox_id", value: "sandbox-123" });
    expect(body.rich_parameter_values).toContainEqual({ name: "env_FOO", value: "BAR" });
  });

  it("deletes a sandbox", async () => {
    const fetchMock = vi.fn(async () => {
      return new Response(null, { status: 204 });
    });
    vi.stubGlobal("fetch", fetchMock);

    const client = new CoderApiClient(config);
    const provider = new CoderSandboxProvider(client);

    await provider.deleteSandbox("ws-123");

    expect(fetchMock).toHaveBeenCalledWith(
      "https://coder.example.com/api/v2/workspaces/ws-123",
      expect.objectContaining({
        method: "DELETE",
      })
    );
  });

  it("classifies 401 as permanent error", async () => {
    const fetchMock = vi.fn(async () => {
      return new Response("Unauthorized", { status: 401 });
    });
    vi.stubGlobal("fetch", fetchMock);

    const client = new CoderApiClient(config);
    const provider = new CoderSandboxProvider(client);

    await expect(
      provider.createSandbox({
        sessionId: "session-123",
        sandboxId: "sandbox-123",
        repoOwner: "owner",
        repoName: "repo",
        controlPlaneUrl: "https://control-plane.example.com",
        sandboxAuthToken: "auth-token",
        provider: "anthropic",
        model: "claude-3-5-sonnet",
      })
    ).rejects.toMatchObject({
      name: "SandboxProviderError",
      errorType: "permanent",
      message: expect.stringContaining("Verify CODER_TOKEN"),
    });
  });
});
