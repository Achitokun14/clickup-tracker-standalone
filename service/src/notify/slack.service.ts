import { Injectable, Logger } from "@nestjs/common";

/**
 * Plan §K.4 — opt-in one-way Slack bridge.
 *
 * Activation: SLACK_WEBHOOK_URL env var. Per-project channel routing
 * via scrum_config.slack_channel (CU webhook payloads include `channel`
 * field; default channel from the webhook URL is used otherwise).
 *
 * Posts on:
 *   - sprint plan finalised (goal + selected count)
 *   - critical bug opened (severity:critical tag)
 *   - sprint ends (retro summary)
 *
 * No Slack app needed — incoming webhook only. Posts are best-effort:
 * on transport error we log + continue, never throw to the caller.
 */
@Injectable()
export class SlackService {
	private readonly log = new Logger(SlackService.name);

	configured(): boolean {
		return Boolean(process.env.SLACK_WEBHOOK_URL);
	}

	async postSprintPlan(input: {
		projectName: string;
		isoWeek: string;
		goal: string;
		taskCount: number;
		channel?: string;
	}): Promise<{ posted: boolean }> {
		const text =
			`:rocket: *${input.projectName}* — Sprint plan ${input.isoWeek}\n` +
			`Goal: ${input.goal}\n` +
			`Selected: ${input.taskCount} task(s)`;
		return this.post({ text, channel: input.channel });
	}

	async postCriticalBug(input: {
		projectName: string;
		taskName: string;
		taskUrl?: string;
		reporterEmail?: string;
		channel?: string;
	}): Promise<{ posted: boolean }> {
		const link = input.taskUrl
			? `<${input.taskUrl}|${input.taskName}>`
			: input.taskName;
		const reporter = input.reporterEmail ? ` (${input.reporterEmail})` : "";
		const text = `:rotating_light: *${input.projectName}* — critical bug opened${reporter}\n${link}`;
		return this.post({ text, channel: input.channel });
	}

	async postRetroSummary(input: {
		projectName: string;
		isoWeek: string;
		delivered: number;
		committed: number;
		channel?: string;
	}): Promise<{ posted: boolean }> {
		const pct =
			input.committed > 0
				? Math.round((input.delivered / input.committed) * 100)
				: 0;
		const text =
			`:checkered_flag: *${input.projectName}* — Retro ${input.isoWeek}\n` +
			`Delivered: ${input.delivered}/${input.committed} (${pct}%)`;
		return this.post({ text, channel: input.channel });
	}

	private async post(payload: {
		text: string;
		channel?: string;
	}): Promise<{ posted: boolean }> {
		const url = process.env.SLACK_WEBHOOK_URL;
		if (!url) return { posted: false };
		try {
			const body: Record<string, unknown> = { text: payload.text };
			if (payload.channel) body.channel = payload.channel;
			const r = await fetch(url, {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify(body),
			});
			if (!r.ok) {
				this.log.debug(`slack post HTTP ${r.status}`);
				return { posted: false };
			}
			return { posted: true };
		} catch (err) {
			this.log.debug(`slack post failed: ${(err as Error).message}`);
			return { posted: false };
		}
	}
}
