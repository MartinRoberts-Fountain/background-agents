/**
 * Unit tests for RwxSandboxProvider.
 *
 * Tests dispatch param assembly, code-server password derivation,
 * SCM provider selection, and error classification for createSandbox.
 */

import { describe, it, expect, vi, afterEach } from "vitest";
import { computeHmacHex } from "@open-inspect/shared";
import { RwxSandboxProvider, type RwxProviderConfig } from "./rwx-provider";
import { SandboxProviderError } from "../provider";
import type { CreateSandboxConfig } from "../provider";
import {
  RwxApiError,
  type RwxRestClient,
  type RwxRestConfig,
  type RwxCreateDispatchParams,
  type RwxCreateDispatchResponse,
  type RwxGetDispatchResponse,
} from "../rwx-rest-client";

// ==================== Mock Factories ====================

const defaultRestConfig: RwxRestConfig = {
  apiToken: "test-rwx-token",
  dispatchKey: "open-inspect-sandbox",
};

function createMockClient(
  overrides: Partial<{
    createDispatch: (params: RwxCreateDispatchParams) => Promise<RwxCreateDispatchResponse>;
    getDispatch: (dispatchId: string) => Promise<RwxGetDispatchResponse>;
  }> = {},
  configOverrides: Partial<RwxRestConfig> = {}
): RwxRestClient {
  return {
    config: { ...defaultRestConfig, ...configOverrides },
    createDispatch: vi.fn(
      async (): Promise<RwxCreateDispatchResponse> => ({
        dispatch_id: "rwx-dispatch-id",
      })
    ),
    getDispatch: vi.fn(
      async (): Promise<RwxGetDispatchResponse> => ({
        status: "dispatched",
        runs: [{ run_id: "rwx-run-id", run_url: "https://cloud.rwx.com/mint/org/runs/1" }],
      })
    ),
    ...overrides,
  } as unknown as RwxRestClient;
}

const defaultProviderConfig: RwxProviderConfig = {
  scmProvider: "github",
  codeServerPasswordSecret: "test-secret-key",
};

const baseCreateConfig: CreateSandboxConfig = {
  sessionId: "session-123",
  sandboxId: "sandbox-456",
  repoOwner: "testowner",
  repoName: "testrepo",
  controlPlaneUrl: "https://control-plane.test",
  sandboxAuthToken: "auth-token-abc",
  provider: "anthropic",
  model: "anthropic/claude-sonnet-4-5",
};

// ==================== Tests ====================

