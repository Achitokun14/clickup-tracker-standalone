import {
	durationSeconds,
	renderDeploymentBody,
	renderDeploymentsPageMd,
} from "./deployment-mirror.service";
import type { RailwayDeployment } from "./railway.service";

const sampleDep: RailwayDeployment = {
	id: "dep-1",
	status: "SUCCESS",
	commitSha: "abc1234deadbeef",
	environmentId: "env-prod",
	environmentName: "production",
	serviceId: "svc-1",
	createdAt: "2026-05-02T10:14:00Z",
	finishedAt: "2026-05-02T10:17:12Z",
	staticUrl: "https://app.up.railway.app",
};

describe("deployment-mirror helpers", () => {
	it("durationSeconds returns finishedAt-createdAt in seconds", () => {
		expect(durationSeconds(sampleDep)).toBe(192);
	});

	it("durationSeconds returns null when timestamps are missing or inverted", () => {
		expect(durationSeconds({ ...sampleDep, finishedAt: null })).toBeNull();
		expect(durationSeconds({ ...sampleDep, createdAt: null })).toBeNull();
		expect(
			durationSeconds({
				...sampleDep,
				createdAt: "2026-05-02T10:20:00Z",
				finishedAt: "2026-05-02T10:14:00Z",
			}),
		).toBeNull();
	});

	it("renderDeploymentsPageMd renders an empty-state when no rows", () => {
		const md = renderDeploymentsPageMd([]);
		expect(md).toContain("# Deployments");
		expect(md).toContain("No deployments mirrored yet");
	});

	it("renderDeploymentsPageMd renders a 6-col table for each row", () => {
		const md = renderDeploymentsPageMd([
			{
				id: "d1",
				environment: "production",
				status: "SUCCESS",
				commit_sha: "abc1234deadbeef",
				started_at: new Date("2026-05-02T10:14:00Z"),
				finished_at: new Date("2026-05-02T10:17:00Z"),
				cu_task_id: "T-1",
			},
		]);
		expect(md).toContain(
			"| Started | Env | Status | Commit | Duration | CU Task |",
		);
		expect(md).toContain("`production`");
		expect(md).toContain("✅ SUCCESS");
		expect(md).toContain("`abc1234`");
		expect(md).toContain("180s");
		expect(md).toContain("`T-1`");
	});

	it("renderDeploymentBody surfaces commit, env, duration, status emoji", () => {
		const md = renderDeploymentBody(sampleDep);
		expect(md).toContain("**Service:**");
		expect(md).toContain("**Environment:** production");
		expect(md).toContain("abc1234deadbeef");
		expect(md).toContain("**Duration:** 192s");
		expect(md).toContain("✅ SUCCESS");
		expect(md).toContain("https://app.up.railway.app");
		expect(md).toContain("Auto-imported by clickup-tracker");
	});
});
