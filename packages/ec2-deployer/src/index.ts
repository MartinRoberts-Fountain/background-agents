/**
 * EC2 Deployer Worker
 *
 * A Cloudflare Worker that manages the lifecycle of Amazon EC2 instances
 * for Open-Inspect sandboxes.
 */

import { DurableObject } from "cloudflare:workers";
import { AwsClient } from "aws4fetch";

interface DeployBody {
  sandboxId: string;
  sessionId: string;
  controlPlaneUrl: string;
  sandboxAuthToken: string;
  provider: string;
  repoOwner: string;
  repoName: string;
  userEnvVars?: Record<string, string>;
  model: string;
  /** Optional repo-specific AMI ID. Uses base EC2_AMI_ID if not provided. */
  amiId?: string;
}

interface ProviderObjectBody {
  providerObjectId: string;
}

interface BuildImageBody {
  buildId: string;
  setupScript: string;
  callbackUrl: string;
}

interface CloudflareApiResponse<T> {
  success: boolean;
  result: T;
  errors: { code?: number; message: string }[];
}

interface ResultInfo {
  page: number;
  per_page: number;
  count: number;
  total_count: number;
}

interface TunnelInfo {
  id: string;
  name: string;
  created_at: string;
  deleted_at: string | null;
}

interface CloudflareListTunnelsResponse {
  success: boolean;
  result: TunnelInfo[];
  result_info: ResultInfo;
  errors: { code?: number; message: string }[];
}

interface AwsXmlResult {
  instancesSet?: { item: { instanceId: string } };
  instanceState?: { name: string };
  imageId?: string;
  imageState?: string;
}

export interface Env {
  EC2_INSTANCE: DurableObjectNamespace;
  EC2_IMAGE_BUILD: DurableObjectNamespace;
  EC2_API_SECRET: string;
  AWS_ACCESS_KEY_ID: string;
  AWS_SECRET_ACCESS_KEY: string;
  AWS_REGION: string;
  EC2_AMI_ID: string;
  CLOUDFLARE_ACCOUNT_ID: string;
  CLOUDFLARE_API_TOKEN: string;
  CLOUDFLARE_TUNNEL_SECRET: string;
  /** Control plane base URL for fetching EC2 config and sending build callbacks. */
  CONTROL_PLANE_URL?: string;
}

/**
 * Periodically cleans up orphaned Cloudflare tunnels and their associated EC2 instances.
 */
async function cleanupOldResources(env: Env): Promise<void> {
  let page = 1;
  const perPage = 50;
  let hasMore = true;

  while (hasMore) {
    const response = await fetch(
      `https://api.cloudflare.com/client/v4/accounts/${env.CLOUDFLARE_ACCOUNT_ID}/tunnels?page=${page}&per_page=${perPage}`,
      {
        headers: {
          Authorization: `Bearer ${env.CLOUDFLARE_API_TOKEN}`,
          "Content-Type": "application/json",
        },
      }
    );

    if (!response.ok) {
      console.error(`Failed to list tunnels: ${response.status} ${await response.text()}`);
      break;
    }

    const data = (await response.json()) as CloudflareListTunnelsResponse;
    if (!data.success) {
      console.error(`Cloudflare API error listing tunnels: ${JSON.stringify(data.errors)}`);
      break;
    }

    const now = Date.now();
    for (const tunnel of data.result) {
      if (tunnel.deleted_at || !tunnel.name.startsWith("sandbox-")) continue;

      const createdAt = new Date(tunnel.created_at).getTime();
      const ageMs = now - createdAt;

      // If older than 24 hours
      if (ageMs > 24 * 60 * 60 * 1000) {
        const sandboxId = tunnel.name.slice("sandbox-".length);
        const id = env.EC2_INSTANCE.idFromName(sandboxId);
        const stub = env.EC2_INSTANCE.get(id);

        try {
          // Trigger the DO's teardown which terminates EC2 and deletes tunnel
          await stub.fetch("https://worker.local/delete", { method: "POST" });
          console.log(`Cleaned up orphaned tunnel/sandbox: ${tunnel.name}`);
        } catch (err) {
          console.error(`Failed to trigger cleanup for sandbox ${sandboxId}: ${err}`);
        }
      }
    }

    const { total_count, page: currentPage, per_page } = data.result_info;
    hasMore = currentPage * per_page < total_count;
    page++;
  }
}

