import { ciTagFor } from "./actions-mirror.service";

describe("ciTagFor", () => {
	it("maps GitHub Actions conclusions to canonical tags", () => {
		expect(ciTagFor("success")).toBe("ci-pass");
		expect(ciTagFor("failure")).toBe("ci-fail");
		expect(ciTagFor("timed_out")).toBe("ci-fail");
		expect(ciTagFor("cancelled")).toBe("ci-cancelled");
		expect(ciTagFor("skipped")).toBeNull();
		expect(ciTagFor("unknown")).toBeNull();
	});
});
