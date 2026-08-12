import { useEffect, useMemo, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { useQueries } from "@tanstack/react-query";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  Button,
  Card,
  CardContent,
  Command,
  CommandEmpty,
  CommandInput,
  CommandItem,
  CommandList,
  Icons,
  Popover,
  PopoverContent,
  PopoverTrigger,
  Skeleton,
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@wealthfolio/ui";
import { toast } from "sonner";

import { getAssetTaxonomyAssignments, getHoldingsList } from "@/adapters";
import { useAccounts } from "@/hooks/use-accounts";
import { usePortfolios } from "@/hooks/use-portfolios";
import { useSyncMarketDataMutation } from "@/hooks/use-sync-market-data";
import { useTaxonomy } from "@/hooks/use-taxonomies";
import { AccountPurpose, HoldingType } from "@/lib/constants";
import { QueryKeys } from "@/lib/query-keys";
import type {
  Account,
  AccountScope,
  AllocationTarget,
  AllocationWorksheetLineInput,
  AllocationWorksheetResult,
  Asset,
  AssetTaxonomyAssignment,
  DriftReport,
  Holding,
  TaxonomyCategory,
} from "@/lib/types";
import { cn, formatAmount } from "@/lib/utils";
import { useAssets } from "@/pages/asset/hooks/use-assets";
import { useLatestQuotes } from "@/pages/asset/hooks/use-latest-quotes";
import { useExchangeRates } from "@/pages/settings/general/exchange-rates/use-exchange-rate";

import { useAllocationWorksheet } from "../hooks/use-allocation-worksheet";
import {
  allocationTargetColorForRow,
  buildAllocationTargetColorMap,
} from "./allocation-target-colors";
import {
  allocationProgress,
  csvCell,
  decimalInputOrZero,
  formatDecimalInput,
  parseDecimalInput,
  resolveProjectionDenominator,
  type WorksheetDecimalValue,
} from "./allocation-worksheet-utils";

const DISCLOSURE_STORAGE_KEY = "wealthfolio:rebalancing-worksheet-disclosure:v2";
const DRAFT_STORAGE_PREFIX = "wealthfolio:rebalancing-worksheet-draft:v1";
const DISCLOSURE_VERSION = 2;
const DRAFT_VERSION = 1;
const CASH_PRESETS = [0.25, 0.5, 0.75, 1] as const;
const AMOUNT_EPSILON = 0.01;
const AUTO_CALCULATE_DEBOUNCE_MS = 500;

type WorksheetView = "position" | "review";
type WorksheetEditMode = "amount" | "after_percentage";

interface AllocationWorksheetTabProps {
  profile: AllocationTarget | null;
  driftReport: DriftReport | null;
  accountScope: AccountScope;
  sourceVersion: string;
  isSourceLoading: boolean;
}

interface PositionAccountHolding {
  accountId: string;
  value: number;
  quantity: number;
}

interface WorksheetPosition {
  assetId: string;
  symbol: string;
  name: string;
  value: number;
  quantity: number;
  currentPct: number;
  categoryIds: string[];
  categoryNames: string[];
  categoryExposures: PositionCategoryExposure[];
  accountHoldings: PositionAccountHolding[];
  isAdded: boolean;
}

interface PositionCategoryExposure {
  categoryId: string;
  categoryName: string;
  weightBps: number;
}

interface PositionAdjustment {
  inputMode: WorksheetEditMode;
  inputValue: string;
  accountAmounts: Record<string, string>;
}

type PositionAdjustments = Record<string, PositionAdjustment>;

interface WorksheetDraft {
  version: number;
  savedAt: string;
  editMode: WorksheetEditMode;
  cashToDeploy: string;
  selectedAccountIds: string[];
  addedAssetIds: string[];
  adjustments: PositionAdjustments;
}

interface WorksheetExportLabels {
  title: string;
  target: string;
  prepared: string;
  funding: string;
  totalIncreases: string;
  totalReductions: string;
  adjustments: string;
  direction: string;
  security: string;
  account: string;
  unknownAccount: string;
  amount: string;
  quantity: string;
  unitPrice: string;
  increase: string;
  reduce: string;
  warnings: string;
  disclaimer: string;
}

interface PreparedWorksheet {
  lines: AllocationWorksheetLineInput[];
  issue?: PreparedWorksheetIssue;
  increaseTotal: number;
  reductionTotal: number;
  changedPositionCount: number;
}

interface PreparedWorksheetIssue {
  message: string;
  kind: "accounts" | "cash" | "position" | "allocation" | "funding" | "empty" | "lines";
  assetId?: string;
}

interface WorksheetCalculationError {
  title: string;
  description?: string;
  assetId?: string;
}

function currencyFractionDigits(currency: string): number {
  try {
    return (
      new Intl.NumberFormat(undefined, { style: "currency", currency }).resolvedOptions()
        .maximumFractionDigits ?? 2
    );
  } catch {
    return 2;
  }
}

function formatQuantity(value: number): string {
  return new Intl.NumberFormat(undefined, { maximumFractionDigits: 6 }).format(value);
}

function formatSourceTimestamp(value: string): string {
  const timestamp = new Date(value);
  if (Number.isNaN(timestamp.getTime())) return value;
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(timestamp);
}

function formatSignedAmount(value: number, currency: string): string {
  if (!Number.isFinite(value)) return "—";
  if (Math.abs(value) < AMOUNT_EPSILON) return "—";
  return `${value > 0 ? "+" : "−"}${formatAmount(Math.abs(value), currency)}`;
}

function accountScopeDraftKey(scope: AccountScope): string {
  if (scope.type === "account") return `account:${scope.accountId}`;
  if (scope.type === "portfolio") return `portfolio:${scope.portfolioId}`;
  if (scope.type === "accounts") return `accounts:${[...scope.accountIds].sort().join(",")}`;
  return "all";
}

function worksheetDraftStorageKey(targetId: string, scope: AccountScope): string {
  return `${DRAFT_STORAGE_PREFIX}:${targetId}:${accountScopeDraftKey(scope)}`;
}

function readWorksheetDraft(storageKey: string): WorksheetDraft | null {
  try {
    const parsed: unknown = JSON.parse(localStorage.getItem(storageKey) ?? "null");
    if (!parsed || typeof parsed !== "object") return null;
    const draft = parsed as Partial<WorksheetDraft>;
    if (
      draft.version !== DRAFT_VERSION ||
      (draft.editMode !== "amount" && draft.editMode !== "after_percentage") ||
      typeof draft.cashToDeploy !== "string" ||
      !Array.isArray(draft.selectedAccountIds) ||
      !Array.isArray(draft.addedAssetIds) ||
      !draft.adjustments ||
      typeof draft.adjustments !== "object"
    ) {
      return null;
    }
    return draft as WorksheetDraft;
  } catch {
    return null;
  }
}

function buildExportCsv(
  result: AllocationWorksheetResult,
  accountNames: Map<string, string>,
  fundingSummary: string,
  disclosure: string,
  labels: WorksheetExportLabels,
) {
  const rows: WorksheetDecimalValue[][] = [
    [labels.title],
    [labels.target, result.targetName],
    [labels.prepared, formatSourceTimestamp(result.calculatedAt)],
    [labels.funding, fundingSummary],
    [labels.totalIncreases, formatAmount(result.increaseTotal, result.baseCurrency)],
    [labels.totalReductions, formatAmount(result.reductionTotal, result.baseCurrency)],
    [],
    [labels.adjustments],
    [
      labels.direction,
      labels.security,
      labels.account,
      `${labels.amount} (${result.baseCurrency})`,
      labels.quantity,
      `${labels.unitPrice} (${result.baseCurrency})`,
    ],
  ];
  for (const line of result.lines) {
    rows.push([
      line.direction === "increase" ? labels.increase : labels.reduce,
      `${line.symbol} — ${line.name}`,
      accountNames.get(line.accountId) ?? labels.unknownAccount,
      line.estimatedAmount,
      line.quantity,
      line.unitPrice,
    ]);
  }
  if (result.warnings.length > 0) {
    rows.push([], [labels.warnings]);
    for (const warning of result.warnings) rows.push([warning.message]);
  }
  rows.push([], [labels.disclaimer], [disclosure]);

  return rows.map((row) => row.map(csvCell).join(",")).join("\n");
}

function downloadCsv(csv: string) {
  const blob = new Blob([csv], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = `rebalancing-worksheet-${new Date().toISOString().slice(0, 10)}.csv`;
  anchor.click();
  URL.revokeObjectURL(url);
}

function positionChangeAmount(
  adjustment: PositionAdjustment | undefined,
  position: WorksheetPosition,
  projectedPortfolioValue: number,
): number {
  if (!adjustment || adjustment.inputValue.trim() === "") return 0;
  if (adjustment.inputMode === "amount") return parseDecimalInput(adjustment.inputValue);
  const afterPercentage = parseDecimalInput(adjustment.inputValue);
  return (afterPercentage / 100) * projectedPortfolioValue - position.value;
}

function eligibleAccountsForPosition(
  position: WorksheetPosition,
  changeAmount: number,
  adjustment: PositionAdjustment | undefined,
  selectedAccountIds: Set<string>,
  accounts: Account[],
): Account[] {
  const heldAccountIds = new Set(position.accountHoldings.map((holding) => holding.accountId));
  const heldAccountOrder = new Map(
    position.accountHoldings.map((holding, index) => [holding.accountId, index]),
  );
  const includedAccountIds = new Set(Object.keys(adjustment?.accountAmounts ?? {}));
  return accounts
    .filter(
      (account) =>
        selectedAccountIds.has(account.id) &&
        (heldAccountIds.has(account.id) ||
          (changeAmount >= 0 && includedAccountIds.has(account.id))),
    )
    .sort((left, right) => {
      const leftHoldingIndex = heldAccountOrder.get(left.id);
      const rightHoldingIndex = heldAccountOrder.get(right.id);
      if (leftHoldingIndex !== undefined && rightHoldingIndex !== undefined) {
        return leftHoldingIndex - rightHoldingIndex;
      }
      if (leftHoldingIndex !== undefined) return -1;
      if (rightHoldingIndex !== undefined) return 1;
      return left.name.localeCompare(right.name);
    });
}

function buildPositions(
  holdings: Holding[],
  assets: Asset[],
  addedAssetIds: string[],
  report: DriftReport,
  taxonomyId: string,
  assignmentsByAsset: Map<string, AssetTaxonomyAssignment[]>,
  taxonomyCategories: TaxonomyCategory[],
): WorksheetPosition[] {
  const assetById = new Map(assets.map((asset) => [asset.id, asset]));
  const categoryById = new Map(taxonomyCategories.map((category) => [category.id, category]));
  const categoryValuesByAsset = new Map<
    string,
    Map<string, { categoryName: string; value: number }>
  >();
  for (const row of report.holdings?.rows ?? []) {
    if (row.isCash || !row.assetId) continue;
    const categories =
      categoryValuesByAsset.get(row.assetId) ??
      new Map<string, { categoryName: string; value: number }>();
    const current = categories.get(row.categoryId) ?? {
      categoryName: row.categoryName,
      value: 0,
    };
    current.value += row.value;
    categories.set(row.categoryId, current);
    categoryValuesByAsset.set(row.assetId, categories);
  }

  const positions = new Map<string, WorksheetPosition>();
  for (const holding of holdings) {
    const assetId = holding.instrument?.id;
    if (holding.holdingType !== HoldingType.SECURITY || !assetId || holding.quantity <= 0) continue;
    const asset = assetById.get(assetId);
    const categories =
      categoryValuesByAsset.get(assetId) ??
      new Map<string, { categoryName: string; value: number }>();
    const current: WorksheetPosition = positions.get(assetId) ?? {
      assetId,
      symbol: holding.instrument?.symbol ?? asset?.displayCode ?? assetId,
      name: holding.instrument?.name ?? asset?.name ?? holding.instrument?.symbol ?? assetId,
      value: 0,
      quantity: 0,
      currentPct: 0,
      categoryIds: [...categories.keys()],
      categoryNames: [...categories.values()].map((category) => category.categoryName),
      categoryExposures: [],
      accountHoldings: [],
      isAdded: false,
    };
    const value = Number(holding.marketValue.base) || 0;
    current.value += value;
    current.quantity += holding.quantity;
    const accountHolding = current.accountHoldings.find(
      (item) => item.accountId === holding.accountId,
    );
    if (accountHolding) {
      accountHolding.value += value;
      accountHolding.quantity += holding.quantity;
    } else {
      current.accountHoldings.push({
        accountId: holding.accountId,
        value,
        quantity: holding.quantity,
      });
    }
    positions.set(assetId, current);
  }

  for (const assetId of addedAssetIds) {
    if (positions.has(assetId)) continue;
    const asset = assetById.get(assetId);
    if (!asset) continue;
    const assignments = (assignmentsByAsset.get(assetId) ?? []).filter(
      (assignment) => assignment.taxonomyId === taxonomyId && assignment.weight > 0,
    );
    const assignedWeight = assignments.reduce((sum, assignment) => sum + assignment.weight, 0);
    const categoryExposures: PositionCategoryExposure[] = assignments.map((assignment) => ({
      categoryId: assignment.categoryId,
      categoryName: categoryById.get(assignment.categoryId)?.name ?? assignment.categoryId,
      weightBps: assignment.weight,
    }));
    if (assignedWeight < 10_000) {
      categoryExposures.push({
        categoryId: "__UNKNOWN__",
        categoryName: "Unclassified",
        weightBps: 10_000 - assignedWeight,
      });
    }
    positions.set(assetId, {
      assetId,
      symbol: asset.displayCode ?? asset.instrumentSymbol ?? asset.name ?? asset.id,
      name: asset.name ?? asset.displayCode ?? asset.instrumentSymbol ?? asset.id,
      value: 0,
      quantity: 0,
      currentPct: 0,
      categoryIds: categoryExposures.map((exposure) => exposure.categoryId),
      categoryNames: categoryExposures.map((exposure) => exposure.categoryName),
      categoryExposures,
      accountHoldings: [],
      isAdded: true,
    });
  }

  return [...positions.values()]
    .map((position) => {
      const categoryValues = categoryValuesByAsset.get(position.assetId);
      const classifiedValue = categoryValues
        ? [...categoryValues.values()].reduce((sum, category) => sum + category.value, 0)
        : 0;
      const categoryExposures =
        position.categoryExposures.length > 0
          ? position.categoryExposures
          : categoryValues && classifiedValue > 0
            ? [...categoryValues.entries()].map(([categoryId, category]) => ({
                categoryId,
                categoryName: category.categoryName,
                weightBps: Math.round((category.value / classifiedValue) * 10_000),
              }))
            : [
                {
                  categoryId: "__UNKNOWN__",
                  categoryName: "Unclassified",
                  weightBps: 10_000,
                },
              ];
      return {
        ...position,
        currentPct: report.totalValue > 0 ? (position.value / report.totalValue) * 100 : 0,
        categoryIds: categoryExposures.map((exposure) => exposure.categoryId),
        categoryNames: categoryExposures.map((exposure) => exposure.categoryName),
        categoryExposures,
        accountHoldings: [...position.accountHoldings].sort(
          (left, right) => right.value - left.value,
        ),
      };
    })
    .sort((left, right) => right.value - left.value || left.symbol.localeCompare(right.symbol));
}

interface CashControlProps {
  observedCash: number;
  value: string;
  currency: string;
  onChange: (value: string) => void;
}

function CashControl({ observedCash, value, currency, onChange }: CashControlProps) {
  const { t } = useTranslation();
  const selectedCash = Math.max(0, decimalInputOrZero(value));
  const fractionDigits = currencyFractionDigits(currency);
  const sliderPercentage =
    observedCash > 0 ? Math.min(100, (selectedCash / observedCash) * 100) : 0;
  const unrecordedCash = Math.max(0, selectedCash - observedCash);

  return (
    <div id="worksheet-cash" className="min-w-0 p-5 sm:p-6">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <p className="text-muted-foreground font-mono text-[11px] uppercase tracking-[0.16em]">
          {t("allocation:worksheet.cashToDeploy")}
        </p>
        <span className="text-muted-foreground font-mono text-xs">
          {t("allocation:worksheet.ofObservedCash", {
            amount: formatAmount(observedCash, currency),
          })}
        </span>
      </div>

      <div className="mt-2 flex items-baseline gap-2">
        <span className="text-muted-foreground text-sm">{currency}</span>
        <input
          aria-label={t("allocation:worksheet.cashToDeploy")}
          value={value}
          onChange={(event) => onChange(event.target.value)}
          inputMode="decimal"
          placeholder="0"
          className="placeholder:text-muted-foreground/50 min-w-0 flex-1 bg-transparent font-mono text-3xl font-semibold tabular-nums outline-none"
        />
      </div>

      <input
        aria-label={t("allocation:worksheet.cashSlider")}
        type="range"
        min={0}
        max={observedCash || 1}
        step={observedCash > 0 ? 10 ** -fractionDigits : 1}
        value={Math.min(selectedCash, observedCash)}
        disabled={observedCash <= 0}
        onChange={(event) =>
          onChange(Number.parseFloat(event.target.value).toFixed(fractionDigits))
        }
        className="lever-slider mt-3 block w-full disabled:cursor-not-allowed disabled:opacity-40"
        style={{ ["--lever-pct" as string]: `${sliderPercentage}%` }}
      />

      <div className="mt-3 flex flex-wrap gap-2">
        {CASH_PRESETS.map((fraction) => {
          const preset = observedCash * fraction;
          const isActive = Math.abs(preset - selectedCash) <= 0.5 + observedCash * 0.001;
          return (
            <button
              key={fraction}
              type="button"
              disabled={observedCash <= 0}
              onClick={() => onChange(preset.toFixed(fractionDigits))}
              className={cn(
                "rounded-full border px-3 py-1 font-mono text-xs transition-colors disabled:opacity-40",
                isActive
                  ? "border-foreground bg-foreground text-background"
                  : "border-border text-muted-foreground hover:border-foreground/40 hover:text-foreground",
              )}
            >
              {fraction === 1
                ? t("allocation:worksheet.allCash")
                : `${Math.round(fraction * 100)}%`}
            </button>
          );
        })}
      </div>

      {unrecordedCash > 0 && (
        <div className="mt-4 rounded-lg border border-amber-400/50 bg-amber-50/60 px-3 py-2 dark:bg-amber-950/15">
          <p className="text-xs leading-relaxed text-amber-950/80 dark:text-amber-100/80">
            {t("allocation:worksheet.unrecordedCashDerived", {
              amount: formatAmount(unrecordedCash, currency),
              observed: formatAmount(observedCash, currency),
            })}
          </p>
        </div>
      )}
    </div>
  );
}

interface AccountScopeControlProps {
  accounts: Account[];
  selectedAccountIds: Set<string>;
  onToggle: (accountId: string) => void;
  onSelectAll: () => void;
  onClearAll: () => void;
}

function AccountScopeControl({
  accounts,
  selectedAccountIds,
  onToggle,
  onSelectAll,
  onClearAll,
}: AccountScopeControlProps) {
  const { t } = useTranslation();
  const allSelected = accounts.length > 0 && selectedAccountIds.size === accounts.length;
  const noneSelected = selectedAccountIds.size === 0;

  return (
    <div id="worksheet-account-scope" className="min-w-0 p-5 sm:p-6 lg:border-r">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
          <p className="text-muted-foreground font-mono text-[11px] uppercase tracking-[0.16em]">
            {t("allocation:worksheet.accountsInScope")}
          </p>
          <span className="text-muted-foreground text-xs">
            {t("allocation:worksheet.accountsInScopeHint")}
          </span>
        </div>
        <div className="flex items-center gap-2 text-xs">
          <span className="text-muted-foreground font-mono text-[11px]">
            {t("allocation:worksheet.selectedAccountCount", {
              selected: selectedAccountIds.size,
              total: accounts.length,
            })}
          </span>
          <button
            type="button"
            disabled={allSelected}
            onClick={onSelectAll}
            className="text-foreground underline-offset-4 hover:underline disabled:pointer-events-none disabled:opacity-35"
          >
            {t("allocation:worksheet.selectAllAccounts")}
          </button>
          <span className="text-border">·</span>
          <button
            type="button"
            disabled={noneSelected}
            onClick={onClearAll}
            className="text-foreground underline-offset-4 hover:underline disabled:pointer-events-none disabled:opacity-35"
          >
            {t("allocation:worksheet.clearAccounts")}
          </button>
        </div>
      </div>
      <div className="mt-4 flex flex-wrap gap-2">
        {accounts.map((account) => {
          const selected = selectedAccountIds.has(account.id);
          return (
            <button
              key={account.id}
              type="button"
              aria-pressed={selected}
              onClick={() => onToggle(account.id)}
              className={cn(
                "flex items-center gap-1.5 rounded-full border px-3.5 py-1.5 font-mono text-xs transition-colors",
                selected
                  ? "text-foreground border-[#557866] bg-[#557866]/10 shadow-sm"
                  : "border-border text-muted-foreground hover:border-foreground/40 hover:text-foreground",
              )}
            >
              <span
                className={cn(
                  "flex h-3.5 w-3.5 items-center justify-center rounded-full border",
                  selected ? "border-[#557866] bg-[#557866] text-white" : "border-current/40",
                )}
              >
                {selected && <Icons.Check className="h-2.5 w-2.5" />}
              </span>
              {account.name}
            </button>
          );
        })}
      </div>
      <p className="text-muted-foreground mt-5 max-w-3xl text-xs leading-relaxed">
        {t("allocation:worksheet.scopeDoesNotChangeTarget")}
      </p>
    </div>
  );
}

interface AddPositionButtonProps {
  assets: Asset[];
  excludedAssetIds: Set<string>;
  onSelect: (assetId: string) => void;
}

function AddPositionButton({ assets, excludedAssetIds, onSelect }: AddPositionButtonProps) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const availableAssets = assets.filter((asset) => !excludedAssetIds.has(asset.id));

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button size="sm" variant="outline">
          <Icons.Plus className="mr-1.5 h-4 w-4" />
          {t("allocation:worksheet.addPosition")}
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-[340px] max-w-[calc(100vw-2rem)] p-0" align="end">
        <Command>
          <CommandInput placeholder={t("allocation:worksheet.searchSecurities")} />
          <CommandList>
            <CommandEmpty>{t("allocation:worksheet.noMatchingSecurities")}</CommandEmpty>
            {availableAssets.map((asset) => {
              const symbol = asset.displayCode ?? asset.instrumentSymbol ?? asset.name ?? asset.id;
              return (
                <CommandItem
                  key={asset.id}
                  value={`${symbol} ${asset.name ?? ""}`}
                  onSelect={() => {
                    onSelect(asset.id);
                    setOpen(false);
                  }}
                  className="flex flex-col items-start gap-0.5 py-2"
                >
                  <span className="font-mono text-xs font-medium">{symbol}</span>
                  {asset.name && (
                    <span className="text-muted-foreground text-xs">{asset.name}</span>
                  )}
                </CommandItem>
              );
            })}
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  );
}

