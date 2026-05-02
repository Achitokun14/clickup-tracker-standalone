import {
	durationSeconds,
	renderDeploymentBody,
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
