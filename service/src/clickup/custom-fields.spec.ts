import { Test } from "@nestjs/testing";
import { PrismaService } from "../prisma/prisma.service";
import { ClickUpDirectService } from "./clickup-direct.service";
import {
	CustomFieldsService,
	FIELDS_PER_LIST,
	FIELD_SPECS,
} from "./custom-fields";

describe("CustomFieldsService", () => {
	const calls: string[] = [];

	const fakeClickup = {
		getListCustomFields: jest.fn(),
		createCustomField: jest.fn(),
		setCustomFieldValue: jest.fn(),
	};

	const execs: Array<{ sql: string; args: unknown[] }> = [];
	const fakePrisma = {
		$executeRawUnsafe: jest.fn(async (sql: string, ...args: unknown[]) => {
			execs.push({ sql, args });
		}),
	};

	let svc: CustomFieldsService;

	beforeEach(async () => {
		calls.length = 0;
		execs.length = 0;
		fakeClickup.getListCustomFields.mockReset();
		fakeClickup.createCustomField.mockReset();
		fakeClickup.setCustomFieldValue.mockReset();
		fakePrisma.$executeRawUnsafe.mockClear();

		const moduleRef = await Test.createTestingModule({
			providers: [
				CustomFieldsService,
				{ provide: ClickUpDirectService, useValue: fakeClickup },
				{ provide: PrismaService, useValue: fakePrisma },
			],
		}).compile();
		svc = moduleRef.get(CustomFieldsService);
	});

	describe("seedFieldsForList", () => {
		it("creates all wanted fields when list has none", async () => {
			fakeClickup.getListCustomFields.mockResolvedValue([]);
			let counter = 0;
			fakeClickup.createCustomField.mockImplementation(async () => ({
				id: `f${++counter}`,
			}));

			const result = await svc.seedFieldsForList("LIST1", "bugs", "tok");

			const wanted = FIELDS_PER_LIST.bugs;
			expect(Object.keys(result).sort()).toEqual([...wanted].sort());
			expect(fakeClickup.createCustomField).toHaveBeenCalledTimes(
				wanted.length,
			);
		});

		it("re-uses existing fields by name (idempotent)", async () => {
			const wanted = FIELDS_PER_LIST.bugs;
			fakeClickup.getListCustomFields.mockResolvedValue(
				wanted.map((k, i) => ({
					id: `existing-${i}`,
					name: FIELD_SPECS[k].name,
				})),
			);

			const result = await svc.seedFieldsForList("LIST1", "bugs", "tok");

			expect(fakeClickup.createCustomField).not.toHaveBeenCalled();
			for (const k of wanted) {
				expect(result[k]).toMatch(/^existing-/);
			}
		});

		it("name match is case-insensitive", async () => {
			fakeClickup.getListCustomFields.mockResolvedValue([
				{ id: "u1", name: "AUTHOR_EMAIL" },
				{ id: "u2", name: "Author_Github_URL" },
			]);

			const result = await svc.seedFieldsForList("L", "adrs", "tok");

			expect(result.author_email).toBe("u1");
			expect(result.author_github_url).toBe("u2");
			expect(fakeClickup.createCustomField).not.toHaveBeenCalled();
		});

		it("dropdown fields pass type_config.options to createCustomField", async () => {
			fakeClickup.getListCustomFields.mockResolvedValue([]);
			fakeClickup.createCustomField.mockResolvedValue({ id: "x" });

			await svc.seedFieldsForList("L", "bugs", "tok");

			const severityCall = fakeClickup.createCustomField.mock.calls.find(
				(c) => c[1].name === "severity",
			);
			expect(severityCall).toBeDefined();
			expect(severityCall?.[1].type).toBe("drop_down");
			expect(severityCall?.[1].type_config?.options?.length).toBeGreaterThan(0);
		});

		it("returns {} when listSpec has no fields", async () => {
			const result = await svc.seedFieldsForList(
				"L",
				"history_overview",
				"tok",
			);
			expect(result).toEqual({});
			expect(fakeClickup.getListCustomFields).not.toHaveBeenCalled();
		});

		it("survives single-field createCustomField failure (continues on rest)", async () => {
			fakeClickup.getListCustomFields.mockResolvedValue([]);
			let n = 0;
			fakeClickup.createCustomField.mockImplementation(async () => {
				n++;
				if (n === 1) throw new Error("boom");
				return { id: `id${n}` };
			});

			const result = await svc.seedFieldsForList("L", "bugs", "tok");

			const wanted = FIELDS_PER_LIST.bugs;
			expect(Object.keys(result).length).toBe(wanted.length - 1);
		});

		it("returns {} when getListCustomFields throws (does not crash)", async () => {
			fakeClickup.getListCustomFields.mockRejectedValue(new Error("503"));
			const result = await svc.seedFieldsForList("L", "bugs", "tok");
			expect(result).toEqual({});
		});
	});

	describe("persistFieldIds", () => {
		it("issues a JSONB jsonb_set UPDATE scoped to listKey", async () => {
			await svc.persistFieldIds("PROJ-uuid", "active_sprint", {
				commit_sha: "F1",
				epic: "F2",
			});
			expect(fakePrisma.$executeRawUnsafe).toHaveBeenCalledTimes(1);
			const [_sql, projectId, path, value] =
				fakePrisma.$executeRawUnsafe.mock.calls[0];
			expect(projectId).toBe("PROJ-uuid");
			expect(path).toBe("{active_sprint}");
			expect(JSON.parse(value as string)).toEqual({
				commit_sha: "F1",
				epic: "F2",
			});
		});

		it("no-ops on empty fieldIds (avoids needless DB write)", async () => {
			await svc.persistFieldIds("p", "bugs", {});
			expect(fakePrisma.$executeRawUnsafe).not.toHaveBeenCalled();
		});
	});

	describe("setFieldsOnTask", () => {
		it("calls setCustomFieldValue for each value with mapped field id", async () => {
			fakeClickup.setCustomFieldValue.mockResolvedValue(undefined);
			await svc.setFieldsOnTask(
				"TASK1",
				{ commit_sha: "F1", epic: "F2", source: "F3" },
				{
					commit_sha: "abc1234",
					epic: "epic:api-backend",
					source: "commit",
				},
				"tok",
			);
			expect(fakeClickup.setCustomFieldValue).toHaveBeenCalledTimes(3);
		});

		it("skips values for keys without field id (project pre-dates seeding)", async () => {
			fakeClickup.setCustomFieldValue.mockResolvedValue(undefined);
			await svc.setFieldsOnTask(
				"TASK1",
				{ commit_sha: "F1" },
				{ commit_sha: "abc1234", epic: "epic:api-backend" },
				"tok",
			);
			expect(fakeClickup.setCustomFieldValue).toHaveBeenCalledTimes(1);
		});

		it("skips empty / null / undefined values", async () => {
			await svc.setFieldsOnTask(
				"T",
				{ commit_sha: "F1", epic: "F2" },
				{ commit_sha: "", epic: undefined as unknown as string },
				"tok",
			);
			expect(fakeClickup.setCustomFieldValue).not.toHaveBeenCalled();
		});

		it("no-ops when fieldIdsForList is undefined", async () => {
			await svc.setFieldsOnTask(
				"T",
				undefined,
				{ commit_sha: "abc1234" },
				"tok",
			);
			expect(fakeClickup.setCustomFieldValue).not.toHaveBeenCalled();
		});

		it("survives per-field setCustomFieldValue failure", async () => {
			fakeClickup.setCustomFieldValue.mockImplementation(async (_, id) => {
				if (id === "F2") throw new Error("nope");
			});
			await svc.setFieldsOnTask(
				"T",
				{ commit_sha: "F1", epic: "F2", source: "F3" },
				{ commit_sha: "abc", epic: "epic:x", source: "commit" },
				"tok",
			);
			expect(fakeClickup.setCustomFieldValue).toHaveBeenCalledTimes(3);
		});
	});
});
