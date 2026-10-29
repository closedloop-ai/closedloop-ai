/** SQL predicate for strict monitored-event UTC timestamps. */
export function isoTimestampValidSql(value: string): string {
  const month = `CAST(substr(${value}, 6, 2) AS INTEGER)`;
  const day = `CAST(substr(${value}, 9, 2) AS INTEGER)`;
  const year = `CAST(substr(${value}, 1, 4) AS INTEGER)`;
  return `(
    (
      length(${value}) = 17
      OR length(${value}) = 20
      OR (
        length(${value}) >= 22
        AND substr(${value}, 20, 1) = '.'
      )
    )
    AND substr(${value}, 5, 1) = '-'
    AND substr(${value}, 8, 1) = '-'
    AND substr(${value}, 11, 1) = 'T'
    AND substr(${value}, 14, 1) = ':'
    AND substr(${value}, -1, 1) = 'Z'
    AND substr(${value}, 1, 4) NOT GLOB '*[^0-9]*'
    AND substr(${value}, 6, 2) NOT GLOB '*[^0-9]*'
    AND substr(${value}, 9, 2) NOT GLOB '*[^0-9]*'
    AND substr(${value}, 12, 2) NOT GLOB '*[^0-9]*'
    AND substr(${value}, 15, 2) NOT GLOB '*[^0-9]*'
    AND CAST(substr(${value}, 12, 2) AS INTEGER) BETWEEN 0 AND 23
    AND CAST(substr(${value}, 15, 2) AS INTEGER) BETWEEN 0 AND 59
    AND ${month} BETWEEN 1 AND 12
    AND ${day} BETWEEN 1 AND CASE
      WHEN ${month} IN (1, 3, 5, 7, 8, 10, 12) THEN 31
      WHEN ${month} IN (4, 6, 9, 11) THEN 30
      WHEN (${year} % 400 = 0) OR (${year} % 4 = 0 AND ${year} % 100 <> 0) THEN 29
      ELSE 28
    END
    AND (
      length(${value}) = 17
      OR (
        substr(${value}, 17, 1) = ':'
        AND substr(${value}, 18, 2) NOT GLOB '*[^0-9]*'
        AND CAST(substr(${value}, 18, 2) AS INTEGER) BETWEEN 0 AND 59
        AND (
          length(${value}) = 20
          OR substr(${value}, 21, length(${value}) - 21) NOT GLOB '*[^0-9]*'
        )
      )
    )
    AND julianday(${value}) IS NOT NULL
  )`;
}

/** SQL mirror for the persisted sync timestamp forms accepted by Date.parse. */
export function syncTimestampValidSql(value: string): string {
  const trimmed = jsTrimSql(value);
  return `(
    length(${trimmed}) > 0
    AND (
      ${dateParseIsoLikeValidSql(trimmed)}
      OR ${rfc2822TimestampValidSql(trimmed)}
    )
  )`;
}

/** ECMAScript-compatible whitespace trim used by activity SQL identities. */
export function jsTrimSql(value: string): string {
  return `trim(${value}, ${jsWhitespaceSql()})`;
}

function dateParseIsoLikeValidSql(value: string): string {
  const normalized = basicOffsetTimestampSql(value);
  return `(
    length(${value}) >= 10
    AND substr(${value}, 1, 4) NOT GLOB '*[^0-9]*'
    AND substr(${value}, 5, 1) = '-'
    AND substr(${value}, 6, 2) NOT GLOB '*[^0-9]*'
    AND substr(${value}, 8, 1) = '-'
    AND substr(${value}, 9, 2) NOT GLOB '*[^0-9]*'
    AND (
      length(${value}) = 10
      OR substr(${value}, 11, 1) IN ('T', ' ')
    )
    AND NOT (
      substr(${value}, 11, 1) = 'T'
      AND substr(${value}, 12, 2) = '24'
      AND substr(${value}, 15, 2) <> '00'
    )
    AND julianday(${normalized}) IS NOT NULL
  )`;
}