/** Rebuild interval: 7 days in milliseconds. */
const REBUILD_INTERVAL_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * Trigger a new EC2 image build if the setup script is configured and the
 * last build is older than REBUILD_INTERVAL_MS (or no image exists yet).
 * Called from the weekly cron handler.
 */
async function maybeRebuildImage(env: Env): Promise<void> {
  if (!env.CONTROL_PLANE_URL) {
    console.log("CONTROL_PLANE_URL not set, skipping EC2 image rebuild check");
    return;
  }

  let config: {
    setupScript: string | null;
    currentAmiId: string | null;
    status: string;
    lastBuiltAt: number | null;
  };

  try {
    const res = await fetch(`${env.CONTROL_PLANE_URL}/ec2/config`);
    if (!res.ok) {
      console.error(`Failed to fetch EC2 config: ${res.status}`);
      return;
    }
    config = (await res.json()) as typeof config;
  } catch (e) {
    console.error(`Error fetching EC2 config: ${e}`);
    return;
  }

  if (!config.setupScript) {
    console.log("No EC2 setup script configured, skipping rebuild");
    return;
  }

  if (config.status === "building") {
    console.log("EC2 image build already in progress, skipping");
    return;
  }

  const now = Date.now();
  const lastBuilt = config.lastBuiltAt ?? 0;
  if (config.currentAmiId && now - lastBuilt < REBUILD_INTERVAL_MS) {
    console.log(
      `EC2 image built ${Math.round((now - lastBuilt) / 86400000)}d ago, next rebuild in ` +
        `${Math.round((REBUILD_INTERVAL_MS - (now - lastBuilt)) / 86400000)}d`
    );
    return;
  }

  console.log("Triggering weekly EC2 image rebuild");

  const buildId = `ec2-img-cron-${now}`;
  const callbackUrl = `${env.CONTROL_PLANE_URL}/ec2/build-complete`;

  try {
    // Notify control plane that a build is starting
    await fetch(`${env.CONTROL_PLANE_URL}/ec2/trigger`, { method: "POST" });
    // The trigger endpoint creates the buildId and calls us back via /build-image.
    // But to avoid the double-hop, create the DO directly.
    const id = env.EC2_IMAGE_BUILD.idFromName(buildId);
    const stub = env.EC2_IMAGE_BUILD.get(id);
    // Fire-and-forget: the DO manages its own lifecycle and callbacks
    stub
      .fetch("https://worker.local/build-image", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          buildId,
          setupScript: config.setupScript,
          callbackUrl,
        }),
      })
      .catch((e) => console.error(`EC2 image build DO error: ${e}`));

    console.log(`EC2 image rebuild started: ${buildId}`);
  } catch (e) {
    console.error(`Failed to start EC2 image rebuild: ${e}`);
  }
}

/**
 * Worker entry point.
 */
export default {
  // Reference so bundler does not tree-shake DOs (Cloudflare needs the named export)
  get EC2InstanceDO() {
    return EC2InstanceDO;
  },
  get EC2ImageBuildDO() {
    return EC2ImageBuildDO;
  },
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    // Health check
    if (url.pathname === "/health") {
      return Response.json({ status: "ok", service: "open-inspect-ec2-deployer" });
    }

    // Verify token
    const authHeader = request.headers.get("Authorization");
    if (!authHeader || !authHeader.startsWith("Bearer ")) {
      return new Response("Unauthorized", { status: 401 });
    }

    const token = authHeader.slice(7);
    const isValid = await verifyToken(token, env.EC2_API_SECRET);
    if (!isValid) {
      return new Response("Unauthorized", { status: 401 });
    }

    if (url.pathname === "/deploy" && request.method === "POST") {
      // Parse from a clone so we can forward the original (single-use) body to the DO
      const body = (await request.clone().json()) as DeployBody;
      const id = env.EC2_INSTANCE.idFromName(body.sandboxId);
      const stub = env.EC2_INSTANCE.get(id);
      return stub.fetch(request);
    }

    if (url.pathname === "/build-image" && request.method === "POST") {
      const body = (await request.clone().json()) as BuildImageBody;
      const id = env.EC2_IMAGE_BUILD.idFromName(body.buildId);
      const stub = env.EC2_IMAGE_BUILD.get(id);
      return stub.fetch(request);
    }

    if (
      (url.pathname === "/stop" || url.pathname === "/start" || url.pathname === "/delete") &&
      request.method === "POST"
    ) {
      // Parse from a clone so we can forward the original (single-use) body to the DO
      const body = (await request.clone().json()) as ProviderObjectBody;
      const id = env.EC2_INSTANCE.idFromString(body.providerObjectId);
      const stub = env.EC2_INSTANCE.get(id);
      return stub.fetch(request);
    }

    return new Response("Not Found", { status: 404 });
  },

  async scheduled(_event: ScheduledEvent, env: Env): Promise<void> {
    await Promise.all([cleanupOldResources(env), maybeRebuildImage(env)]);
  },
};

