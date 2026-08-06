/**
 * Present a fully-fetched result set as a page.
 *
 * Task listing fetches every matching task so the reported total is the real total.
 * `perPage` then controls how many of them come back, which keeps two properties
 * that were previously in conflict:
 *
 *   - nothing is silently dropped: the total always describes the whole result set,
 *     so a caller can tell there is more to fetch
 *   - `perPage` still limits the response, so a caller asking for 5 gets 5
 *
 * The earlier behaviour failed one or the other. Originally `perPage` was passed
 * straight to the API and the short page was reported as the total, so tasks
 * vanished. Then `perPage` became a batch size and every call returned everything,
 * which fixed the dropping but made `perPage` do nothing.
 */
import type { Task } from 'node-vikunja';

export interface PagedResult {
  /** The slice to return to the caller. */
  tasks: Task[];
  pagination: {
    /** Size of the complete result set, not of this page. */
    total: number;
    page: number;
    perPage: number;
    totalPages: number;
    hasMore: boolean;
  };
}

/**
 * Slice `tasks` to the requested page.
 *
 * With no `perPage` the whole set is returned and `hasMore` is false — a caller who
 * did not ask for pagination gets everything, which is the least surprising default
 * for "list my tasks".
 *
 * An out-of-range page yields an empty slice rather than an error: paging one past
 * the end is a normal way to discover you have reached it.
 */
export function paginateResults(
  tasks: Task[],
  args: { page?: number; perPage?: number },
): PagedResult {
  const total = tasks.length;

  if (args.perPage === undefined || args.perPage <= 0) {
    return {
      tasks,
      pagination: { total, page: 1, perPage: total, totalPages: 1, hasMore: false },
    };
  }

  const perPage = Math.floor(args.perPage);
  const page = args.page !== undefined && args.page > 0 ? Math.floor(args.page) : 1;
  const totalPages = Math.max(1, Math.ceil(total / perPage));
  const start = (page - 1) * perPage;
  const slice = tasks.slice(start, start + perPage);

  return {
    tasks: slice,
    pagination: {
      total,
      page,
      perPage,
      totalPages,
      hasMore: start + slice.length < total,
    },
  };
}