function rfc2822TimestampValidSql(value: string): string {
  const withoutWeekday = `CASE
    WHEN lower(substr(${value}, 1, 5)) IN (
      'mon, ', 'tue, ', 'wed, ', 'thu, ', 'fri, ', 'sat, ', 'sun, '
    ) THEN substr(${value}, 6)
    ELSE ${value}
  END`;
  const day = `CAST(substr(${withoutWeekday}, 1, 2) AS INTEGER)`;
  const month = `lower(substr(${withoutWeekday}, 4, 3))`;
  const year = `CAST(substr(${withoutWeekday}, 8, 4) AS INTEGER)`;
  const zone = `lower(substr(${withoutWeekday}, 22))`;
  return `(
    length(${withoutWeekday}) BETWEEN 24 AND 26
    AND substr(${withoutWeekday}, 1, 2) NOT GLOB '*[^0-9]*'
    AND substr(${withoutWeekday}, 3, 1) = ' '
    AND ${month} IN (
      'jan', 'feb', 'mar', 'apr', 'may', 'jun',
      'jul', 'aug', 'sep', 'oct', 'nov', 'dec'
    )
    AND substr(${withoutWeekday}, 7, 1) = ' '
    AND substr(${withoutWeekday}, 8, 4) NOT GLOB '*[^0-9]*'
    AND substr(${withoutWeekday}, 12, 1) = ' '
    AND substr(${withoutWeekday}, 13, 2) NOT GLOB '*[^0-9]*'
    AND substr(${withoutWeekday}, 15, 1) = ':'
    AND substr(${withoutWeekday}, 16, 2) NOT GLOB '*[^0-9]*'
    AND substr(${withoutWeekday}, 18, 1) = ':'
    AND substr(${withoutWeekday}, 19, 2) NOT GLOB '*[^0-9]*'
    AND substr(${withoutWeekday}, 21, 1) = ' '
    AND CAST(substr(${withoutWeekday}, 13, 2) AS INTEGER) BETWEEN 0 AND 23
    AND CAST(substr(${withoutWeekday}, 16, 2) AS INTEGER) BETWEEN 0 AND 59
    AND CAST(substr(${withoutWeekday}, 19, 2) AS INTEGER) BETWEEN 0 AND 59
    AND ${day} BETWEEN 1 AND ${rfcMonthDayMaximumSql(month, year)}
    AND (
      ${zone} IN ('ut', 'utc', 'gmt', 'est', 'edt', 'cst', 'cdt', 'mst', 'mdt', 'pst', 'pdt')
      OR (
        length(${zone}) = 5
        AND substr(${zone}, 1, 1) IN ('+', '-')
        AND substr(${zone}, 2, 4) NOT GLOB '*[^0-9]*'
        AND CAST(substr(${zone}, 2, 2) AS INTEGER) BETWEEN 0 AND 23
        AND CAST(substr(${zone}, 4, 2) AS INTEGER) BETWEEN 0 AND 59
      )
    )
  )`;
}

function rfcMonthDayMaximumSql(month: string, year: string): string {
  return `CASE
    WHEN ${month} IN ('jan', 'mar', 'may', 'jul', 'aug', 'oct', 'dec') THEN 31
    WHEN ${month} IN ('apr', 'jun', 'sep', 'nov') THEN 30
    WHEN (${year} % 400 = 0) OR (${year} % 4 = 0 AND ${year} % 100 <> 0) THEN 29
    ELSE 28
  END`;
}

function basicOffsetTimestampSql(value: string): string {
  return `CASE
    WHEN length(${value}) >= 5
     AND substr(${value}, -5, 1) IN ('+', '-')
     AND substr(${value}, -4, 4) NOT GLOB '*[^0-9]*'
    THEN substr(${value}, 1, length(${value}) - 2)
      || ':' || substr(${value}, -2)
    ELSE ${value}
  END`;
}

function jsWhitespaceSql(): string {
  return "char(9,10,11,12,13,32,160,5760,8192,8193,8194,8195,8196,8197,8198,8199,8200,8201,8202,8232,8233,8239,8287,12288,65279)";
}
