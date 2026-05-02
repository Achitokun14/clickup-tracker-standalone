import { Injectable, Logger } from "@nestjs/common";

/**
 * Plan §N.1 — Railway GraphQL client.
 *
 * Endpoint: https://backboard.railway.com/graphql/v2
 * Auth: Bearer ${RAILWAY_API_TOKEN} (account-scoped personal token).
 *
 * The Railway public schema is a moving target, so we keep the query
 * surface minimal and defensive: each method returns the smallest set
 * of fields the daemon actually consumes. Schema drift only breaks the
 * specific call that referenced a missing field; the cron loop logs +
 * skips and tries the next project.
 */

export interface RailwayProject {
	id: string;
	name: string;
}

export interface RailwayService {
	id: string;
	name: string;
	projectId: string;
}

export interface RailwayDeployment {
	id: string;
	status: string; // BUILDING | DEPLOYING | SUCCESS | FAILED | CANCELLED | REMOVED | INITIALIZING | QUEUED
	commitSha: string | null;
	environmentId: string | null;
	environmentName: string | null;
	serviceId: string;
	createdAt: string | null;
	finishedAt: string | null;
	staticUrl: string | null;
}

const ENDPOINT =
	process.env.RAILWAY_GRAPHQL_URL || "https://backboard.railway.com/graphql/v2";

@Injectable()
export class RailwayApiService {
	private readonly log = new Logger(RailwayApiService.name);

	get configured(): boolean {
		return Boolean(process.env.RAILWAY_API_TOKEN);
	}

	private get token(): string {
		return process.env.RAILWAY_API_TOKEN ?? "";
	}

	async listProjects(): Promise<RailwayProject[]> {
		const data = await this.gql<{
			me: {
				projects: { edges: Array<{ node: { id: string; name: string } }> };
			};
		}>(`
			query { me { projects { edges { node { id name } } } } }
		`);
		return data.me.projects.edges.map((e) => e.node);
	}

	async listServices(projectId: string): Promise<RailwayService[]> {
		const data = await this.gql<{
			project: {
				services: { edges: Array<{ node: { id: string; name: string } }> };
			};
		}>(
			`query($id: String!) {
				project(id: $id) {
					services { edges { node { id name } } }
				}
			}`,
			{ id: projectId },
		);
		return data.project.services.edges.map((e) => ({
			id: e.node.id,
			name: e.node.name,
			projectId,
		}));
	}

	/**
	 * Deployments for a service since `since` (inclusive). Up to `limit`
	 * most-recent rows. Caller filters by environment if needed.
	 */
	async listDeployments(input: {
		projectId: string;
		serviceId: string;
		since?: Date;
		limit?: number;
	}): Promise<RailwayDeployment[]> {
		const data = await this.gql<{
			deployments: {
				edges: Array<{
					node: {
						id: string;
						status: string;
						staticUrl: string | null;
						createdAt: string | null;
						updatedAt: string | null;
						meta: { commitHash?: string | null } | null;
						environmentId: string | null;
						environment: { name: string | null } | null;
						serviceId: string;
					};
				}>;
			};
		}>(
			`query($projectId: String!, $serviceId: String!, $first: Int) {
				deployments(
					input: { projectId: $projectId, serviceId: $serviceId },
					first: $first
				) {
					edges { node {
						id status staticUrl createdAt updatedAt
						meta { commitHash }
						environmentId
						environment { name }
						serviceId
					} }
				}
			}`,
			{
				projectId: input.projectId,
				serviceId: input.serviceId,
				first: input.limit ?? 50,
			},
		);
		const since = input.since?.getTime();
		const out: RailwayDeployment[] = [];
		for (const edge of data.deployments.edges) {
			const node = edge.node;
			const created = node.createdAt ? Date.parse(node.createdAt) : 0;
			if (since && created && created < since) continue;
			out.push({
				id: node.id,
				status: node.status,
				commitSha: node.meta?.commitHash ?? null,
				environmentId: node.environmentId,
				environmentName: node.environment?.name ?? null,
				serviceId: node.serviceId,
				createdAt: node.createdAt,
				finishedAt: terminalStatus(node.status) ? node.updatedAt : null,
				staticUrl: node.staticUrl,
			});
		}
		return out;
	}

	async getDeploymentLogs(
		deploymentId: string,
		limit = 200,
	): Promise<string[]> {
		const data = await this.gql<{
			deploymentLogs: Array<{ message: string }>;
		}>(
			`query($id: String!, $limit: Int) {
				deploymentLogs(deploymentId: $id, limit: $limit) { message }
			}`,
			{ id: deploymentId, limit },
		);
		return (data.deploymentLogs ?? []).map((r) => r.message);
	}

	private async gql<T>(
		query: string,
		variables: Record<string, unknown> = {},
	): Promise<T> {
		if (!this.configured) {
			throw new Error("RAILWAY_API_TOKEN not configured");
		}
		const res = await fetch(ENDPOINT, {
			method: "POST",
			headers: {
				Authorization: `Bearer ${this.token}`,
				"Content-Type": "application/json",
			},
			body: JSON.stringify({ query, variables }),
		});
		if (!res.ok) {
			throw new Error(
				`railway gql ${res.status}: ${(await res.text()).slice(0, 200)}`,
			);
		}
		const body = (await res.json()) as {
			data?: T;
			errors?: Array<{ message: string }>;
		};
		if (body.errors?.length) {
			throw new Error(
				`railway gql: ${body.errors.map((e) => e.message).join("; ")}`,
			);
		}
		if (!body.data) throw new Error("railway gql: empty data");
		return body.data;
	}
}

export function terminalStatus(status: string): boolean {
	const s = status.toUpperCase();
	return (
		s === "SUCCESS" ||
		s === "FAILED" ||
		s === "CANCELLED" ||
		s === "REMOVED" ||
		s === "CRASHED"
	);
}

export function statusEmoji(status: string): string {
	switch (status.toUpperCase()) {
		case "SUCCESS":
			return "✅";
		case "FAILED":
		case "CRASHED":
			return "❌";
		case "CANCELLED":
			return "⏸";
		case "REMOVED":
			return "🗑";
		case "DEPLOYING":
			return "🟪";
		case "BUILDING":
			return "🟦";
		case "INITIALIZING":
		case "QUEUED":
			return "⏳";
		default:
			return "•";
	}
}
