import type { ParsedGitRemote } from "./git-remote-parse";

/**
 * Build a host-aware web URL for a commit SHA. Different hosts use different
 * path conventions:
 *   - GitHub / Gitea / Codeberg:   /{owner}/{repo}/commit/{sha}    (singular)
 *   - GitLab (incl. nested):       /{path}/-/commit/{sha}          (with -/ separator)
 *   - Bitbucket Cloud:             /{owner}/{repo}/commits/{sha}   (plural)
 *   - Bitbucket Server (self-hosted): caller must opt in via `host: "bitbucket-server"`.
 *
 * Returns null if remote info isn't enough to format a URL (e.g. unknown host
 * with no override).
 */
export function commitUrl(
	remote: ParsedGitRemote | null,
	sha: string,
	hint?: {
		kind?:
			| "github"
			| "gitlab"
			| "bitbucket-cloud"
			| "bitbucket-server"
			| "gitea"
			| "codeberg";
	},
): string | null {
	if (!remote || !sha) return null;
	const host = remote.host;
	const kind = hint?.kind ?? detectKind(host);
	if (!kind) {
		// Best-effort: assume GitHub-style for unknown hosts so the link is at
		// least probably-right (most self-hosted Gitea/Forgejo use this shape).
		return `https://${host}/${remote.ownerRepo}/commit/${sha}`;
	}
	switch (kind) {
		case "github":
		case "gitea":
		case "codeberg":
			return `https://${host}/${remote.ownerRepo}/commit/${sha}`;
		case "gitlab":
			return `https://${host}/${remote.ownerRepo}/-/commit/${sha}`;
		case "bitbucket-cloud":
			return `https://${host}/${remote.ownerRepo}/commits/${sha}`;
		case "bitbucket-server": {
			// Bitbucket Server: /projects/{PROJ}/repos/{repo}/commits/{sha}
			// ownerRepo for BB-Server should already be {PROJ}/{repo}.
			const [proj, repo] = remote.ownerRepo.split("/");
			if (!proj || !repo) return null;
			return `https://${host}/projects/${proj}/repos/${repo}/commits/${sha}`;
		}
		default:
			return null;
	}
}

function detectKind(
	host: string,
): "github" | "gitlab" | "bitbucket-cloud" | "gitea" | "codeberg" | null {
	if (host === "github.com") return "github";
	if (host === "gitlab.com" || /(^|\.)gitlab\./.test(host)) return "gitlab";
	if (host === "bitbucket.org") return "bitbucket-cloud";
	if (host === "codeberg.org") return "codeberg";
	if (/(^|\.)gitea\./.test(host)) return "gitea";
	return null;
}