/**
 * Verify HMAC-authenticated token.
 */
async function verifyToken(token: string, secret: string): Promise<boolean> {
  const dotIndex = token.indexOf(".");
  if (dotIndex === -1) return false;

  const timestampPart = token.slice(0, dotIndex);
  const signature = token.slice(dotIndex + 1);

  const timestamp = parseInt(timestampPart, 10);
  if (isNaN(timestamp) || Math.abs(Date.now() - timestamp) > 5 * 60 * 1000) {
    return false;
  }

  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(timestampPart));
  const expected = Array.from(new Uint8Array(sig))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
  return signature === expected;
}

/**
 * EC2 Instance Durable Object
 *
 * Manages the state and lifecycle of a single EC2 instance and its Cloudflare Tunnel.
 */
export class EC2InstanceDO extends DurableObject<Env> {
  private instanceId: string | null = null;
  private tunnelId: string | null = null;
  private tunnelToken: string | null = null;
  private status: string = "pending";
  private createdAt: number = 0;
  private aws: AwsClient;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.aws = new AwsClient({
      accessKeyId: env.AWS_ACCESS_KEY_ID,
      secretAccessKey: env.AWS_SECRET_ACCESS_KEY,
      region: env.AWS_REGION,
      service: "ec2",
    });
    this.ctx.blockConcurrencyWhile(async () => {
      this.instanceId = (await this.ctx.storage.get<string>("instanceId")) || null;
      this.tunnelId = (await this.ctx.storage.get<string>("tunnelId")) || null;
      this.tunnelToken = (await this.ctx.storage.get<string>("tunnelToken")) || null;
      this.status = (await this.ctx.storage.get<string>("status")) || "pending";
      this.createdAt = (await this.ctx.storage.get<number>("createdAt")) || 0;
    });
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === "/deploy") {
      return this.handleDeploy(request);
    }
    if (url.pathname === "/stop") {
      return this.handleStop();
    }
    if (url.pathname === "/start") {
      return this.handleStart();
    }
    if (url.pathname === "/delete") {
      return this.handleDelete();
    }

    return new Response("Not Found", { status: 404 });
  }

  private async handleDeploy(request: Request): Promise<Response> {
    if (this.instanceId) {
      return Response.json({
        success: true,
        sandboxId: ((await request.json()) as DeployBody).sandboxId,
        providerObjectId: this.ctx.id.toString(),
        status: this.status,
        createdAt: this.createdAt,
      });
    }

    const body = (await request.json()) as DeployBody;
    this.createdAt = Date.now();
    await this.ctx.storage.put("createdAt", this.createdAt);

    try {
      // 1. Create Cloudflare Tunnel
      const tunnelName = `sandbox-${body.sandboxId}`;
      const tunnelResult = await this.createCloudflareTunnel(tunnelName);
      this.tunnelId = tunnelResult.id;
      this.tunnelToken = tunnelResult.token;
      await this.ctx.storage.put("tunnelId", this.tunnelId);
      await this.ctx.storage.put("tunnelToken", this.tunnelToken);

      // 2. Launch EC2 Instance
      this.instanceId = await this.launchEC2Instance(body, this.tunnelToken!);
      await this.ctx.storage.put("instanceId", this.instanceId);

      this.status = "spawning";
      await this.ctx.storage.put("status", this.status);

      // 3. Wait for tunnel to come online
      await this.waitForTunnelOnline(this.tunnelId!);

      this.status = "running";
      await this.ctx.storage.put("status", this.status);

      // 4. Schedule 24-hour auto-teardown
      await this.ctx.storage.setAlarm(Date.now() + 24 * 60 * 60 * 1000);

      return Response.json({
        success: true,
        sandboxId: body.sandboxId,
        providerObjectId: this.ctx.id.toString(),
        status: this.status,
        createdAt: this.createdAt,
      });
    } catch (error: unknown) {
      // If deployment fails halfway, clean up any partially created resources
      await this.teardown();
      return Response.json(
        {
          success: false,
          error: error instanceof Error ? error.message : String(error),
        },
        { status: 500 }
      );
    }
  }

  private async handleStop(): Promise<Response> {
    if (!this.instanceId)
      return Response.json({ success: false, error: "No instance" }, { status: 404 });
    await this.awsRequest("StopInstances", { InstanceId: [this.instanceId] });
    this.status = "stopped";
    await this.ctx.storage.put("status", this.status);
    return Response.json({ success: true });
  }

  private async handleStart(): Promise<Response> {
    if (!this.instanceId)
      return Response.json({ success: false, error: "No instance" }, { status: 404 });
    await this.awsRequest("StartInstances", { InstanceId: [this.instanceId] });
    this.status = "running";
    await this.ctx.storage.put("status", this.status);
    // After starting, wait for the tunnel to come back online
    await this.waitForTunnelOnline(this.tunnelId!);
    return Response.json({ success: true });
  }

  private async handleDelete(): Promise<Response> {
    await this.teardown();
    return Response.json({ success: true });
  }

  async alarm() {
    await this.teardown();
  }

  private async teardown() {
    if (this.instanceId) {
      await this.awsRequest("TerminateInstances", { InstanceId: [this.instanceId] });
    }
    if (this.tunnelId) {
      await this.deleteCloudflareTunnel(this.tunnelId);
    }
    await this.ctx.storage.deleteAll();
    this.instanceId = null;
    this.tunnelId = null;
    this.tunnelToken = null;
    this.status = "deleted";
  }

  private async launchEC2Instance(config: DeployBody, tunnelToken: string): Promise<string> {
    // Only includes dynamic configuration that cannot be baked into the AMI.
    const userData = btoa(`#!/bin/bash
# Write dynamic Cloudflare Tunnel token
# sudo cloudflared service install "${tunnelToken}"

# Write dynamic environment for OpenCode server
cat > /etc/opencode/env <<EOF
PATH="/home/ubuntu/.nvm/versions/node/v22.19.0/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin:/usr/games:/usr/local/games:/snap/bin"
SANDBOX_ID=${config.sandboxId}
SESSION_ID=${config.sessionId}
CONTROL_PLANE_URL=${config.controlPlaneUrl}
SANDBOX_AUTH_TOKEN=${config.sandboxAuthToken}
LLM_PROVIDER=${config.provider}
LLM_MODEL=${config.model}
REPO_OWNER=${config.repoOwner}
REPO_NAME=${config.repoName}
VCS_CLONE_TOKEN=${config.userEnvVars?.["VCS_CLONE_TOKEN"] || config.userEnvVars?.["GITHUB_APP_TOKEN"] || config.userEnvVars?.["GITHUB_TOKEN"] || ""}
ANTHROPIC_API_KEY=${config.userEnvVars?.["ANTHROPIC_API_KEY"] || ""}
EOF

# Trigger start-up of baked services
#systemctl restart cloudflared
systemctl restart sandbox-supervisor
`);

    const imageId = config.amiId || this.env.EC2_AMI_ID;
    const result = await this.awsRequest("RunInstances", {
      ImageId: imageId,
      InstanceType: "t4g.2xlarge",
      MinCount: "1",
      MaxCount: "1",
      KeyName: "development-am",
      "SecurityGroupId.1": "sg-064453e70f4d22ea9",
      UserData: userData,
      InstanceMarketOptions: {
        MarketType: "spot",
      },
      TagSpecification: [
        {
          ResourceType: "instance",
          Tag: [
            { Key: "Name", Value: `open-inspect-sandbox-${config.sandboxId}` },
            { Key: "OpenInspectSandboxId", Value: config.sandboxId },
          ],
        },
      ],
    });

    const instanceId = result?.instancesSet?.item?.instanceId;
    if (!instanceId) throw new Error(`Failed to launch EC2 instance: ${JSON.stringify(result)}`);
    return instanceId;
  }

  private async createCloudflareTunnel(name: string): Promise<{ id: string; token: string }> {
    const response = await fetch(
      `https://api.cloudflare.com/client/v4/accounts/${this.env.CLOUDFLARE_ACCOUNT_ID}/tunnels`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${this.env.CLOUDFLARE_API_TOKEN}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ name, tunnel_secret: this.env.CLOUDFLARE_TUNNEL_SECRET }),
      }
    );
    const result = (await response.json()) as CloudflareApiResponse<{ id: string }>;
    if (!result.success) {
      const authError = result.errors?.some(
        (e) => e.code === 10000 || /authentication/i.test(e.message ?? "")
      );
      if (authError) {
        throw new Error(
          "CF Tunnel creation failed: Cloudflare API authentication error. " +
            "Verify CLOUDFLARE_API_TOKEN (EC2 deployer token with Tunnel read/write) and CLOUDFLARE_ACCOUNT_ID. " +
            `Details: ${JSON.stringify(result.errors)}`
        );
      }
      throw new Error(`CF Tunnel creation failed: ${JSON.stringify(result.errors)}`);
    }

    const tunnelId = result.result.id;
    const token = btoa(
      JSON.stringify({
        a: this.env.CLOUDFLARE_ACCOUNT_ID,
        t: tunnelId,
        s: this.env.CLOUDFLARE_TUNNEL_SECRET,
      })
    );

    return { id: tunnelId, token };
  }

  private async deleteCloudflareTunnel(tunnelId: string) {
    await fetch(
      `https://api.cloudflare.com/client/v4/accounts/${this.env.CLOUDFLARE_ACCOUNT_ID}/tunnels/${tunnelId}`,
      {
        method: "DELETE",
        headers: {
          Authorization: `Bearer ${this.env.CLOUDFLARE_API_TOKEN}`,
        },
      }
    );
  }

  private async waitForTunnelOnline(tunnelId: string) {
    for (let i = 0; i < 60; i++) {
      const response = await fetch(
        `https://api.cloudflare.com/client/v4/accounts/${this.env.CLOUDFLARE_ACCOUNT_ID}/tunnels/${tunnelId}/connections`,
        {
          headers: { Authorization: `Bearer ${this.env.CLOUDFLARE_API_TOKEN}` },
        }
      );
      const result = (await response.json()) as CloudflareApiResponse<unknown[]>;
      if (result.success && result.result && result.result.length > 0) return;
      await new Promise((r) => setTimeout(r, 5000));
    }
    throw new Error("Timeout waiting for tunnel to come online");
  }

  private async awsRequest(action: string, params: Record<string, unknown>): Promise<AwsXmlResult> {
    const url = new URL(`https://ec2.${this.env.AWS_REGION}.amazonaws.com/`);
    url.searchParams.set("Action", action);
    url.searchParams.set("Version", "2016-11-15");

    // Flatten params for Query API
    this.flattenParams(params).forEach(([key, value]) => {
      url.searchParams.set(key, value);
    });

    const response = await this.aws.fetch(url.toString());
    const text = await response.text();

    if (!response.ok) {
      throw new Error(`AWS API error (${action}): ${response.status} ${text}`);
    }

    // Simplified XML to JSON parsing (only for the fields we need)
    return this.parseXml(text);
  }

  private flattenParams(params: Record<string, unknown>, prefix = ""): [string, string][] {
    let result: [string, string][] = [];
    for (const [key, value] of Object.entries(params)) {
      const fullKey = prefix ? `${prefix}.${key}` : key;
      if (Array.isArray(value)) {
        value.forEach((v: unknown, i) => {
          if (typeof v === "object" && v !== null) {
            result = result.concat(
              this.flattenParams(v as Record<string, unknown>, `${fullKey}.${i + 1}`)
            );
          } else {
            result.push([`${fullKey}.${i + 1}`, String(v)]);
          }
        });
      } else if (typeof value === "object" && value !== null) {
        result = result.concat(this.flattenParams(value as Record<string, unknown>, fullKey));
      } else {
        result.push([fullKey, String(value)]);
      }
    }
    return result;
  }

  private parseXml(xml: string): AwsXmlResult {
    return parseAwsXml(xml);
  }
}

