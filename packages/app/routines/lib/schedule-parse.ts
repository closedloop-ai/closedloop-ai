/**
 * Natural-language → 5-field cron for the create/edit modal's schedule input
 * (FEA-3853). Pure and renderer-safe (no cron-parser): the modal parses the
 * typed phrase to a cron here, then asks the main process to VALIDATE that cron
 * and preview its next runs (the crewd cron primitive is the source of truth for
 * validity — this only maps friendly phrases onto the expression). A phrase this
 * does not recognize returns null, and the modal surfaces "not a schedule we
 * understand" rather than guessing.
 *
 * A raw 5-field cron typed directly is passed straight through, so power users
 * are never blocked by the phrase vocabulary.
 */

/** The preset chips the modal offers, each mapping to a canonical cron. */
export const SCHEDULE_PRESETS = [
  { id: "daily", label: "Daily", cron: "0 9 * * *" },
  { id: "weekdays", label: "Weekdays", cron: "0 9 * * 1-5" },
  { id: "weekly", label: "Weekly", cron: "0 9 * * 1" },
  { id: "hourly", label: "Hourly", cron: "0 * * * *" },
] as const;

export type SchedulePresetId = (typeof SCHEDULE_PRESETS)[number]["id"];

const WEEKDAY_TO_CRON: Record<string, string> = {
  sunday: "0",
  monday: "1",
  tuesday: "2",
  wednesday: "3",
  thursday: "4",
  friday: "5",
  saturday: "6",
};

/** A literal 5-field cron: five glyph-only tokens (digits, `* / , -`), no words. */
const RAW_CRON = /^[\d*/,-]+\s+[\d*/,-]+\s+[\d*/,-]+\s+[\d*/,-]+\s+[\d*/,-]+$/;
const AT_TIME = /\bat\s+(\d{1,2})(?::(\d{2}))?\s*(am|pm)?\b/;
const EVERY_N_MINUTES = /\bevery\s+(\d{1,2})\s*(?:min|mins|minutes?)\b/;
const EVERY_WEEKDAY_NAME =
  /\bevery\s+(sunday|monday|tuesday|wednesday|thursday|friday|saturday)\b/;
const HOURLY = /\b(hourly|every hour)\b/;
const WEEKDAYS = /\b(weekday|weekdays)\b/;
const WEEKLY = /\b(weekly|every week)\b/;
const DAILY = /\b(daily|every day|everyday)\b/;

/** Extract `minute`/`hour` from an "at 9am" / "at 14:30" clause, defaulting 9:00. */
function parseTime(text: string): { minute: number; hour: number } {
  const match = text.match(AT_TIME);
  if (!match) {
    return { minute: 0, hour: 9 };
  }
  let hour = Number(match[1]);
  const minute = match[2] ? Number(match[2]) : 0;
  const meridiem = match[3];
  if (meridiem === "pm" && hour < 12) {
    hour += 12;
  }
  if (meridiem === "am" && hour === 12) {
    hour = 0;
  }
  if (hour > 23 || minute > 59) {
    return { minute: 0, hour: 9 };
  }
  return { minute, hour };
}

/**
 * Parse a natural-language schedule phrase into a 5-field cron, or return null
 * when the phrase is not one we recognize. Handles: a raw cron (passthrough),
 * "every N minutes", "hourly"/"every hour", "daily"/"every day at TIME",
 * "weekdays"/"every weekday at TIME", "weekly"/"every week at TIME", and
 * "every <weekday> at TIME".
 */
export function parseScheduleText(input: string): string | null {
  const raw = input.trim();
  if (raw.length === 0) {
    return null;
  }
  // A directly-typed 5-field cron passes through (main still validates it).
  if (RAW_CRON.test(raw)) {
    return raw;
  }

  const text = raw.toLowerCase();

  const minutesMatch = text.match(EVERY_N_MINUTES);
  if (minutesMatch) {
    const step = Number(minutesMatch[1]);
    if (step >= 1 && step <= 59) {
      return `*/${step} * * * *`;
    }
  }

  if (HOURLY.test(text)) {
    return "0 * * * *";
  }

  const { minute, hour } = parseTime(text);

  const namedDay = text.match(EVERY_WEEKDAY_NAME);
  if (namedDay) {
    const dow = WEEKDAY_TO_CRON[namedDay[1]];
    if (dow !== undefined) {
      return `${minute} ${hour} * * ${dow}`;
    }
  }

  if (WEEKDAYS.test(text)) {
    return `${minute} ${hour} * * 1-5`;
  }
  if (WEEKLY.test(text)) {
    return `${minute} ${hour} * * 1`;
  }
  if (DAILY.test(text)) {
    return `${minute} ${hour} * * *`;
  }

  return null;
}
