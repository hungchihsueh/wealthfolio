import { describe, expect, it } from "vitest";

import {
  allocationProgress,
  csvCell,
  formatDecimalInput,
  parseDecimalInput,
  resolveProjectionDenominator,
} from "./allocation-worksheet-utils";

describe("allocation worksheet input utilities", () => {
  it("accepts period and comma decimal separators without changing scale", () => {
    expect(parseDecimalInput("32.5")).toBe(32.5);
    expect(parseDecimalInput("32,5")).toBe(32.5);
    expect(parseDecimalInput("-0,125")).toBe(-0.125);
    expect(formatDecimalInput(32.5, 4)).toBe("32.5");
  });

  it("rejects grouped and partially malformed values", () => {
    expect(parseDecimalInput("1,000.00")).toBeNaN();
    expect(parseDecimalInput("12abc")).toBeNaN();
    expect(parseDecimalInput("1.2.3")).toBeNaN();
  });

  it("uses the fixed portfolio denominator when cash is represented", () => {
    expect(
      resolveProjectionDenominator(100_000, 10_000, true, [
        { currentValue: 20_000, inputMode: "after_percentage", inputValue: "30" },
      ]),
    ).toBe(110_000);
  });

  it("solves the changing denominator when cash is excluded", () => {
    const denominator = resolveProjectionDenominator(100_000, 0, false, [
      { currentValue: 20_000, inputMode: "after_percentage", inputValue: "30" },
    ]);
    expect(denominator).toBeCloseTo(114_285.714286, 5);
    expect(denominator * 0.3 - 20_000).toBeCloseTo(14_285.714286, 5);
  });

  it("solves multiple percentage rows together with fixed changes", () => {
    const denominator = resolveProjectionDenominator(100_000, 0, false, [
      { currentValue: 20_000, inputMode: "after_percentage", inputValue: "30" },
      { currentValue: 10_000, inputMode: "after_percentage", inputValue: "20" },
      { currentValue: 5_000, inputMode: "amount", inputValue: "5000" },
    ]);
    expect(denominator).toBe(150_000);
  });

  it("does not interpret a cleared final percentage as a full reduction", () => {
    expect(
      resolveProjectionDenominator(100_000, 0, false, [
        { currentValue: 20_000, inputMode: "after_percentage", inputValue: "" },
      ]),
    ).toBe(100_000);
  });

  it("protects spreadsheet text while preserving numeric cells", () => {
    expect(csvCell('=HYPERLINK("https://example.com")')).toBe(
      '"\'=HYPERLINK(""https://example.com"")"',
    );
    expect(csvCell("@SUM(A1:A2)")).toBe('"\'@SUM(A1:A2)"');
    expect(csvCell(-12.5)).toBe('"-12.5"');
  });

  it("distinguishes exact, incomplete, and excessive account allocation", () => {
    expect(allocationProgress(100, 100, 0.01)).toEqual({
      remaining: 0,
      overallocated: 0,
      isFullyAllocated: true,
    });
    expect(allocationProgress(100, 80, 0.01).remaining).toBe(20);
    expect(allocationProgress(100, 120, 0.01)).toEqual({
      remaining: 0,
      overallocated: 20,
      isFullyAllocated: false,
    });
  });
});
