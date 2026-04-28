#!/usr/bin/env node
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
	CallToolRequestSchema,
	ListResourcesRequestSchema,
	ListToolsRequestSchema,
	ReadResourceRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";

const BASE_URL = (
	process.env.CUP_TRACKER_BASE_URL || "http://localhost:4020"
).replace(/\/$/, "");
const API_TOKEN = process.env.CUP_TRACKER_API_TOKEN || "";
const ORG_ID =
	process.env.CUP_TRACKER_ORG_ID || "00000000-0000-0000-0000-000000000000";

function authHeaders(): Record<string, string> {
	const h: Record<string, string> = { "X-Organisation-Id": ORG_ID };
	if (API_TOKEN) h.Authorization = `Bearer ${API_TOKEN}`;
	return h;
}

async function http<T = unknown>(
	method: string,
	path: string,
	body?: unknown,
): Promise<T> {
	const headers: Record<string, string> = { ...authHeaders() };
	let payload: string | undefined;
	if (body !== undefined) {
		headers["Content-Type"] = "application/json";
		payload = JSON.stringify(body);
	}
	const res = await fetch(`${BASE_URL}${path}`, {
		method,
		headers,
		body: payload,
	});
	const text = await res.text();
	if (!res.ok) {
		throw new Error(
			`HTTP ${res.status} ${method} ${path} — ${text || res.statusText}`,
		);
	}
	if (!text) return undefined as T;
	try {
		return JSON.parse(text) as T;
	} catch {
		return text as unknown as T;
	}
}

const TOOL_DEFS = [
	{
		name: "clickup_list_projects",
		description: "List all tracked projects in the active organisation.",
		inputSchema: { type: "object", properties: {} },
	},
	{
		name: "clickup_register_project",
		description:
			"Register a local repo path with clickup-tracker. Creates a ClickUp Folder + 3 Lists. Returns hookSecret ONCE.",
		inputSchema: {
			type: "object",
			required: ["localPath"],
			properties: {
				localPath: {
					type: "string",
					description: "Absolute path to the repo.",
				},
				displayName: {
					type: "string",
					description: "Display name (defaults to basename of localPath).",
				},
			},
		},
	},
	{
		name: "clickup_resolve_project",
		description:
			"Resolve which tracked project (if any) owns a given filesystem path (longest-prefix match).",
		inputSchema: {
			type: "object",
			required: ["path"],
			properties: { path: { type: "string" } },
		},
	},
	{
		name: "clickup_sync_project",
		description:
			"Enqueue an immediate drift sync for a project (instead of waiting for the cron).",
		inputSchema: {
			type: "object",
			required: ["projectId"],
			properties: { projectId: { type: "string" } },
		},
	},
	{
		name: "clickup_backup_project",
		description:
			"Take a manual snapshot of the project's ClickUp Folder/Lists/Tasks tree.",
		inputSchema: {
			type: "object",
			required: ["projectId"],
			properties: { projectId: { type: "string" } },
		},
	},
	{
		name: "clickup_list_backups",
		description: "List available backups for a project.",
		inputSchema: {
			type: "object",
			required: ["projectId"],
			properties: { projectId: { type: "string" } },
		},
	},
	{
		name: "clickup_restore_project",
		description:
			"Restore a project's ClickUp tree from a backup. mode = additive | merge | replace (replace requires confirm:true).",
		inputSchema: {
			type: "object",
			required: ["projectId", "backupId"],
			properties: {
				projectId: { type: "string" },
				backupId: { type: "string" },
				mode: {
					type: "string",
					enum: ["additive", "merge", "replace"],
					default: "additive",
				},
				confirm: { type: "boolean", default: false },
			},
		},
	},
	{
		name: "clickup_get_status",
		description:
			"Composite health + project-list snapshot. If `cwd` is provided, also resolves which project (if any) owns it.",
		inputSchema: {
			type: "object",
			properties: {
				cwd: {
					type: "string",
					description: "Optional working directory to resolve.",
				},
			},
		},
	},
];

