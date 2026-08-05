/**
 * Tests for username→ID assignee resolution.
 *
 * The behaviour that matters most here is refusing to guess. Vikunja's user search
 * is a substring match, so "emily" can return emily, emily2 and emilyg — picking the
 * first would silently assign the wrong person, which is worse than an error.
 */
import { resolveAssignees, needsResolution } from '../../src/utils/assignees';
import { MCPError, ErrorCode } from '../../src/types';

jest.mock('../../src/utils/logger', () => ({
  logger: { debug: jest.fn(), info: jest.fn(), warn: jest.fn(), error: jest.fn() },
}));

const clientWith = (users: Array<{ id?: number; username?: string }>) => ({
  users: { getUsers: jest.fn(async () => users) },
});

describe('resolveAssignees', () => {
  it('passes numeric ids through without a lookup', async () => {
    const client = clientWith([]);
    await expect(resolveAssignees(client, [1, 2, 3])).resolves.toEqual([1, 2, 3]);
    expect(client.users.getUsers).not.toHaveBeenCalled();
  });

  it('resolves a username to its id', async () => {
    const client = clientWith([{ id: 7, username: 'emily' }]);
    await expect(resolveAssignees(client, ['emily'])).resolves.toEqual([7]);
    expect(client.users.getUsers).toHaveBeenCalledWith({ s: 'emily' });
  });

  it('handles a mix of ids and usernames, preserving order', async () => {
    const client = clientWith([{ id: 7, username: 'emily' }]);
    await expect(resolveAssignees(client, [3, 'emily', 9])).resolves.toEqual([3, 7, 9]);
  });

  it('picks the exact match rather than the first substring hit', async () => {
    // The substring search returns three users; only one is actually "emily".
    const client = clientWith([
      { id: 11, username: 'emilyg' },
      { id: 7, username: 'emily' },
      { id: 12, username: 'emily2' },
    ]);
    await expect(resolveAssignees(client, ['emily'])).resolves.toEqual([7]);
  });

  it('matches case-insensitively', async () => {
    const client = clientWith([{ id: 7, username: 'Emily' }]);
    await expect(resolveAssignees(client, ['emily'])).resolves.toEqual([7]);
  });

  it('trims surrounding whitespace before matching', async () => {
    const client = clientWith([{ id: 7, username: 'emily' }]);
    await expect(resolveAssignees(client, ['  emily  '])).resolves.toEqual([7]);
    expect(client.users.getUsers).toHaveBeenCalledWith({ s: 'emily' });
  });

  it('throws NOT_FOUND when nothing matches exactly, listing near misses', async () => {
    const client = clientWith([
      { id: 11, username: 'emilyg' },
      { id: 12, username: 'emily2' },
    ]);
    await expect(resolveAssignees(client, ['emily'])).rejects.toThrow(MCPError);
    await expect(resolveAssignees(client, ['emily'])).rejects.toThrow(/Similar: emilyg, emily2/);
  });

  it('throws when the search returns nothing at all', async () => {
    const client = clientWith([]);
    await expect(resolveAssignees(client, ['nobody'])).rejects.toThrow(
      /No user found with username "nobody"/,
    );
  });

  it('refuses to guess between two case-variant exact matches', async () => {
    const client = clientWith([
      { id: 7, username: 'emily' },
      { id: 8, username: 'Emily' },
    ]);
    await expect(resolveAssignees(client, ['emily'])).rejects.toThrow(
      /matched 2 users; use a numeric user ID/,
    );
  });

  it('rejects an empty username instead of searching for everything', async () => {
    const client = clientWith([{ id: 1, username: 'anyone' }]);
    await expect(resolveAssignees(client, ['   '])).rejects.toThrow(/cannot be empty/);
    expect(client.users.getUsers).not.toHaveBeenCalled();
  });

  it('surfaces a lookup failure as an API error', async () => {
    const client = {
      users: {
        getUsers: jest.fn(async () => {
          throw new Error('connection refused');
        }),
      },
    };
    await expect(resolveAssignees(client, ['emily'])).rejects.toThrow(
      /Failed to look up assignee "emily": connection refused/,
    );
  });

  it('handles a non-Error rejection from the client', async () => {
    const client = {
      users: {
        getUsers: jest.fn(async () => {
          throw 'string failure';
        }),
      },
    };
    await expect(resolveAssignees(client, ['emily'])).rejects.toThrow(/string failure/);
  });

  it('errors when a matched user has no id', async () => {
    const client = clientWith([{ username: 'emily' }]);
    await expect(resolveAssignees(client, ['emily'])).rejects.toThrow(/has no id/);
  });

  it('ignores search results that carry no username', async () => {
    // A result without a username can never be an exact match; it must not throw
    // on the missing field, and must not be silently treated as a match either.
    const client = clientWith([{ id: 5 }, { id: 7, username: 'emily' }]);
    await expect(resolveAssignees(client, ['emily'])).resolves.toEqual([7]);
  });

  it('treats an undefined search result as no matches', async () => {
    const client = {
      users: { getUsers: jest.fn(async () => undefined as unknown as []) },
    };
    await expect(resolveAssignees(client, ['emily'])).rejects.toThrow(/No user found/);
  });

  it('uses NOT_FOUND and VALIDATION_ERROR codes appropriately', async () => {
    const missing = clientWith([]);
    await expect(resolveAssignees(missing, ['ghost'])).rejects.toMatchObject({
      code: ErrorCode.NOT_FOUND,
    });
    const ambiguous = clientWith([
      { id: 1, username: 'dup' },
      { id: 2, username: 'DUP' },
    ]);
    await expect(resolveAssignees(ambiguous, ['dup'])).rejects.toMatchObject({
      code: ErrorCode.VALIDATION_ERROR,
    });
  });
});

describe('needsResolution', () => {
  it('is false for undefined and for all-numeric lists', () => {
    expect(needsResolution(undefined)).toBe(false);
    expect(needsResolution([])).toBe(false);
    expect(needsResolution([1, 2])).toBe(false);
  });

  it('is true when any entry is a username', () => {
    expect(needsResolution(['emily'])).toBe(true);
    expect(needsResolution([1, 'emily'])).toBe(true);
  });
});