interface AddAccountButtonProps {
  accounts: Account[];
  onSelect: (accountId: string) => void;
}

function AddAccountButton({ accounts, onSelect }: AddAccountButtonProps) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const sortedAccounts = [...accounts].sort((left, right) => left.name.localeCompare(right.name));

  if (accounts.length === 0) return null;

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button size="sm" variant="outline" className="h-8">
          <Icons.Plus className="mr-1.5 h-3.5 w-3.5" />
          {t("allocation:worksheet.addAccount")}
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-[300px] max-w-[calc(100vw-2rem)] p-0" align="end">
        <Command>
          <CommandInput placeholder={t("allocation:worksheet.searchAccounts")} />
          <CommandList>
            <CommandEmpty>{t("allocation:worksheet.noMatchingAccounts")}</CommandEmpty>
            {sortedAccounts.map((account) => (
              <CommandItem
                key={account.id}
                value={account.name}
                onSelect={() => {
                  onSelect(account.id);
                  setOpen(false);
                }}
              >
                <span className="truncate text-xs font-medium">{account.name}</span>
              </CommandItem>
            ))}
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  );
}

interface AccountAllocationProps {
  position: WorksheetPosition;
  changeAmount: number;
  accounts: Account[];
  availableAccounts: Account[];
  adjustment: PositionAdjustment;
  currency: string;
  cashByAccount: Map<string, number>;
  onAmountChange: (accountId: string, value: string) => void;
  onIncludeAccount: (accountId: string) => void;
  onRemoveAccount: (accountId: string) => void;
}

