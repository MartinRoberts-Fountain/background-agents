/**
 * Coder sandbox provider implementation.
 *
 * Deploys sandbox environments as Coder workspaces.
 * Each sandbox is a Coder workspace created from a specific template.
 */

import {
  DEFAULT_SANDBOX_TIMEOUT_SECONDS,
  SandboxProviderError,
  type SandboxProvider,
  type SandboxProviderCapabilities,
  type CreateSandboxConfig,
  type CreateSandboxResult,
} from "../provider";
import { createLogger } from "../../logger";

const log = createLogger("coder-provider");

// ==================== Coder API Client ====================

export interface CoderApiConfig {
  /** Base URL of the Coder API (e.g., https://coder.example.com) */
  baseUrl: string;
  /** Coder session token */
  token: string;
  /** Organization ID where workspaces will be created */
  organizationId: string;
  /** Template ID to use for creating workspaces */
  templateId: string;
}

export interface CoderParameter {
  name: string;
  value: string;
}

export interface CoderWorkspaceResponse {
  id: string;
  name: string;
  latest_build: {
    status: string;
    job: {
      status: string;
    };
  };
}

/**
 * Client for the Coder API.
 */
export class CoderApiClient {
  private readonly config: CoderApiConfig;

  constructor(config: CoderApiConfig) {
    if (!config.baseUrl) {
      throw new Error("CoderApiClient requires baseUrl");
    }
    if (!config.token) {
      throw new Error("CoderApiClient requires token");
    }
    if (!config.organizationId) {
      throw new Error("CoderApiClient requires organizationId");
    }
    if (!config.templateId) {
      throw new Error("CoderApiClient requires templateId");
    }

    this.config = {
      ...config,
      baseUrl: CoderApiClient.normalizeBaseUrl(config.baseUrl),
    };
  }

  private static normalizeBaseUrl(baseUrl: string): string {
    const trimmed = baseUrl.trim();
    const withProtocol = /^[a-zA-Z][a-zA-Z\d+\-.]*:\/\//.test(trimmed)
      ? trimmed
      : `https://${trimmed}`;
    const withoutTrailingSlash = withProtocol.replace(/\/+$/, "");

    try {
      new URL(withoutTrailingSlash);
    } catch {
      throw new Error(`Invalid Coder API URL: ${baseUrl}`);
    }

    return withoutTrailingSlash;
  }

  private getHeaders(): Record<string, string> {
    return {
      "Content-Type": "application/json",
      "Coder-Session-Token": this.config.token,
    };
  }

  async createWorkspace(name: string, parameters: CoderParameter[]): Promise<CoderWorkspaceResponse> {
    const url = `${this.config.baseUrl}/api/v2/organizations/${this.config.organizationId}/members/me/workspaces`;
    const response = await fetch(url, {
      method: "POST",
      headers: this.getHeaders(),
      body: JSON.stringify({
        name,
        template_id: this.config.templateId,
        rich_parameter_values: parameters,
      }),
    });

    if (!response.ok) {
      const text = await response.text();
      throw new Error(`Coder API error (${response.status}): ${text}`);
    }

    return (await response.json()) as CoderWorkspaceResponse;
  }

  async deleteWorkspace(workspaceId: string): Promise<void> {
    const url = `${this.config.baseUrl}/api/v2/workspaces/${workspaceId}`;
    const response = await fetch(url, {
      method: "DELETE",
      headers: this.getHeaders(),
    });

    if (!response.ok) {
      const text = await response.text();
      throw new Error(`Coder API error (${response.status}): ${text}`);
    }
  }

  async getWorkspace(workspaceId: string): Promise<CoderWorkspaceResponse> {
    const url = `${this.config.baseUrl}/api/v2/workspaces/${workspaceId}`;
    const response = await fetch(url, {
      method: "GET",
      headers: this.getHeaders(),
    });

    if (!response.ok) {
      const text = await response.text();
      throw new Error(`Coder API error (${response.status}): ${text}`);
    }

    return (await response.json()) as CoderWorkspaceResponse;
  }
}

