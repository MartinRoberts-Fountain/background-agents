/**
 * Agent session event handler — orchestrates issue→session lifecycle.
 * Extracted from index.ts for modularity.
 */

import type {
  Env,
  CallbackContext,
  LinearIssueDetails,
  AgentSessionWebhook,
  AgentSessionWebhookIssue,
  IssueUpdateWebhook,
} from "./types";
import {
  getLinearClient,
  emitAgentActivity,
  fetchIssueDetails,
  updateAgentSession,
  getRepoSuggestions,
} from "./utils/linear-client";
import { generateInternalToken } from "./utils/internal";
import { classifyRepo } from "./classifier";
import { getAvailableRepos } from "./classifier/repos";
import { getLinearConfig } from "./utils/integration-config";
import { createLogger } from "./logger";
import { makePlan } from "./plan";
import {
  resolveStaticRepo,
  extractModelFromLabels,
  extractModeFromLabels,
  resolveSessionModelSettings,
} from "./model-resolution";
import type { SessionMode } from "./model-resolution";
import {
  getTeamRepoMapping,
  getProjectRepoMapping,
  getUserPreferences,
  lookupIssueSession,
  storeIssueSession,
} from "./kv-store";

const log = createLogger("handler");

// ─── Shared Constants ────────────────────────────────────────────────────────

const PLAN_MODE_INSTRUCTION =
  "IMPORTANT: You are in PLAN mode. Do NOT make any code changes or create a pull request. Instead, analyze the codebase and provide a detailed implementation plan that includes the files to modify, the specific changes needed, and any risks or considerations. The plans should not be overengineered or unnecessarily complex.";

const APPLY_MODE_INSTRUCTION =
  "IMPORTANT: You are in APPLY mode. Create a new branch off the base branch, implement the changes, commit, and call the create-pull-request tool to open a pull request. Do NOT use the gh CLI. Use the `spawn-task` tool to spawn any large or complex tasks that can be done independently of the main task to create a separate pull request.";

const SESSION_THREAD_MARKER = "This thread is for an agent session with fountaincodingagent.";

/** Status names that trigger an automatic apply session from a plan. */
const PLAN_TRIGGER_STATUSES = new Set(["todo", "to do"]);

function getModeInstruction(mode: SessionMode): string {
  return mode === "plan" ? PLAN_MODE_INSTRUCTION : APPLY_MODE_INSTRUCTION;
}

export function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

async function getAuthHeaders(env: Env, traceId?: string): Promise<Record<string, string>> {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (env.INTERNAL_CALLBACK_SECRET) {
    const authToken = await generateInternalToken(env.INTERNAL_CALLBACK_SECRET);
    headers["Authorization"] = `Bearer ${authToken}`;
  }
  if (traceId) headers["x-trace-id"] = traceId;
  return headers;
}

// ─── Control Plane Helpers ────────────────────────────────────────────────────

interface CreateSessionParams {
  env: Env;
  headers: Record<string, string>;
  repoOwner: string;
  repoName: string;
  title: string;
  model: string;
  reasoningEffort: string | undefined;
  mode: SessionMode;
  sandboxProvider: "helm" | "ec2";
}

async function createControlPlaneSession(
  params: CreateSessionParams
): Promise<{ sessionId: string } | null> {
  const res = await params.env.CONTROL_PLANE.fetch("https://internal/sessions", {
    method: "POST",
    headers: params.headers,
    body: JSON.stringify({
      repoOwner: params.repoOwner,
      repoName: params.repoName,
      title: params.title,
      model: params.model,
      reasoningEffort: params.reasoningEffort,
      mode: params.mode,
      sandboxProvider: params.sandboxProvider,
    }),
  });

  if (!res.ok) {
    return null;
  }
  return (await res.json()) as { sessionId: string };
}

interface SendPromptParams {
  env: Env;
  headers: Record<string, string>;
  sessionId: string;
  content: string;
  callbackContext: CallbackContext;
  authorId?: string;
}

async function sendSessionPrompt(params: SendPromptParams): Promise<boolean> {
  const body: Record<string, unknown> = {
    content: params.content,
    source: "linear",
    callbackContext: params.callbackContext,
  };
  if (params.authorId) body.authorId = params.authorId;

  const res = await params.env.CONTROL_PLANE.fetch(
    `https://internal/sessions/${params.sessionId}/prompt`,
    { method: "POST", headers: params.headers, body: JSON.stringify(body) }
  );
  return res.ok;
}

