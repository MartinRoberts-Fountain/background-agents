import { describe, expect, it, vi, beforeEach } from "vitest";
import { agentDefaultsRoutes } from "./agent-defaults";

vi.mock("../logger", () => ({
  createLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
}));

const mockStore = {
  get: vi.fn(),
  getAllForUser: vi.fn(),
  set: vi.fn(),
};

vi.mock("../db/agent-defaults", () => ({
  AgentDefaultsStore: vi.fn(() => mockStore),
}));

const getHandler = agentDefaultsRoutes.find((r) => r.method === "GET")!.handler;
const putHandler = agentDefaultsRoutes.find((r) => r.method === "PUT")!.handler;

function makeEnv(dbConfigured = true) {
  return {
    DB: dbConfigured ? ({} as D1Database) : undefined,
  } as any;
}

const ctx = {
  request_id: "req-1",
  trace_id: "trace-1",
  metrics: { time: vi.fn((_label: string, fn: () => any) => fn()) },
} as any;

const emptyMatch = [] as unknown as RegExpMatchArray;

describe("GET /agent-defaults", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns 503 when DB is not configured", async () => {
    const req = new Request("https://host/agent-defaults?userId=u1");
    const res = await getHandler(req, makeEnv(false), emptyMatch, ctx);
    expect(res.status).toBe(503);
  });

  it("returns 400 when userId is missing", async () => {
    const req = new Request("https://host/agent-defaults");
    const res = await getHandler(req, makeEnv(), emptyMatch, ctx);
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error: "userId is required" });
  });

  it("returns specific default when repoOwner and repoName are provided", async () => {
    mockStore.get.mockResolvedValue("my-agent");
    const req = new Request("https://host/agent-defaults?userId=u1&repoOwner=org&repoName=repo");
    const res = await getHandler(req, makeEnv(), emptyMatch, ctx);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ defaultAgent: "my-agent" });
    expect(mockStore.get).toHaveBeenCalledWith("u1", "org", "repo");
  });

  it("returns all defaults when only userId is provided", async () => {
    mockStore.getAllForUser.mockResolvedValue([
      { repoOwner: "org", repoName: "repo", defaultAgent: "agent-1" },
    ]);
    const req = new Request("https://host/agent-defaults?userId=u1");
    const res = await getHandler(req, makeEnv(), emptyMatch, ctx);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.defaults).toHaveLength(1);
    expect(mockStore.getAllForUser).toHaveBeenCalledWith("u1");
  });

  it("returns 500 on store error", async () => {
    mockStore.getAllForUser.mockRejectedValue(new Error("DB error"));
    const req = new Request("https://host/agent-defaults?userId=u1");
    const res = await getHandler(req, makeEnv(), emptyMatch, ctx);
    expect(res.status).toBe(500);
  });
});

describe("PUT /agent-defaults", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns 503 when DB is not configured", async () => {
    const req = new Request("https://host/agent-defaults", {
      method: "PUT",
      body: JSON.stringify({ userId: "u1", repoOwner: "org", repoName: "repo" }),
    });
    const res = await putHandler(req, makeEnv(false), emptyMatch, ctx);
    expect(res.status).toBe(503);
  });

  it("returns 400 on invalid JSON", async () => {
    const req = new Request("https://host/agent-defaults", {
      method: "PUT",
      body: "not-json",
    });
    const res = await putHandler(req, makeEnv(), emptyMatch, ctx);
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error: "Invalid JSON body" });
  });

  it("returns 400 when required fields are missing", async () => {
    const req = new Request("https://host/agent-defaults", {
      method: "PUT",
      body: JSON.stringify({ userId: "u1" }),
    });
    const res = await putHandler(req, makeEnv(), emptyMatch, ctx);
    expect(res.status).toBe(400);
  });

  it("sets the default agent", async () => {
    mockStore.set.mockResolvedValue(undefined);
    const req = new Request("https://host/agent-defaults", {
      method: "PUT",
      body: JSON.stringify({
        userId: "u1",
        repoOwner: "org",
        repoName: "repo",
        defaultAgent: "my-agent",
      }),
    });
    const res = await putHandler(req, makeEnv(), emptyMatch, ctx);
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ status: "updated", defaultAgent: "my-agent" });
    expect(mockStore.set).toHaveBeenCalledWith("u1", "org", "repo", "my-agent");
  });

  it("clears the default agent when defaultAgent is omitted", async () => {
    mockStore.set.mockResolvedValue(undefined);
    const req = new Request("https://host/agent-defaults", {
      method: "PUT",
      body: JSON.stringify({ userId: "u1", repoOwner: "org", repoName: "repo" }),
    });
    const res = await putHandler(req, makeEnv(), emptyMatch, ctx);
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ status: "updated", defaultAgent: null });
    expect(mockStore.set).toHaveBeenCalledWith("u1", "org", "repo", null);
  });

  it("returns 500 on store error", async () => {
    mockStore.set.mockRejectedValue(new Error("DB error"));
    const req = new Request("https://host/agent-defaults", {
      method: "PUT",
      body: JSON.stringify({
        userId: "u1",
        repoOwner: "org",
        repoName: "repo",
        defaultAgent: "a",
      }),
    });
    const res = await putHandler(req, makeEnv(), emptyMatch, ctx);
    expect(res.status).toBe(500);
  });
});
