/**
 * Mode-template routes and handlers.
 */

import { SESSION_MODES, type SessionMode } from "@open-inspect/shared";
import { ModeTemplateStore } from "../db/mode-templates";
import { createLogger } from "../logger";
import type { Env } from "../types";
import { type Route, type RequestContext, parsePattern, json, error } from "./shared";

const logger = createLogger("router:mode-templates");

async function handleListModeTemplates(
  _request: Request,
  env: Env,
  _match: RegExpMatchArray,
  ctx: RequestContext
): Promise<Response> {
  if (!env.DB) {
    return json({ templates: [] });
  }

  try {
    const store = new ModeTemplateStore(env.DB);
    const templates = await store.list();
    return json({ templates });
  } catch (e) {
    logger.error("Failed to list mode templates", {
      error: e instanceof Error ? e.message : String(e),
      request_id: ctx.request_id,
      trace_id: ctx.trace_id,
    });
    return json({ templates: [] });
  }
}

async function handleGetModeTemplate(
  _request: Request,
  env: Env,
  match: RegExpMatchArray,
  ctx: RequestContext
): Promise<Response> {
  const mode = match.groups?.mode as string;
  if (!SESSION_MODES.includes(mode as SessionMode)) {
    return error(`Invalid mode: ${mode}`, 400);
  }

  if (!env.DB) {
    return error("Mode template storage is not configured", 503);
  }

  try {
    const store = new ModeTemplateStore(env.DB);
    const template = await store.get(mode as SessionMode);
    if (!template) {
      return json({ mode, systemPrompt: "", defaultModel: null, updatedAt: 0 });
    }
    return json(template);
  } catch (e) {
    logger.error("Failed to get mode template", {
      error: e instanceof Error ? e.message : String(e),
      mode,
      request_id: ctx.request_id,
      trace_id: ctx.trace_id,
    });
    return error("Failed to get mode template", 500);
  }
}

async function handleUpsertModeTemplate(
  request: Request,
  env: Env,
  match: RegExpMatchArray,
  ctx: RequestContext
): Promise<Response> {
  const mode = match.groups?.mode as string;
  if (!SESSION_MODES.includes(mode as SessionMode)) {
    return error(`Invalid mode: ${mode}`, 400);
  }

  if (!env.DB) {
    return error("Mode template storage is not configured", 503);
  }

  let body: { systemPrompt?: string; defaultModel?: string | null };
  try {
    body = (await request.json()) as { systemPrompt?: string; defaultModel?: string | null };
  } catch {
    return error("Invalid JSON body", 400);
  }

  if (typeof body.systemPrompt !== "string") {
    return error("systemPrompt must be a string", 400);
  }

  try {
    const store = new ModeTemplateStore(env.DB);
    await store.upsert(mode as SessionMode, body.systemPrompt, body.defaultModel ?? null);

    logger.info("mode_template.updated", {
      event: "mode_template.updated",
      mode,
      request_id: ctx.request_id,
      trace_id: ctx.trace_id,
    });

    return json({ status: "updated", mode });
  } catch (e) {
    logger.error("Failed to update mode template", {
      error: e instanceof Error ? e.message : String(e),
      mode,
      request_id: ctx.request_id,
      trace_id: ctx.trace_id,
    });
    return error("Failed to update mode template", 500);
  }
}

export const modeTemplateRoutes: Route[] = [
  {
    method: "GET",
    pattern: parsePattern("/mode-templates"),
    handler: handleListModeTemplates,
  },
  {
    method: "GET",
    pattern: parsePattern("/mode-templates/:mode"),
    handler: handleGetModeTemplate,
  },
  {
    method: "PUT",
    pattern: parsePattern("/mode-templates/:mode"),
    handler: handleUpsertModeTemplate,
  },
];