const server = new Server(
	{ name: "clickup-tracker", version: "0.1.0" },
	{ capabilities: { tools: {}, resources: {} } },
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({
	tools: TOOL_DEFS,
}));

server.setRequestHandler(ListResourcesRequestSchema, async () => ({
	resources: [
		{
			uri: "clickup://projects",
			name: "Tracked projects",
			description:
				"List of all projects tracked by the clickup-tracker daemon.",
			mimeType: "application/json",
		},
	],
}));

server.setRequestHandler(ReadResourceRequestSchema, async (req) => {
	if (req.params.uri !== "clickup://projects") {
		throw new Error(`Unknown resource: ${req.params.uri}`);
	}
	const projects = await http("GET", "/projects");
	return {
		contents: [
			{
				uri: "clickup://projects",
				mimeType: "application/json",
				text: JSON.stringify(projects, null, 2),
			},
		],
	};
});

server.setRequestHandler(CallToolRequestSchema, async (req) => {
	const { name, arguments: rawArgs } = req.params;
	const args = (rawArgs ?? {}) as Record<string, unknown>;
	try {
		const result = await dispatch(name, args);
		return {
			content: [
				{
					type: "text",
					text:
						typeof result === "string"
							? result
							: JSON.stringify(result, null, 2),
				},
			],
		};
	} catch (err) {
		return {
			isError: true,
			content: [
				{
					type: "text",
					text: err instanceof Error ? err.message : String(err),
				},
			],
		};
	}
});

async function dispatch(
	name: string,
	args: Record<string, unknown>,
): Promise<unknown> {
	switch (name) {
		case "clickup_list_projects":
			return http("GET", "/projects");

		case "clickup_register_project": {
			const localPath = String(args.localPath ?? "");
			if (!localPath) throw new Error("localPath is required");
			const displayName =
				typeof args.displayName === "string" && args.displayName
					? args.displayName
					: localPath.split(/[\\/]/).filter(Boolean).pop() || localPath;
			return http("POST", "/projects", { localPath, displayName });
		}

		case "clickup_resolve_project": {
			const p = String(args.path ?? "");
			if (!p) throw new Error("path is required");
			return http("GET", `/projects/resolve?path=${encodeURIComponent(p)}`);
		}

		case "clickup_sync_project":
			return http("POST", `/projects/${requireId(args)}/sync`);

		case "clickup_backup_project":
			return http("POST", `/projects/${requireId(args)}/backup`);

		case "clickup_list_backups":
			return http("GET", `/projects/${requireId(args)}/backups`);

		case "clickup_restore_project": {
			const projectId = requireId(args);
			const backupId = String(args.backupId ?? "");
			if (!backupId) throw new Error("backupId is required");
			const mode = (args.mode as string) || "additive";
			const body: Record<string, unknown> = { backupId, mode };
			if (mode === "replace") body.confirm = Boolean(args.confirm);
			return http("POST", `/projects/${projectId}/restore`, body);
		}

		case "clickup_get_status": {
			const [health, projects] = await Promise.all([
				http("GET", "/health").catch((e) => ({
					ok: false,
					error: String(e),
				})),
				http("GET", "/projects").catch(() => []),
			]);
			let resolved: unknown = null;
			if (typeof args.cwd === "string" && args.cwd) {
				resolved = await http(
					"GET",
					`/projects/resolve?path=${encodeURIComponent(args.cwd)}`,
				).catch(() => null);
			}
			return { health, projects, resolved };
		}

		default:
			throw new Error(`Unknown tool: ${name}`);
	}
}

function requireId(args: Record<string, unknown>): string {
	const id = String(args.projectId ?? "");
	if (!id) throw new Error("projectId is required");
	return id;
}

async function main(): Promise<void> {
	const transport = new StdioServerTransport();
	await server.connect(transport);
	console.error(
		`[clickup-tracker-mcp] connected (base=${BASE_URL}, org=${ORG_ID})`,
	);
}

main().catch((err) => {
	console.error("[clickup-tracker-mcp] fatal:", err);
	process.exit(1);
});
