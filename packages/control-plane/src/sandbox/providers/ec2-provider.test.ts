import { afterEach, describe, expect, it, vi } from "vitest";
import { EC2ApiClient, createEC2Provider, type EC2ApiConfig } from "./ec2-provider";

vi.mock("@open-inspect/shared", () => ({
  generateInternalToken: vi.fn(async () => "test-token"),
}));

const baseConfig: EC2ApiConfig = {
  apiUrl: "https://ec2-deployer.internal",
  apiSecret: "secret",
};

function stubFetch(response: Response | (() => Response)) {
  const mock = vi.fn(async () => (typeof response === "function" ? response() : response));
  vi.stubGlobal("fetch", mock);
  return mock;
}

describe("EC2ApiClient", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("throws if apiUrl is missing", () => {
    expect(() => new EC2ApiClient({ apiUrl: "", apiSecret: "s" })).toThrow(
      "EC2ApiClient requires apiUrl"
    );
  });

  it("throws if apiSecret is missing", () => {
    expect(() => new EC2ApiClient({ apiUrl: "https://api", apiSecret: "" })).toThrow(
      "EC2ApiClient requires apiSecret"
    );
  });

  it("sends deploy request with auth headers", async () => {
    const fetchMock = stubFetch(
      new Response(
        JSON.stringify({
          success: true,
          sandboxId: "sb-1",
          providerObjectId: "i-abc123",
          status: "running",
          createdAt: 1000,
        })
      )
    );

    const client = new EC2ApiClient(baseConfig);
    const result = await client.deploy({
      sandboxId: "sb-1",
      sessionId: "sess-1",
      repoOwner: "owner",
      repoName: "repo",
      controlPlaneUrl: "https://cp",
      sandboxAuthToken: "tok",
      provider: "anthropic",
      model: "anthropic/claude-sonnet-4-5",
    });

    expect(result.success).toBe(true);
    expect(result.providerObjectId).toBe("i-abc123");
    expect(fetchMock).toHaveBeenCalledWith(
      "https://ec2-deployer.internal/deploy",
      expect.objectContaining({
        method: "POST",
        headers: expect.objectContaining({ Authorization: "Bearer test-token" }),
      })
    );
  });

  it("throws on non-ok deploy response", async () => {
    stubFetch(new Response("bad request", { status: 400 }));
    const client = new EC2ApiClient(baseConfig);

    await expect(
      client.deploy({
        sandboxId: "sb-1",
        sessionId: "sess-1",
        repoOwner: "owner",
        repoName: "repo",
        controlPlaneUrl: "https://cp",
        sandboxAuthToken: "tok",
        provider: "anthropic",
        model: "anthropic/claude-sonnet-4-5",
      })
    ).rejects.toThrow("EC2 deployer error: 400");
  });

  it("sends stop request", async () => {
    const fetchMock = stubFetch(new Response(JSON.stringify({ success: true })));
    const client = new EC2ApiClient(baseConfig);

    const result = await client.stop("i-abc123");

    expect(result.success).toBe(true);
    expect(fetchMock).toHaveBeenCalledWith(
      "https://ec2-deployer.internal/stop",
      expect.objectContaining({ method: "POST" })
    );
  });

  it("throws on non-ok stop response", async () => {
    stubFetch(new Response("server error", { status: 500 }));
    const client = new EC2ApiClient(baseConfig);

    await expect(client.stop("i-abc123")).rejects.toThrow("EC2 deployer error: 500");
  });

  it("sends start request", async () => {
    const fetchMock = stubFetch(new Response(JSON.stringify({ success: true })));
    const client = new EC2ApiClient(baseConfig);

    const result = await client.start("i-abc123");

    expect(result.success).toBe(true);
    expect(fetchMock).toHaveBeenCalledWith(
      "https://ec2-deployer.internal/start",
      expect.objectContaining({ method: "POST" })
    );
  });

  it("throws on non-ok start response", async () => {
    stubFetch(new Response("not found", { status: 404 }));
    const client = new EC2ApiClient(baseConfig);

    await expect(client.start("i-abc123")).rejects.toThrow("EC2 deployer error: 404");
  });
});

