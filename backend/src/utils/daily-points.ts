/**
 * Day-by-day points from stored month rows. Kept free of database imports so
 * it can be unit tested on its own.
 */

export interface MonthRow {
  id: string;
  metricType: string;
  year: number;
  month: number;
  total: number;
  daily: unknown;
  collectedAt: Date | null;
  createdAt: Date;
}

export interface DailyPoint {
  id: string;
  locationId: string;
  date: Date;
  metricType: string;
  value: number;
  createdAt: Date;
}

/**
 * One point per day from the stored month rows, keeping days in [from, to]
 * that have already passed. A partial month therefore only compares the days
 * so far. Derived rows carry no daily values and contribute nothing here.
 */
export function flattenDaily(
  rows: MonthRow[],
  placeId: string,
  from: Date,
  to: Date,
  today: Date = new Date()
): DailyPoint[] {
  const first = new Date(from.getFullYear(), from.getMonth(), from.getDate()).getTime();
  const todayDay = new Date(today.getFullYear(), today.getMonth(), today.getDate());
  const last = Math.min(new Date(to.getFullYear(), to.getMonth(), to.getDate()).getTime(), todayDay.getTime());

  const points: DailyPoint[] = [];
  for (const row of rows) {
    if (!Array.isArray(row.daily)) continue;
    row.daily.forEach((value, i) => {
      const date = new Date(row.year, row.month - 1, i + 1);
      if (date.getTime() < first || date.getTime() > last) return;
      points.push({
        id: `${row.id}:${i + 1}`,
        locationId: placeId,
        date,
        metricType: row.metricType,
        value: Number(value),
        createdAt: row.collectedAt ?? row.createdAt,
      });
    });
  }
  return points.sort((a, b) => a.date.getTime() - b.date.getTime());
}

