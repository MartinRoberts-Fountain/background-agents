/**
 * Global EC2 image builder routes.
 *
 * The EC2 AMI is shared across all repositories. A single setup script is
 * configured via the web interface. The EC2 deployer runs the script on the
 * base AMI, shuts it down, creates a new AMI, and callbacks here with the
 * new AMI ID. That AMI is then used for all future EC2 sandbox sessions.
 */

import { Ec2ConfigStore } from "../db/ec2-config";
import { EC2ApiClient } from "../sandbox/providers/ec2-provider";
import { createLogger } from "../logger";
import type { Env } from "../types";
import { type Route, type RequestContext, parsePattern, json, error } from "./shared";

const logger = createLogger("router:ec2");

/**
 * GET /ec2/config
 * Returns the global EC2 config (setup script, current AMI, status).
 * Called by the web UI and by the EC2 deployer cron.
 */
async function handleGetConfig(
  _request: Request,
  env: Env,
  _match: RegExpMatchArray,
  _ctx: RequestContext
): Promise<Response> {
  if (!env.DB) {
    return error("Database not configured", 503);
  }

  const store = new Ec2ConfigStore(env.DB);
  const config = await store.getConfig();

  return json({
    setupScript: config?.setupScript ?? null,
    currentAmiId: config?.currentAmiId ?? null,
    status: config?.status ?? "idle",
    lastBuiltAt: config?.lastBuiltAt ?? null,
  });
}

/**
 * PUT /ec2/config
 * Set the global setup script. Only updates the setup script field.
 */
async function handleSetConfig(
  request: Request,
  env: Env,
  _match: RegExpMatchArray,
  ctx: RequestContext
): Promise<Response> {
  if (!env.DB) {
    return error("Database not configured", 503);
  }

  let body: { setupScript?: unknown };
  try {
    body = (await request.json()) as typeof body;
  } catch {
    return error("Invalid JSON body", 400);
  }

  if (body.setupScript !== null && typeof body.setupScript !== "string") {
    return error("setupScript must be a string or null", 400);
  }

  const script = (body.setupScript as string | null) ?? null;
  const store = new Ec2ConfigStore(env.DB);

  try {
    await store.setSetupScript(script);

    logger.info("ec2.config_updated", {
      has_script: script !== null && script.length > 0,
      request_id: ctx.request_id,
      trace_id: ctx.trace_id,
    });

    return json({ ok: true });
  } catch (e) {
    logger.error("ec2.config_update_error", {
      error: e instanceof Error ? e.message : String(e),
      request_id: ctx.request_id,
      trace_id: ctx.trace_id,
    });
    return error("Failed to update EC2 config", 500);
  }
}

/**
 * POST /ec2/trigger
 * Manually trigger an EC2 image build.
 */
async function handleTrigger(
  _request: Request,
  env: Env,
  _match: RegExpMatchArray,
  ctx: RequestContext
): Promise<Response> {
  if (!env.DB) {
    return error("Database not configured", 503);
  }
  if (!env.EC2_API_URL || !env.EC2_API_SECRET) {
    return error("EC2 configuration not available", 503);
  }
  if (!env.WORKER_URL) {
    return error("WORKER_URL not configured", 503);
  }

  const store = new Ec2ConfigStore(env.DB);
  const config = await store.getConfig();

  if (!config?.setupScript) {
    return error("No setup script configured", 400);
  }

  if (config.status === "building") {
    return error("A build is already in progress", 409);
  }

  const buildId = `ec2-img-${Date.now()}`;

  try {
    await store.markBuilding(buildId);

    const callbackUrl = `${env.WORKER_URL}/ec2/build-complete`;

    const ec2Client = new EC2ApiClient({
      apiUrl: env.EC2_API_URL,
      apiSecret: env.EC2_API_SECRET,
    });

    await ec2Client.buildImage({
      buildId,
      setupScript: config.setupScript,
      callbackUrl,
    });

    logger.info("ec2.build_triggered", {
      build_id: buildId,
      request_id: ctx.request_id,
      trace_id: ctx.trace_id,
    });

    return json({ buildId, status: "building" });
  } catch (e) {
    await store.markFailed();
    logger.error("ec2.trigger_error", {
      error: e instanceof Error ? e.message : String(e),
      request_id: ctx.request_id,
      trace_id: ctx.trace_id,
    });
    return error("Failed to trigger EC2 image build", 500);
  }
}

/**
 * POST /ec2/build-complete
 * Callback from EC2 image builder on success.
 */
async function handleBuildComplete(
  request: Request,
  env: Env,
  _match: RegExpMatchArray,
  ctx: RequestContext
): Promise<Response> {
  if (!env.DB) {
    return error("Database not configured", 503);
  }

  let body: {
    build_id?: string;
    provider_image_id?: string;
    build_duration_seconds?: number;
  };
  try {
    body = (await request.json()) as typeof body;
  } catch {
    return error("Invalid JSON body", 400);
  }

  if (!body.build_id || !body.provider_image_id) {
    return error("build_id and provider_image_id are required", 400);
  }

  const store = new Ec2ConfigStore(env.DB);

  try {
    const replacedAmiId = await store.markReady(
      body.provider_image_id,
      body.build_duration_seconds ?? 0
    );

    logger.info("ec2.build_complete", {
      build_id: body.build_id,
      provider_image_id: body.provider_image_id,
      replaced_ami_id: replacedAmiId,
      build_duration_seconds: body.build_duration_seconds,
      request_id: ctx.request_id,
      trace_id: ctx.trace_id,
    });

    return json({ ok: true, replacedAmiId });
  } catch (e) {
    logger.error("ec2.build_complete_error", {
      error: e instanceof Error ? e.message : String(e),
      build_id: body.build_id,
      request_id: ctx.request_id,
      trace_id: ctx.trace_id,
    });
    return error("Failed to record EC2 build completion", 500);
  }
}

/**
 * POST /ec2/build-failed
 * Callback from EC2 image builder on failure.
 */
async function handleBuildFailed(
  request: Request,
  env: Env,
  _match: RegExpMatchArray,
  ctx: RequestContext
): Promise<Response> {
  if (!env.DB) {
    return error("Database not configured", 503);
  }

  let body: { build_id?: string; error?: string };
  try {
    body = (await request.json()) as typeof body;
  } catch {
    return error("Invalid JSON body", 400);
  }

  if (!body.build_id) {
    return error("build_id is required", 400);
  }

  const store = new Ec2ConfigStore(env.DB);

  try {
    await store.markFailed();

    logger.info("ec2.build_failed", {
      build_id: body.build_id,
      error_message: body.error,
      request_id: ctx.request_id,
      trace_id: ctx.trace_id,
    });

    return json({ ok: true });
  } catch (e) {
    logger.error("ec2.build_failed_error", {
      error: e instanceof Error ? e.message : String(e),
      build_id: body.build_id,
      request_id: ctx.request_id,
      trace_id: ctx.trace_id,
    });
    return error("Failed to record EC2 build failure", 500);
  }
}

export const ec2Routes: Route[] = [
  { method: "GET", pattern: parsePattern("/ec2/config"), handler: handleGetConfig },
  { method: "PUT", pattern: parsePattern("/ec2/config"), handler: handleSetConfig },
  { method: "POST", pattern: parsePattern("/ec2/trigger"), handler: handleTrigger },
  { method: "POST", pattern: parsePattern("/ec2/build-complete"), handler: handleBuildComplete },
  { method: "POST", pattern: parsePattern("/ec2/build-failed"), handler: handleBuildFailed },
];
