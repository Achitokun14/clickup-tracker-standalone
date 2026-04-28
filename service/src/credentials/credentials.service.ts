import { Injectable, NotFoundException } from '@nestjs/common';

export interface ClickUpCredentials {
  workspace_id: string;
  team_id: string;
  team_name: string;
  token: string;
  auth_type: 'oauth' | 'personal';
}

/**
 * Standalone build: credentials live in env (CLICKUP_API_TOKEN +
 * CLICKUP_TEAM_ID). Single-workspace identity — there is no
 * `clickup.workspaces` table to JOIN against.
 *
 * The orgId argument is preserved for API compatibility with the
 * monorepo build (so projects can still be tagged per-org), but the
 * same env credentials are returned for every org.
 */
@Injectable()
export class CredentialsService {
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  async forOrg(_orgId: string): Promise<ClickUpCredentials> {
    const token = process.env.CLICKUP_API_TOKEN;
    const teamId = process.env.CLICKUP_TEAM_ID;
    if (!token) {
      throw new NotFoundException(
        'CLICKUP_API_TOKEN not set. Add it to .env or the docker-compose env block.',
      );
    }
    if (!teamId) {
      throw new NotFoundException(
        'CLICKUP_TEAM_ID not set. Add it to .env or the docker-compose env block.',
      );
    }
    return {
      workspace_id: process.env.CLICKUP_WORKSPACE_ID || teamId,
      team_id: teamId,
      team_name: process.env.CLICKUP_TEAM_NAME || 'Default',
      token,
      auth_type: 'personal',
    };
  }
}