function isSessionThreadMarkerComment(body: string): boolean {
  const normalized = body.trim();
  return (
    normalized === SESSION_THREAD_MARKER ||
    normalized === `**Unknown:** ${SESSION_THREAD_MARKER}` ||
    normalized === `**Agent instruction:** ${SESSION_THREAD_MARKER}` ||
    normalized ===
      `**Unknown:** ${SESSION_THREAD_MARKER}\n\n---\n**Agent instruction:** ${SESSION_THREAD_MARKER}`
  );
}

// ─── Sub-handlers ────────────────────────────────────────────────────────────

async function handleStop(webhook: AgentSessionWebhook, env: Env, traceId: string): Promise<void> {
  const startTime = Date.now();
  const agentSessionId = webhook.agentSession.id;
  const issueId = webhook.agentSession.issue?.id;

  if (issueId) {
    const existingSession = await lookupIssueSession(env, issueId);
    if (existingSession) {
      const headers = await getAuthHeaders(env, traceId);
      try {
        const stopRes = await env.CONTROL_PLANE.fetch(
          `https://internal/sessions/${existingSession.sessionId}/stop`,
          { method: "POST", headers }
        );
        log.info("agent_session.stopped", {
          trace_id: traceId,
          agent_session_id: agentSessionId,
          session_id: existingSession.sessionId,
          issue_id: issueId,
          stop_status: stopRes.status,
        });
      } catch (e) {
        log.error("agent_session.stop_failed", {
          trace_id: traceId,
          session_id: existingSession.sessionId,
          error: e instanceof Error ? e : new Error(String(e)),
        });
      }
      await env.LINEAR_KV.delete(`issue:${issueId}`);
    }
  }

  log.info("agent_session.stop_handled", {
    trace_id: traceId,
    action: webhook.action,
    agent_session_id: agentSessionId,
    duration_ms: Date.now() - startTime,
  });
}

async function handleFollowUp(
  webhook: AgentSessionWebhook,
  issue: AgentSessionWebhookIssue,
  env: Env,
  traceId: string
): Promise<void> {
  const startTime = Date.now();
  const agentSessionId = webhook.agentSession.id;
  const comment = webhook.agentSession.comment;
  const agentActivity = webhook.agentActivity;
  const orgId = webhook.organizationId;

  const client = await getLinearClient(env, orgId);
  if (!client) {
    log.error("agent_session.no_oauth_token", {
      trace_id: traceId,
      org_id: orgId,
      agent_session_id: agentSessionId,
    });
    return;
  }

  const existingSession = await lookupIssueSession(env, issue.id);
  if (!existingSession) return;

  // agentActivity is always bot-originated (echoed back by Linear); skip it
  if (agentActivity?.body) {
    log.info("agent_session.followup_skipped_bot_content", {
      trace_id: traceId,
      agent_session_id: agentSessionId,
      issue_id: issue.id,
    });
    return;
  }

  const followUpContent = comment?.body || "Follow-up on the issue.";

  const isPlanMode = existingSession.mode === "plan";

  await emitAgentActivity(
    client,
    agentSessionId,
    {
      type: "thought",
      body: isPlanMode
        ? "Processing feedback to revise the plan..."
        : "Processing follow-up message...",
    },
    true
  );

  const headers = await getAuthHeaders(env, traceId);
  let sessionContext = "";
  try {
    const eventsRes = await env.CONTROL_PLANE.fetch(
      `https://internal/sessions/${existingSession.sessionId}/events?limit=50`,
      { method: "GET", headers }
    );
    if (eventsRes.ok) {
      const eventsData = (await eventsRes.json()) as {
        events: Array<{ type: string; data: Record<string, unknown> }>;
      };
      const recentTokens = eventsData.events.filter((e) => e.type === "token").slice(-1);
      if (recentTokens.length > 0) {
        const lastContent = String(recentTokens[0].data.content ?? "");
        if (lastContent) {
          sessionContext = `\n\n---\n**Previous agent response:**\n${lastContent}`;
        }
      }
    }
  } catch {
    /* best effort */
  }

  let promptContent: string;
  if (isPlanMode) {
    promptContent = `Follow-up on ${issue.identifier} — the user has provided feedback on the plan. Please revise the plan based on their comments and provide an updated implementation plan.\n\n**User feedback:**\n${followUpContent}${sessionContext}\n\n${PLAN_MODE_INSTRUCTION} Revise your previous plan based on the feedback above. Provide the complete updated plan, not just the changes.`;
  } else {
    promptContent = `Follow-up on ${issue.identifier}:\n\n${followUpContent}${sessionContext}`;
  }

  const promptRes = await env.CONTROL_PLANE.fetch(
    `https://internal/sessions/${existingSession.sessionId}/prompt`,
    {
      method: "POST",
      headers,
      body: JSON.stringify({
        content: promptContent,
        authorId: `linear:${webhook.appUserId}`,
        source: "linear",
      }),
    }
  );

  if (promptRes.ok) {
    await emitAgentActivity(client, agentSessionId, {
      type: "response",
      body: isPlanMode
        ? `Revising plan based on feedback.\n\n[View session](${env.WEB_APP_URL}/session/${existingSession.sessionId})`
        : `Follow-up sent to existing session.\n\n[View session](${env.WEB_APP_URL}/session/${existingSession.sessionId})`,
    });
  } else {
    await emitAgentActivity(client, agentSessionId, {
      type: "error",
      body: isPlanMode
        ? "Failed to send plan revision to the existing session."
        : "Failed to send follow-up to the existing session.",
    });
  }

  log.info("agent_session.followup", {
    trace_id: traceId,
    issue_identifier: issue.identifier,
    session_id: existingSession.sessionId,
    agent_session_id: agentSessionId,
    duration_ms: Date.now() - startTime,
  });
}

