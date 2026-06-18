/**
 * Direct REST client for the RWX Dispatch API.
 *
 * Creates and polls dispatches on the RWX cloud platform.
 * API reference: https://www.rwx.com/docs/api/dispatches
 */

import { createLogger } from "../logger";

const log = createLogger("rwx-rest-client");

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

export interface RwxRestConfig {
  /** RWX API access token (Bearer auth) */
  apiToken: string;
  /** Override for tests or non-default RWX API base URL (default: https://cloud.rwx.com) */
  baseUrl?: string;
}

// ---------------------------------------------------------------------------
// Per-operation timeouts (ms)
// ---------------------------------------------------------------------------

const TIMEOUT_CREATE_MS = 30_000;
const TIMEOUT_GET_MS = 15_000;

const DEFAULT_RWX_BASE_URL = "https://cloud.rwx.com";

// ---------------------------------------------------------------------------
// Response types
// ---------------------------------------------------------------------------

export interface RwxCreateDispatchResponse {
  dispatch_id: string;
}

export interface RwxDispatchRun {
  run_id: string;
  run_url: string;
}

export interface RwxGetDispatchResponse {
  /** Dispatch lifecycle status (e.g. "pending", "dispatched"). */
  status: string;
  /** Error message if the dispatch failed. */
  error?: string;
  /** Runs created for this dispatch; empty while the run has not been created yet. */
  runs: RwxDispatchRun[];
}

// ---------------------------------------------------------------------------
// Request types
// ---------------------------------------------------------------------------

export interface RwxCreateDispatchParams {
  key: string;
  params?: Record<string, string>;
  ref?: string;
  title?: string;
}

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

/** Thrown for RWX API errors. Carries HTTP status for classification. */
export class RwxApiError extends Error {
  constructor(
    message: string,
    public readonly status: number
  ) {
    super(message);
    this.name = "RwxApiError";
  }
}

// ---------------------------------------------------------------------------
// Client
// ---------------------------------------------------------------------------

export class RwxRestClient {
  private readonly baseUrl: string;

  constructor(public readonly config: RwxRestConfig) {
    if (!config.apiToken) {
      throw new Error("RwxRestClient requires apiToken");
    }
    if (!config.dispatchKey) {
      throw new Error("RwxRestClient requires dispatchKey");
    }

    this.baseUrl = (config.baseUrl || DEFAULT_RWX_BASE_URL).replace(/\/+$/, "");
  }

  // -----------------------------------------------------------------------
  // Public API
  // -----------------------------------------------------------------------

  async createDispatch(params: RwxCreateDispatchParams): Promise<RwxCreateDispatchResponse> {
    const startMs = Date.now();
    try {
      return await this.request<RwxCreateDispatchResponse>(
        "POST",
        "/mint/api/runs/dispatches",
        TIMEOUT_CREATE_MS,
        params
      );
    } finally {
      log.info("rwx.create_dispatch", {
        duration_ms: Date.now() - startMs,
        dispatch_key: params.key,
      });
    }
  }

  async getDispatch(dispatchId: string): Promise<RwxGetDispatchResponse> {
    return this.request<RwxGetDispatchResponse>(
      "GET",
      `/mint/api/runs/dispatches/${encodeURIComponent(dispatchId)}`,
      TIMEOUT_GET_MS
    );
  }

  // -----------------------------------------------------------------------
  // Internals
  // -----------------------------------------------------------------------

  private getHeaders(): Record<string, string> {
    return {
      "Content-Type": "application/json",
      Accept: "application/json",
      Authorization: `Bearer ${this.config.apiToken}`,
    };
  }

  private async request<T>(
    method: "GET" | "POST",
    path: string,
    timeoutMs: number,
    body?: unknown
  ): Promise<T> {
    const url = `${this.baseUrl}${path}`;
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

    try {
      const init: RequestInit = {
        method,
        headers: this.getHeaders(),
        signal: controller.signal,
      };
      if (body !== undefined) {
        init.body = JSON.stringify(body);
      }

      const response = await fetch(url, init);

      if (!response.ok) {
        const text = await response.text();
        throw new RwxApiError(text || response.statusText, response.status);
      }

      return (await response.json()) as T;
    } finally {
      clearTimeout(timeoutId);
    }
  }
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export function createRwxRestClient(config: RwxRestConfig): RwxRestClient {
  return new RwxRestClient(config);
}
