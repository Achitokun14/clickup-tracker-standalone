import {
	DEPLOYMENT_ENV_OPTIONS,
	DEPLOYMENT_FIELD_KEYS,
	DEPLOYMENT_STATUS_OPTIONS,
	seedDeploymentFields,
} from "./deployment-fields";

describe("seedDeploymentFields", () => {
	it("creates the 5 deployment fields when none exist", async () => {
		const calls: any[] = [];
		const clickup = {
			getListCustomFields: jest.fn().mockResolvedValue([]),
			createCustomField: jest.fn(async (_listId: string, body: any) => {
				calls.push(body);
				return { id: `id-${body.name}` };
			}),
		};
		const r = await seedDeploymentFields(clickup as any, "L1", "T");
		expect(r.created).toEqual([...DEPLOYMENT_FIELD_KEYS]);
		expect(r.existing).toEqual([]);
		expect(r.ids.environment).toBe("id-environment");
		expect(r.ids.commit_sha).toBe("id-commit_sha");
		// status dropdown carries all 7 Railway statuses
		const status = calls.find((c) => c.name === "deployment_status");
		expect(status.type_config.options.map((o: any) => o.name)).toEqual([
			...DEPLOYMENT_STATUS_OPTIONS,
		]);
		// env dropdown carries the 3 canonical environments
		const env = calls.find((c) => c.name === "environment");
		expect(env.type_config.options.map((o: any) => o.name)).toEqual([
			...DEPLOYMENT_ENV_OPTIONS,
		]);
	});

	it("is idempotent — preserves existing field ids and only fills the gap", async () => {
		const clickup = {
			getListCustomFields: jest.fn().mockResolvedValue([
				{ id: "EX-env", name: "environment" },
				{ id: "EX-sha", name: "commit_sha" },
			]),
			createCustomField: jest
				.fn()
				.mockImplementation(async (_l: string, body: any) => ({
					id: `new-${body.name}`,
				})),
		};
		const r = await seedDeploymentFields(clickup as any, "L1", "T");
		expect(r.existing.sort()).toEqual(["commit_sha", "environment"]);
		expect(r.created.sort()).toEqual([
			"build_duration_seconds",
			"deploy_url",
			"deployment_status",
		]);
		expect(r.ids.environment).toBe("EX-env");
		expect(r.ids.commit_sha).toBe("EX-sha");
		expect(r.ids.deploy_url).toBe("new-deploy_url");
		expect(clickup.createCustomField).toHaveBeenCalledTimes(3);
	});
});
