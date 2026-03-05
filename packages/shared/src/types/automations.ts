/**
 * Automation types shared across control-plane, web, and bots.
 */

export type AutomationRunStatus = "starting" | "running" | "completed" | "failed" | "skipped";

export interface Automation {
  id: string;
  name: string;
  repoOwner: string;
  repoName: string;
  baseBranch: string;
  repoId: number | null;
  instructions: string;
  triggerType: "schedule";
  scheduleCron: string | null;
  scheduleTz: string;
  model: string;
  enabled: boolean;
  nextRunAt: number | null;
  consecutiveFailures: number;
  createdBy: string;
  createdAt: number;
  updatedAt: number;
  deletedAt: number | null;
}

export interface AutomationRun {
  id: string;
  automationId: string;
  sessionId: string | null;
  status: AutomationRunStatus;
  skipReason: string | null;
  failureReason: string | null;
  scheduledAt: number;
  startedAt: number | null;
  completedAt: number | null;
  createdAt: number;
  sessionTitle: string | null;
  artifactSummary: string | null;
}

export interface AutomationCallbackContext {
  source: "automation";
  automationId: string;
  runId: string;
  automationName: string;
}

export interface ListAutomationsResponse {
  automations: Automation[];
  total: number;
}

export interface ListAutomationRunsResponse {
  runs: AutomationRun[];
  total: number;
}

export interface CreateAutomationRequest {
  name: string;
  repoOwner: string;
  repoName: string;
  baseBranch?: string;
  instructions: string;
  triggerType?: "schedule";
  scheduleCron: string;
  scheduleTz: string;
  model?: string;
}

export interface UpdateAutomationRequest {
  name?: string;
  instructions?: string;
  baseBranch?: string;
  scheduleCron?: string;
  scheduleTz?: string;
  model?: string;
  enabled?: boolean;
}
