// Calendar periods for grouping sessions by the date they started. No vscode import, so
// the tests can run it under plain node. All periods are in local time.

export type GroupBy = 'all' | 'year' | 'month' | 'week' | 'day';

export const GROUP_LABELS: Record<GroupBy, string> = { all: 'All', year: 'Year', month: 'Month', week: 'Week', day: 'Day' };

/** The quota week starts Saturday at 2 PM. */
const WEEK_START_DAY = 6;
const WEEK_START_HOUR = 14;

export interface Period {
  /** Stable id for the period, for example 2026-10 for October 2026. */
  key: string;
  label: string;
  /** Start of the period, in ms. */
  start: number;
}

export function weekStart(ms: number): Date {
  const d = new Date(ms);
  const start = new Date(d.getFullYear(), d.getMonth(), d.getDate(), WEEK_START_HOUR);
  start.setDate(start.getDate() - ((start.getDay() - WEEK_START_DAY + 7) % 7));
  if (start.getTime() > ms) start.setDate(start.getDate() - 7);
  return start;
}

const pad = (n: number) => String(n).padStart(2, '0');

/** The period of `mode` that contains `ms`. */
export function periodOf(ms: number, mode: Exclude<GroupBy, 'all'>): Period {
  const d = new Date(ms);
  const y = d.getFullYear();
  switch (mode) {
    case 'year':
      return { key: `${y}`, label: `${y}`, start: new Date(y, 0, 1).getTime() };
    case 'month': {
      const start = new Date(y, d.getMonth(), 1);
      return { key: `${y}-${pad(d.getMonth() + 1)}`, label: start.toLocaleDateString('en-US', { month: 'short', year: 'numeric' }), start: start.getTime() };
    }
    case 'week': {
      const s = weekStart(ms);
      const day = s.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric' });
      return { key: `w${s.getFullYear()}-${pad(s.getMonth() + 1)}-${pad(s.getDate())}`, label: `Week of ${day}, 2 PM`, start: s.getTime() };
    }
    case 'day': {
      const start = new Date(y, d.getMonth(), d.getDate());
      return {
        key: `${y}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`,
        label: start.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric' }),
        start: start.getTime(),
      };
    }
  }
}

/** Groups items into periods by their start time, newest period first and newest item
 * first within each period. Each item lands in exactly one period. */
export function groupByPeriod<T>(items: T[], startOf: (item: T) => number, mode: Exclude<GroupBy, 'all'>): (Period & { items: T[] })[] {
  const groups = new Map<string, Period & { items: T[] }>();
  for (const item of items) {
    const p = periodOf(startOf(item), mode);
    let g = groups.get(p.key);
    if (!g) groups.set(p.key, (g = { ...p, items: [] }));
    g.items.push(item);
  }
  const out = [...groups.values()].sort((a, b) => b.start - a.start);
  for (const g of out) g.items.sort((a, b) => startOf(b) - startOf(a));
  return out;
}
