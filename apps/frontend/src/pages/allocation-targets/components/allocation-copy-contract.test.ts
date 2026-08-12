import { describe, expect, it } from "vitest";

import deAllocation from "@/i18n/locales/de/allocation.json";
import deInsights from "@/i18n/locales/de/insights.json";
import enAllocation from "@/i18n/locales/en/allocation.json";
import enInsights from "@/i18n/locales/en/insights.json";
import esAllocation from "@/i18n/locales/es/allocation.json";
import esInsights from "@/i18n/locales/es/insights.json";
import frAllocation from "@/i18n/locales/fr/allocation.json";
import frInsights from "@/i18n/locales/fr/insights.json";
import zhAllocation from "@/i18n/locales/zh/allocation.json";
import zhInsights from "@/i18n/locales/zh/insights.json";

import { BUILT_IN_PRESETS, modelPresetTitle } from "./model-preset-data";

function leafPaths(value: unknown, prefix = ""): string[] {
  if (!value || typeof value !== "object" || Array.isArray(value)) return [prefix];
  return Object.entries(value)
    .flatMap(([key, child]) => leafPaths(child, prefix ? `${prefix}.${key}` : key))
    .sort();
}

describe("allocation copy contract", () => {
  it("keeps allocation and Insights translation keys aligned in all five locales", () => {
    for (const locale of [deAllocation, esAllocation, frAllocation, zhAllocation]) {
      expect(leafPaths(locale)).toEqual(leafPaths(enAllocation));
    }
    for (const locale of [deInsights, esInsights, frInsights, zhInsights]) {
      expect(leafPaths(locale)).toEqual(leafPaths(enInsights));
    }
  });

  it("does not retain the automated planner translation surfaces", () => {
    expect(enAllocation).not.toHaveProperty("planner");
    expect(enAllocation).not.toHaveProperty("trades");
    expect(enAllocation).not.toHaveProperty("rebalance");
    expect(enInsights.insights.rails).not.toHaveProperty("suggested_moves");
    expect(JSON.stringify(enAllocation)).not.toMatch(
      /proposed trades|review rebalance|largest move/i,
    );
    expect(enAllocation.worksheet).not.toHaveProperty("acknowledgeWarnings");
    expect(enAllocation.worksheet).not.toHaveProperty("acknowledgeExport");
  });

  it("uses quantitative example titles without risk or featured metadata", () => {
    for (const preset of BUILT_IN_PRESETS) {
      expect(preset).not.toHaveProperty("risk");
      expect(preset).not.toHaveProperty("featured");
      expect(modelPresetTitle(preset, [])).toMatch(/\d+%/);
    }
  });
});