function parseAwsXml(xml: string): AwsXmlResult {
  const res: AwsXmlResult = {};
  const matchInstanceId = xml.match(/<instanceId>(.*?)<\/instanceId>/);
  if (matchInstanceId) {
    res.instancesSet = { item: { instanceId: matchInstanceId[1] } };
  }
  const matchState = xml.match(/<instanceState>\s*<code>\d+<\/code>\s*<name>(.*?)<\/name>/);
  if (matchState) {
    res.instanceState = { name: matchState[1] };
  }
  const matchImageId = xml.match(/<imageId>(ami-[a-f0-9]+)<\/imageId>/);
  if (matchImageId) {
    res.imageId = matchImageId[1];
  }
  const matchImageState = xml.match(/<imageState>(.*?)<\/imageState>/);
  if (matchImageState) {
    res.imageState = matchImageState[1];
  }
  return res;
}

/** Poll interval for checking EC2 instance and AMI state. */
const IMAGE_BUILD_POLL_INTERVAL_MS = 30_000; // 30 seconds

/** Maximum time to wait for setup script to complete (instance to stop). */
const IMAGE_BUILD_TIMEOUT_MS = 60 * 60 * 1000; // 60 minutes

/**
 * EC2 Image Build Durable Object
 *
 * Manages the lifecycle of an EC2 image build using DO alarms for polling:
 * 1. Launch base AMI with setup script as UserData (script shuts down on completion)
 * 2. Set alarm to poll DescribeInstanceStatus until instance is "stopped"
 * 3. Create AMI from the stopped instance
 * 4. Set alarm to poll DescribeImages until AMI is "available"
 * 5. Terminate instance, callback to control plane with new AMI ID
 */
