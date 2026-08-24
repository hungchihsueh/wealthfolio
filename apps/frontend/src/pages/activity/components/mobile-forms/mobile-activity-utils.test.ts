import { describe, expect, it } from "vitest";
import { ActivityType } from "@/lib/constants";
import { getMobileActivityAmount } from "./mobile-activity-utils";

describe("getMobileActivityAmount", () => {
  it("prefers the canonical amount over legacy charge columns", () => {
    expect(
      getMobileActivityAmount({
        activityType: ActivityType.TAX,
        amount: "25",
        tax: "15",
        fee: "10",
      }),
    ).toBe(25);
  });

  it("loads legacy fee and tax amounts for editing", () => {
    expect(getMobileActivityAmount({ activityType: ActivityType.FEE, fee: "10" })).toBe(10);
    expect(getMobileActivityAmount({ activityType: ActivityType.TAX, tax: "15" })).toBe(15);
    expect(getMobileActivityAmount({ activityType: ActivityType.TAX, fee: "8" })).toBe(8);
  });

  it("treats zero as missing and normalizes legacy signs", () => {
    expect(
      getMobileActivityAmount({ activityType: ActivityType.FEE, amount: "0", fee: "-4" }),
    ).toBe(4);
    expect(getMobileActivityAmount({ activityType: ActivityType.TAX, amount: "0", tax: "0" })).toBe(
      undefined,
    );
  });
});