async function handleNewSession(
  webhook: AgentSessionWebhook,
  issue: AgentSessionWebhookIssue,
  env: Env,
  traceId: string
): Promise<void> {
  const startTime = Date.now();
  const agentSessionId = webhook.agentSession.id;
  const comment = webhook.agentSession.comment;
  const orgId = webhook.organizationId;

  // Determine mode early from webhook labels (refined after fetching full details)
  const earlyMode: SessionMode = extractModeFromLabels(issue.labels ?? []) ?? "apply";

  const client = await getLinearClient(env, orgId);
  if (!client) {
    log.error("agent_session.no_oauth_token", {
      trace_id: traceId,
      org_id: orgId,
      agent_session_id: agentSessionId,
    });
    return;
  }

  await updateAgentSession(client, agentSessionId, { plan: makePlan("start", earlyMode) });
  await emitAgentActivity(
    client,
    agentSessionId,
    {
      type: "thought",
      body: "Analyzing issue and resolving repository...",
    },
    true
  );

  // Fetch full issue details for context
  const issueDetails = await fetchIssueDetails(client, issue.id);
  const labels = issueDetails?.labels || issue.labels || [];
  const labelNames = labels.map((l) => l.name);
  const projectInfo = issueDetails?.project || issue.project;

  // Resolve mode and sandbox provider based on ticket status
  const stateName = (issueDetails?.state?.name || issue.state?.name || "").toLowerCase();
  let mode: SessionMode = extractModeFromLabels(labels) ?? earlyMode;
  let sandboxProvider: "helm" | "ec2" = "ec2";

  if (stateName === "triage" || stateName === "backlog") {
    mode = "plan";
    sandboxProvider = "helm";
  }

  // ─── Resolve repo ─────────────────────────────────────────────────────

  let repoOwner: string | null = null;
  let repoName: string | null = null;
  let repoFullName: string | null = null;
  let classificationReasoning: string | null = null;

  // 1. Check project→repo mapping FIRST
  if (projectInfo?.id) {
    const projectMapping = await getProjectRepoMapping(env);
    const mapped = projectMapping[projectInfo.id];
    if (mapped) {
      repoOwner = mapped.owner;
      repoName = mapped.name;
      repoFullName = `${mapped.owner}/${mapped.name}`;
      classificationReasoning = `Project "${projectInfo.name}" is mapped to ${repoFullName}`;
    }
  }

  // 2. Check static team→repo mapping (override)
  if (!repoOwner) {
    const teamMapping = await getTeamRepoMapping(env);
    const teamId = issue.team?.id ?? "";
    if (teamId && teamMapping[teamId] && teamMapping[teamId].length > 0) {
      const staticRepo = resolveStaticRepo(teamMapping, teamId, labelNames);
      if (staticRepo) {
        repoOwner = staticRepo.owner;
        repoName = staticRepo.name;
        repoFullName = `${staticRepo.owner}/${staticRepo.name}`;
        classificationReasoning = `Team static mapping`;
      }
    }
  }

  // 3. Try Linear's built-in issueRepositorySuggestions API
  if (!repoOwner) {
    const repos = await getAvailableRepos(env, traceId);
    if (repos.length > 0) {
      const candidates = repos.map((r) => ({
        hostname: "github.com",
        repositoryFullName: `${r.owner}/${r.name}`,
      }));

      const suggestions = await getRepoSuggestions(client, issue.id, agentSessionId, candidates);
      const topSuggestion = suggestions.find((s) => s.confidence >= 0.7);
      if (topSuggestion) {
        const [owner, name] = topSuggestion.repositoryFullName.split("/");
        repoOwner = owner;
        repoName = name;
        repoFullName = topSuggestion.repositoryFullName;
        classificationReasoning = `Linear suggested ${repoFullName} (confidence: ${Math.round(topSuggestion.confidence * 100)}%)`;
      }
    }
  }

  // 4. Fall back to our LLM classification
  if (!repoOwner) {
    await emitAgentActivity(
      client,
      agentSessionId,
      {
        type: "thought",
        body: "Classifying repository using AI...",
      },
      true
    );

    const classification = await classifyRepo(
      env,
      issue.title,
      issue.description,
      labelNames,
      projectInfo?.name,
      traceId
    );

    if (classification.needsClarification || !classification.repo) {
      const altList = (classification.alternatives || [])
        .map((r) => `- **${r.fullName}**: ${r.description}`)
        .join("\n");

      await emitAgentActivity(client, agentSessionId, {
        type: "elicitation",
        body: `I couldn't determine which repository to work on.\n\n${classification.reasoning}\n\n**Available repositories:**\n${altList || "None available"}\n\nPlease reply with the repository name, or configure a project→repo mapping.`,
      });

      log.warn("agent_session.classification_uncertain", {
        trace_id: traceId,
        issue_identifier: issue.identifier,
        confidence: classification.confidence,
        reasoning: classification.reasoning,
      });
      return;
    }

    repoOwner = classification.repo.owner;
    repoName = classification.repo.name;
    repoFullName = classification.repo.fullName;
    classificationReasoning = classification.reasoning;
  }

  if (!repoOwner || !repoName || !repoFullName) {
    await emitAgentActivity(client, agentSessionId, {
      type: "elicitation",
      body: "I couldn't determine which repository to work on. Please configure a project→repo or team→repo mapping and try again.",
    });
    log.warn("agent_session.repo_resolution_failed", {
      trace_id: traceId,
      issue_identifier: issue.identifier,
    });
    return;
  }

  const integrationConfig = await getLinearConfig(env, repoFullName.toLowerCase());
  if (
    integrationConfig.enabledRepos !== null &&
    !integrationConfig.enabledRepos.includes(repoFullName.toLowerCase())
  ) {
    await emitAgentActivity(client, agentSessionId, {
      type: "error",
      body: `The Linear integration is not enabled for \`${repoFullName}\`.`,
    });
    log.info("agent_session.repo_not_enabled", {
      trace_id: traceId,
      issue_identifier: issue.identifier,
      repo: repoFullName,
    });
    return;
  }

  // ─── Resolve model ────────────────────────────────────────────────────

  let userModel: string | undefined;
  let userReasoningEffort: string | undefined;
  const appUserId = webhook.appUserId;
  if (appUserId) {
    const prefs = await getUserPreferences(env, appUserId);
    if (prefs?.model) {
      userModel = prefs.model;
    }
    userReasoningEffort = prefs?.reasoningEffort;
  }

  const labelModel = extractModelFromLabels(labels);
  const { model, reasoningEffort } = resolveSessionModelSettings({
    envDefaultModel: env.DEFAULT_MODEL,
    configModel: integrationConfig.model,
    configReasoningEffort: integrationConfig.reasoningEffort,
    allowUserPreferenceOverride: integrationConfig.allowUserPreferenceOverride,
    allowLabelModelOverride: integrationConfig.allowLabelModelOverride,
    userModel,
    userReasoningEffort,
    labelModel,
  });

  // ─── Create session ───────────────────────────────────────────────────

  await updateAgentSession(client, agentSessionId, { plan: makePlan("repo_resolved", mode) });
  await emitAgentActivity(
    client,
    agentSessionId,
    {
      type: "thought",
      body: `Creating coding session on ${repoFullName} (model: ${model}, mode: ${mode})...`,
    },
    true
  );

  const headers = await getAuthHeaders(env, traceId);

  const session = await createControlPlaneSession({
    env,
    headers,
    repoOwner: repoOwner!,
    repoName: repoName!,
    title: `${issue.identifier}: ${issue.title}`,
    model,
    reasoningEffort,
    mode,
    sandboxProvider,
  });

  if (!session) {
    await emitAgentActivity(client, agentSessionId, {
      type: "error",
      body: "Failed to create a coding session.",
    });
    log.error("control_plane.create_session", {
      trace_id: traceId,
      issue_identifier: issue.identifier,
      repo: repoFullName,
      duration_ms: Date.now() - startTime,
    });
    return;
  }

  await storeIssueSession(env, issue.id, {
    sessionId: session.sessionId,
    issueId: issue.id,
    issueIdentifier: issue.identifier,
    repoOwner: repoOwner!,
    repoName: repoName!,
    model,
    agentSessionId,
    mode,
    createdAt: Date.now(),
  });

  // Set externalUrls and update plan
  await updateAgentSession(client, agentSessionId, {
    externalUrls: [
      { label: "View Session", url: `${env.WEB_APP_URL}/session/${session.sessionId}` },
    ],
    plan: makePlan("session_created", mode),
  });

  // ─── Build and send prompt ────────────────────────────────────────────

  // Prefer Linear's promptContext; append mode instruction when using it
  const basePrompt =
    webhook.agentSession.promptContext || buildPrompt(issue, issueDetails, comment, mode);
  const prompt = webhook.agentSession.promptContext
    ? `${basePrompt}\n\n${getModeInstruction(mode)}`
    : basePrompt;

  const callbackContext: CallbackContext = {
    source: "linear",
    issueId: issue.id,
    issueIdentifier: issue.identifier,
    issueUrl: issue.url,
    repoFullName: repoFullName!,
    model,
    agentSessionId,
    organizationId: orgId,
    emitToolProgressActivities: integrationConfig.emitToolProgressActivities,
  };

  const promptOk = await sendSessionPrompt({
    env,
    headers,
    sessionId: session.sessionId,
    content: prompt,
    callbackContext,
    authorId: `linear:${webhook.appUserId}`,
  });

  if (!promptOk) {
    await emitAgentActivity(client, agentSessionId, {
      type: "error",
      body: "Failed to send the prompt to the coding session.",
    });
    log.error("control_plane.send_prompt", {
      trace_id: traceId,
      session_id: session.sessionId,
      issue_identifier: issue.identifier,
      duration_ms: Date.now() - startTime,
    });
    return;
  }

  await emitAgentActivity(client, agentSessionId, {
    type: "response",
    body: `${mode === "plan" ? "Planning" : "Working on"} \`${repoFullName}\` with **${model}**.\n\n${classificationReasoning ? `*${classificationReasoning}*\n\n` : ""}[View session](${env.WEB_APP_URL}/session/${session.sessionId})`,
  });

  log.info("agent_session.session_created", {
    trace_id: traceId,
    session_id: session.sessionId,
    agent_session_id: agentSessionId,
    issue_identifier: issue.identifier,
    repo: repoFullName,
    mode,
    model,
    classification_reasoning: classificationReasoning,
    duration_ms: Date.now() - startTime,
  });
}

