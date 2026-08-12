export type WorksheetDecimalValue = string | number | boolean | null | undefined;

export interface ProjectionAdjustmentInput {
  currentValue: number;
  inputMode: "amount" | "after_percentage";
  inputValue: string;
}

export interface AllocationProgress {
  remaining: number;
  overallocated: number;
  isFullyAllocated: boolean;
}

const DECIMAL_INPUT_PATTERN = /^[+-]?(?:\d+(?:[.,]\d*)?|[.,]\d+)$/;
const SPREADSHEET_FORMULA_PREFIX = /^[=+\-@\t\r]/;

export function parseDecimalInput(value: string): number {
  const trimmed = value.trim();
  if (trimmed === "") return 0;
  if (!DECIMAL_INPUT_PATTERN.test(trimmed)) return Number.NaN;
  return Number(trimmed.replace(",", "."));
}

export function decimalInputOrZero(value: string): number {
  const parsed = parseDecimalInput(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

export function formatDecimalInput(value: number, maximumFractionDigits = 2): string {
  if (!Number.isFinite(value)) return "";
  const normalized = Math.abs(value) < Number.EPSILON ? 0 : value;
  return normalized
    .toFixed(maximumFractionDigits)
    .replace(/(\.\d*?[1-9])0+$/, "$1")
    .replace(/\.0+$/, "");
}

export function csvCell(value: WorksheetDecimalValue): string {
  let text = String(value ?? "");
  if (typeof value === "string" && SPREADSHEET_FORMULA_PREFIX.test(text)) {
    text = `'${text}`;
  }
  return `"${text.replaceAll('"', '""')}"`;
}

export function resolveProjectionDenominator(
  currentTotal: number,
  externalContribution: number,
  includesCashCategory: boolean,
  adjustments: ProjectionAdjustmentInput[],
): number {
  if (includesCashCategory) return currentTotal + externalContribution;

  let fixedChange = 0;
  let percentageCurrentValue = 0;
  let percentageWeight = 0;
  for (const adjustment of adjustments) {
    if (adjustment.inputValue.trim() === "") continue;
    const parsed = parseDecimalInput(adjustment.inputValue);
    if (!Number.isFinite(parsed)) return Number.NaN;
    if (adjustment.inputMode === "amount") {
      fixedChange += parsed;
    } else {
      percentageCurrentValue += adjustment.currentValue;
      percentageWeight += parsed / 100;
    }
  }

  const numerator = currentTotal + fixedChange - percentageCurrentValue;
  const denominatorFactor = 1 - percentageWeight;
  if (denominatorFactor < -Number.EPSILON) return Number.NaN;
  if (Math.abs(denominatorFactor) <= Number.EPSILON) {
    if (Math.abs(numerator) > 0.01) return Number.NaN;
    const fullyAllocatedTotal = currentTotal + fixedChange;
    return fullyAllocatedTotal > 0 ? fullyAllocatedTotal : Number.NaN;
  }

  const projectedTotal = numerator / denominatorFactor;
  return projectedTotal > 0 && Number.isFinite(projectedTotal) ? projectedTotal : Number.NaN;
}

export function allocationProgress(
  requested: number,
  assigned: number,
  epsilon: number,
): AllocationProgress {
  const difference = requested - assigned;
  return {
    remaining: Math.max(0, difference),
    overallocated: Math.max(0, -difference),
    isFullyAllocated: Math.abs(difference) <= epsilon,
  };
}
