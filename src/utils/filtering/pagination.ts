/**
 * Page-exhausting fetch helper for task listing.
 *
 * Vikunja caps a page at its `max_items_per_page` setting (50 by default, see
 * /api/v1/info). The filtering strategies previously issued a single request with
 * `per_page` defaulted to 1000 as memory protection, which the server silently
 * clamps — so on a project with more than `max_items_per_page` matching tasks the
 * remainder were dropped and the tool still reported the truncated count as if it
 * were the whole set. Observed against Vikunja v2.4.0: a `done = false` query on an
 * 83-task project returned 7 of 12 open tasks.
 *
 * Termination is deliberately NOT "returned < requested". Because the server clamps
 * 1000 down to 50, that test is true on the very first page and would stop
 * immediately, reproducing the original bug. Instead the effective page size is
 * learned from the first response, and a short page is what signals the end.
 */
import { logger } from '../logger';

/** Hard stop so a server that always returns a full page cannot spin forever. */
const MAX_PAGES = 100;

export interface PaginatedFetchResult<T> {
  items: T[];
  pagesFetched: number;
  /** True if MAX_PAGES was hit and there may be further unfetched pages. */
  truncated: boolean;
}

/**
 * Fetch every page for a listing call.
 *
 * @param fetchPage    issues one request for the given params
 * @param params       base query params; `page` is overwritten while iterating
 * @param autoPaginate when false, performs exactly one request. Used when the
 *                     caller asked for a specific page and expects only that page.
 */
export async function fetchAllPages<T, P extends object>(
  fetchPage: (params: P) => Promise<T[] | undefined>,
  params: P,
  autoPaginate: boolean,
): Promise<PaginatedFetchResult<T>> {
  // Generic over the param type so callers can pass node-vikunja's GetTasksParams,
  // which has no index signature and so will not widen to Record<string, unknown>.
  const pageOf = (p: P): number | undefined => {
    const v = (p as { page?: unknown }).page;
    return typeof v === 'number' ? v : undefined;
  };
  const firstPage = pageOf(params) ?? 1;

  const first = (await fetchPage({ ...params, page: firstPage })) ?? [];

  // An explicit page request is honoured verbatim — auto-paging would return more
  // than the caller asked for and break their own pagination.
  if (!autoPaginate) {
    return { items: first, pagesFetched: 1, truncated: false };
  }

  // The server's effective page size, learned from what it actually returned
  // rather than what we asked for.
  //
  // Note this costs one extra request when the whole result set fits in a single
  // short page: a first page of 10 against a requested 1000 is ambiguous — either
  // that is everything, or the server clamped us — and telling the two apart would
  // need max_items_per_page, which the client does not surface. Spending a request
  // to find out is preferable to silently dropping the rest of the project, which
  // is the bug this replaces.
  const pageSize = first.length;
  if (pageSize === 0) {
    return { items: first, pagesFetched: 1, truncated: false };
  }

  const items = [...first];
  let page = firstPage;
  let pagesFetched = 1;

  // A full page means there may be more; a short page means we reached the end.
  while (pagesFetched < MAX_PAGES) {
    page += 1;
    const batch = (await fetchPage({ ...params, page })) ?? [];
    pagesFetched += 1;
    items.push(...batch);
    if (batch.length < pageSize) {
      return { items, pagesFetched, truncated: false };
    }
  }

  logger.warn('Task pagination stopped at page limit; results may be incomplete', {
    maxPages: MAX_PAGES,
    itemsFetched: items.length,
  });
  return { items, pagesFetched, truncated: true };
}

/**
 * Whether a listing request should exhaust pages.
 *
 * Only an explicit `page` disables it: asking for page 3 means "give me page 3",
 * and returning more would break the caller's own pagination.
 *
 * `perPage` alone does NOT disable it. It is a batch size — how many rows to pull
 * per request — not a cap on the total. Treating it as a cap silently dropped
 * tasks: `perPage: 5` returned 5 of 44 and reported 5 as the total, and varying
 * perPage between calls made the "total" appear to change at random. A list tool
 * must not lose rows because of how many it was asked to fetch at a time.
 */
export function shouldAutoPaginate(args: { page?: number; perPage?: number }): boolean {
  return args.page === undefined;
}
