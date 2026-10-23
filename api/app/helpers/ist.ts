/**
 * IST bucketing that doesn't depend on the MySQL server's time zone: epoch-ms columns
 * (student_sessions.started_at, …) are shifted by +05:30 and divided, in SQL or JS.
 */
export const IST_OFFSET_MS = 19_800_000
export const DAY_MS = 86_400_000

/** SQL expression: the IST day number (days since 1970-01-01 IST) of an epoch-ms column. */
export const istDaySql = (column: string) => `FLOOR((${column} + ${IST_OFFSET_MS}) / ${DAY_MS})`

/** SQL: IST hour 0–23 of an epoch-ms column. */
export const istHourSql = (column: string) => `FLOOR(MOD(${column} + ${IST_OFFSET_MS}, ${DAY_MS}) / 3600000)`

/** SQL: IST weekday 0 = Sunday … 6 = Saturday (1970-01-01 was a Thursday). */
export const istWeekdaySql = (column: string) => `MOD(${istDaySql(column)} + 4, 7)`

export const istDayOf = (ms: number) => Math.floor((ms + IST_OFFSET_MS) / DAY_MS)

/** IST day number → "YYYY-MM-DD". */
export function istDayLabel(day: number) {
  return new Date(day * DAY_MS).toISOString().slice(0, 10)
}

/** Epoch ms of 00:00 IST on the given IST day. */
export const istDayStart = (day: number) => day * DAY_MS - IST_OFFSET_MS
