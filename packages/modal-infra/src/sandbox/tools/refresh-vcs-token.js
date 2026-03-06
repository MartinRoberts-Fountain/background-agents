/**
 * Refresh VCS Token Tool — requests a new GitHub/SCM token and updates the git remote.
 *
 * Use this when git push or pull operations fail due to an expired token.
 */
import { tool } from "@opencode-ai/plugin"
import { bridgeFetch, extractError } from "./_bridge-client.js"
import { spawnSync } from "child_process"
import { existsSync } from "fs"

export default tool({
  name: "refresh-vcs-token",
  description:
    "Refresh the version control (VCS) token for this sandbox. Use this if you encounter authentication errors during git operations (like git push). The tool fetches a new token from the control plane and automatically updates the 'origin' remote URL.",
  args: {},
  async execute() {
    try {
      const response = await bridgeFetch("/internal/vcs-token-refresh", {
        method: "POST",
      })

      if (!response.ok) {
        const errorMessage = await extractError(response)
        return `Failed to refresh VCS token: ${errorMessage} (HTTP ${response.status})`
      }

      const { token } = await response.json()
      if (!token) {
        return "Failed to refresh VCS token: No token returned from control plane."
      }

      // Get repo info from environment
      const repoOwner = process.env.REPO_OWNER
      const repoName = process.env.REPO_NAME
      const vcsHost = process.env.VCS_HOST || "github.com"
      const vcsCloneUsername = process.env.VCS_CLONE_USERNAME || "x-access-token"

      if (!repoOwner || !repoName) {
        return "Failed to update git remote: REPO_OWNER or REPO_NAME environment variables are missing."
      }

      // Determine the workspace directory. We prefer the repo directory if it exists.
      const workspacePath = "/workspace"
      const repoPath = `${workspacePath}/${repoName}`
      const cwd = existsSync(`${repoPath}/.git`) ? repoPath : workspacePath

      // Update the git remote URL.
      const remoteUrl = `https://${vcsCloneUsername}:${token}@${vcsHost}/${repoOwner}/${repoName}.git`

      const result = spawnSync("git", ["remote", "set-url", "origin", remoteUrl], { cwd })

      if (result.status !== 0) {
        return `VCS token was refreshed, but failed to update git remote: ${result.stderr?.toString() || "Unknown error"}`
      }

      // Also update environment variables for the current process and potential children
      process.env.VCS_CLONE_TOKEN = token
      if (process.env.SCM_PROVIDER === "github" || vcsHost === "github.com") {
        process.env.GITHUB_APP_TOKEN = token
        process.env.GITHUB_TOKEN = token
      }

      return [
        "VCS token refreshed successfully.",
        "The 'origin' remote URL has been updated with the new token.",
        "You can now retry your git operations."
      ].join("\n")
    } catch (error) {
      return `Failed to refresh VCS token: ${error instanceof Error ? error.message : String(error)}`
    }
  },
})
