/**
 * Parse a git remote URL into { host, ownerRepo }. Handles:
 *   - GitHub HTTPS: https://github.com/owner/repo.git
 *   - GitHub SSH:   git@github.com:owner/repo.git
 *   - GitLab nested: https://gitlab.com/group/sub/repo.git
 *   - Bitbucket Cloud: https://bitbucket.org/owner/repo.git
 *   - Gitea / Codeberg / self-hosted GitLab: same shapes
 *
 * Returns null on URLs we can't confidently parse (file://, ssh-config aliases,
 * empty strings).
 */
export interface ParsedGitRemote {
	host: string;
	ownerRepo: string;
}

const REMOTE_RX =
	/^(?:https?:\/\/(?:[^@]+@)?|git@|ssh:\/\/(?:git@)?)([^:/]+)[:/](.+?)(?:\.git)?\/?$/;

export function parseGitRemote(url: string): ParsedGitRemote | null {
	if (!url) return null;
	const trimmed = url.trim();
	const m = REMOTE_RX.exec(trimmed);
	if (!m) return null;
	const host = m[1].toLowerCase();
	const ownerRepo = m[2].replace(/^\/+|\/+$/g, "");
	if (!host || !ownerRepo.includes("/")) return null;
	return { host, ownerRepo };
}
