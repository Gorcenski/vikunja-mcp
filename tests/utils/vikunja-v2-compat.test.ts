/**
 * Tests for the Vikunja v2 compatibility shims.
 *
 * These assert on the request actually issued, not on a returned status, because
 * the bug being fixed was a 201 response that assigned nobody. A test that only
 * checked "did it resolve" would have passed against the broken behaviour.
 */
import { applyVikunjaV2Compat } from '../../src/utils/vikunja-v2-compat';

jest.mock('../../src/utils/logger', () => ({
  logger: { debug: jest.fn(), info: jest.fn(), warn: jest.fn(), error: jest.fn() },
}));

const SESSION = { apiUrl: 'https://vikunja.example.com/api/v1', apiToken: 'tk_test' };

interface Call {
  url: string;
  method: string;
  body: unknown;
  auth: string | undefined;
}

/** Stub fetch, recording every request and replying from a queue of responses. */
function stubFetch(responses: Array<{ status: number; body: unknown }>): Call[] {
  const calls: Call[] = [];
  let i = 0;
  global.fetch = jest.fn(async (url: string | URL, init?: RequestInit) => {
    const headers = (init?.headers ?? {}) as Record<string, string>;
    calls.push({
      url: String(url),
      method: init?.method ?? 'GET',
      body: init?.body ? JSON.parse(String(init.body)) : undefined,
      auth: headers.Authorization,
    });
    const r = responses[Math.min(i++, responses.length - 1)] ?? { status: 200, body: [] };
    return {
      status: r.status,
      text: async () => (r.body === undefined ? '' : JSON.stringify(r.body)),
    } as unknown as Response;
  }) as unknown as typeof fetch;
  return calls;
}

function patchedClient(): { tasks: Record<string, (...a: never[]) => Promise<unknown>> } {
  const client = { tasks: {} } as { tasks: Record<string, (...a: never[]) => Promise<unknown>> };
  applyVikunjaV2Compat(client, SESSION);
  return client;
}

describe('getAllTasks shim', () => {
  it('requests /tasks, not the removed /tasks/all', async () => {
    const calls = stubFetch([{ status: 200, body: [{ id: 1 }, { id: 2 }] }]);
    const client = patchedClient();
    const tasks = await client.tasks.getAllTasks!();
    expect(calls[0]?.url).toBe('https://vikunja.example.com/api/v1/tasks');
    expect(calls[0]?.url).not.toContain('/tasks/all');
    expect(tasks).toEqual([{ id: 1 }, { id: 2 }]);
  });

  it('sends the bearer token', async () => {
    const calls = stubFetch([{ status: 200, body: [] }]);
    await patchedClient().tasks.getAllTasks!();
    expect(calls[0]?.auth).toBe('Bearer tk_test');
  });

  it('passes query params through and drops empty ones', async () => {
    const calls = stubFetch([{ status: 200, body: [] }]);
    await (patchedClient().tasks.getAllTasks as (p: unknown) => Promise<unknown>)({
      page: 2,
      per_page: 50,
      filter: '',
      s: undefined,
    });
    expect(calls[0]?.url).toContain('page=2');
    expect(calls[0]?.url).toContain('per_page=50');
    expect(calls[0]?.url).not.toContain('filter=');
    expect(calls[0]?.url).not.toContain('s=');
  });

  it('tolerates a trailing slash on the configured apiUrl', async () => {
    const client = { tasks: {} } as { tasks: Record<string, () => Promise<unknown>> };
    applyVikunjaV2Compat(client, { ...SESSION, apiUrl: 'https://vikunja.example.com/api/v1/' });
    const calls = stubFetch([{ status: 200, body: [] }]);
    await client.tasks.getAllTasks!();
    expect(calls[0]?.url).toBe('https://vikunja.example.com/api/v1/tasks');
  });

  it('throws with the API message on a non-2xx', async () => {
    stubFetch([{ status: 400, body: { code: 2004, message: 'Invalid model provided' } }]);
    await expect(patchedClient().tasks.getAllTasks!()).rejects.toThrow('Invalid model provided');
  });

  it('throws a generic message when the error body has none', async () => {
    stubFetch([{ status: 500, body: undefined }]);
    await expect(patchedClient().tasks.getAllTasks!()).rejects.toThrow('HTTP 500 from GET /tasks');
  });

  it('returns an empty array when the body is not a list', async () => {
    stubFetch([{ status: 200, body: { unexpected: true } }]);
    await expect(patchedClient().tasks.getAllTasks!()).resolves.toEqual([]);
  });

  it('returns an empty array for an empty response body', async () => {
    stubFetch([{ status: 200, body: undefined }]);
    await expect(patchedClient().tasks.getAllTasks!()).resolves.toEqual([]);
  });

  it('does not crash on a non-JSON error body', async () => {
    // A reverse proxy or gateway can return an HTML error page rather than the
    // API's JSON, which JSON.parse would throw on.
    global.fetch = jest.fn(async () => ({
      status: 502,
      text: async () => '<html><body>Bad Gateway</body></html>',
    })) as unknown as typeof fetch;
    await expect(patchedClient().tasks.getAllTasks!()).rejects.toThrow('HTTP 502 from GET /tasks');
  });
});

