import { Module } from "@nestjs/common";
import { PrismaService } from "../prisma/prisma.service";
import { ScrumModule } from "../scrum/scrum.module";
import { GithubWebhookController } from "./github-webhook.controller";

@Module({
	imports: [ScrumModule],
	controllers: [GithubWebhookController],
	providers: [PrismaService],
})
export class GithubModule {}
