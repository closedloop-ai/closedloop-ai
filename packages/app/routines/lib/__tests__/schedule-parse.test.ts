import { describe, expect, it } from "vitest";
import { parseScheduleText, SCHEDULE_PRESETS } from "../schedule-parse";

describe("parseScheduleText", () => {
  it("parses the natural-language phrases the modal offers", () => {
    expect(parseScheduleText("every weekday at 9am")).toBe("0 9 * * 1-5");
    expect(parseScheduleText("daily at 6pm")).toBe("0 18 * * *");
    expect(parseScheduleText("every monday at 14:30")).toBe("30 14 * * 1");
    expect(parseScheduleText("weekly")).toBe("0 9 * * 1");
    expect(parseScheduleText("hourly")).toBe("0 * * * *");
    expect(parseScheduleText("every 15 minutes")).toBe("*/15 * * * *");
  });

  it("handles 12am/12pm meridiem edge cases", () => {
    expect(parseScheduleText("daily at 12am")).toBe("0 0 * * *");
    expect(parseScheduleText("daily at 12pm")).toBe("0 12 * * *");
  });

  it("passes a directly-typed 5-field cron straight through", () => {
    expect(parseScheduleText("*/5 * * * *")).toBe("*/5 * * * *");
    expect(parseScheduleText("0 9 1-5 * *")).toBe("0 9 1-5 * *");
  });

  it("returns null for an empty or unrecognized phrase", () => {
    expect(parseScheduleText("")).toBeNull();
    expect(parseScheduleText("sometime soon")).toBeNull();
    expect(parseScheduleText("banana")).toBeNull();
  });

  it("every preset maps to a parseable cron", () => {
    for (const preset of SCHEDULE_PRESETS) {
      expect(parseScheduleText(preset.label.toLowerCase())).toBe(preset.cron);
    }
  });
});
