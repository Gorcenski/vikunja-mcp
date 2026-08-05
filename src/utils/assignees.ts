/**
 * Assignee resolution: accept usernames as well as numeric user IDs.
 *
 * The task tools only accepted `assignees` as numeric IDs, which are not
 * discoverable from an MCP session authenticated with an API token — the `users`
 * tool is JWT-only, so there was no way to turn a username into an ID without
 * leaving the session. In practice that made assignment unusable for token auth.
 *
 * Vikunja's own /api/v1/users search does work with an API token, so resolution is
 * done here rather than by widening which tools get registered.
 */
import { MCPError, ErrorCode } from '../types';
import { logger } from './logger';

/** Minimal shape needed from the client; keeps this testable without the SDK. */
export interface UserLookupClient {
  users: {
    getUsers: (params: { s?: string }) => Promise<Array<{ id?: number; username?: string }>>;
  };
}

/**
 * Resolve a mixed list of user IDs and usernames to numeric IDs.
 *
 * Numbers pass through untouched — a caller who already has an ID should not pay
 * for a lookup, and it keeps the previous behaviour exactly.
 *
 * Usernames are matched **exactly** (case-insensitively) against the search
 * results rather than taking the first hit: Vikunja's `?s=` is a substring search,
 * so "em" can return several users and "emily" can return "emily" and "emily2".
 * Assigning the wrong person silently is worse than failing, so an ambiguous or
 * absent match raises.
 */
export async function resolveAssignees(
  client: UserLookupClient,
  assignees: Array<number | string>,
): Promise<number[]> {
  const resolved: number[] = [];

  for (const entry of assignees) {
    if (typeof entry === 'number') {
      resolved.push(entry);
      continue;
    }

    const username = entry.trim();
    if (!username) {
      throw new MCPError(ErrorCode.VALIDATION_ERROR, 'Assignee username cannot be empty');
    }

    let candidates: Array<{ id?: number; username?: string }>;
    try {
      candidates = (await client.users.getUsers({ s: username })) ?? [];
    } catch (error) {
      throw new MCPError(
        ErrorCode.API_ERROR,
        `Failed to look up assignee "${username}": ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }

    const exact = candidates.filter(
      (u) => (u.username ?? '').toLowerCase() === username.toLowerCase(),
    );

    if (exact.length === 0) {
      const seen = candidates
        .map((u) => u.username)
        .filter((u): u is string => Boolean(u))
        .join(', ');
      throw new MCPError(
        ErrorCode.NOT_FOUND,
        `No user found with username "${username}"${seen ? `. Similar: ${seen}` : ''}`,
      );
    }

    // Defensive: Vikunja usernames are unique, so more than one exact
    // case-insensitive match means two usernames differing only by case.
    // Guessing between them would assign the wrong person.
    if (exact.length > 1) {
      throw new MCPError(
        ErrorCode.VALIDATION_ERROR,
        `Username "${username}" matched ${exact.length} users; use a numeric user ID instead`,
      );
    }

    const id = exact[0]?.id;
    if (typeof id !== 'number') {
      throw new MCPError(
        ErrorCode.API_ERROR,
        `User "${username}" was found but has no id in the API response`,
      );
    }

    logger.debug('Resolved assignee username to id', { username, id });
    resolved.push(id);
  }

  return resolved;
}

/** True if any entry needs a lookup — lets callers skip the client round-trip. */
export function needsResolution(assignees: Array<number | string> | undefined): boolean {
  return Boolean(assignees?.some((a) => typeof a === 'string'));
}
