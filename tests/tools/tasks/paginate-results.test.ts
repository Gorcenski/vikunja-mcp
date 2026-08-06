/**
 * Tests for presenting a fetched result set as a page.
 *
 * The invariant that matters: `total` always describes the whole result set, never
 * the returned slice. Reporting the slice size as the total is exactly how tasks
 * appeared to vanish — "Found 5 tasks" when 29 matched.
 */
import { paginateResults } from '../../../src/tools/tasks/filtering/paginate-results';
import type { Task } from 'node-vikunja';

const tasks = (n: number): Task[] =>
  Array.from({ length: n }, (_, i) => ({ id: i + 1, title: `t${i + 1}` }) as unknown as Task);

describe('paginateResults', () => {
  it('returns everything when perPage is not given', () => {
    const r = paginateResults(tasks(29), {});
    expect(r.tasks).toHaveLength(29);
    expect(r.pagination).toMatchObject({ total: 29, page: 1, totalPages: 1, hasMore: false });
  });

  it('limits the slice to perPage but reports the full total', () => {
    const r = paginateResults(tasks(29), { perPage: 5 });
    expect(r.tasks).toHaveLength(5);
    expect(r.pagination.total).toBe(29);
    expect(r.pagination.totalPages).toBe(6);
    expect(r.pagination.hasMore).toBe(true);
  });

  it('returns the requested page', () => {
    const r = paginateResults(tasks(29), { perPage: 10, page: 2 });
    expect(r.tasks.map((t) => t.id)).toEqual([11, 12, 13, 14, 15, 16, 17, 18, 19, 20]);
    expect(r.pagination).toMatchObject({ total: 29, page: 2, totalPages: 3, hasMore: true });
  });

  it('marks the last page as having no more', () => {
    const r = paginateResults(tasks(29), { perPage: 10, page: 3 });
    expect(r.tasks).toHaveLength(9);
    expect(r.pagination.hasMore).toBe(false);
  });

  it('returns an empty slice past the end rather than erroring', () => {
    const r = paginateResults(tasks(29), { perPage: 10, page: 99 });
    expect(r.tasks).toEqual([]);
    expect(r.pagination).toMatchObject({ total: 29, page: 99, hasMore: false });
  });

  it('handles an exact multiple with no phantom extra page', () => {
    const r = paginateResults(tasks(20), { perPage: 10, page: 2 });
    expect(r.tasks).toHaveLength(10);
    expect(r.pagination.totalPages).toBe(2);
    expect(r.pagination.hasMore).toBe(false);
  });

  it('handles an empty result set', () => {
    const r = paginateResults([], { perPage: 5 });
    expect(r.tasks).toEqual([]);
    expect(r.pagination).toMatchObject({ total: 0, totalPages: 1, hasMore: false });
  });

  it('ignores a non-positive perPage and returns everything', () => {
    for (const perPage of [0, -5]) {
      const r = paginateResults(tasks(7), { perPage });
      expect(r.tasks).toHaveLength(7);
      expect(r.pagination.total).toBe(7);
    }
  });

  it('treats a non-positive page as page 1', () => {
    const r = paginateResults(tasks(10), { perPage: 3, page: 0 });
    expect(r.tasks.map((t) => t.id)).toEqual([1, 2, 3]);
    expect(r.pagination.page).toBe(1);
  });

  it('floors fractional page and perPage', () => {
    const r = paginateResults(tasks(10), { perPage: 3.9, page: 2.7 });
    expect(r.pagination.perPage).toBe(3);
    expect(r.pagination.page).toBe(2);
    expect(r.tasks.map((t) => t.id)).toEqual([4, 5, 6]);
  });

  it('never reports a total smaller than what it returns', () => {
    // The property that was violated before: total must describe the result set.
    for (const perPage of [1, 5, 15, 50]) {
      const r = paginateResults(tasks(29), { perPage });
      expect(r.pagination.total).toBe(29);
      expect(r.tasks.length).toBeLessThanOrEqual(r.pagination.total);
    }
  });
});
