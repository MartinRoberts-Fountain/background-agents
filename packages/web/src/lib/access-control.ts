export interface AccessControlConfig {
  allowedDomains: string[];
  allowedUsers: string[];
}

export interface AccessCheckParams {
  githubUsername?: string;
  email?: string;
}

/**
 * Parse comma-separated environment variable into a lowercase, trimmed array
 */
export function parseAllowlist(value: string | undefined): string[] {
  if (!value) return [];
  return value
    .split(",")
    .map((item) => item.trim().toLowerCase())
    .filter(Boolean);
}

/**
 * Check if a user is allowed to sign in based on access control configuration.
 *
 * Returns true if:
 * - Both allowlists are empty (no restrictions)
 * - User's GitHub username is in allowedUsers
 * - User's email domain is in allowedDomains
 *
 * Logic is OR-based: matching either list grants access.
 */
export function checkAccessAllowed(
  config: AccessControlConfig,
  params: AccessCheckParams
): boolean {
  const { allowedDomains, allowedUsers } = config;
  const { githubUsername, email } = params;

  // No restrictions if both lists are empty
  if (allowedDomains.length === 0 && allowedUsers.length === 0) {
    return true;
  }

  // Check explicit user allowlist (GitHub username)
  if (githubUsername && allowedUsers.includes(githubUsername.toLowerCase())) {
    return true;
  }

  // Check email domain allowlist
  if (email) {
    const domain = email.toLowerCase().split("@")[1];
    if (domain && allowedDomains.includes(domain)) {
      return true;
    }
  }

  return false;
}

/** GitHub API response shape for GET /user/memberships/orgs */
interface GitHubOrgMembership {
  organization?: { login?: string };
  state?: string;
}

/**
 * Check if the authenticated user is a member of any of the allowed GitHub organizations.
 * Uses the GitHub API with the user's access token (requires OAuth scope "read:org").
 *
 * @param accessToken - User's GitHub OAuth access token
 * @param allowedOrgs - Allowed org logins (case-insensitive). If empty, returns true (no org restriction).
 */
export async function checkGitHubOrgMembership(
  accessToken: string,
  allowedOrgs: string[]
): Promise<boolean> {
  if (allowedOrgs.length === 0) return true;

  const allowedSet = new Set(allowedOrgs.map((o) => o.toLowerCase()));
  let page = 1;
  const perPage = 100;

  while (true) {
    const url = `https://api.github.com/user/memberships/orgs?state=active&per_page=${perPage}&page=${page}`;
    const res = await fetch(url, {
      headers: {
        Accept: "application/vnd.github+json",
        Authorization: `Bearer ${accessToken}`,
        "X-GitHub-Api-Version": "2022-11-28",
      },
    });

    if (!res.ok) return false;

    const data = (await res.json()) as GitHubOrgMembership[];
    for (const m of data) {
      const login = m.organization?.login?.toLowerCase();
      if (login && allowedSet.has(login)) return true;
    }

    if (data.length < perPage) break;
    page += 1;
  }

  return false;
}
