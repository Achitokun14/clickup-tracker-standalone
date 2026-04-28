import { Body, Controller, Headers, Post, Req, UseGuards } from '@nestjs/common';
import { EventsService } from './events.service';
import { GitHmacGuard } from './git-hmac.guard';
import { GitEventDto, PromptEventDto } from './dto/git-event.dto';

/**
 * Public webhook ingress. The /public/ prefix bypasses the gateway's
 * InternalAuthGuard so post-commit hooks on developer machines can POST
 * directly. HMAC verification (GitHmacGuard) is the only auth.
 */
@Controller('public')
export class EventsController {
  constructor(private readonly events: EventsService) {}

  @Post('git-events')
  @UseGuards(GitHmacGuard)
  async ingestGit(
    @Req() req: any,
    @Body() dto: GitEventDto,
    @Headers('x-cup-idempotency-key') idempotencyKey?: string,
  ) {
    const projectId = req.cupProject.id;
    const receipt = await this.events.ingestGit(projectId, dto, idempotencyKey);
    return { ok: true, ...receipt };
  }

  @Post('prompt-events')
  @UseGuards(GitHmacGuard)
  async ingestPrompt(
    @Req() req: any,
    @Body() dto: PromptEventDto,
    @Headers('x-cup-idempotency-key') idempotencyKey?: string,
  ) {
    const projectId = req.cupProject.id;
    const receipt = await this.events.ingestPrompt(projectId, dto, idempotencyKey);
    return { ok: true, ...receipt };
  }
}
