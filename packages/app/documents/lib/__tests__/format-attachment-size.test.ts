import { describe, expect, test } from "vitest";
import { formatAttachmentSize } from "../format-attachment-size";

describe("formatAttachmentSize", () => {
  test("renders sub-megabyte sizes in whole kilobytes", () => {
    expect(formatAttachmentSize(0)).toBe("0 KB");
    expect(formatAttachmentSize(1)).toBe("1 KB");
    expect(formatAttachmentSize(42_000)).toBe("42 KB");
    expect(formatAttachmentSize(1024 * 1023)).toBe("1023 KB");
  });

  test("carries into megabytes instead of rendering 1024 KB", () => {
    expect(formatAttachmentSize(1_048_575)).toBe("1.0 MB");
    expect(formatAttachmentSize(1024 * 1024)).toBe("1.0 MB");
  });

  test("renders megabyte sizes with one decimal", () => {
    expect(formatAttachmentSize(10 * 1024 * 1024)).toBe("10.0 MB");
    expect(formatAttachmentSize(1024 * 1024 * 1023)).toBe("1023.0 MB");
  });

  test("carries into gigabytes instead of rendering 1024.0 MB", () => {
    expect(formatAttachmentSize(1_073_741_823)).toBe("1.0 GB");
    expect(formatAttachmentSize(1024 * 1024 * 1024)).toBe("1.0 GB");
  });

  test("renders multi-gigabyte sizes in gigabytes", () => {
    expect(formatAttachmentSize(5_368_709_120)).toBe("5.0 GB");
  });
});
