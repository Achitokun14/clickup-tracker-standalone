import {
  BadGatewayException,
  HttpException,
  HttpStatus,
  Injectable,
  UnauthorizedException,
} from "@nestjs/common";

const BASE_URL =
  process.env.CLICKUP_API_BASE || "https://api.clickup.com/api/v2";

export interface ClickUpFolder {
  id: string;
  name: string;
}
export interface ClickUpList {
  id: string;
  name: string;
}
export interface ClickUpSpace {
  id: string;
  name: string;
}
export interface ClickUpTask {
  id: string;
  name: string;
  url?: string;
}
export interface ClickUpTaskFull {
  id: string;
  name: string;
  text_content?: string;
  description?: string;
  markdown_description?: string;
  status?: { status: string; type?: string };
  url?: string;
  list?: { id: string };
  custom_fields?: Array<{ id: string; name?: string; value?: unknown }>;
  date_created?: string;
}

/**
 * Direct (non-queued) ClickUp API client used during register / restore
 * flows where we need synchronous responses with returned IDs. Rate
 * limiting is left to ClickUp's 90 req/min quota — sustained mutation
 * volume should go through the cup-sync BullMQ worker instead.
 */
@Injectable()
export class ClickUpDirectService {
  async listSpaces(teamId: string, token: string): Promise<ClickUpSpace[]> {
    const r = await this.fetch<{ spaces: ClickUpSpace[] }>(
      `/team/${teamId}/space?archived=false`,
      token,
    );
    return r.spaces;
  }

  async createSpace(
    teamId: string,
    name: string,
    token: string,
  ): Promise<ClickUpSpace> {
    return this.fetch<ClickUpSpace>(`/team/${teamId}/space`, token, "POST", {
      name,
      multiple_assignees: true,
      features: {
        due_dates: { enabled: true },
        tags: { enabled: true },
        time_estimates: { enabled: true },
        checklists: { enabled: true },
        custom_fields: { enabled: true },
      },
    });
  }

  async listFolders(spaceId: string, token: string): Promise<ClickUpFolder[]> {
    const r = await this.fetch<{ folders: ClickUpFolder[] }>(
      `/space/${spaceId}/folder?archived=false`,
      token,
    );
    return r.folders;
  }

  async createFolder(
    spaceId: string,
    name: string,
    token: string,
  ): Promise<ClickUpFolder> {
    return this.fetch<ClickUpFolder>(
      `/space/${spaceId}/folder`,
      token,
      "POST",
      { name },
    );
  }

  async listListsInFolder(
    folderId: string,
    token: string,
  ): Promise<ClickUpList[]> {
    const r = await this.fetch<{ lists: ClickUpList[] }>(
      `/folder/${folderId}/list?archived=false`,
      token,
    );
    return r.lists;
  }

  async createListInFolder(
    folderId: string,
    name: string,
    token: string,
  ): Promise<ClickUpList> {
    return this.fetch<ClickUpList>(`/folder/${folderId}/list`, token, "POST", {
      name,
    });
  }

  async createTask(
    listId: string,
    body: {
      name: string;
      markdown_description?: string;
      status?: string;
      tags?: string[];
    },
    token: string,
  ): Promise<ClickUpTask> {
    return this.fetch<ClickUpTask>(`/list/${listId}/task`, token, "POST", body);
  }

  async addComment(
    taskId: string,
    comment: string,
    token: string,
  ): Promise<void> {
    await this.fetch(`/task/${taskId}/comment`, token, "POST", {
      comment_text: comment,
      notify_all: false,
    });
  }

  async archiveFolder(folderId: string, token: string): Promise<void> {
    await this.fetch(`/folder/${folderId}`, token, "PUT", { archived: true });
  }

  async deleteFolder(folderId: string, token: string): Promise<void> {
    await this.fetch(`/folder/${folderId}`, token, "DELETE");
  }

  async getFolder(folderId: string, token: string): Promise<ClickUpFolder> {
    return this.fetch<ClickUpFolder>(`/folder/${folderId}`, token);
  }

  async getTask(taskId: string, token: string): Promise<ClickUpTaskFull> {
    return this.fetch<ClickUpTaskFull>(`/task/${taskId}`, token);
  }

  async listTasksInList(
    listId: string,
    token: string,
  ): Promise<ClickUpTaskFull[]> {
    const r = await this.fetch<{ tasks: ClickUpTaskFull[] }>(
      `/list/${listId}/task?archived=false&include_closed=true&subtasks=true`,
      token,
    );
    return r.tasks ?? [];
  }

  async updateTask(
    taskId: string,
    patch: {
      name?: string;
      description?: string;
      status?: string;
      markdown_description?: string;
    },
    token: string,
  ): Promise<void> {
    await this.fetch(`/task/${taskId}`, token, "PUT", patch);
  }

  private async fetch<T = unknown>(
    path: string,
    token: string,
    method: "GET" | "POST" | "PUT" | "DELETE" = "GET",
    body?: unknown,
  ): Promise<T> {
    const url = `${BASE_URL}${path}`;
    const res = await fetch(url, {
      method,
      headers: {
        Authorization: token,
        "Content-Type": "application/json",
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    if (!res.ok) {
      const detail = text.slice(0, 300);
      const summary = `ClickUp ${method} ${path} → ${res.status}: ${detail}`;
      if (res.status === 401 || res.status === 403) {
        throw new UnauthorizedException(
          `ClickUp rejected the token (HTTP ${res.status}). Check CLICKUP_API_TOKEN. Upstream: ${detail}`,
        );
      }
      if (res.status === 429) {
        throw new HttpException(
          { code: "CLICKUP_RATE_LIMITED", message: summary },
          HttpStatus.TOO_MANY_REQUESTS,
        );
      }
      if (res.status >= 500) {
        throw new BadGatewayException(
          `ClickUp upstream ${res.status}: ${detail}`,
        );
      }
      throw new HttpException(summary, res.status);
    }
    return text ? (JSON.parse(text) as T) : (undefined as T);
  }
}