function AccountAllocation({
  position,
  changeAmount,
  accounts,
  availableAccounts,
  adjustment,
  currency,
  cashByAccount,
  onAmountChange,
  onIncludeAccount,
  onRemoveAccount,
}: AccountAllocationProps) {
  const { t } = useTranslation();
  const requested = Math.abs(changeAmount);
  const assigned =
    accounts.length === 1
      ? requested
      : accounts.reduce(
          (sum, account) =>
            sum + Math.max(0, decimalInputOrZero(adjustment.accountAmounts[account.id] ?? "")),
          0,
        );
  const { remaining, overallocated, isFullyAllocated } = allocationProgress(
    requested,
    assigned,
    AMOUNT_EPSILON,
  );
  const isReduce = changeAmount < 0;
  const activeAccountIds = new Set(accounts.map((account) => account.id));
  const additionalAccounts = isReduce
    ? []
    : availableAccounts.filter((account) => !activeAccountIds.has(account.id));
  const heldAccountIds = new Set(position.accountHoldings.map((holding) => holding.accountId));

  return (
    <div
      data-account-allocation
      className="border-border/60 bg-muted/20 mt-3 rounded-xl border p-4"
    >
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div>
          <p className="font-mono text-[11px] font-medium uppercase tracking-[0.12em]">
            {t("allocation:worksheet.accountAllocation")}
          </p>
          <p className="text-muted-foreground mt-1 text-xs">
            {t(
              isReduce
                ? "allocation:worksheet.reductionAccountAllocationHint"
                : "allocation:worksheet.accountAllocationHint",
            )}
          </p>
        </div>
        <div className="flex flex-wrap items-center justify-end gap-2">
          <span
            className={cn(
              "rounded-full px-2.5 py-1 font-mono text-[11px]",
              isFullyAllocated
                ? "bg-emerald-100 text-emerald-900 dark:bg-emerald-950/35 dark:text-emerald-200"
                : overallocated > AMOUNT_EPSILON
                  ? "bg-red-100 text-red-900 dark:bg-red-950/35 dark:text-red-200"
                  : "bg-amber-100 text-amber-900 dark:bg-amber-950/35 dark:text-amber-200",
            )}
          >
            {isFullyAllocated
              ? t("allocation:worksheet.fullyAllocated")
              : overallocated > AMOUNT_EPSILON
                ? t("allocation:worksheet.overAllocatedBy", {
                    amount: formatAmount(overallocated, currency),
                  })
                : t("allocation:worksheet.remainingToAllocate", {
                    amount: formatAmount(remaining, currency),
                  })}
          </span>
          <AddAccountButton accounts={additionalAccounts} onSelect={onIncludeAccount} />
        </div>
      </div>

      <div className="mt-3 divide-y">
        {accounts.length === 0 && (
          <p className="text-muted-foreground py-3 text-xs leading-relaxed">
            {t("allocation:worksheet.noAccountsIncluded")}
          </p>
        )}
        {accounts.map((account) => {
          const holding = position.accountHoldings.find((item) => item.accountId === account.id);
          const currentValue = holding?.value ?? 0;
          const currentAmount = Math.max(
            0,
            decimalInputOrZero(adjustment.accountAmounts[account.id] ?? ""),
          );
          const rowRemaining = Math.max(0, requested - (assigned - currentAmount));
          return (
            <div
              key={account.id}
              className="grid gap-2 py-3 first:pt-0 last:pb-0 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-center"
            >
              <div className="min-w-0">
                <p className="truncate text-xs font-medium">{account.name}</p>
                <p className="text-muted-foreground mt-0.5 text-[11px]">
                  {holding
                    ? t("allocation:worksheet.accountHoldingSummary", {
                        amount: formatAmount(currentValue, currency),
                        quantity: formatQuantity(holding?.quantity ?? 0),
                      })
                    : t("allocation:worksheet.accountCashSummary", {
                        amount: formatAmount(cashByAccount.get(account.id) ?? 0, currency),
                      })}
                  {!isReduce && holding && (
                    <>
                      {" · "}
                      {t("allocation:worksheet.accountCashSummary", {
                        amount: formatAmount(cashByAccount.get(account.id) ?? 0, currency),
                      })}
                    </>
                  )}
                </p>
              </div>
              <div className="flex items-center gap-2">
                {accounts.length === 1 ? (
                  <span className="font-mono text-sm font-semibold tabular-nums">
                    {formatAmount(requested, currency)}
                  </span>
                ) : (
                  <>
                    <div className="border-input bg-background focus-within:ring-ring flex h-9 w-40 items-center rounded-md border px-2.5 focus-within:ring-1">
                      <span className="text-muted-foreground mr-1.5 text-xs">{currency}</span>
                      <input
                        aria-label={t("allocation:worksheet.accountAmountLabel", {
                          account: account.name,
                        })}
                        value={adjustment.accountAmounts[account.id] ?? ""}
                        onChange={(event) => onAmountChange(account.id, event.target.value)}
                        inputMode="decimal"
                        placeholder="0"
                        className="min-w-0 flex-1 bg-transparent text-right font-mono text-xs outline-none"
                      />
                    </div>
                    {remaining > AMOUNT_EPSILON && (
                      <Button
                        size="sm"
                        variant="ghost"
                        className="h-8 px-2 text-[11px]"
                        onClick={() =>
                          onAmountChange(account.id, formatDecimalInput(rowRemaining, 6))
                        }
                      >
                        {t("allocation:worksheet.useRemaining")}
                      </Button>
                    )}
                  </>
                )}
                {!isReduce && !heldAccountIds.has(account.id) && (
                  <Button
                    size="icon"
                    variant="ghost"
                    className="h-8 w-8"
                    aria-label={t("allocation:worksheet.removeIncludedAccount", {
                      account: account.name,
                    })}
                    onClick={() => onRemoveAccount(account.id)}
                  >
                    <Icons.X className="h-3.5 w-3.5" />
                  </Button>
                )}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

interface ImpactCategory {
  categoryId: string;
  categoryName: string;
  color: string;
  currentBps: number;
  projectedBps: number;
  targetBps: number;
  projectedDifferenceBps: number;
  effectiveBandBps: number;
}

function ImpactBar({
  label,
  categories,
  value,
  emphasis,
}: {
  label: string;
  categories: ImpactCategory[];
  value: (category: ImpactCategory) => number;
  emphasis?: boolean;
}) {
  return (
    <div className="flex items-center gap-3">
      <span
        className={cn(
          "w-16 shrink-0 font-mono text-[11px]",
          emphasis ? "text-foreground font-semibold" : "text-muted-foreground",
        )}
      >
        {label}
      </span>
      <div className="bg-muted/35 flex h-7 min-w-0 flex-1 overflow-hidden rounded-md">
        {categories.map((category) => {
          const width = value(category) / 100;
          if (width <= 0) return null;
          return (
            <div
              key={category.categoryId}
              className="flex min-w-0 items-center overflow-hidden pl-2 font-mono text-[10px] font-medium text-white/95"
              style={{ width: `${width}%`, background: category.color }}
              title={`${category.categoryName}: ${width.toFixed(1)}%`}
            >
              {width >= 14 ? `${width.toFixed(0)}%` : null}
            </div>
          );
        })}
      </div>
    </div>
  );
}

interface ReviewChangesProps {
  result: AllocationWorksheetResult | null;
  isStale: boolean;
  isCalculating: boolean;
  issue?: PreparedWorksheetIssue;
  calculationError: WorksheetCalculationError | null;
  accountNames: Map<string, string>;
  currency: string;
  onReviewIssue: () => void;
  onCopy: () => void;
  onDownload: () => void;
}

function ReviewChanges({
  result,
  isStale,
  isCalculating,
  issue,
  calculationError,
  accountNames,
  currency,
  onReviewIssue,
  onCopy,
  onDownload,
}: ReviewChangesProps) {
  const { t } = useTranslation();
  const hasFreshResult = Boolean(result && !isStale);
  const warningsByLine = new Map<string, string[]>();
  for (const warning of result?.warnings ?? []) {
    if (!warning.lineId) continue;
    const warnings = warningsByLine.get(warning.lineId) ?? [];
    warnings.push(warning.message);
    warningsByLine.set(warning.lineId, warnings);
  }

  if (!result) {
    return (
      <div className="px-5 py-14 text-center">
        {isCalculating ? (
          <Icons.Spinner className="text-muted-foreground mx-auto h-5 w-5 animate-spin" />
        ) : (
          <Icons.ListChecks className="text-muted-foreground mx-auto h-5 w-5" />
        )}
        <p className="mt-3 text-sm font-medium">
          {isCalculating
            ? t("allocation:worksheet.reviewUpdating")
            : t("allocation:worksheet.reviewEmpty")}
        </p>
        <p className="text-muted-foreground mx-auto mt-1 max-w-md text-xs leading-relaxed">
          {calculationError?.description ?? issue?.message ?? t("allocation:worksheet.reviewHint")}
        </p>
        {issue && issue.kind !== "empty" && (
          <Button size="sm" variant="outline" className="mt-4" onClick={onReviewIssue}>
            <Icons.AlertCircle className="mr-1.5 h-4 w-4" />
            {t("allocation:worksheet.reviewWorksheet")}
          </Button>
        )}
      </div>
    );
  }

  return (
    <div>
      <div className="flex flex-wrap items-start justify-between gap-3 border-b px-4 py-4 sm:px-5">
        <div>
          <div className="flex flex-wrap items-center gap-2">
            <h3 className="font-mono text-sm font-semibold">
              {t("allocation:worksheet.reviewChanges")}
            </h3>
            <span className="bg-muted text-muted-foreground rounded-full px-2 py-0.5 font-mono text-[10px]">
              {t("allocation:worksheet.lineCount", { count: result.lines.length })}
            </span>
            {isStale && (
              <span className="rounded-full bg-amber-500/10 px-2 py-0.5 font-mono text-[10px] text-amber-800 dark:text-amber-200">
                {isCalculating
                  ? t("allocation:worksheet.updatingPreview")
                  : t("allocation:worksheet.previewOutOfDate")}
              </span>
            )}
          </div>
          <p className="text-muted-foreground mt-1 text-xs leading-relaxed">
            {isStale ? t("allocation:worksheet.reviewStale") : t("allocation:worksheet.reviewHint")}
          </p>
        </div>
        {hasFreshResult && (
          <div className="flex items-center gap-2">
            <Button size="sm" variant="outline" onClick={onCopy}>
              <Icons.Copy className="mr-1.5 h-4 w-4" />
              {t("allocation:worksheet.copySummary")}
            </Button>
            <Button size="sm" variant="outline" onClick={onDownload}>
              <Icons.Download className="mr-1.5 h-4 w-4" />
              {t("allocation:worksheet.download")}
            </Button>
          </div>
        )}
      </div>

      <div className={cn("transition-opacity", isStale && "pointer-events-none opacity-50")}>
        <div className="text-muted-foreground bg-muted/15 hidden grid-cols-[5.5rem_minmax(12rem,1.4fr)_minmax(9rem,1fr)_7rem_7rem_9rem] gap-3 border-b px-5 py-3 font-mono text-[10px] uppercase tracking-[0.14em] xl:grid">
          <span>{t("allocation:worksheet.direction")}</span>
          <span>{t("allocation:worksheet.security")}</span>
          <span>{t("allocation:worksheet.account")}</span>
          <span className="text-right">{t("allocation:worksheet.resolvedAmount")}</span>
          <span className="text-right">{t("allocation:worksheet.quantity")}</span>
          <span className="text-right">{t("allocation:worksheet.unitPrice")}</span>
        </div>

        <div className="divide-y">
          {result.lines.map((line) => {
            const warnings = warningsByLine.get(line.lineId) ?? [];
            return (
              <div
                key={line.lineId}
                className="grid gap-3 px-4 py-4 sm:px-5 xl:grid-cols-[5.5rem_minmax(12rem,1.4fr)_minmax(9rem,1fr)_7rem_7rem_9rem] xl:items-center"
              >
                <div>
                  <span className="bg-muted rounded-full px-2 py-1 font-mono text-[10px] font-medium">
                    {line.direction === "increase"
                      ? t("allocation:worksheet.increase")
                      : t("allocation:worksheet.reduce")}
                  </span>
                </div>
                <div className="min-w-0">
                  <p className="truncate font-mono text-xs font-semibold">
                    {line.symbol} · {line.name}
                  </p>
                  {warnings.length > 0 && (
                    <p
                      className="mt-1 flex items-center gap-1 text-[10px] text-amber-800 dark:text-amber-200"
                      title={warnings.join("\n")}
                    >
                      <Icons.AlertCircle className="h-3 w-3 shrink-0" />
                      {t("allocation:worksheet.lineWarningCount", { count: warnings.length })}
                    </p>
                  )}
                </div>
                <p className="truncate font-mono text-xs">
                  {accountNames.get(line.accountId) ?? t("allocation:worksheet.unknownAccount")}
                </p>
                <p className="font-mono text-xs font-semibold tabular-nums xl:text-right">
                  {formatAmount(line.estimatedAmount, currency)}
                </p>
                <p className="font-mono text-xs tabular-nums xl:text-right">
                  ≈ {formatQuantity(line.quantity)}
                </p>
                <div className="xl:text-right">
                  <TooltipProvider delayDuration={150}>
                    <Tooltip>
                      <TooltipTrigger asChild>
                        <button
                          type="button"
                          className="border-muted-foreground/60 cursor-help border-b border-dotted font-mono text-xs tabular-nums"
                        >
                          {formatAmount(line.unitPrice, currency)}
                        </button>
                      </TooltipTrigger>
                      <TooltipContent side="left" className="max-w-80 space-y-1 text-xs">
                        <p>
                          {t("allocation:worksheet.recordedPriceSource", {
                            price: formatAmount(
                              line.quoteSource.value,
                              line.quoteSource.fromCurrency,
                            ),
                            date: formatSourceTimestamp(line.quoteSource.timestamp),
                          })}
                        </p>
                        {line.fxSource ? (
                          <p>
                            {t("allocation:worksheet.fxConversionSource", {
                              from: line.fxSource.fromCurrency,
                              to: line.fxSource.toCurrency,
                              rate: formatDecimalInput(line.fxSource.value, 6),
                              date: formatSourceTimestamp(line.fxSource.timestamp),
                            })}
                          </p>
                        ) : (
                          <p>{t("allocation:worksheet.noFxConversion")}</p>
                        )}
                      </TooltipContent>
                    </Tooltip>
                  </TooltipProvider>
                </div>
              </div>
            );
          })}
        </div>
      </div>

      <p className="text-muted-foreground border-t px-4 py-3 text-xs leading-relaxed sm:px-5">
        {t("allocation:worksheet.reviewDisclaimer")}
      </p>
    </div>
  );
}

interface ImpactRailProps {
  report: DriftReport;
  result: AllocationWorksheetResult | null;
  isStale: boolean;
  prepared: PreparedWorksheet;
  profile: AllocationTarget;
  calculationError: WorksheetCalculationError | null;
  isCalculating: boolean;
  firstUseOpen: boolean;
  onCalculate: () => void;
  onReviewIssue: () => void;
  onClassifySecurity: (lineId: string) => void;
}

function ImpactRail({
  report,
  result,
  isStale,
  prepared,
  profile,
  calculationError,
  isCalculating,
  firstUseOpen,
  onCalculate,
  onReviewIssue,
  onClassifySecurity,
}: ImpactRailProps) {
  const { t } = useTranslation();
  const driftByCategory = new Map(report.rows.map((row) => [row.categoryId, row]));
  const sourceRows =
    result?.categories ??
    report.rows.map((row) => ({
      categoryId: row.categoryId,
      categoryName: row.categoryName,
      currentBps: row.currentBps,
      projectedBps: row.currentBps,
      targetBps: row.targetBps,
      projectedDifferenceBps: row.driftBps,
    }));
  const visibleRows = sourceRows.filter(
    (row) => row.currentBps > 0 || row.projectedBps > 0 || row.targetBps > 0,
  );
  const colorMap = buildAllocationTargetColorMap(visibleRows);
  const categories: ImpactCategory[] = visibleRows.map((row, index) => ({
    ...row,
    color: allocationTargetColorForRow(row, colorMap, index),
    effectiveBandBps: driftByCategory.get(row.categoryId)?.effectiveBandBps ?? profile.driftBandBps,
  }));
  const outsideRange = categories.filter(
    (category) => Math.abs(category.projectedDifferenceBps) > category.effectiveBandBps,
  );
  const projectedOutsideCount = outsideRange.length;
  const largestDifference = result?.maxDifferenceBpsAfter ?? report.maxDriftBps;
  const totalMoved = result ? result.increaseTotal + result.reductionTotal : 0;

  return (
    <Card className="overflow-hidden lg:sticky lg:top-4">
      <CardContent className="p-0">
        <div
          className={cn("p-5 transition-opacity sm:p-6", result && isStale && "opacity-50")}
          aria-busy={isCalculating}
        >
          <div className="flex flex-wrap items-center justify-between gap-2">
            <p className="text-muted-foreground font-mono text-[11px] uppercase tracking-[0.16em]">
              {t("allocation:worksheet.portfolioImpact")}
            </p>
            {(isCalculating || (result && isStale)) && (
              <span className="rounded-full bg-[#557866]/10 px-2 py-1 font-mono text-[10px] text-[#365747] dark:text-[#9fc0ae]">
                {isCalculating
                  ? t("allocation:worksheet.updatingPreview")
                  : t("allocation:worksheet.previewOutOfDate")}
              </span>
            )}
          </div>

          <p className="mt-4 font-mono text-xl font-semibold leading-tight">
            {t("allocation:worksheet.outsideRangeImpact", {
              before: report.outOfBandCount,
              after: projectedOutsideCount,
            })}
          </p>
          <div className="text-muted-foreground mt-2 space-y-1 font-mono text-xs">
            <p>
              {t("allocation:worksheet.largestDifference", {
                amount: `${(largestDifference / 100).toFixed(1)}pp`,
              })}
            </p>
            {result && (
              <p>
                {t("allocation:worksheet.totalAdjusted", {
                  amount: formatAmount(totalMoved, report.baseCurrency),
                })}
              </p>
            )}
          </div>

          <div className="mt-5 space-y-2">
            <ImpactBar
              label={t("allocation:worksheet.currentLabel")}
              categories={categories}
              value={(category) => category.currentBps}
            />
            <ImpactBar
              label={t("allocation:worksheet.projectedLabel")}
              categories={categories}
              value={(category) => category.projectedBps}
              emphasis
            />
            <ImpactBar
              label={t("allocation:worksheet.target")}
              categories={categories}
              value={(category) => category.targetBps}
            />
          </div>
        </div>

        <div
          className={cn(
            "border-t px-5 py-4 transition-opacity sm:px-6",
            result && isStale && "opacity-55",
          )}
        >
          <p className="text-muted-foreground font-mono text-[11px] uppercase tracking-[0.14em]">
            {outsideRange.length > 0
              ? t("allocation:worksheet.outsideRange")
              : t("allocation:worksheet.withinRange")}
          </p>
          <div className="mt-2 divide-y">
            {outsideRange.slice(0, 5).map((category) => {
              const current = category.currentBps / 100;
              const projected = category.projectedBps / 100;
              const target = category.targetBps / 100;
              const bandStart = Math.max(0, target - category.effectiveBandBps / 100);
              const bandWidth = Math.min(100 - bandStart, category.effectiveBandBps / 50);
              return (
                <div key={category.categoryId} className="py-3">
                  <div className="flex items-center justify-between gap-3">
                    <span className="flex min-w-0 items-center gap-2 text-xs font-medium">
                      <span
                        className="h-2.5 w-2.5 shrink-0 rounded-full"
                        style={{ background: category.color }}
                      />
                      <span className="truncate">{category.categoryName}</span>
                    </span>
                    <span className="shrink-0 font-mono text-xs tabular-nums">
                      {category.projectedDifferenceBps > 0 ? "+" : "−"}
                      {Math.abs(category.projectedDifferenceBps / 100).toFixed(1)}pp
                    </span>
                  </div>
                  <div className="relative mt-3 h-4">
                    <div className="bg-border absolute left-0 right-0 top-1.5 h-px" />
                    <div
                      className="dark:bg-muted absolute top-0 h-3 rounded-sm bg-[#e9e2c9]"
                      style={{ left: `${bandStart}%`, width: `${Math.max(2, bandWidth)}%` }}
                    />
                    <div
                      className="bg-foreground absolute top-0 h-3 w-0.5"
                      style={{ left: `${Math.min(100, target)}%` }}
                    />
                    <div
                      className="border-muted-foreground bg-background absolute top-1 h-2 w-2 -translate-x-1/2 rounded-full border"
                      style={{ left: `${Math.min(100, current)}%` }}
                    />
                    <div
                      className="absolute top-1 h-2 w-2 -translate-x-1/2 rounded-full"
                      style={{ left: `${Math.min(100, projected)}%`, background: category.color }}
                    />
                  </div>
                  <p className="text-muted-foreground mt-1 font-mono text-[10px]">
                    {current.toFixed(1)}% → {projected.toFixed(1)}% ·{" "}
                    {t("allocation:worksheet.target")} {target.toFixed(1)}%
                  </p>
                </div>
              );
            })}
            {outsideRange.length === 0 && (
              <p className="text-muted-foreground py-3 text-xs leading-relaxed">
                {t("allocation:worksheet.noOutsideRange")}
              </p>
            )}
          </div>
        </div>

        <div className="space-y-3 border-t p-5 sm:p-6">
          {calculationError && (
            <div
              role="alert"
              className="border-destructive/30 bg-destructive/5 rounded-lg border p-3"
            >
              <p className="text-destructive text-xs font-semibold">{calculationError.title}</p>
              {calculationError.description && (
                <p className="text-muted-foreground mt-1 text-xs leading-relaxed">
                  {calculationError.description}
                </p>
              )}
            </div>
          )}
          {!calculationError && prepared.issue && (
            <p className="text-muted-foreground text-xs leading-relaxed">
              {prepared.issue.message}
            </p>
          )}
          {(prepared.issue || calculationError) && (
            <Button
              className="w-full"
              disabled={isCalculating || firstUseOpen}
              onClick={prepared.issue ? onReviewIssue : onCalculate}
            >
              {prepared.issue ? (
                <Icons.AlertCircle className="mr-1.5 h-4 w-4" />
              ) : (
                <Icons.BarChart className="mr-1.5 h-4 w-4" />
              )}
              {prepared.issue
                ? t("allocation:worksheet.reviewWorksheet")
                : t("allocation:worksheet.retryPreview")}
            </Button>
          )}

          {isCalculating && !prepared.issue && (
            <p className="text-muted-foreground flex items-center text-xs">
              <Icons.Spinner className="mr-1.5 h-3.5 w-3.5 animate-spin" />
              {t("allocation:worksheet.updatingFromSources")}
            </p>
          )}

          {result && !isStale && (
            <>
              {result.warnings.length > 0 && (
                <details className="rounded-lg border border-amber-400/50 bg-amber-50/50 px-3 py-2 dark:bg-amber-950/15">
                  <summary className="cursor-pointer text-xs font-medium text-amber-950 dark:text-amber-200">
                    {t("allocation:worksheet.warningCount", { count: result.warnings.length })}
                  </summary>
                  <ul className="mt-2 space-y-2 text-xs text-amber-950/75 dark:text-amber-100/75">
                    {result.warnings.map((warning) => (
                      <li key={warning.id}>
                        • {warning.message}
                        {(warning.kind === "partial_classification" ||
                          warning.kind === "unclassified_asset") &&
                          warning.lineId && (
                            <Button
                              variant="link"
                              size="sm"
                              className="ml-1 h-auto p-0 text-xs text-amber-900 underline dark:text-amber-200"
                              onClick={() => onClassifySecurity(warning.lineId!)}
                            >
                              {t("allocation:worksheet.classifySecurity")}
                            </Button>
                          )}
                      </li>
                    ))}
                  </ul>
                </details>
              )}
            </>
          )}
        </div>
      </CardContent>
    </Card>
  );
}

export function AllocationWorksheetTab({
  profile,
  driftReport,
  accountScope,
  sourceVersion,
  isSourceLoading,
}: AllocationWorksheetTabProps) {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const worksheet = useAllocationWorksheet();
  const syncPrice = useSyncMarketDataMutation(true);
  const exchangeRates = useExchangeRates();
  const { assets, isLoading: assetsLoading } = useAssets();
  const taxonomy = useTaxonomy(profile?.taxonomyId ?? null);
  const { accounts, isLoading: accountsLoading } = useAccounts({
    accountPurpose: AccountPurpose.HOLDINGS,
  });
  const { data: portfolios = [] } = usePortfolios();

  const [view, setView] = useState<WorksheetView>("position");
  const [editMode, setEditMode] = useState<WorksheetEditMode>("amount");
  const [cashToDeploy, setCashToDeploy] = useState("");
  const [selectedAccountIds, setSelectedAccountIds] = useState<Set<string>>(new Set());
  const [addedAssetIds, setAddedAssetIds] = useState<string[]>([]);
  const [adjustments, setAdjustments] = useState<PositionAdjustments>({});
  const [expandedAssetIds, setExpandedAssetIds] = useState<Set<string>>(new Set());
  const [categoryFilter, setCategoryFilter] = useState("all");
  const [result, setResult] = useState<AllocationWorksheetResult | null>(null);
  const [isResultStale, setIsResultStale] = useState(false);
  const [calculationError, setCalculationError] = useState<WorksheetCalculationError | null>(null);
  const [pendingExport, setPendingExport] = useState<"copy" | "csv" | null>(null);
  const calculationVersionRef = useRef(0);
  const calculateRef = useRef<(() => Promise<void>) | null>(null);
  const autoCalculateTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const initializedScopeRef = useRef("");
  const draftStorageKey = profile ? worksheetDraftStorageKey(profile.id, accountScope) : null;
  const [firstUseOpen, setFirstUseOpen] = useState(() => {
    try {
      const stored = localStorage.getItem(DISCLOSURE_STORAGE_KEY);
      if (!stored) return true;
      const parsed: unknown = JSON.parse(stored);
      return !(
        parsed &&
        typeof parsed === "object" &&
        "version" in parsed &&
        parsed.version === DISCLOSURE_VERSION
      );
    } catch {
      return true;
    }
  });

  const scopedAccounts = useMemo(() => {
    if (accountScope.type === "account") {
      return accounts.filter((account) => account.id === accountScope.accountId);
    }
    if (accountScope.type === "accounts") {
      return accounts.filter((account) => accountScope.accountIds.includes(account.id));
    }
    if (accountScope.type === "portfolio") {
      const accountIds =
        portfolios.find((portfolio) => portfolio.id === accountScope.portfolioId)?.accountIds ?? [];
      return accounts.filter((account) => accountIds.includes(account.id));
    }
    return accounts;
  }, [accountScope, accounts, portfolios]);
  const scopedAccountKey = scopedAccounts
    .map((account) => account.id)
    .sort()
    .join("|");

  const holdingQueries = useQueries({
    queries: scopedAccounts.map((account) => {
      const filter: AccountScope = { type: "account", accountId: account.id };
      return {
        queryKey: [QueryKeys.HOLDINGS, filter],
        queryFn: () => getHoldingsList(filter),
      };
    }),
  });
  const scopedHoldings = holdingQueries.flatMap((query) => query.data ?? []);
  const holdingsLoading = holdingQueries.some((query) => query.isPending);
  const holdingsVersion = holdingQueries.map((query) => query.dataUpdatedAt).join("|");
  const addedAssignmentQueries = useQueries({
    queries: addedAssetIds.map((assetId) => ({
      queryKey: QueryKeys.assetTaxonomyAssignments(assetId),
      queryFn: () => getAssetTaxonomyAssignments(assetId),
    })),
  });
  const assignmentSourceVersion = addedAssignmentQueries
    .map((query) => query.dataUpdatedAt)
    .join("|");
  const assignmentsByAsset = new Map(
    addedAssetIds.map((assetId, index) => [assetId, addedAssignmentQueries[index]?.data ?? []]),
  );

  const eligibleAssets = useMemo(
    () =>
      assets
        .filter((asset) => asset.isActive !== false && asset.kind === "INVESTMENT")
        .sort((left, right) => {
          const leftLabel = left.displayCode ?? left.name ?? left.id;
          const rightLabel = right.displayCode ?? right.name ?? right.id;
          return leftLabel.localeCompare(rightLabel);
        }),
    [assets],
  );
  const positions =
    driftReport && profile
      ? buildPositions(
          scopedHoldings,
          eligibleAssets,
          addedAssetIds,
          driftReport,
          profile.taxonomyId,
          assignmentsByAsset,
          taxonomy.data?.categories ?? [],
        )
      : [];
  const positionByAsset = new Map(positions.map((position) => [position.assetId, position]));
  const selectedAssetIds = positions.map((position) => position.assetId);
  const latestQuotes = useLatestQuotes(selectedAssetIds);
  const accountNames = useMemo(
    () => new Map(scopedAccounts.map((account) => [account.id, account.name])),
    [scopedAccounts],
  );
  const cashByAccount = useMemo(() => {
    const values = new Map<string, number>();
    for (const holding of scopedHoldings) {
      if (holding.holdingType !== HoldingType.CASH) continue;
      values.set(
        holding.accountId,
        (values.get(holding.accountId) ?? 0) + (Number(holding.marketValue.base) || 0),
      );
    }
    return values;
  }, [scopedHoldings]);
  const assetSourceVersion = useMemo(
    () => eligibleAssets.map((asset) => `${asset.id}:${asset.updatedAt}`).join("|"),
    [eligibleAssets],
  );

  useEffect(() => {
    if (
      !draftStorageKey ||
      !scopedAccountKey ||
      initializedScopeRef.current === draftStorageKey ||
      isSourceLoading ||
      assetsLoading ||
      accountsLoading ||
      holdingsLoading
    ) {
      return;
    }

    const draft = readWorksheetDraft(draftStorageKey);
    const validAccountIds = new Set(scopedAccounts.map((account) => account.id));
    const validAssetIds = new Set(eligibleAssets.map((asset) => asset.id));
    const restoredAdjustments: PositionAdjustments = {};
    for (const [assetId, value] of Object.entries(draft?.adjustments ?? {})) {
      if (!validAssetIds.has(assetId) || !value || typeof value !== "object") continue;
      const adjustment = value as Partial<PositionAdjustment>;
      if (
        (adjustment.inputMode !== "amount" && adjustment.inputMode !== "after_percentage") ||
        typeof adjustment.inputValue !== "string" ||
        !adjustment.accountAmounts ||
        typeof adjustment.accountAmounts !== "object"
      ) {
        continue;
      }
      restoredAdjustments[assetId] = {
        inputMode: adjustment.inputMode,
        inputValue: adjustment.inputValue,
        accountAmounts: Object.fromEntries(
          Object.entries(adjustment.accountAmounts).filter(
            ([accountId, amount]) => validAccountIds.has(accountId) && typeof amount === "string",
          ),
        ),
      };
    }

    initializedScopeRef.current = draftStorageKey;
    setEditMode(draft?.editMode ?? "amount");
    setCashToDeploy(draft?.cashToDeploy ?? "");
    setSelectedAccountIds(
      draft
        ? new Set(
            draft.selectedAccountIds.filter(
              (accountId): accountId is string =>
                typeof accountId === "string" && validAccountIds.has(accountId),
            ),
          )
        : new Set(validAccountIds),
    );
    setAddedAssetIds(
      (draft?.addedAssetIds ?? []).filter(
        (assetId): assetId is string => typeof assetId === "string" && validAssetIds.has(assetId),
      ),
    );
    setAdjustments(restoredAdjustments);
    setExpandedAssetIds(new Set(Object.keys(restoredAdjustments)));
    setResult(null);
    setCalculationError(null);
    setCategoryFilter("all");
    setView("position");
  }, [
    accountsLoading,
    assetsLoading,
    draftStorageKey,
    eligibleAssets,
    holdingsLoading,
    isSourceLoading,
    scopedAccountKey,
    scopedAccounts,
  ]);

  useEffect(() => {
    if (!draftStorageKey || initializedScopeRef.current !== draftStorageKey) return;
    const timer = setTimeout(() => {
      const draft: WorksheetDraft = {
        version: DRAFT_VERSION,
        savedAt: new Date().toISOString(),
        editMode,
        cashToDeploy,
        selectedAccountIds: [...selectedAccountIds],
        addedAssetIds,
        adjustments,
      };
      try {
        localStorage.setItem(draftStorageKey, JSON.stringify(draft));
      } catch {
        // Draft persistence is optional; the current worksheet remains usable.
      }
    }, 250);
    return () => clearTimeout(timer);
  }, [addedAssetIds, adjustments, cashToDeploy, draftStorageKey, editMode, selectedAccountIds]);

  useEffect(() => {
    if (autoCalculateTimerRef.current) clearTimeout(autoCalculateTimerRef.current);
    calculationVersionRef.current += 1;
    setIsResultStale(true);
    setCalculationError(null);
    setPendingExport(null);
    worksheet.reset();
    autoCalculateTimerRef.current = setTimeout(() => {
      void calculateRef.current?.();
    }, AUTO_CALCULATE_DEBOUNCE_MS);
    return () => {
      if (autoCalculateTimerRef.current) clearTimeout(autoCalculateTimerRef.current);
    };
    // The dependencies represent user input or source-data changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    adjustments,
    cashToDeploy,
    selectedAccountIds,
    addedAssetIds,
    sourceVersion,
    latestQuotes.dataUpdatedAt,
    exchangeRates.dataUpdatedAt,
    assetSourceVersion,
    assignmentSourceVersion,
    taxonomy.dataUpdatedAt,
    holdingsVersion,
    firstUseOpen,
  ]);

  if (isSourceLoading || assetsLoading || accountsLoading || holdingsLoading) {
    return <Skeleton className="h-[38rem] w-full rounded-xl" />;
  }
  if (!profile || !driftReport) return null;

  const observedCash = Math.max(0, driftReport.deployableCash);
  const rawEnteredCash = parseDecimalInput(cashToDeploy);
  const enteredCash = Math.max(0, Number.isFinite(rawEnteredCash) ? rawEnteredCash : 0);
  const trackedCashToUse = Math.min(enteredCash, observedCash);
  const externalContribution = Math.max(0, enteredCash - observedCash);
  const selectedAccounts = scopedAccounts.filter((account) => selectedAccountIds.has(account.id));

  const projectedPortfolioValue = resolveProjectionDenominator(
    driftReport.totalValue,
    externalContribution,
    driftReport.rows.some((row) => row.isCash),
    positions.flatMap((position) => {
      const adjustment = adjustments[position.assetId];
      return adjustment
        ? [
            {
              currentValue: position.value,
              inputMode: adjustment.inputMode,
              inputValue: adjustment.inputValue,
            },
          ]
        : [];
    }),
  );
  const hasInvalidPositionInput = positions.some((position) => {
    const value = adjustments[position.assetId]?.inputValue;
    return value !== undefined && value.trim() !== "" && !Number.isFinite(parseDecimalInput(value));
  });

  const categories = driftReport.rows.filter(
    (row) => !row.isCash && row.categoryId !== "__UNKNOWN__",
  );
  const visiblePositions = positions.filter(
    (position) => categoryFilter === "all" || position.categoryIds.includes(categoryFilter),
  );

  const prepared: PreparedWorksheet = (() => {
    const lines: AllocationWorksheetLineInput[] = [];
    let increaseTotal = 0;
    let reductionTotal = 0;
    let changedPositionCount = 0;
    let issue: PreparedWorksheetIssue | undefined;

    if (selectedAccounts.length === 0) {
      issue = {
        message: t("allocation:worksheet.selectAccountIssue"),
        kind: "accounts",
      };
    }
    if (!Number.isFinite(rawEnteredCash)) {
      issue = {
        message: t("allocation:worksheet.invalidCashInput"),
        kind: "cash",
      };
    } else if (rawEnteredCash < 0) {
      issue = {
        message: t("allocation:worksheet.cashMustBePositive"),
        kind: "cash",
      };
    }

    for (const position of positions) {
      const adjustment = adjustments[position.assetId];
      if (adjustment && !Number.isFinite(parseDecimalInput(adjustment.inputValue))) {
        issue ??= {
          message: t("allocation:worksheet.invalidPositionInput", {
            symbol: position.symbol,
          }),
          kind: "position",
          assetId: position.assetId,
        };
        continue;
      }
      if (
        adjustment?.inputMode === "after_percentage" &&
        !Number.isFinite(projectedPortfolioValue)
      ) {
        if (hasInvalidPositionInput) continue;
        issue ??= {
          message: t("allocation:worksheet.invalidFinalPercentagesIssue"),
          kind: "position",
          assetId: position.assetId,
        };
        continue;
      }
      const changeAmount = positionChangeAmount(adjustment, position, projectedPortfolioValue);
      if (!adjustment || Math.abs(changeAmount) < AMOUNT_EPSILON) continue;
      changedPositionCount += 1;

      if (changeAmount < 0 && !profile.allowSells) {
        issue ??= {
          message: t("allocation:worksheet.reductionsDisabledIssue", {
            symbol: position.symbol,
          }),
          kind: "position",
          assetId: position.assetId,
        };
        continue;
      }
      if (changeAmount < 0 && Math.abs(changeAmount) > position.value + AMOUNT_EPSILON) {
        issue ??= {
          message: t("allocation:worksheet.reductionExceedsPositionIssue", {
            symbol: position.symbol,
            amount: formatAmount(position.value, driftReport.baseCurrency),
          }),
          kind: "position",
          assetId: position.assetId,
        };
        continue;
      }

      const requestedAmount = Math.abs(changeAmount);
      if (changeAmount > 0) increaseTotal += requestedAmount;
      else reductionTotal += requestedAmount;

      const eligibleAccounts = eligibleAccountsForPosition(
        position,
        changeAmount,
        adjustment,
        selectedAccountIds,
        scopedAccounts,
      );
      if (eligibleAccounts.length === 0) {
        issue ??= {
          message: t("allocation:worksheet.noEligibleAccountIssue", {
            symbol: position.symbol,
          }),
          kind: "allocation",
          assetId: position.assetId,
        };
        continue;
      }

      const hasInvalidAccountAmount =
        eligibleAccounts.length > 1 &&
        eligibleAccounts.some((account) => {
          const value = adjustment.accountAmounts[account.id] ?? "";
          return value.trim() !== "" && !Number.isFinite(parseDecimalInput(value));
        });
      if (hasInvalidAccountAmount) {
        issue ??= {
          message: t("allocation:worksheet.invalidAccountAmount", {
            symbol: position.symbol,
          }),
          kind: "allocation",
          assetId: position.assetId,
        };
        continue;
      }

      const allocations =
        eligibleAccounts.length === 1
          ? [{ accountId: eligibleAccounts[0].id, amount: requestedAmount }]
          : eligibleAccounts
              .map((account) => ({
                accountId: account.id,
                amount: Math.max(
                  0,
                  decimalInputOrZero(adjustment.accountAmounts[account.id] ?? ""),
                ),
              }))
              .filter((allocation) => allocation.amount >= AMOUNT_EPSILON);
      const allocatedAmount = allocations.reduce((sum, allocation) => sum + allocation.amount, 0);
      if (eligibleAccounts.length > 1 && Math.abs(allocatedAmount - requestedAmount) > 0.02) {
        issue ??= {
          message: t("allocation:worksheet.allocateAccountsIssue", {
            symbol: position.symbol,
            amount: formatAmount(requestedAmount, driftReport.baseCurrency),
          }),
          kind: "allocation",
          assetId: position.assetId,
        };
        continue;
      }

      for (const allocation of allocations) {
        const accountHolding = position.accountHoldings.find(
          (holding) => holding.accountId === allocation.accountId,
        );
        const reducesEntireAccountHolding =
          changeAmount < 0 &&
          accountHolding !== undefined &&
          Math.abs(allocation.amount - accountHolding.value) <= 0.02;
        lines.push({
          lineId: `position:${position.assetId}:${allocation.accountId}:${changeAmount > 0 ? "increase" : "reduce"}`,
          direction: changeAmount > 0 ? "increase" : "reduce",
          assetId: position.assetId,
          accountId: allocation.accountId,
          inputMode: reducesEntireAccountHolding ? "quantity" : "amount",
          value: reducesEntireAccountHolding
            ? String(accountHolding.quantity)
            : allocation.amount.toFixed(6),
        });
      }
    }

    if (changedPositionCount === 0) {
      issue ??= {
        message: t("allocation:worksheet.addAdjustmentIssue"),
        kind: "empty",
      };
    }
    if (increaseTotal > enteredCash + reductionTotal + AMOUNT_EPSILON) {
      issue ??= {
        message: t("allocation:worksheet.fundingShortfallIssue", {
          shortfall: formatAmount(
            increaseTotal - enteredCash - reductionTotal,
            driftReport.baseCurrency,
          ),
        }),
        kind: "funding",
      };
    }
    if (lines.length > 50) {
      issue ??= {
        message: t("allocation:worksheet.tooManyLinesIssue"),
        kind: "lines",
      };
    }

    return { lines, issue, increaseTotal, reductionTotal, changedPositionCount };
  })();
  const isPreviewUpdating =
    worksheet.isPending ||
    (isResultStale &&
      !prepared.issue &&
      prepared.changedPositionCount > 0 &&
      calculationError === null);
  const resultByAsset = new Map<
    string,
    { amount: number; quantity: number; accountCount: number }
  >();
  if (result && !isResultStale) {
    for (const line of result.lines) {
      const current = resultByAsset.get(line.assetId) ?? {
        amount: 0,
        quantity: 0,
        accountCount: 0,
      };
      const sign = line.direction === "increase" ? 1 : -1;
      current.amount += sign * line.estimatedAmount;
      current.quantity += sign * line.quantity;
      current.accountCount += 1;
      resultByAsset.set(line.assetId, current);
    }
  }

  function updateAdjustment(assetId: string, next: PositionAdjustment | null) {
    setAdjustments((current) => {
      const updated = { ...current };
      if (!next) delete updated[assetId];
      else updated[assetId] = next;
      return updated;
    });
  }

  function updatePositionInput(position: WorksheetPosition, value: string) {
    const includedAccountIds = Object.keys(adjustments[position.assetId]?.accountAmounts ?? {});
    updateAdjustment(position.assetId, {
      inputMode: editMode,
      inputValue: value,
      accountAmounts: Object.fromEntries(includedAccountIds.map((accountId) => [accountId, ""])),
    });
    const nextChange =
      editMode === "amount"
        ? parseDecimalInput(value)
        : (parseDecimalInput(value) / 100) * projectedPortfolioValue - position.value;
    if (Math.abs(nextChange) >= AMOUNT_EPSILON) {
      setExpandedAssetIds((current) => new Set(current).add(position.assetId));
    }
  }

  function reducePositionToZero(position: WorksheetPosition) {
    updateAdjustment(position.assetId, {
      inputMode: editMode,
      inputValue: editMode === "amount" ? formatDecimalInput(-position.value, 6) : "0",
      accountAmounts: Object.fromEntries(
        position.accountHoldings
          .filter((holding) => selectedAccountIds.has(holding.accountId))
          .map((holding) => [holding.accountId, formatDecimalInput(holding.value, 6)]),
      ),
    });
    setExpandedAssetIds((current) => new Set(current).add(position.assetId));
  }

  function switchEditMode(nextMode: WorksheetEditMode) {
    if (nextMode === editMode) return;
    setAdjustments((current) => {
      const updated: PositionAdjustments = {};
      for (const [assetId, adjustment] of Object.entries(current)) {
        const position = positionByAsset.get(assetId);
        if (!position) continue;
        const change = positionChangeAmount(adjustment, position, projectedPortfolioValue);
        updated[assetId] = {
          ...adjustment,
          inputMode: nextMode,
          inputValue:
            nextMode === "amount"
              ? formatDecimalInput(change, 6)
              : formatDecimalInput(
                  projectedPortfolioValue > 0
                    ? ((position.value + change) / projectedPortfolioValue) * 100
                    : 0,
                  4,
                ),
        };
      }
      return updated;
    });
    setEditMode(nextMode);
  }

  function updateAccountAmount(assetId: string, accountId: string, value: string) {
    const adjustment = adjustments[assetId];
    if (!adjustment) return;
    updateAdjustment(assetId, {
      ...adjustment,
      accountAmounts: { ...adjustment.accountAmounts, [accountId]: value },
    });
  }

  function includeAccountForPosition(
    assetId: string,
    accountId: string,
    currentAccounts: Account[],
    requestedAmount: number,
  ) {
    const adjustment = adjustments[assetId];
    if (!adjustment) return;
    const accountAmounts = { ...adjustment.accountAmounts };
    if (currentAccounts.length === 1 && !(currentAccounts[0].id in accountAmounts)) {
      accountAmounts[currentAccounts[0].id] = formatDecimalInput(requestedAmount, 6);
    }
    accountAmounts[accountId] ??= "";
    updateAdjustment(assetId, { ...adjustment, accountAmounts });
  }

  function removeIncludedAccount(assetId: string, accountId: string) {
    const adjustment = adjustments[assetId];
    if (!adjustment) return;
    const accountAmounts = { ...adjustment.accountAmounts };
    delete accountAmounts[accountId];
    updateAdjustment(assetId, { ...adjustment, accountAmounts });
  }

  function toggleAccount(accountId: string) {
    setSelectedAccountIds((current) => {
      const next = new Set(current);
      if (next.has(accountId)) next.delete(accountId);
      else next.add(accountId);
      return next;
    });
    setAdjustments((current) =>
      Object.fromEntries(
        Object.entries(current).map(([assetId, adjustment]) => {
          const accountAmounts = { ...adjustment.accountAmounts };
          delete accountAmounts[accountId];
          return [assetId, { ...adjustment, accountAmounts }];
        }),
      ),
    );
  }

  function removeAddedPosition(assetId: string) {
    setAddedAssetIds((current) => current.filter((id) => id !== assetId));
    updateAdjustment(assetId, null);
    setExpandedAssetIds((current) => {
      const next = new Set(current);
      next.delete(assetId);
      return next;
    });
  }

  function resetChanges() {
    setAdjustments({});
    setExpandedAssetIds(new Set());
    setResult(null);
    setCalculationError(null);
  }

  function reviewPreparedIssue() {
    const issue = prepared.issue;
    if (!issue) return;
    if (issue.assetId) {
      if (issue.kind === "allocation") {
        setExpandedAssetIds((current) => new Set(current).add(issue.assetId!));
      }
      requestAnimationFrame(() => {
        const element = document.getElementById(`worksheet-position-${issue.assetId}`);
        element?.scrollIntoView({ behavior: "smooth", block: "center" });
        const selector = issue.kind === "allocation" ? "[data-account-allocation] input" : "input";
        element?.querySelector<HTMLInputElement>(selector)?.focus({ preventScroll: true });
      });
      return;
    }
    const elementId =
      issue.kind === "accounts"
        ? "worksheet-account-scope"
        : issue.kind === "cash" || issue.kind === "funding"
          ? "worksheet-cash"
          : "worksheet-positions";
    const element = document.getElementById(elementId);
    element?.scrollIntoView({ behavior: "smooth", block: "center" });
    element?.querySelector<HTMLInputElement>("input")?.focus({ preventScroll: true });
  }

  async function calculate() {
    if (prepared.issue || prepared.lines.length === 0 || firstUseOpen) {
      return;
    }
    if (autoCalculateTimerRef.current) clearTimeout(autoCalculateTimerRef.current);
    setCalculationError(null);
    setPendingExport(null);
    const calculationVersion = calculationVersionRef.current;
    try {
      const data = await worksheet.mutateAsync({
        targetId: profile!.id,
        filter: accountScope,
        cash: {
          trackedCashToUse: trackedCashToUse.toFixed(6),
          externalContribution: externalContribution.toFixed(6),
        },
        lines: prepared.lines,
      });
      if (calculationVersion !== calculationVersionRef.current) return;
      setResult(data);
      setIsResultStale(false);
      setCalculationError(null);
    } catch (error) {
      if (calculationVersion !== calculationVersionRef.current) return;
      const rawMessage =
        typeof error === "string"
          ? error
          : error instanceof Error
            ? error.message
            : typeof error === "object" &&
                error !== null &&
                "message" in error &&
                typeof error.message === "string"
              ? error.message
              : "";
      const affectedLine = prepared.lines.find((line) => rawMessage.includes(line.lineId));
      const affectedPosition = affectedLine ? positionByAsset.get(affectedLine.assetId) : undefined;
      let detail = rawMessage.replace(/^.*?Invalid input:\s*/i, "");
      if (affectedLine) {
        detail = detail.replace(
          `Worksheet line ${affectedLine.lineId}`,
          affectedPosition
            ? t("allocation:worksheet.positionErrorPrefix", { symbol: affectedPosition.symbol })
            : t("allocation:worksheet.positionErrorGeneric"),
        );
      }
      setCalculationError({
        title: t("allocation:worksheet.failed"),
        description: detail || undefined,
        assetId: /classification (?:weights )?total/i.test(rawMessage)
          ? affectedLine?.assetId
          : undefined,
      });
    }
  }
  calculateRef.current = calculate;

  function acknowledgeFirstUse() {
    try {
      localStorage.setItem(
        DISCLOSURE_STORAGE_KEY,
        JSON.stringify({ version: DISCLOSURE_VERSION, acknowledgedAt: new Date().toISOString() }),
      );
    } catch {
      // The disclosure still gates the current session when storage is unavailable.
    }
    setFirstUseOpen(false);
  }

  const disclosure = t("allocation:worksheet.fullDisclosure");
  const exportDisclosure = t("allocation:worksheet.exportDisclosure");
  const fundingSummary = t("allocation:worksheet.cashFundingSummary", {
    amount: formatAmount(enteredCash, driftReport.baseCurrency),
  });
  const exportLabels: WorksheetExportLabels = {
    title: t("allocation:worksheet.title"),
    target: t("allocation:worksheet.target"),
    prepared: t("allocation:worksheet.exportPrepared"),
    funding: t("allocation:worksheet.cashToDeploy"),
    totalIncreases: t("allocation:worksheet.totalIncreases"),
    totalReductions: t("allocation:worksheet.totalReductions"),
    adjustments: t("allocation:worksheet.exportAdjustments"),
    direction: t("allocation:worksheet.direction"),
    security: t("allocation:worksheet.security"),
    account: t("allocation:worksheet.account"),
    unknownAccount: t("allocation:worksheet.unknownAccount"),
    amount: t("allocation:worksheet.amount"),
    quantity: t("allocation:worksheet.quantity"),
    unitPrice: t("allocation:worksheet.unitPrice"),
    increase: t("allocation:worksheet.increase"),
    reduce: t("allocation:worksheet.reduce"),
    warnings: t("allocation:worksheet.warnings"),
    disclaimer: t("allocation:worksheet.exportDisclaimer"),
  };

  async function confirmExport() {
    if (!result || !pendingExport || isResultStale) return;
    const csv = buildExportCsv(
      result,
      accountNames,
      fundingSummary,
      exportDisclosure,
      exportLabels,
    );
    if (pendingExport === "copy") {
      await navigator.clipboard.writeText(csv);
      toast.success(t("allocation:worksheet.copied"));
    } else {
      downloadCsv(csv);
    }
    setPendingExport(null);
  }

  return (
    <div className="space-y-4">
      <AlertDialog open={firstUseOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t("allocation:worksheet.firstUseTitle")}</AlertDialogTitle>
            <AlertDialogDescription>
              {t("allocation:worksheet.firstUseDisclosure")}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogAction onClick={acknowledgeFirstUse}>
              {t("allocation:worksheet.continue")}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <AlertDialog
        open={pendingExport !== null && result !== null && !isResultStale}
        onOpenChange={(open) => {
          if (!open) setPendingExport(null);
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t("allocation:worksheet.exportConfirmTitle")}</AlertDialogTitle>
            <AlertDialogDescription>
              {t("allocation:worksheet.exportConfirmDescription")}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t("allocation:worksheet.exportCancel")}</AlertDialogCancel>
            <AlertDialogAction onClick={() => void confirmExport()}>
              {pendingExport === "copy"
                ? t("allocation:worksheet.exportConfirmCopy")
                : t("allocation:worksheet.exportConfirmDownload")}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <Card className="overflow-hidden">
        <CardContent className="grid p-0 lg:grid-cols-[minmax(0,1.4fr)_minmax(20rem,0.7fr)]">
          <AccountScopeControl
            accounts={scopedAccounts}
            selectedAccountIds={selectedAccountIds}
            onToggle={toggleAccount}
            onSelectAll={() =>
              setSelectedAccountIds(new Set(scopedAccounts.map((account) => account.id)))
            }
            onClearAll={() => setSelectedAccountIds(new Set())}
          />
          <CashControl
            observedCash={observedCash}
            value={cashToDeploy}
            currency={driftReport.baseCurrency}
            onChange={setCashToDeploy}
          />
        </CardContent>
      </Card>

      <div className="grid items-start gap-4 lg:grid-cols-[minmax(0,1fr)_23rem] xl:grid-cols-[minmax(0,1fr)_26rem]">
        <Card id="worksheet-positions" className="min-w-0 overflow-hidden">
          <CardContent className="p-0">
            <div className="space-y-3 border-b p-4 sm:p-5">
              <div className="flex flex-wrap items-center justify-between gap-3">
                <div className="flex flex-wrap items-center gap-2">
                  <div className="border-border bg-muted/20 flex rounded-full border p-1">
                    {(["position", "review"] as const).map((option) => (
                      <button
                        key={option}
                        type="button"
                        onClick={() => setView(option)}
                        className={cn(
                          "rounded-full px-4 py-1.5 font-mono text-xs transition-colors",
                          view === option
                            ? "bg-foreground text-background"
                            : "text-muted-foreground hover:text-foreground",
                        )}
                      >
                        {option === "position"
                          ? t("allocation:worksheet.byPosition")
                          : t("allocation:worksheet.reviewChanges")}
                      </button>
                    ))}
                  </div>
                  {view === "position" && (
                    <div className="border-border bg-muted/20 flex rounded-full border p-1">
                      {(["amount", "after_percentage"] as const).map((option) => (
                        <button
                          key={option}
                          type="button"
                          onClick={() => switchEditMode(option)}
                          className={cn(
                            "rounded-full px-3.5 py-1.5 font-mono text-xs transition-colors",
                            editMode === option
                              ? "bg-foreground text-background"
                              : "text-muted-foreground hover:text-foreground",
                          )}
                        >
                          {option === "amount"
                            ? t("allocation:worksheet.changeAmount")
                            : t("allocation:worksheet.afterPercentage")}
                        </button>
                      ))}
                    </div>
                  )}
                </div>
                <div className="flex items-center gap-2">
                  <Button
                    size="sm"
                    variant="ghost"
                    disabled={Object.keys(adjustments).length === 0}
                    onClick={resetChanges}
                  >
                    <Icons.Undo className="mr-1.5 h-4 w-4" />
                    {t("allocation:worksheet.resetChanges")}
                  </Button>
                  <AddPositionButton
                    assets={eligibleAssets}
                    excludedAssetIds={new Set(positions.map((position) => position.assetId))}
                    onSelect={(assetId) => setAddedAssetIds((current) => [...current, assetId])}
                  />
                </div>
              </div>

              {view === "position" && categories.length > 0 && (
                <div className="flex flex-wrap items-center gap-2">
                  <span className="text-muted-foreground mr-1 font-mono text-[10px] uppercase tracking-[0.14em]">
                    {t("allocation:worksheet.allocationFocus")}
                  </span>
                  <button
                    type="button"
                    onClick={() => setCategoryFilter("all")}
                    className={cn(
                      "rounded-full border px-3 py-1 font-mono text-[11px]",
                      categoryFilter === "all"
                        ? "border-foreground bg-foreground text-background"
                        : "border-border text-muted-foreground",
                    )}
                  >
                    {t("allocation:worksheet.allCategories")}
                  </button>
                  {categories.map((category) => (
                    <button
                      key={category.categoryId}
                      type="button"
                      onClick={() => setCategoryFilter(category.categoryId)}
                      className={cn(
                        "rounded-full border px-3 py-1 font-mono text-[11px]",
                        categoryFilter === category.categoryId
                          ? "border-foreground bg-foreground text-background"
                          : "border-border text-muted-foreground",
                      )}
                    >
                      {category.categoryName}
                    </button>
                  ))}
                </div>
              )}
            </div>

            {view === "position" ? (
              <div>
                <div className="text-muted-foreground bg-muted/15 hidden grid-cols-[minmax(12rem,1.6fr)_7rem_4rem_8.5rem_8.5rem_2rem] gap-3 border-b px-5 py-3 font-mono text-[10px] uppercase tracking-[0.14em] xl:grid">
                  <span>{t("allocation:worksheet.position")}</span>
                  <span className="text-right">{t("allocation:worksheet.currentValue")}</span>
                  <span className="text-right">{t("allocation:worksheet.now")}</span>
                  <span className="text-right">
                    {editMode === "amount"
                      ? t("allocation:worksheet.changeAmount")
                      : t("allocation:worksheet.projectedPercent")}
                  </span>
                  <span className="text-right">{t("allocation:worksheet.projectedChange")}</span>
                  <span />
                </div>

                {visiblePositions.length === 0 ? (
                  <div className="px-5 py-14 text-center">
                    <p className="text-sm font-medium">
                      {t("allocation:worksheet.noPositionsTitle")}
                    </p>
                    <p className="text-muted-foreground mx-auto mt-1 max-w-md text-xs leading-relaxed">
                      {t("allocation:worksheet.noPositionsDescription")}
                    </p>
                  </div>
                ) : (
                  <div className="divide-y">
                    {visiblePositions.map((position) => {
                      const adjustment = adjustments[position.assetId];
                      const resolvedChangeAmount = positionChangeAmount(
                        adjustment,
                        position,
                        projectedPortfolioValue,
                      );
                      const changeAmount = Number.isFinite(resolvedChangeAmount)
                        ? resolvedChangeAmount
                        : 0;
                      const projectedValue = Math.max(0, position.value + changeAmount);
                      const eligibleAccounts = eligibleAccountsForPosition(
                        position,
                        changeAmount,
                        adjustment,
                        selectedAccountIds,
                        scopedAccounts,
                      );
                      const isExpanded = expandedAssetIds.has(position.assetId);
                      const resolved = resultByAsset.get(position.assetId);
                      const quote = latestQuotes.data?.[position.assetId];
                      const displayInput = adjustment
                        ? adjustment.inputValue
                        : editMode === "amount"
                          ? ""
                          : formatDecimalInput(position.currentPct, 4);
                      return (
                        <div
                          id={`worksheet-position-${position.assetId}`}
                          key={position.assetId}
                          className="px-4 py-4 sm:px-5"
                        >
                          <div className="grid gap-3 xl:grid-cols-[minmax(12rem,1.6fr)_7rem_4rem_8.5rem_8.5rem_2rem] xl:items-center">
                            <div className="min-w-0">
                              <div className="flex min-w-0 items-baseline gap-2">
                                <span className="shrink-0 font-mono text-sm font-semibold">
                                  {position.symbol}
                                </span>
                                <span className="text-muted-foreground truncate text-xs">
                                  {position.name}
                                </span>
                              </div>
                              <p className="text-muted-foreground mt-1 truncate text-[11px]">
                                {position.categoryNames.length > 0
                                  ? position.categoryNames.join(" · ")
                                  : t("allocation:worksheet.unclassified")}
                                {position.accountHoldings.length > 0 &&
                                  ` · ${t("allocation:worksheet.accountCount", { count: position.accountHoldings.length })}`}
                              </p>
                              {resolved && (
                                <p className="text-muted-foreground mt-1 font-mono text-[10px]">
                                  {t("allocation:worksheet.resolvedPositionSummary", {
                                    value: formatAmount(projectedValue, driftReport.baseCurrency),
                                    quantity: `${resolved.quantity > 0 ? "+" : "−"}${formatQuantity(Math.abs(resolved.quantity))}`,
                                  })}
                                </p>
                              )}
                            </div>

                            <div className="flex items-center justify-between xl:block xl:text-right">
                              <span className="text-muted-foreground text-[10px] uppercase xl:hidden">
                                {t("allocation:worksheet.currentValue")}
                              </span>
                              <span className="font-mono text-xs tabular-nums">
                                {formatAmount(position.value, driftReport.baseCurrency)}
                              </span>
                            </div>
                            <div className="flex items-center justify-between xl:block xl:text-right">
                              <span className="text-muted-foreground text-[10px] uppercase xl:hidden">
                                {t("allocation:worksheet.now")}
                              </span>
                              <span className="font-mono text-xs tabular-nums">
                                {position.currentPct.toFixed(1)}%
                              </span>
                            </div>
                            <div className="flex items-center justify-between gap-3 xl:justify-end">
                              <span className="text-muted-foreground text-[10px] uppercase xl:hidden">
                                {editMode === "amount"
                                  ? t("allocation:worksheet.changeAmount")
                                  : t("allocation:worksheet.projectedPercent")}
                              </span>
                              <div className="flex w-44 items-center gap-1 xl:w-full">
                                <div className="border-input bg-background flex h-9 min-w-0 flex-1 items-center rounded-md border px-2.5 focus-within:border-[#557866] focus-within:ring-1 focus-within:ring-[#557866]/30">
                                  <span className="text-muted-foreground mr-1.5 text-xs">
                                    {editMode === "amount" ? driftReport.baseCurrency : ""}
                                  </span>
                                  <input
                                    aria-label={t("allocation:worksheet.positionInputLabel", {
                                      symbol: position.symbol,
                                    })}
                                    value={displayInput}
                                    onChange={(event) =>
                                      updatePositionInput(position, event.target.value)
                                    }
                                    onKeyDown={(event) => {
                                      if (
                                        editMode !== "after_percentage" ||
                                        (event.key !== "ArrowUp" && event.key !== "ArrowDown")
                                      ) {
                                        return;
                                      }
                                      event.preventDefault();
                                      const current = decimalInputOrZero(displayInput);
                                      const step = event.shiftKey ? 1 : 0.5;
                                      const next = Math.min(
                                        100,
                                        Math.max(
                                          0,
                                          current + (event.key === "ArrowUp" ? step : -step),
                                        ),
                                      );
                                      updatePositionInput(position, formatDecimalInput(next, 4));
                                    }}
                                    inputMode="decimal"
                                    placeholder={editMode === "amount" ? "±0" : undefined}
                                    className="min-w-0 flex-1 bg-transparent text-right font-mono text-xs outline-none"
                                  />
                                  {editMode === "after_percentage" && (
                                    <span className="text-muted-foreground ml-1 text-xs">%</span>
                                  )}
                                </div>
                                {position.value > AMOUNT_EPSILON &&
                                  profile.allowSells &&
                                  position.accountHoldings.every((holding) =>
                                    selectedAccountIds.has(holding.accountId),
                                  ) && (
                                    <TooltipProvider delayDuration={150}>
                                      <Tooltip>
                                        <TooltipTrigger asChild>
                                          <Button
                                            type="button"
                                            variant="ghost"
                                            size="icon"
                                            className="h-8 w-8 shrink-0"
                                            disabled={projectedValue <= AMOUNT_EPSILON}
                                            aria-label={t(
                                              "allocation:worksheet.reducePositionToZero",
                                            )}
                                            onClick={() => reducePositionToZero(position)}
                                          >
                                            <Icons.MinusCircle className="h-4 w-4" />
                                          </Button>
                                        </TooltipTrigger>
                                        <TooltipContent>
                                          {t("allocation:worksheet.reducePositionToZero")}
                                        </TooltipContent>
                                      </Tooltip>
                                    </TooltipProvider>
                                  )}
                              </div>
                            </div>
                            <div className="flex items-center justify-between xl:block xl:text-right">
                              <span className="text-muted-foreground text-[10px] uppercase xl:hidden">
                                {t("allocation:worksheet.projectedChange")}
                              </span>
                              <span className="font-mono text-xs font-medium tabular-nums">
                                {formatSignedAmount(changeAmount, driftReport.baseCurrency)}
                              </span>
                            </div>
                            <div className="flex items-center justify-end gap-1">
                              {Math.abs(changeAmount) >= AMOUNT_EPSILON && (
                                <Button
                                  variant="ghost"
                                  size="icon"
                                  className="h-8 w-8"
                                  aria-label={t("allocation:worksheet.toggleAccountAllocation")}
                                  onClick={() =>
                                    setExpandedAssetIds((current) => {
                                      const next = new Set(current);
                                      if (next.has(position.assetId)) next.delete(position.assetId);
                                      else next.add(position.assetId);
                                      return next;
                                    })
                                  }
                                >
                                  <Icons.ChevronDown
                                    className={cn(
                                      "h-4 w-4 transition-transform",
                                      isExpanded && "rotate-180",
                                    )}
                                  />
                                </Button>
                              )}
                              {position.isAdded && (
                                <Button
                                  variant="ghost"
                                  size="icon"
                                  className="h-8 w-8"
                                  aria-label={t("allocation:worksheet.removePosition")}
                                  onClick={() => removeAddedPosition(position.assetId)}
                                >
                                  <Icons.X className="h-4 w-4" />
                                </Button>
                              )}
                            </div>
                          </div>

                          {quote?.quote ? (
                            <p className="text-muted-foreground mt-2 text-[10px] xl:ml-0">
                              {t("allocation:worksheet.priceSourceInline", {
                                price: formatAmount(quote.quote.close, quote.quote.currency),
                                date: quote.quoteDate ?? quote.quote.timestamp,
                              })}
                              {quote.isStale ? ` · ${t("allocation:worksheet.dated")}` : ""}
                            </p>
                          ) : position.isAdded && latestQuotes.isFetched ? (
                            <div className="mt-2 flex flex-wrap items-center gap-2">
                              <span className="text-destructive text-xs">
                                {t("allocation:worksheet.noQuoteShort")}
                              </span>
                              <Button
                                size="sm"
                                variant="outline"
                                className="h-7 px-2 text-xs"
                                disabled={syncPrice.isPending}
                                onClick={() => {
                                  const asset = eligibleAssets.find(
                                    (item) => item.id === position.assetId,
                                  );
                                  if (asset?.quoteMode === "MARKET") syncPrice.mutate([asset.id]);
                                  else navigate(`/holdings/${position.assetId}`);
                                }}
                              >
                                {eligibleAssets.find((item) => item.id === position.assetId)
                                  ?.quoteMode === "MARKET"
                                  ? t("allocation:worksheet.refreshPrice")
                                  : t("allocation:worksheet.addManualPrice")}
                              </Button>
                            </div>
                          ) : null}

                          {adjustment && isExpanded && Math.abs(changeAmount) >= AMOUNT_EPSILON && (
                            <AccountAllocation
                              position={position}
                              changeAmount={changeAmount}
                              accounts={eligibleAccounts}
                              availableAccounts={selectedAccounts}
                              adjustment={adjustment}
                              currency={driftReport.baseCurrency}
                              cashByAccount={cashByAccount}
                              onAmountChange={(accountId, value) =>
                                updateAccountAmount(position.assetId, accountId, value)
                              }
                              onIncludeAccount={(accountId) =>
                                includeAccountForPosition(
                                  position.assetId,
                                  accountId,
                                  eligibleAccounts,
                                  Math.abs(changeAmount),
                                )
                              }
                              onRemoveAccount={(accountId) =>
                                removeIncludedAccount(position.assetId, accountId)
                              }
                            />
                          )}
                        </div>
                      );
                    })}
                  </div>
                )}
              </div>
            ) : (
              <ReviewChanges
                result={result}
                isStale={isResultStale}
                isCalculating={isPreviewUpdating}
                issue={prepared.issue}
                calculationError={calculationError}
                accountNames={accountNames}
                currency={driftReport.baseCurrency}
                onReviewIssue={reviewPreparedIssue}
                onCopy={() => setPendingExport("copy")}
                onDownload={() => setPendingExport("csv")}
              />
            )}

            <div className="border-t px-4 py-3 sm:px-5">
              <details>
                <summary className="text-muted-foreground hover:text-foreground cursor-pointer text-xs font-medium">
                  {t("allocation:worksheet.limitationsTitle")}
                </summary>
                <p className="text-muted-foreground mt-2 text-xs leading-relaxed">{disclosure}</p>
              </details>
            </div>
          </CardContent>
        </Card>

        <ImpactRail
          report={driftReport}
          result={result}
          isStale={isResultStale}
          prepared={prepared}
          profile={profile}
          calculationError={calculationError}
          isCalculating={isPreviewUpdating}
          firstUseOpen={firstUseOpen}
          onCalculate={() => void calculate()}
          onReviewIssue={reviewPreparedIssue}
          onClassifySecurity={(lineId) => {
            const assetId = result?.lines.find((line) => line.lineId === lineId)?.assetId;
            if (assetId) navigate(`/holdings/${assetId}`);
          }}
        />
      </div>
    </div>
  );
}
