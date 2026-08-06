/**
 * Tests for collection rendering in responses.
 *
 * The bug: items were rendered only when the collection had 10 or fewer entries.
 * Anything larger printed "Results: 29 item(s)" and no items, so any page size above
 * 10 produced an empty-looking response with nothing explaining why.
 */
import { createSuccessResponse } from '../../src/utils/simple-response';

const tasks = (n: number): Array<Record<string, unknown>> =>
  Array.from({ length: n }, (_, i) => ({ id: i + 1, title: `Task ${i + 1}`, done: false }));

// createSuccessResponse formats internally; the rendered markdown is `.content`.
const render = (n: number): string =>
  createSuccessResponse('list-tasks', `Found ${n} tasks`, {
    tasks: tasks(n),
  } as never).content;

describe('collection rendering', () => {
  it('renders a small collection', () => {
    const out = render(3);
    expect(out).toContain('Task 1');
    expect(out).toContain('Task 3');
  });

  it('renders 11 items — the old cap dropped everything above 10', () => {
    const out = render(11);
    expect(out).toContain('Task 1');
    expect(out).toContain('Task 11');
  });

  it('renders a 15-item page', () => {
    const out = render(15);
    expect(out).toContain('Task 15');
  });

  it('renders a 29-item page in full', () => {
    // 29 is the real-world case: a full "My Open Tasks" listing.
    const out = render(29);
    expect(out).toContain('Task 1');
    expect(out).toContain('Task 29');
    expect(out).not.toContain('Showing the first');
  });

  it('always reports the collection size', () => {
    for (const n of [3, 11, 29, 60]) {
      expect(render(n)).toContain(`${n} item(s)`);
    }
  });

  it('bounds a very large collection and says so explicitly', () => {
    const out = render(80);
    expect(out).toContain('Task 1');
    expect(out).toContain('Task 50');
    expect(out).not.toContain('Task 51');
    // The truncation must be visible, not inferred from a short body.
    expect(out).toContain('Showing the first 50 of 80');
    expect(out).toContain('perPage');
  });

  it('renders nothing for an empty collection but still states the count', () => {
    const out = render(0);
    expect(out).toContain('0 item(s)');
    expect(out).not.toContain('Task');
  });
});