describe('bulkAssignUsersToTask shim', () => {
  const assign = (client: ReturnType<typeof patchedClient>, taskId: number, ids: number[]) =>
    (
      client.tasks.bulkAssignUsersToTask as unknown as (
        t: number,
        d: { user_ids: number[] },
      ) => Promise<unknown>
    )(taskId, { user_ids: ids });

  it('issues one PUT per user to the endpoint that actually persists', async () => {
    const calls = stubFetch([
      { status: 201, body: { user_id: 1 } },
      { status: 201, body: { user_id: 2 } },
    ]);
    const client = patchedClient();
    await assign(client, 44, [1, 2]);

    expect(calls).toHaveLength(2);
    expect(calls[0]).toMatchObject({
      url: 'https://vikunja.example.com/api/v1/tasks/44/assignees',
      method: 'PUT',
      body: { user_id: 1 },
    });
    expect(calls[1]?.body).toEqual({ user_id: 2 });
    // The bulk endpoint responds 201 and assigns nobody, so it must not be used.
    expect(calls.every((c) => !c.url.includes('/bulk'))).toBe(true);
  });

  it('treats already-assigned as success so the update diff stays idempotent', async () => {
    stubFetch([{ status: 400, body: { code: 4021, message: 'This user is already assigned' } }]);
    await expect(assign(patchedClient(), 44, [1])).resolves.toEqual({ assignees: [1] });
  });

  it('throws on a genuine failure', async () => {
    stubFetch([{ status: 403, body: { code: 4003, message: 'Forbidden' } }]);
    await expect(assign(patchedClient(), 44, [1])).rejects.toThrow('Forbidden');
  });

  it('throws a generic message when a failure body has none', async () => {
    stubFetch([{ status: 500, body: undefined }]);
    await expect(assign(patchedClient(), 44, [7])).rejects.toThrow(
      'HTTP 500 assigning user 7 to task 44',
    );
  });

  it('stops at the first genuine failure rather than continuing', async () => {
    const calls = stubFetch([
      { status: 201, body: { user_id: 1 } },
      { status: 403, body: { message: 'Forbidden' } },
      { status: 201, body: { user_id: 3 } },
    ]);
    await expect(assign(patchedClient(), 44, [1, 2, 3])).rejects.toThrow('Forbidden');
    expect(calls).toHaveLength(2);
  });

  it('handles an empty and a missing user_ids list', async () => {
    const calls = stubFetch([]);
    await expect(assign(patchedClient(), 44, [])).resolves.toEqual({ assignees: [] });
    const client = patchedClient();
    await expect(
      (
        client.tasks.bulkAssignUsersToTask as unknown as (
          t: number,
          d: Record<string, never>,
        ) => Promise<unknown>
      )(44, {}),
    ).resolves.toEqual({ assignees: [] });
    expect(calls).toHaveLength(0);
  });
});

describe('applyVikunjaV2Compat', () => {
  it('does nothing when the client has no tasks service', () => {
    const client = {} as { tasks?: unknown };
    expect(() => applyVikunjaV2Compat(client, SESSION)).not.toThrow();
    expect(client.tasks).toBeUndefined();
  });

  it('tolerates a null client', () => {
    expect(() => applyVikunjaV2Compat(null, SESSION)).not.toThrow();
  });
});