export class EC2ImageBuildDO extends DurableObject<Env> {
  private instanceId: string | null = null;
  private buildId: string | null = null;
  private callbackUrl: string | null = null;
  private pendingAmiId: string | null = null;
  private startedAtMs: number = 0;
  private status: string = "pending";
  private aws: AwsClient;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.aws = new AwsClient({
      accessKeyId: env.AWS_ACCESS_KEY_ID,
      secretAccessKey: env.AWS_SECRET_ACCESS_KEY,
      region: env.AWS_REGION,
      service: "ec2",
    });
    this.ctx.blockConcurrencyWhile(async () => {
      this.instanceId = (await this.ctx.storage.get<string>("instanceId")) || null;
      this.buildId = (await this.ctx.storage.get<string>("buildId")) || null;
      this.callbackUrl = (await this.ctx.storage.get<string>("callbackUrl")) || null;
      this.pendingAmiId = (await this.ctx.storage.get<string>("pendingAmiId")) || null;
      this.startedAtMs = (await this.ctx.storage.get<number>("startedAtMs")) || 0;
      this.status = (await this.ctx.storage.get<string>("status")) || "pending";
    });
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === "/build-image") {
      return this.handleBuildImage(request);
    }

    return new Response("Not Found", { status: 404 });
  }

  private async handleBuildImage(request: Request): Promise<Response> {
    if (this.status !== "pending") {
      return Response.json({
        success: true,
        buildId: this.buildId,
        status: this.status,
      });
    }

    const body = (await request.json()) as BuildImageBody;
    this.buildId = body.buildId;
    this.callbackUrl = body.callbackUrl;
    this.startedAtMs = Date.now();

    // 1. Launch EC2 with setup script that shuts down on completion
    const userData = btoa(`#!/bin/bash
set -e

# Run the user-provided setup script
cat > /tmp/open-inspect-setup.sh <<'SETUP_SCRIPT_EOF'
${body.setupScript}
SETUP_SCRIPT_EOF

chmod +x /tmp/open-inspect-setup.sh
bash /tmp/open-inspect-setup.sh 2>&1 | tee /var/log/open-inspect-setup.log

# Signal completion by shutting down
shutdown -h now
`);

    try {
      const launchResult = await this.awsRequest("RunInstances", {
        ImageId: this.env.EC2_AMI_ID,
        InstanceType: "t4g.2xlarge",
        MinCount: "1",
        MaxCount: "1",
        KeyName: "development-am",
        "SecurityGroupId.1": "sg-064453e70f4d22ea9",
        UserData: userData,
        TagSpecification: [
          {
            ResourceType: "instance",
            Tag: [
              { Key: "Name", Value: `open-inspect-image-build-${body.buildId}` },
              { Key: "OpenInspectBuildId", Value: body.buildId },
            ],
          },
        ],
      });

      this.instanceId = launchResult?.instancesSet?.item?.instanceId ?? null;
      if (!this.instanceId) {
        throw new Error(`Failed to launch EC2 instance: ${JSON.stringify(launchResult)}`);
      }

      this.status = "running_setup";
      await this.ctx.storage.put("buildId", this.buildId);
      await this.ctx.storage.put("callbackUrl", this.callbackUrl);
      await this.ctx.storage.put("instanceId", this.instanceId);
      await this.ctx.storage.put("startedAtMs", this.startedAtMs);
      await this.ctx.storage.put("status", this.status);

      console.log(`Image build ${body.buildId}: launched instance ${this.instanceId}`);

      // Schedule first poll in 30 seconds — alarm() drives the rest of the build
      await this.ctx.storage.setAlarm(Date.now() + IMAGE_BUILD_POLL_INTERVAL_MS);

      return Response.json({ success: true, buildId: body.buildId, status: this.status });
    } catch (err: unknown) {
      const errorMessage = err instanceof Error ? err.message : String(err);
      console.error(`Image build ${body.buildId} launch failed: ${errorMessage}`);
      await this.failBuild(errorMessage);
      return Response.json(
        { success: false, buildId: body.buildId, error: errorMessage },
        { status: 500 }
      );
    }
  }

  /**
   * Alarm handler — called repeatedly to poll AWS state and advance the build.
   * Stages: running_setup → creating_ami → complete / failed
   */
  async alarm(): Promise<void> {
    if (!this.buildId || !this.callbackUrl || !this.instanceId) {
      console.error("EC2ImageBuildDO alarm: missing required state, aborting");
      await this.ctx.storage.deleteAll();
      return;
    }

    // Check global timeout
    if (this.startedAtMs > 0 && Date.now() - this.startedAtMs > IMAGE_BUILD_TIMEOUT_MS) {
      console.error(`Image build ${this.buildId}: timed out after ${IMAGE_BUILD_TIMEOUT_MS}ms`);
      await this.failBuild("Build timed out");
      return;
    }

    try {
      if (this.status === "running_setup") {
        await this.pollInstanceState();
      } else if (this.status === "creating_ami") {
        await this.pollAmiState();
      } else {
        // Nothing to do for complete/failed
        console.log(`EC2ImageBuildDO alarm: status is ${this.status}, no action`);
      }
    } catch (err: unknown) {
      const errorMessage = err instanceof Error ? err.message : String(err);
      console.error(`Image build ${this.buildId} alarm error: ${errorMessage}`);
      await this.failBuild(errorMessage);
    }
  }

  private async pollInstanceState(): Promise<void> {
    const result = await this.awsRequest("DescribeInstanceStatus", {
      InstanceId: [this.instanceId!],
      IncludeAllInstances: "true",
    });

    const state = result.instanceState?.name;
    console.log(`Image build ${this.buildId}: instance state = ${state}`);

    if (state === "terminated") {
      throw new Error(`Instance ${this.instanceId} terminated unexpectedly during setup`);
    }

    if (state !== "stopped") {
      // Not done yet — reschedule poll
      await this.ctx.storage.setAlarm(Date.now() + IMAGE_BUILD_POLL_INTERVAL_MS);
      return;
    }

    // Instance stopped — create the AMI
    console.log(`Image build ${this.buildId}: instance stopped, creating AMI`);
    const amiName = `open-inspect-${this.buildId}`;
    const createImageResult = await this.awsRequest("CreateImage", {
      InstanceId: this.instanceId!,
      Name: amiName,
      Description: `Open-Inspect image build ${this.buildId}`,
      NoReboot: "true",
    });

    const newAmiId = createImageResult.imageId;
    if (!newAmiId) {
      throw new Error(`Failed to create AMI: ${JSON.stringify(createImageResult)}`);
    }

    console.log(`Image build ${this.buildId}: AMI ${newAmiId} creation started`);

    this.pendingAmiId = newAmiId;
    this.status = "creating_ami";
    await this.ctx.storage.put("pendingAmiId", newAmiId);
    await this.ctx.storage.put("status", this.status);

    // Poll AMI state soon
    await this.ctx.storage.setAlarm(Date.now() + IMAGE_BUILD_POLL_INTERVAL_MS);
  }

  private async pollAmiState(): Promise<void> {
    const amiId = this.pendingAmiId!;
    const result = await this.awsRequest("DescribeImages", {
      ImageId: [amiId],
    });

    const state = result.imageState;
    console.log(`Image build ${this.buildId}: AMI ${amiId} state = ${state}`);

    if (state === "failed" || state === "error") {
      throw new Error(`AMI ${amiId} creation failed with state: ${state}`);
    }

    if (state !== "available") {
      // Not done yet — reschedule poll
      await this.ctx.storage.setAlarm(Date.now() + IMAGE_BUILD_POLL_INTERVAL_MS);
      return;
    }

    const buildDurationSeconds = Math.round((Date.now() - this.startedAtMs) / 1000);
    console.log(`Image build ${this.buildId}: AMI ${amiId} available (${buildDurationSeconds}s)`);

    // Terminate the build instance (best-effort)
    try {
      await this.awsRequest("TerminateInstances", { InstanceId: [this.instanceId!] });
    } catch (e) {
      console.warn(`Image build ${this.buildId}: failed to terminate instance: ${e}`);
    }

    this.status = "complete";
    await this.ctx.storage.put("status", this.status);

    // Callback to control plane
    await this.sendCallback(this.callbackUrl!, {
      build_id: this.buildId,
      provider_image_id: amiId,
      build_duration_seconds: buildDurationSeconds,
    });

    // Clean up DO storage
    await this.ctx.storage.deleteAll();
  }

  private async failBuild(errorMessage: string): Promise<void> {
    this.status = "failed";
    await this.ctx.storage.put("status", this.status);

    // Terminate instance if it was launched (best-effort)
    if (this.instanceId) {
      try {
        await this.awsRequest("TerminateInstances", { InstanceId: [this.instanceId] });
      } catch {
        // Best-effort cleanup
      }
    }

    // Send failure callback (best-effort)
    if (this.callbackUrl && this.buildId) {
      const failedCallbackUrl = this.callbackUrl.replace("/build-complete", "/build-failed");
      try {
        await this.sendCallback(failedCallbackUrl, {
          build_id: this.buildId,
          error: errorMessage,
        });
      } catch {
        // Best-effort
      }
    }

    await this.ctx.storage.deleteAll();
  }

  private async sendCallback(url: string, body: Record<string, unknown>): Promise<void> {
    const maxRetries = 3;
    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      try {
        const response = await fetch(url, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        });
        if (response.ok) return;
        console.warn(`Callback attempt ${attempt + 1} failed: ${response.status}`);
      } catch (e) {
        console.warn(`Callback attempt ${attempt + 1} error: ${e}`);
      }
      if (attempt < maxRetries) {
        await new Promise((r) => setTimeout(r, Math.pow(2, attempt + 1) * 1000));
      }
    }
    throw new Error(`Failed to send callback to ${url} after ${maxRetries + 1} attempts`);
  }

  private async awsRequest(action: string, params: Record<string, unknown>): Promise<AwsXmlResult> {
    const url = new URL(`https://ec2.${this.env.AWS_REGION}.amazonaws.com/`);
    url.searchParams.set("Action", action);
    url.searchParams.set("Version", "2016-11-15");

    this.flattenParams(params).forEach(([key, value]) => {
      url.searchParams.set(key, value);
    });

    const response = await this.aws.fetch(url.toString());
    const text = await response.text();

    if (!response.ok) {
      throw new Error(`AWS API error (${action}): ${response.status} ${text}`);
    }

    return parseAwsXml(text);
  }

  private flattenParams(params: Record<string, unknown>, prefix = ""): [string, string][] {
    let result: [string, string][] = [];
    for (const [key, value] of Object.entries(params)) {
      const fullKey = prefix ? `${prefix}.${key}` : key;
      if (Array.isArray(value)) {
        value.forEach((v: unknown, i) => {
          if (typeof v === "object" && v !== null) {
            result = result.concat(
              this.flattenParams(v as Record<string, unknown>, `${fullKey}.${i + 1}`)
            );
          } else {
            result.push([`${fullKey}.${i + 1}`, String(v)]);
          }
        });
      } else if (typeof value === "object" && value !== null) {
        result = result.concat(this.flattenParams(value as Record<string, unknown>, fullKey));
      } else {
        result.push([fullKey, String(value)]);
      }
    }
    return result;
  }
}