// ─── Issue Status Change → Apply Trigger ─────────────────────────────────────

export async function handleIssueStatusChange(
  webhook: IssueUpdateWebhook,
  env: Env,
  traceId: string
): Promise<void> {
  const startTime = Date.now();
  const issueData = webhook.data;
  const newStateName = issueData.state.name.toLowerCase();

  // Only trigger on transitions TO "To Do" / "Todo"
  if (!PLAN_TRIGGER_STATUSES.has(newStateName)) {
    log.debug("issue_status_change.ignored_state", {
      trace_id: traceId,
      issue_id: issueData.id,
      new_state: issueData.state.name,
    });
    return;
  }

  // Must have had a stateId change (not just any update)
  if (!webhook.updatedFrom.stateId) {
    log.debug("issue_status_change.no_state_change", {
      trace_id: traceId,
      issue_id: issueData.id,
    });
    return;
  }

  // Look up existing plan session for this issue
  const existingSession = await lookupIssueSession(env, issueData.id);
  if (!existingSession || existingSession.mode !== "plan") {
    log.debug("issue_status_change.no_plan_session", {
      trace_id: traceId,
      issue_id: issueData.id,
      issue_identifier: issueData.identifier,
      has_session: Boolean(existingSession),
      mode: existingSession?.mode,
    });
    return;
  }

  const orgId = webhook.organizationId;
  const client = await getLinearClient(env, orgId);
  if (!client) {
    log.error("issue_status_change.no_oauth_token", {
      trace_id: traceId,
      org_id: orgId,
      issue_id: issueData.id,
    });
    return;
  }

  log.info("issue_status_change.triggering_apply", {
    trace_id: traceId,
    issue_id: issueData.id,
    issue_identifier: issueData.identifier,
    plan_session_id: existingSession.sessionId,
    new_state: issueData.state.name,
  });

  const headers = await getAuthHeaders(env, traceId);

  // Stop the old plan session (best effort)
  try {
    await env.CONTROL_PLANE.fetch(`https://internal/sessions/${existingSession.sessionId}/stop`, {
      method: "POST",
      headers,
    });
  } catch {
    /* best effort */
  }

  // Fetch full issue details for label-based model override
  const issueDetails = await fetchIssueDetails(client, issueData.id);
  const labels = issueDetails?.labels || issueData.labels || [];

  // Resolve model settings
  const integrationConfig = await getLinearConfig(
    env,
    `${existingSession.repoOwner}/${existingSession.repoName}`.toLowerCase()
  );
  const labelModel = extractModelFromLabels(labels);
  const { model, reasoningEffort } = resolveSessionModelSettings({
    envDefaultModel: env.DEFAULT_MODEL,
    configModel: integrationConfig.model,
    configReasoningEffort: integrationConfig.reasoningEffort,
    allowUserPreferenceOverride: integrationConfig.allowUserPreferenceOverride,
    allowLabelModelOverride: integrationConfig.allowLabelModelOverride,
    labelModel,
  });

  // Create new apply-mode session
  const repoOwner = existingSession.repoOwner;
  const repoName = existingSession.repoName;
  const repoFullName = `${repoOwner}/${repoName}`;

  const session = await createControlPlaneSession({
    env,
    headers,
    repoOwner,
    repoName,
    title: `${issueData.identifier}: ${issueData.title}`,
    model,
    reasoningEffort,
    mode: "apply",
    sandboxProvider: "ec2",
  });

  if (!session) {
    log.error("issue_status_change.create_session_failed", {
      trace_id: traceId,
      issue_identifier: issueData.identifier,
      repo: repoFullName,
    });
    return;
  }

  // Store the new session mapping (replaces the plan session)
  await storeIssueSession(env, issueData.id, {
    sessionId: session.sessionId,
    issueId: issueData.id,
    issueIdentifier: issueData.identifier,
    repoOwner,
    repoName,
    model,
    agentSessionId: existingSession.agentSessionId,
    mode: "apply",
    createdAt: Date.now(),
  });

  // Build prompt — plan output is on the Linear ticket and is included
  // in promptContext for new agent sessions automatically.
  const promptParts: string[] = [
    `Linear Issue: ${issueData.identifier} — ${issueData.title}`,
    `URL: ${issueData.url}`,
    "",
    issueData.description || "(No description provided)",
    "",
    getModeInstruction("apply"),
  ];

  const callbackContext: CallbackContext = {
    source: "linear",
    issueId: issueData.id,
    issueIdentifier: issueData.identifier,
    issueUrl: issueData.url,
    repoFullName,
    model,
    agentSessionId: existingSession.agentSessionId,
    organizationId: orgId,
    emitToolProgressActivities: integrationConfig.emitToolProgressActivities,
  };

  const promptOk = await sendSessionPrompt({
    env,
    headers,
    sessionId: session.sessionId,
    content: promptParts.join("\n"),
    callbackContext,
  });

  if (!promptOk) {
    log.error("issue_status_change.send_prompt_failed", {
      trace_id: traceId,
      session_id: session.sessionId,
      issue_identifier: issueData.identifier,
    });
    return;
  }

  // Emit agent activity if we have a stored agentSessionId (best effort)
  if (existingSession.agentSessionId) {
    try {
      await emitAgentActivity(client, existingSession.agentSessionId, {
        type: "response",
        body: `Ticket moved to **${issueData.state.name}** — starting apply session on \`${repoFullName}\` with **${model}**.\n\n[View session](${env.WEB_APP_URL}/session/${session.sessionId})`,
      });
    } catch {
      /* best effort */
    }
  }

  log.info("issue_status_change.apply_session_created", {
    trace_id: traceId,
    session_id: session.sessionId,
    plan_session_id: existingSession.sessionId,
    issue_identifier: issueData.identifier,
    repo: repoFullName,
    model,
    duration_ms: Date.now() - startTime,
  });
}