describe("RwxSandboxProvider", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe("capabilities", () => {
    it("reports correct capabilities", () => {
      const provider = new RwxSandboxProvider(createMockClient(), defaultProviderConfig);
      expect(provider.name).toBe("rwx");
      expect(provider.capabilities).toEqual({
        supportsSnapshots: false,
        supportsRestore: false,
        supportsWarm: false,
        supportsPersistentResume: false,
        supportsExplicitStop: false,
      });
    });
  });

  describe("createSandbox", () => {
    it("happy path: dispatches with correct key and returns dispatch_id as providerObjectId", async () => {
      const client = createMockClient();
      const provider = new RwxSandboxProvider(client, defaultProviderConfig);

      const result = await provider.createSandbox(baseCreateConfig);

      expect(result.sandboxId).toBe("sandbox-456");
      expect(result.providerObjectId).toBe("rwx-dispatch-id");
      expect(result.status).toBe("warming");
      expect(result.createdAt).toBeGreaterThan(0);

      const createCall = (client.createDispatch as ReturnType<typeof vi.fn>).mock.calls[0][0];
      expect(createCall.key).toBe("open-inspect-sandbox");
      expect(createCall.title).toContain("session-123");
    });

    it("passes branch as ref when provided", async () => {
      const client = createMockClient();
      const provider = new RwxSandboxProvider(client, defaultProviderConfig);

      await provider.createSandbox({ ...baseCreateConfig, branch: "feature/test" });

      const createCall = (client.createDispatch as ReturnType<typeof vi.fn>).mock.calls[0][0];
      expect(createCall.ref).toBe("feature/test");
    });

    it("omits ref when branch not provided", async () => {
      const client = createMockClient();
      const provider = new RwxSandboxProvider(client, defaultProviderConfig);

      await provider.createSandbox(baseCreateConfig);

      const createCall = (client.createDispatch as ReturnType<typeof vi.fn>).mock.calls[0][0];
      expect(createCall.ref).toBeUndefined();
    });

    it("assembles core dispatch params correctly for GitHub", async () => {
      const client = createMockClient();
      const provider = new RwxSandboxProvider(client, defaultProviderConfig);

      await provider.createSandbox(baseCreateConfig);

      const params = (client.createDispatch as ReturnType<typeof vi.fn>).mock.calls[0][0].params;

      expect(params.PYTHONUNBUFFERED).toBe("1");
      expect(params.SANDBOX_ID).toBe("sandbox-456");
      expect(params.CONTROL_PLANE_URL).toBe("https://control-plane.test");
      expect(params.SANDBOX_AUTH_TOKEN).toBe("auth-token-abc");
      expect(params.REPO_OWNER).toBe("testowner");
      expect(params.REPO_NAME).toBe("testrepo");
      expect(params.VCS_HOST).toBe("github.com");
      expect(params.VCS_CLONE_USERNAME).toBe("x-access-token");
    });

    it("includes SESSION_CONFIG with correct structure", async () => {
      const client = createMockClient();
      const provider = new RwxSandboxProvider(client, defaultProviderConfig);

      await provider.createSandbox(baseCreateConfig);

      const params = (client.createDispatch as ReturnType<typeof vi.fn>).mock.calls[0][0].params;
      const sessionConfig = JSON.parse(params.SESSION_CONFIG);
      expect(sessionConfig).toEqual({
        session_id: "session-123",
        repo_owner: "testowner",
        repo_name: "testrepo",
        provider: "anthropic",
        model: "anthropic/claude-sonnet-4-5",
      });
    });

    it("includes branch in SESSION_CONFIG when provided", async () => {
      const client = createMockClient();
      const provider = new RwxSandboxProvider(client, defaultProviderConfig);

      await provider.createSandbox({ ...baseCreateConfig, branch: "feature/test" });

      const params = (client.createDispatch as ReturnType<typeof vi.fn>).mock.calls[0][0].params;
      const sessionConfig = JSON.parse(params.SESSION_CONFIG);
      expect(sessionConfig.branch).toBe("feature/test");
    });

    it("includes mcp_servers in SESSION_CONFIG when provided", async () => {
      const client = createMockClient();
      const provider = new RwxSandboxProvider(client, defaultProviderConfig);

      await provider.createSandbox({
        ...baseCreateConfig,
        mcpServers: [{ id: "mcp-1", name: "Tool", type: "local", enabled: true }],
      });

      const params = (client.createDispatch as ReturnType<typeof vi.fn>).mock.calls[0][0].params;
      const sessionConfig = JSON.parse(params.SESSION_CONFIG);
      expect(sessionConfig.mcp_servers).toEqual([
        { id: "mcp-1", name: "Tool", type: "local", enabled: true },
      ]);
    });

    it("includes user env vars with system vars taking precedence", async () => {
      const client = createMockClient();
      const provider = new RwxSandboxProvider(client, defaultProviderConfig);

      await provider.createSandbox({
        ...baseCreateConfig,
        userEnvVars: { MY_SECRET: "value123", SANDBOX_ID: "should-be-overridden" },
      });

      const params = (client.createDispatch as ReturnType<typeof vi.fn>).mock.calls[0][0].params;
      expect(params.MY_SECRET).toBe("value123");
      // System var overrides user-provided duplicate
      expect(params.SANDBOX_ID).toBe("sandbox-456");
    });

    it("sets AGENT_SLACK_NOTIFY_ENABLED=true when agentSlackNotifyEnabled is on", async () => {
      const client = createMockClient();
      const provider = new RwxSandboxProvider(client, defaultProviderConfig);

      await provider.createSandbox({ ...baseCreateConfig, agentSlackNotifyEnabled: true });

      const params = (client.createDispatch as ReturnType<typeof vi.fn>).mock.calls[0][0].params;
      expect(params.AGENT_SLACK_NOTIFY_ENABLED).toBe("true");
    });

    it("omits AGENT_SLACK_NOTIFY_ENABLED when disabled", async () => {
      const client = createMockClient();
      const provider = new RwxSandboxProvider(client, defaultProviderConfig);

      await provider.createSandbox(baseCreateConfig);

      const params = (client.createDispatch as ReturnType<typeof vi.fn>).mock.calls[0][0].params;
      expect(params.AGENT_SLACK_NOTIFY_ENABLED).toBeUndefined();
    });

    it("assembles GitLab SCM params correctly", async () => {
      const client = createMockClient();
      const provider = new RwxSandboxProvider(client, {
        scmProvider: "gitlab",
        codeServerPasswordSecret: "secret",
      });

      await provider.createSandbox(baseCreateConfig);

      const params = (client.createDispatch as ReturnType<typeof vi.fn>).mock.calls[0][0].params;
      expect(params.VCS_HOST).toBe("gitlab.com");
      expect(params.VCS_CLONE_USERNAME).toBe("oauth2");
    });

    it("assembles Bitbucket SCM params correctly", async () => {
      const client = createMockClient();
      const provider = new RwxSandboxProvider(client, {
        scmProvider: "bitbucket",
        codeServerPasswordSecret: "secret",
      });

      await provider.createSandbox(baseCreateConfig);

      const params = (client.createDispatch as ReturnType<typeof vi.fn>).mock.calls[0][0].params;
      expect(params.VCS_HOST).toBe("bitbucket.org");
      expect(params.VCS_CLONE_USERNAME).toBe("x-token-auth");
    });

    it("classifies RwxApiError 422 as permanent SandboxProviderError", async () => {
      const client = createMockClient({
        createDispatch: async () => {
          throw new RwxApiError("dispatch key not found", 422);
        },
      });
      const provider = new RwxSandboxProvider(client, defaultProviderConfig);

      try {
        await provider.createSandbox(baseCreateConfig);
        expect.unreachable("should have thrown");
      } catch (e) {
        expect(e).toBeInstanceOf(SandboxProviderError);
        expect((e as SandboxProviderError).errorType).toBe("permanent");
      }
    });

    it("classifies RwxApiError 502 as transient SandboxProviderError", async () => {
      const client = createMockClient({
        createDispatch: async () => {
          throw new RwxApiError("bad gateway", 502);
        },
      });
      const provider = new RwxSandboxProvider(client, defaultProviderConfig);

      try {
        await provider.createSandbox(baseCreateConfig);
        expect.unreachable("should have thrown");
      } catch (e) {
        expect(e).toBeInstanceOf(SandboxProviderError);
        expect((e as SandboxProviderError).errorType).toBe("transient");
      }
    });

    it("classifies network errors as transient SandboxProviderError", async () => {
      const client = createMockClient({
        createDispatch: async () => {
          throw new Error("fetch failed: ECONNRESET");
        },
      });
      const provider = new RwxSandboxProvider(client, defaultProviderConfig);

      try {
        await provider.createSandbox(baseCreateConfig);
        expect.unreachable("should have thrown");
      } catch (e) {
        expect(e).toBeInstanceOf(SandboxProviderError);
        expect((e as SandboxProviderError).errorType).toBe("transient");
      }
    });
  });

  describe("code-server password derivation", () => {
    it("derives deterministic password via HMAC and includes it in params", async () => {
      const client = createMockClient();
      const provider = new RwxSandboxProvider(client, defaultProviderConfig);

      await provider.createSandbox({ ...baseCreateConfig, codeServerEnabled: true });

      const params = (client.createDispatch as ReturnType<typeof vi.fn>).mock.calls[0][0].params;
      const expectedDigest = await computeHmacHex("code-server:sandbox-456", "test-secret-key");
      expect(params.CODE_SERVER_PASSWORD).toBe(expectedDigest.slice(0, 32));
      expect(params.CODE_SERVER_PASSWORD).toHaveLength(32);
    });

    it("does not include CODE_SERVER_PASSWORD when code-server is disabled", async () => {
      const client = createMockClient();
      const provider = new RwxSandboxProvider(client, defaultProviderConfig);

      await provider.createSandbox(baseCreateConfig);

      const params = (client.createDispatch as ReturnType<typeof vi.fn>).mock.calls[0][0].params;
      expect(params.CODE_SERVER_PASSWORD).toBeUndefined();
    });
  });
});
