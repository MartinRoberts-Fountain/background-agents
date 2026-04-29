import type { WebhookEventMap } from "@octokit/webhooks-types";

export type PullRequestPayload = Extract<
  WebhookEventMap["pull_request"],
  { action: "opened" | "synchronize" | "closed" }
>;
export type IssueCommentPayload = Extract<WebhookEventMap["issue_comment"], { action: "created" }>;
export type PullRequestReviewCommentPayload = Extract<
  WebhookEventMap["pull_request_review_comment"],
  { action: "created" }
>;
export type CheckSuitePayload = Extract<WebhookEventMap["check_suite"], { action: "completed" }>;
export type IssuesPayload = Extract<WebhookEventMap["issues"], { action: "opened" | "labeled" }>;

export type SupportedGitHubPayload =
  | PullRequestPayload
  | IssueCommentPayload
  | PullRequestReviewCommentPayload
  | CheckSuitePayload
  | IssuesPayload;