describe("EC2SandboxProvider", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("has correct name and capabilities", () => {
    const provider = createEC2Provider(baseConfig);
    expect(provider.name).toBe("ec2");
    expect(provider.capabilities).toEqual({
      supportsSnapshots: false,
      supportsRestore: false,
      supportsWarm: false,
    });
  });

  it("creates sandbox successfully", async () => {
    stubFetch(
      new Response(
        JSON.stringify({
          success: true,
          sandboxId: "sb-1",
          providerObjectId: "i-abc123",
          status: "running",
          createdAt: 1000,
        })
      )
    );

    const provider = createEC2Provider(baseConfig);
    const result = await provider.createSandbox({
      sandboxId: "sb-1",
      sessionId: "sess-1",
      repoOwner: "owner",
      repoName: "repo",
      controlPlaneUrl: "https://cp",
      sandboxAuthToken: "tok",
      provider: "anthropic",
      model: "anthropic/claude-sonnet-4-5",
    });

    expect(result.sandboxId).toBe("sb-1");
    expect(result.providerObjectId).toBe("i-abc123");
    expect(result.status).toBe("running");
    expect(result.createdAt).toBe(1000);
  });

  it("throws SandboxProviderError when deploy returns success: false", async () => {
    stubFetch(
      new Response(
        JSON.stringify({
          success: false,
          sandboxId: "sb-1",
          providerObjectId: "",
          status: "failed",
          createdAt: 1000,
          error: "Instance limit reached",
        })
      )
    );

    const provider = createEC2Provider(baseConfig);

    await expect(
      provider.createSandbox({
        sandboxId: "sb-1",
        sessionId: "sess-1",
        repoOwner: "owner",
        repoName: "repo",
        controlPlaneUrl: "https://cp",
        sandboxAuthToken: "tok",
        provider: "anthropic",
        model: "anthropic/claude-sonnet-4-5",
      })
    ).rejects.toMatchObject({
      name: "SandboxProviderError",
      errorType: "permanent",
    });
  });

  it("classifies 401 errors as permanent", async () => {
    stubFetch(new Response(JSON.stringify({ error: "unauthorized" }), { status: 401 }));

    const provider = createEC2Provider(baseConfig);

    await expect(
      provider.createSandbox({
        sandboxId: "sb-1",
        sessionId: "sess-1",
        repoOwner: "owner",
        repoName: "repo",
        controlPlaneUrl: "https://cp",
        sandboxAuthToken: "tok",
        provider: "anthropic",
        model: "anthropic/claude-sonnet-4-5",
      })
    ).rejects.toMatchObject({
      name: "SandboxProviderError",
      errorType: "permanent",
    });
  });

  it("classifies 502 errors as transient", async () => {
    stubFetch(new Response("bad gateway", { status: 502 }));

    const provider = createEC2Provider(baseConfig);

    await expect(
      provider.createSandbox({
        sandboxId: "sb-1",
        sessionId: "sess-1",
        repoOwner: "owner",
        repoName: "repo",
        controlPlaneUrl: "https://cp",
        sandboxAuthToken: "tok",
        provider: "anthropic",
        model: "anthropic/claude-sonnet-4-5",
      })
    ).rejects.toMatchObject({
      name: "SandboxProviderError",
      errorType: "transient",
    });
  });

  it("classifies timeout errors as transient", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("fetch failed: ETIMEDOUT");
      })
    );

    const provider = createEC2Provider(baseConfig);

    await expect(
      provider.createSandbox({
        sandboxId: "sb-1",
        sessionId: "sess-1",
        repoOwner: "owner",
        repoName: "repo",
        controlPlaneUrl: "https://cp",
        sandboxAuthToken: "tok",
        provider: "anthropic",
        model: "anthropic/claude-sonnet-4-5",
      })
    ).rejects.toMatchObject({
      name: "SandboxProviderError",
      errorType: "transient",
    });
  });

  it("stopSandbox delegates to client.stop", async () => {
    stubFetch(new Response(JSON.stringify({ success: true })));
    const provider = createEC2Provider(baseConfig);

    await expect(provider.stopSandbox("i-abc123")).resolves.toBeUndefined();
  });

  it("stopSandbox throws when client returns success: false", async () => {
    stubFetch(new Response(JSON.stringify({ success: false })));
    const provider = createEC2Provider(baseConfig);

    await expect(provider.stopSandbox("i-abc123")).rejects.toThrow("Failed to stop EC2 instance");
  });

  it("startSandbox delegates to client.start", async () => {
    stubFetch(new Response(JSON.stringify({ success: true })));
    const provider = createEC2Provider(baseConfig);

    await expect(provider.startSandbox("i-abc123")).resolves.toBeUndefined();
  });

  it("startSandbox throws when client returns success: false", async () => {
    stubFetch(new Response(JSON.stringify({ success: false })));
    const provider = createEC2Provider(baseConfig);

    await expect(provider.startSandbox("i-abc123")).rejects.toThrow("Failed to start EC2 instance");
  });

  it("uses DEFAULT_SANDBOX_TIMEOUT_SECONDS when not provided", async () => {
    const fetchMock = stubFetch(
      new Response(
        JSON.stringify({
          success: true,
          sandboxId: "sb-1",
          providerObjectId: "i-abc123",
          status: "running",
          createdAt: 1000,
        })
      )
    );

    const provider = createEC2Provider(baseConfig);
    await provider.createSandbox({
      sandboxId: "sb-1",
      sessionId: "sess-1",
      repoOwner: "owner",
      repoName: "repo",
      controlPlaneUrl: "https://cp",
      sandboxAuthToken: "tok",
      provider: "anthropic",
      model: "anthropic/claude-sonnet-4-5",
    });

    const body = JSON.parse(fetchMock.mock.calls[0][1].body as string);
    expect(body.timeoutSeconds).toBe(7200);
  });
});
