import { describe, expect, it } from "vitest";
import { formatError } from "../src/helper/formatError";

describe("formatError", () => {
  it("returns fallback for empty values", () => {
    expect(formatError(null)).toBe("Unknown error");
  });

  it("returns strings unchanged", () => {
    expect(formatError("boom")).toBe("boom");
  });

  it("formats object error details", () => {
    const message = formatError({
      message: "Request failed",
      code: "E_FAIL",
      status: 500,
      response: { status: 429 },
    });
    expect(message).toBe("Request failed | code=E_FAIL | status=500 | http=429");
  });
});

