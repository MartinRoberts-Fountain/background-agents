/**
 * RWX sandbox provider — triggers a dispatch on the RWX cloud platform.
 *
 * Each sandbox creation POSTs to the RWX Dispatch API with all sandbox
 * environment variables serialised as dispatch params. The user's RWX workflow
 * must define a dispatch trigger with a matching key and map the params to env
 * vars (see https://www.rwx.com/docs/dispatch-triggers).
 *
 * Capabilities: RWX dispatches are ephemeral CI runs. There is no filesystem
 * snapshot API, no persistent resume, and no explicit stop endpoint exposed by
 * the Dispatch API.
 */

import { computeHmacHex } from "@open-inspect/shared";
import { createLogger } from "../../logger";
import type { SourceControlProviderName } from "../../source-control";
import { buildSessionConfig } from "../sandbox-env";
import { RwxApiError, type RwxRestClient } from "../rwx-rest-client";
import {
  SandboxProviderError,
  type CreateSandboxConfig,
  type CreateSandboxResult,
  type SandboxProvider,
  type SandboxProviderCapabilities,
} from "../provider";

const log = createLogger("rwx-provider");

// ---------------------------------------------------------------------------
// Provider config
// ---------------------------------------------------------------------------

export interface RwxProviderConfig {
  scmProvider: SourceControlProviderName;
  /** Secret used for HMAC derivation of code-server passwords */
  codeServerPasswordSecret: string;
}

// ---------------------------------------------------------------------------
// Provider
// ---------------------------------------------------------------------------

export class RwxSandboxProvider implements SandboxProvider {
  readonly name = "rwx";

  readonly capabilities: SandboxProviderCapabilities = {
    supportsSnapshots: false,
    supportsRestore: false,
    supportsWarm: false,
    supportsPersistentResume: false,
    supportsExplicitStop: false,
  };

  constructor(
    private readonly client: RwxRestClient,
    private readonly providerConfig: RwxProviderConfig
  ) {}

  // -----------------------------------------------------------------------
  // SandboxProvider interface
  // -----------------------------------------------------------------------

  async createSandbox(config: CreateSandboxConfig): Promise<CreateSandboxResult> {
    try {
      const params = await this.buildDispatchParams(config);

      const dispatch = await this.client.createDispatch({
        key: `${config.repoOwner}-${config.repoName}`,
        params,
        ref: config.branch,
        title: `Open-Inspect session ${config.sessionId}`,
      });

      log.info("rwx.sandbox_dispatched", {
        session_id: config.sessionId,
        sandbox_id: config.sandboxId,
        dispatch_id: dispatch.dispatch_id,
      });

      return {
        sandboxId: config.sandboxId,
        providerObjectId: dispatch.dispatch_id,
        status: "warming",
        createdAt: Date.now(),
      };
    } catch (error) {
      throw this.classifyError("Failed to create RWX sandbox dispatch", error);
    }
  }

  // -----------------------------------------------------------------------
  // Dispatch param assembly
  // -----------------------------------------------------------------------

  private async buildDispatchParams(config: CreateSandboxConfig): Promise<Record<string, string>> {
    // Start with user env vars (repo secrets), then overlay system vars so
    // user values cannot shadow the control-plane contract.
    const params: Record<string, string> = { ...(config.userEnvVars ?? {}) };

    const sessionConfig = buildSessionConfig(config);

    Object.assign(params, {
      slug: config.sessionId,
      PYTHONUNBUFFERED: "1",
      SANDBOX_ID: config.sandboxId,
      CONTROL_PLANE_URL: config.controlPlaneUrl,
      SANDBOX_AUTH_TOKEN: config.sandboxAuthToken,
      REPO_OWNER: config.repoOwner,
      REPO_NAME: config.repoName,
      SESSION_CONFIG: JSON.stringify(sessionConfig),
    });

    if (config.codeServerEnabled) {
      params.CODE_SERVER_PASSWORD = await this.deriveCodeServerPassword(config.sandboxId);
    }

    if (config.agentSlackNotifyEnabled) {
      params.AGENT_SLACK_NOTIFY_ENABLED = "true";
    }

    this.injectScmParams(params);

    return params;
  }

  private injectScmParams(params: Record<string, string>): void {
    if (this.providerConfig.scmProvider === "gitlab") {
      params.VCS_HOST = "gitlab.com";
      params.VCS_CLONE_USERNAME = "oauth2";
    } else if (this.providerConfig.scmProvider === "bitbucket") {
      params.VCS_HOST = "bitbucket.org";
      params.VCS_CLONE_USERNAME = "x-token-auth";
    } else {
      params.VCS_HOST = "github.com";
      params.VCS_CLONE_USERNAME = "x-access-token";
    }
  }

  // -----------------------------------------------------------------------
  // Code-server password
  // -----------------------------------------------------------------------

  private async deriveCodeServerPassword(sandboxId: string): Promise<string> {
    const digest = await computeHmacHex(
      `code-server:${sandboxId}`,
      this.providerConfig.codeServerPasswordSecret
    );
    return digest.slice(0, 32);
  }

  // -----------------------------------------------------------------------
  // Error classification
  // -----------------------------------------------------------------------

  private classifyError(message: string, error: unknown): SandboxProviderError {
    if (error instanceof RwxApiError) {
      return SandboxProviderError.fromFetchError(
        `${message}: ${error.message}`,
        error,
        error.status
      );
    }
    return SandboxProviderError.fromFetchError(message, error);
  }
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export function createRwxProvider(
  client: RwxRestClient,
  providerConfig: RwxProviderConfig
): RwxSandboxProvider {
  return new RwxSandboxProvider(client, providerConfig);
}
