/**
 * Plan §L.1 — parse a coverage report into a single coverage_pct.
 *
 * Supports three common formats by sniffing the first non-empty bytes:
 *   - LCOV     ("TN:" / "SF:" lines)
 *   - cobertura XML (line-rate attribute on the root element)
 *   - istanbul json summary (statements.pct on the "total" key)
 *
 * Returns null on parse failure so callers can no-op without raising.
 */

export interface ParsedCoverage {
	coveragePct: number;
}

export function parseCoverageReport(
	raw: string | null | undefined,
): ParsedCoverage | null {
	if (!raw) return null;
	const text = raw.trim();
	if (text.length === 0) return null;
	if (text.startsWith("{")) return parseIstanbulJson(text);
	if (text.startsWith("<")) return parseCoberturaXml(text);
	if (text.startsWith("TN:") || text.startsWith("SF:")) return parseLcov(text);
	return null;
}

function parseLcov(raw: string): ParsedCoverage | null {
	let totalLines = 0;
	let hitLines = 0;
	for (const line of raw.split(/\r?\n/)) {
		if (line.startsWith("LF:")) totalLines += Number(line.slice(3)) || 0;
		else if (line.startsWith("LH:")) hitLines += Number(line.slice(3)) || 0;
	}
	if (totalLines === 0) return null;
	return { coveragePct: round2((hitLines / totalLines) * 100) };
}

function parseCoberturaXml(raw: string): ParsedCoverage | null {
	const m = /\bline-rate=["']([0-9.]+)["']/.exec(raw);
	if (!m) return null;
	const rate = Number(m[1]);
	if (!Number.isFinite(rate)) return null;
	return { coveragePct: round2(rate * 100) };
}

function parseIstanbulJson(raw: string): ParsedCoverage | null {
	try {
		const obj = JSON.parse(raw) as {
			total?: { statements?: { pct?: number }; lines?: { pct?: number } };
		};
		const pct = obj?.total?.statements?.pct ?? obj?.total?.lines?.pct ?? null;
		if (pct == null || !Number.isFinite(pct)) return null;
		return { coveragePct: round2(pct) };
	} catch {
		return null;
	}
}

function round2(n: number): number {
	return Math.round(n * 100) / 100;
}
