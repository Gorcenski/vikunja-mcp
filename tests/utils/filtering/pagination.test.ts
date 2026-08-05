/**
 * Tests for the page-exhausting fetch helper.
 *
 * The regression these guard: Vikunja clamps `per_page` to its max_items_per_page
 * (50 by default), so a listing that requested 1000 rows received 50 and reported
 * that as the complete set. Any loop that terminates on "returned < requested"
 * reintroduces the bug, because 50 < 1000 is true on the first page.
 */
import { fetchAllPages, shouldAutoPaginate } from '../../../src/utils/filtering/pagination';

jest.mock('../../../src/utils/logger', () => ({
  logger: { warn: jest.fn(), info: jest.fn(), debug: jest.fn(), error: jest.fn() },
}));

/** Builds a fake API that serves `total` items in pages clamped to `serverCap`. */
function fakeApi(total: number, serverCap: number) {
  const calls: Array<Record<string, unknown>> = [];
  const fetchPage = jest.fn(async (params: { page?: number; per_page?: number }) => {
    calls.push({ ...params });
    const page = params.page ?? 1;
    const size = Math.min(params.per_page ?? serverCap, serverCap);
    const start = (page - 1) * size;
    return Array.from({ length: Math.max(0, Math.min(size, total - start)) }, (_, i) => ({
      id: start + i + 1,
    }));
  });
  return { fetchPage, calls };
}

describe('fetchAllPages', () => {
  it('fetches every page when the server clamps per_page below the request', async () => {
    // 83 items, server caps at 50, caller asked for 1000 — the original bug.
    const { fetchPage } = fakeApi(83, 50);
    const result = await fetchAllPages(fetchPage, { per_page: 1000, page: 1 }, true);

    expect(result.items).toHaveLength(83);
    expect(result.pagesFetched).toBe(2);
    expect(result.truncated).toBe(false);
  });

  it('does not stop early just because the first page is shorter than per_page', async () => {
    const { fetchPage } = fakeApi(120, 50);
    const result = await fetchAllPages(fetchPage, { per_page: 1000 }, true);
    expect(result.items).toHaveLength(120);
    expect(fetchPage).toHaveBeenCalledTimes(3);
  });

  it('probes one extra page when the first page is short of the requested size', async () => {
    // A first page of 10 against a requested 1000 is ambiguous: either that is all
    // the data, or the server clamped us. Telling them apart needs the server's
    // max_items_per_page, which the client does not expose — so the helper spends
    // one extra request rather than risk truncating. That trade is the whole point.
    const { fetchPage } = fakeApi(10, 50);
    const result = await fetchAllPages(fetchPage, { per_page: 1000 }, true);
    expect(result.items).toHaveLength(10);
    expect(result.pagesFetched).toBe(2);
    expect(result.truncated).toBe(false);
  });

  it('handles an exact multiple of the page size without duplicating or dropping', async () => {
    // 100 items at 50/page: page 3 comes back empty and must terminate the loop.
    const { fetchPage } = fakeApi(100, 50);
    const result = await fetchAllPages(fetchPage, { per_page: 1000 }, true);
    expect(result.items).toHaveLength(100);
    expect(result.items.map((i) => (i as { id: number }).id)).toEqual(
      Array.from({ length: 100 }, (_, i) => i + 1),
    );
    expect(result.pagesFetched).toBe(3);
  });

  it('returns an empty result when there are no items', async () => {
    const { fetchPage } = fakeApi(0, 50);
    const result = await fetchAllPages(fetchPage, { per_page: 1000 }, true);
    expect(result.items).toEqual([]);
    expect(result.pagesFetched).toBe(1);
    expect(fetchPage).toHaveBeenCalledTimes(1);
  });

  it('honours an explicit page request without auto-paging', async () => {
    const { fetchPage, calls } = fakeApi(200, 50);
    const result = await fetchAllPages(fetchPage, { page: 2, per_page: 50 }, false);
    expect(result.items).toHaveLength(50);
    expect(result.pagesFetched).toBe(1);
    expect(fetchPage).toHaveBeenCalledTimes(1);
    expect(calls[0].page).toBe(2);
  });

  it('starts auto-paging from an explicit first page', async () => {
    const { fetchPage, calls } = fakeApi(120, 50);
    const result = await fetchAllPages(fetchPage, { page: 2, per_page: 1000 }, true);
    // pages 2 and 3 of a 120-item set = 50 + 20
    expect(result.items).toHaveLength(70);
    expect(calls.map((c) => c.page)).toEqual([2, 3]);
  });

  it('treats an undefined response as an empty page', async () => {
    const fetchPage = jest.fn(async () => undefined);
    const result = await fetchAllPages(fetchPage, { per_page: 1000 }, true);
    expect(result.items).toEqual([]);
    expect(result.pagesFetched).toBe(1);
  });

  it('treats an undefined response mid-pagination as the end', async () => {
    // A full first page followed by undefined must terminate rather than throw.
    const fetchPage = jest.fn(async (params: { page?: number }) =>
      (params.page ?? 1) === 1 ? [{ id: 1 }, { id: 2 }] : undefined,
    );
    const result = await fetchAllPages(fetchPage, { per_page: 1000 }, true);
    expect(result.items).toHaveLength(2);
    expect(result.pagesFetched).toBe(2);
    expect(result.truncated).toBe(false);
  });

  it('ignores a non-numeric page value and starts at 1', async () => {
    const { fetchPage, calls } = fakeApi(10, 50);
    await fetchAllPages(fetchPage, { page: 'nonsense' as unknown as number }, true);
    expect(calls[0].page).toBe(1);
  });

  it('stops at the page limit and reports truncation', async () => {
    // A server that always returns a full page would otherwise loop forever.
    const fetchPage = jest.fn(async () => Array.from({ length: 50 }, (_, i) => ({ id: i })));
    const result = await fetchAllPages(fetchPage, { per_page: 1000 }, true);
    expect(result.truncated).toBe(true);
    expect(result.pagesFetched).toBe(100);
    expect(result.items).toHaveLength(5000);
  });
});

describe('shouldAutoPaginate', () => {
  it('auto-pages when the caller specified neither page nor perPage', () => {
    expect(shouldAutoPaginate({})).toBe(true);
  });

  it('does not auto-page when the caller asked for a specific page', () => {
    // Returning more than the requested page would break caller-driven pagination.
    expect(shouldAutoPaginate({ page: 2 })).toBe(false);
    expect(shouldAutoPaginate({ page: 1, perPage: 25 })).toBe(false);
  });

  it('still auto-pages when only perPage is given', () => {
    // perPage is a batch size, not a cap on the total. Treating it as a cap meant
    // `perPage: 5` returned 5 of 44 tasks and reported 5 as the total, and varying
    // perPage between calls made the total appear to change at random.
    expect(shouldAutoPaginate({ perPage: 25 })).toBe(true);
    expect(shouldAutoPaginate({ perPage: 5 })).toBe(true);
  });
});
