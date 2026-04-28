import { Module } from "@nestjs/common";
import { GitHistoryExtractor } from "./git-history.extractor";
import { RepoExtractExtractor } from "./repo-extract.extractor";

/**
 * Server-side extractors. Pure I/O on the local filesystem; no network or
 * DB. Consumed by the planner (Session 3) and the backfill orchestrator
 * (Session 4).
 */
@Module({
	providers: [GitHistoryExtractor, RepoExtractExtractor],
	exports: [GitHistoryExtractor, RepoExtractExtractor],
})
export class ExtractorsModule {}