// ─── Dispatcher ──────────────────────────────────────────────────────────────

export async function handleAgentSessionEvent(
  webhook: AgentSessionWebhook,
  env: Env,
  traceId: string
): Promise<void> {
  const agentSessionId = webhook.agentSession.id;
  const issue = webhook.agentSession.issue;

  log.info("agent_session.received", {
    trace_id: traceId,
    action: webhook.action,
    agent_session_id: agentSessionId,
    issue_id: issue?.id,
    issue_identifier: issue?.identifier,
    has_comment: Boolean(webhook.agentSession.comment),
    org_id: webhook.organizationId,
  });

  // Stop handling
  if (webhook.action === "stopped" || webhook.action === "cancelled") {
    return handleStop(webhook, env, traceId);
  }

  if (!issue) {
    log.warn("agent_session.no_issue", { trace_id: traceId, agent_session_id: agentSessionId });
    return;
  }

  // Follow-up handling (action: "prompted" with existing session)
  const existingSession = await lookupIssueSession(env, issue.id);
  if (existingSession && webhook.action === "prompted") {
    return handleFollowUp(webhook, issue, env, traceId);
  }

  // New session only when the agent was just assigned or mentioned (action "created").
  // Ignore "prompted" with no existing session (e.g. race or our own activity echoed back).
  if (webhook.action !== "created") {
    log.info("agent_session.new_session_skipped_wrong_action", {
      trace_id: traceId,
      agent_session_id: agentSessionId,
      issue_id: issue.id,
      action: webhook.action,
    });
    return;
  }

  // agentActivity without a user comment means Linear echoed back our own activity; skip it
  if (!webhook.agentSession.comment?.body && webhook.agentActivity?.body) {
    log.info("agent_session.new_session_skipped_bot_content", {
      trace_id: traceId,
      agent_session_id: agentSessionId,
      issue_id: issue.id,
    });
    return;
  }

  return handleNewSession(webhook, issue, env, traceId);
}

