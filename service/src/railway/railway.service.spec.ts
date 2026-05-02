import { statusEmoji, terminalStatus } from "./railway.service";

describe("railway helpers", () => {
	it("terminalStatus marks completed states", () => {
		expect(terminalStatus("SUCCESS")).toBe(true);
		expect(terminalStatus("FAILED")).toBe(true);
		expect(terminalStatus("CANCELLED")).toBe(true);
		expect(terminalStatus("REMOVED")).toBe(true);
		expect(terminalStatus("CRASHED")).toBe(true);
		expect(terminalStatus("BUILDING")).toBe(false);
		expect(terminalStatus("DEPLOYING")).toBe(false);
		expect(terminalStatus("QUEUED")).toBe(false);
	});

	it("statusEmoji maps each canonical status to a glyph", () => {
		expect(statusEmoji("SUCCESS")).toBe("✅");
		expect(statusEmoji("FAILED")).toBe("❌");
		expect(statusEmoji("CRASHED")).toBe("❌");
		expect(statusEmoji("CANCELLED")).toBe("⏸");
		expect(statusEmoji("REMOVED")).toBe("🗑");
		expect(statusEmoji("DEPLOYING")).toBe("🟪");
		expect(statusEmoji("BUILDING")).toBe("🟦");
		expect(statusEmoji("INITIALIZING")).toBe("⏳");
		expect(statusEmoji("QUEUED")).toBe("⏳");
		expect(statusEmoji("UNKNOWN")).toBe("•");
	});
});