// ==================== Coder Sandbox Provider ====================

/**
 * Coder sandbox provider.
 *
 * Implements the SandboxProvider interface by creating Coder workspaces.
 */
export class CoderSandboxProvider implements SandboxProvider {
  readonly name = "coder";

  readonly capabilities: SandboxProviderCapabilities = {
    supportsSnapshots: false,
    supportsRestore: false,
    supportsWarm: false,
  };

  constructor(private readonly client: CoderApiClient) {}

  async deleteSandbox(workspaceId: string): Promise<void> {
    try {
      await this.client.deleteWorkspace(workspaceId);
      log.info("Workspace deletion initiated via Coder", {
        event: "sandbox.coder_deleted",
        workspace_id: workspaceId,
      });
    } catch (error) {
      throw this.classifyError("Failed to delete workspace via Coder", error);
    }
  }

  async createSandbox(config: CreateSandboxConfig): Promise<CreateSandboxResult> {
    try {
      // Generate a workspace name that is unique and Coder-compliant
      // Rules: max 32 chars, start with letter, lowercase alphanumeric + hyphens
      const workspaceName = ("ws-" + config.sandboxId.toLowerCase())
        .replace(/[^a-z0-9-]/g, "-")
        .replace(/-+/g, "-")
        .slice(0, 32)
        .replace(/-$/, "");

      const parameters: CoderParameter[] = [
        { name: "sandbox_id", value: config.sandboxId },
        { name: "session_id", value: config.sessionId },
        { name: "repo_owner", value: config.repoOwner },
        { name: "repo_name", value: config.repoName },
        { name: "control_plane_url", value: config.controlPlaneUrl },
        { name: "sandbox_auth_token", value: config.sandboxAuthToken },
        { name: "provider", value: config.provider },
        { name: "model", value: config.model },
      ];

      if (config.branch) parameters.push({ name: "branch", value: config.branch });
      if (config.agent) parameters.push({ name: "agent", value: config.agent });

      const timeoutSeconds = config.timeoutSeconds ?? DEFAULT_SANDBOX_TIMEOUT_SECONDS;
      parameters.push({ name: "timeout_seconds", value: String(timeoutSeconds) });

      // Add user env vars as parameters if needed by the template
      if (config.userEnvVars) {
        for (const [key, value] of Object.entries(config.userEnvVars)) {
          parameters.push({ name: `env_${key}`, value });
        }
      }

      const result = await this.client.createWorkspace(workspaceName, parameters);

      log.info("Workspace created via Coder", {
        event: "sandbox.coder_created",
        workspace_name: workspaceName,
        workspace_id: result.id,
        sandbox_id: config.sandboxId,
      });

      return {
        sandboxId: config.sandboxId,
        providerObjectId: result.id,
        status: "spawning",
        createdAt: Date.now(),
      };
    } catch (error) {
      throw this.classifyError("Failed to create sandbox via Coder", error);
    }
  }

  private classifyError(message: string, error: unknown): SandboxProviderError {
    if (error instanceof Error) {
      const errorMessage = error.message.toLowerCase();

      if (errorMessage.includes("401") || errorMessage.includes("unauthorized")) {
        return new SandboxProviderError(
          `${message}: Unauthorized. Verify CODER_TOKEN.`,
          "permanent",
          error
        );
      }

      if (
        errorMessage.includes("fetch failed") ||
        errorMessage.includes("timeout") ||
        errorMessage.includes("502") ||
        errorMessage.includes("503") ||
        errorMessage.includes("504")
      ) {
        return new SandboxProviderError(`${message}: ${error.message}`, "transient", error);
      }
    }

    return new SandboxProviderError(
      `${message}: ${error instanceof Error ? error.message : String(error)}`,
      "permanent",
      error instanceof Error ? error : undefined
    );
  }
}

/**
 * Create a Coder sandbox provider.
 */
export function createCoderProvider(config: CoderApiConfig): CoderSandboxProvider {
  const client = new CoderApiClient(config);
  return new CoderSandboxProvider(client);
}