// ─── Prompt Builder ──────────────────────────────────────────────────────────

function buildPrompt(
  issue: { identifier: string; title: string; description?: string | null; url: string },
  issueDetails: LinearIssueDetails | null,
  comment?: { body: string } | null,
  mode: SessionMode = "apply"
): string {
  const parts: string[] = [
    `Linear Issue: ${issue.identifier} — ${issue.title}`,
    `URL: ${issue.url}`,
    "",
    issue.description || "(No description provided)",
  ];

  if (issueDetails) {
    if (issueDetails.labels.length > 0) {
      parts.push("", `**Labels:** ${issueDetails.labels.map((l) => l.name).join(", ")}`);
    }
    if (issueDetails.project) {
      parts.push(`**Project:** ${issueDetails.project.name}`);
    }
    if (issueDetails.assignee) {
      parts.push(`**Assignee:** ${issueDetails.assignee.name}`);
    }
    if (issueDetails.priorityLabel) {
      parts.push(`**Priority:** ${issueDetails.priorityLabel}`);
    }

    const recentComments = issueDetails.comments
      .filter((c) => !isSessionThreadMarkerComment(c.body))
      .slice(-5);

    if (recentComments.length > 0) {
      parts.push("", "---", "**Recent comments:**");
      for (const c of recentComments) {
        const author = c.user?.name || "Unknown";
        parts.push(`- **${author}:** ${c.body.slice(0, 200)}`);
      }
    }
  }

  if (comment?.body && !isSessionThreadMarkerComment(comment.body)) {
    parts.push("", "---", `**Agent instruction:** ${comment.body}`);
  }

  parts.push("", getModeInstruction(mode));

  return parts.join("\n");
}
