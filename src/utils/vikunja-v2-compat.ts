/**
 * Compatibility shims for Vikunja v2 API changes that node-vikunja 0.4.0 predates.
 *
 * 0.4.0 is the latest published version, so there is no dependency bump available;
 * the two affected methods are replaced on the client instance instead. Both bugs
 * were found against a live Vikunja v2.4.0 instance:
 *
 * 1. getAllTasks() requests GET /tasks/all, which no longer exists in v2 — every
 *    call returns 400 "Invalid model provided". The current route is GET /tasks.
 *    This broke every cross-project task list (i.e. any list without a projectId).
 *
 * 2. bulkAssignUsersToTask() posts to /tasks/{id}/assignees/bulk, which in v2.4.0
 *    responds 201 with {"assignees":null} and assigns nobody. It fails silently:
 *    the caller sees success and the task is unchanged. Assignment via MCP appeared
 *    to work and never did. PUT /tasks/{id}/assignees with {user_id} does persist,
 *    so assignment is done one user at a time.
 *
 * Both shims call the API directly with the session's credentials rather than
 * patching node-vikunja, so removing them later is a single call site.
 */
import { logger } from './logger';

/** Vikunja's error code for "user is already assigned to this task". */
const ERR_ALREADY_ASSIGNED = 4021;

interface ClientLike {
  tasks: {
    getAllTasks?: (params?: Record<string, unknown>) => Promise<unknown>;
    bulkAssignUsersToTask?: (taskId: number, data: { user_ids: number[] }) => Promise<unknown>;
  };
}

function buildUrl(apiUrl: string, path: string, params?: Record<string, unknown>): string {
  // apiUrl already includes /api/v1 in every documented configuration.
  const base = apiUrl.replace(/\/+$/, '');
  const url = new URL(`${base}${path}`);
  for (const [k, v] of Object.entries(params ?? {})) {
    // Primitives only. An object would stringify to "[object Object]" and become a
    // silently meaningless query value rather than an obvious error.
    if (typeof v === 'string' && v !== '') {
      url.searchParams.set(k, v);
    } else if (typeof v === 'number' || typeof v === 'boolean') {
      url.searchParams.set(k, String(v));
    }
  }
  return url.toString();
}

async function apiRequest(
  apiUrl: string,
  apiToken: string,
  method: string,
  path: string,
  options: { params?: Record<string, unknown>; body?: unknown } = {},
): Promise<{ status: number; body: unknown }> {
  const res = await fetch(buildUrl(apiUrl, path, options.params), {
    method,
    headers: {
      Authorization: `Bearer ${apiToken}`,
      ...(options.body !== undefined ? { 'Content-Type': 'application/json' } : {}),
    },
    ...(options.body !== undefined ? { body: JSON.stringify(options.body) } : {}),
  });

  let body: unknown = null;
  const text = await res.text();
  if (text) {
    try {
      body = JSON.parse(text);
    } catch {
      body = text;
    }
  }
  return { status: res.status, body };
}

/**
 * Replace the broken methods on a freshly constructed client.
 *
 * Mutates the instance rather than subclassing: node-vikunja's client is created
 * from a dynamically imported constructor, so there is no stable type to extend.
 */
export function applyVikunjaV2Compat(
  client: unknown,
  session: { apiUrl: string; apiToken: string },
): void {
  const c = client as ClientLike;
  if (!c?.tasks) {
    logger.warn('Vikunja v2 compat: client has no tasks service; skipping shims');
    return;
  }

  // --- 1. GET /tasks instead of the removed /tasks/all ----------------------
  c.tasks.getAllTasks = async (params?: Record<string, unknown>): Promise<unknown> => {
    const { status, body } = await apiRequest(session.apiUrl, session.apiToken, 'GET', '/tasks', {
      ...(params ? { params } : {}),
    });
    if (status < 200 || status >= 300) {
      const message =
        (body as { message?: string } | null)?.message ?? `HTTP ${status} from GET /tasks`;
      throw new Error(message);
    }
    return Array.isArray(body) ? body : [];
  };

  // --- 2. one PUT per assignee instead of the no-op bulk endpoint -----------
  c.tasks.bulkAssignUsersToTask = async (
    taskId: number,
    data: { user_ids: number[] },
  ): Promise<unknown> => {
    const assigned: number[] = [];

    for (const userId of data.user_ids ?? []) {
      const { status, body } = await apiRequest(
        session.apiUrl,
        session.apiToken,
        'PUT',
        `/tasks/${taskId}/assignees`,
        { body: { user_id: userId } },
      );

      // Already-assigned is the desired end state, not a failure — assignment
      // must stay idempotent because the update path recomputes a diff and may
      // re-send a user who is already there.
      if ((body as { code?: number } | null)?.code === ERR_ALREADY_ASSIGNED) {
        assigned.push(userId);
        continue;
      }

      if (status < 200 || status >= 300) {
        const message =
          (body as { message?: string } | null)?.message ??
          `HTTP ${status} assigning user ${userId} to task ${taskId}`;
        throw new Error(message);
      }
      assigned.push(userId);
    }

    logger.debug('Assigned users via per-user PUT (bulk endpoint is a no-op in v2)', {
      taskId,
      assigned,
    });
    return { assignees: assigned };
  };
}
