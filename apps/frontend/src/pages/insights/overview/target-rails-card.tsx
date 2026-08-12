import { useTaxonomy } from "@/hooks/use-taxonomies";
import { cn } from "@/lib/utils";
import type { DriftReport, DriftRow, AllocationTarget } from "@/lib/types";
import { Button, Card, Icons, Skeleton } from "@wealthfolio/ui";
import { useTranslation } from "react-i18next";
import {
  allocationTargetColorForRow,
  buildAllocationTargetColorMap,
} from "@/pages/allocation-targets/components/allocation-target-colors";
import { formatTolerance } from "@/pages/allocation-targets/components/drift-copy";
import { resolveDriftReportCategories } from "@/pages/allocation-targets/components/drift-report-resolver";
import {
  formatDriftBps,
  hasVisibleAllocation,
  isOutOfBand,
} from "@/pages/allocation-targets/components/drift-row-utils";

interface TargetRailsCardProps {
  targets: AllocationTarget[];
  selectedTargetId: string | null;
  onTargetChange: (id: string) => void;
  driftReport: DriftReport | null;
  isLoading?: boolean;
  onCreateTarget?: () => void;
  /** Opens the full current-vs-target analysis. */
  onViewDetails?: () => void;
  /** Opens the user-authored rebalancing worksheet. */
  onOpenWorksheet?: () => void;
}

function driftClass(row: DriftRow): string {
  if (row.status === "overweight" || row.status === "not_targeted") return "text-destructive";
  if (row.status === "underweight") return "text-blue-600 dark:text-blue-400";
  return "text-muted-foreground";
}

export function TargetRailsCard({
  targets,
  selectedTargetId,
  onTargetChange,
  driftReport,
  isLoading,
  onCreateTarget,
  onViewDetails,
  onOpenWorksheet,
}: TargetRailsCardProps) {
  const { t } = useTranslation();
  const selectedTarget = targets.find((target) => target.id === selectedTargetId) ?? null;
  const { data: taxonomy } = useTaxonomy(selectedTarget?.taxonomyId ?? null);
  const resolvedDriftReport = driftReport
    ? resolveDriftReportCategories(driftReport, taxonomy?.categories)
    : null;
  const colorByCategory = resolvedDriftReport
    ? buildAllocationTargetColorMap(resolvedDriftReport.rows)
    : undefined;

  if (isLoading) {
    return (
      <Card className="space-y-4 p-5 xl:h-full">
        <Skeleton className="h-5 w-40" />
        <Skeleton className="h-8 w-full" />
        <Skeleton className="h-32 w-full" />
      </Card>
    );
  }

  const hasTarget = !!resolvedDriftReport;
  const categoryOrder = new Map(
    [...(taxonomy?.categories ?? [])]
      .sort((a, b) => a.sortOrder - b.sortOrder || a.name.localeCompare(b.name))
      .map((category, index) => [category.id, index]),
  );
  const rows = [...(resolvedDriftReport?.rows.filter(hasVisibleAllocation) ?? [])].sort(
    (a, b) =>
      (categoryOrder.get(a.categoryId) ?? Number.MAX_SAFE_INTEGER) -
        (categoryOrder.get(b.categoryId) ?? Number.MAX_SAFE_INTEGER) ||
      a.categoryName.localeCompare(b.categoryName),
  );

  const toleranceLabel = (() => {
    const requiredRows = rows.filter((r) => r.isRequired && r.targetBps > 0);
    if (!requiredRows.length) return formatTolerance(selectedTarget?.driftBandBps ?? 0);
    const bands = requiredRows.map((r) => r.effectiveBandBps);
    const minBand = Math.min(...bands);
    const maxBand = Math.max(...bands);
    if (minBand === maxBand) return formatTolerance(minBand);
    const fmt = (bps: number) => {
      const pp = bps / 100;
      return Number.isInteger(pp) ? pp.toFixed(0) : pp.toFixed(1);
    };
    return `±${fmt(minBand)}–${fmt(maxBand)}%`;
  })();
  const maxScale =
    Math.max(1, ...rows.flatMap((r) => [r.currentBps / 100, r.targetBps / 100])) * 1.08;
  const withinTolerance = resolvedDriftReport ? resolvedDriftReport.outOfBandCount === 0 : false;
  const differences = rows
    .map((row, index) => ({
      row,
      color: allocationTargetColorForRow(row, colorByCategory, index),
    }))
    .filter(({ row }) => isOutOfBand(row));

  return (
    <Card className="flex flex-col gap-4 p-5 xl:h-full">
      {/* Header: title + Details (top-right) */}
      <div className="flex items-center justify-between gap-3">
        <div className="text-muted-foreground text-[12px] font-semibold uppercase tracking-[0.18em]">
          {t("insights:insights.rails.target_allocation")}
        </div>
        {hasTarget && onViewDetails && (
          <Button
            variant="outline"
            size="sm"
            className="h-8 gap-1 rounded-full px-3.5 text-xs"
            onClick={onViewDetails}
          >
            {t("insights:insights.rails.details")}
            <Icons.ArrowRight className="h-3 w-3" />
          </Button>
        )}
      </div>

      {/* Target selector — pill carousel */}
      {targets.length > 0 && (
        <div className="-mx-1 flex gap-1.5 overflow-x-auto px-1 pb-1 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
          {targets.map((p) => (
            <button
              key={p.id}
              type="button"
              onClick={() => onTargetChange(p.id)}
              className={cn(
                "flex shrink-0 items-center gap-1.5 whitespace-nowrap rounded-full px-3 py-1 text-[12px] font-medium transition-colors",
                p.id === selectedTargetId
                  ? "bg-foreground text-background"
                  : "bg-muted text-muted-foreground hover:text-foreground",
              )}
            >
              {p.name}
            </button>
          ))}
        </div>
      )}

      {hasTarget ? (
        <>
          {/* Rails */}
          <div className="flex flex-col">
            {rows.map((row, index) => {
              const cur = row.currentBps / 100;
              const tgt = row.targetBps / 100;
              const color = allocationTargetColorForRow(row, colorByCategory, index);
              return (
                <div
                  key={row.categoryId}
                  className="grid grid-cols-[110px_1fr_62px] items-center gap-2.5 border-t py-3 first:border-t-0"
                >
                  <span className="flex items-center gap-2 overflow-hidden text-[12.5px] font-semibold">
                    <span
                      className="h-2.5 w-2.5 shrink-0 rounded-sm"
                      style={{ background: color }}
                    />
                    <span className="truncate">{row.categoryName}</span>
                  </span>
                  <span className="bg-muted relative h-2 rounded-full">
                    <span
                      className="absolute top-0 h-full rounded-full opacity-60"
                      style={{ width: `${(cur / maxScale) * 100}%`, background: color }}
                    />
                    <span
                      className="bg-foreground absolute -top-1 h-4 w-[2.5px] rounded-sm"
                      style={{ left: `calc(${(tgt / maxScale) * 100}% - 1px)` }}
                    />
                  </span>
                  <span
                    className={cn(
                      "text-right text-[11.5px] font-bold tabular-nums",
                      driftClass(row),
                    )}
                  >
                    {formatDriftBps(row.driftBps)}
                  </span>
                </div>
              );
            })}
          </div>

          {/* Descriptive target differences — taxonomy order. */}
          <div className="flex flex-col pt-5 xl:flex-1">
            <div className="text-muted-foreground mb-2 text-[10px] font-semibold uppercase tracking-wider">
              {t("insights:insights.rails.target_differences")}
            </div>
            {differences.length === 0 ? (
              <div className="text-muted-foreground flex flex-col items-center justify-center gap-1.5 py-4 text-center xl:flex-1">
                <Icons.Target className="h-6 w-6" />
                <span className="text-[12px]">{t("insights:insights.rails.all_in_range")}</span>
              </div>
            ) : (
              <div className="flex flex-col gap-2.5">
                {differences.slice(0, 6).map(({ row, color }) => (
                  <div
                    key={row.categoryId}
                    className="flex items-center justify-between gap-2 text-[12px]"
                  >
                    <span className="flex min-w-0 items-center gap-2">
                      <span className="h-2 w-2 shrink-0 rounded-sm" style={{ background: color }} />
                      <span className="text-foreground truncate font-medium">
                        {row.categoryName}
                      </span>
                    </span>
                    <span className="text-muted-foreground shrink-0 font-medium tabular-nums">
                      {row.driftBps > 0
                        ? t("insights:insights.rails.above_target_by", {
                            difference: formatDriftBps(Math.abs(row.driftBps)),
                          })
                        : t("insights:insights.rails.below_target_by", {
                            difference: formatDriftBps(Math.abs(row.driftBps)),
                          })}
                    </span>
                  </div>
                ))}
              </div>
            )}
          </div>

          <p className="text-muted-foreground text-[11px] leading-relaxed">
            {t("insights:insights.rails.descriptive_disclosure")}
          </p>
          {onOpenWorksheet && (
            <Button variant="outline" size="sm" onClick={onOpenWorksheet} className="w-fit">
              {t("insights:insights.rails.open_worksheet")}
            </Button>
          )}

          {/* Bottom status */}
          <div
            className={cn(
              "mt-3 flex items-center gap-2 rounded-lg border px-3 py-2 text-[11px] font-semibold xl:mt-auto",
              withinTolerance
                ? "border-success/15 bg-success/[0.04] text-success"
                : "border-border bg-muted/30 text-muted-foreground",
            )}
          >
            <span
              className={cn(
                "h-1.5 w-1.5 rounded-full",
                withinTolerance ? "bg-success" : "bg-muted-foreground",
              )}
            />
            <span className="min-w-0 flex-1 truncate">
              {withinTolerance
                ? t("insights:insights.rails.inside_target_range")
                : t("insights:insights.rails.outside_range", {
                    count: resolvedDriftReport?.outOfBandCount ?? 0,
                  })}
            </span>
            <span className="shrink-0 tabular-nums">
              {t("insights:insights.rails.tolerance", { tolerance: toleranceLabel })}
            </span>
          </div>
        </>
      ) : (
        <div className="flex flex-1 flex-col items-center justify-center gap-5 py-1 text-center">
          <div className="bg-muted/25 w-full rounded-xl border p-4">
            <div className="text-muted-foreground mb-4 flex items-center justify-between text-[10px] font-semibold uppercase tracking-wider">
              <span>{t("insights:insights.rails.current")}</span>
              <span>{t("insights:insights.rails.target")}</span>
            </div>
            <div className="space-y-3">
              {[
                { width: "72%", target: "64%", color: "bg-success/70" },
                { width: "46%", target: "58%", color: "bg-warning/70" },
                { width: "28%", target: "36%", color: "bg-primary/65" },
              ].map((row, index) => (
                <div key={index} className="grid grid-cols-[14px_1fr] items-center gap-2">
                  <span className={cn("h-2.5 w-2.5 rounded-sm", row.color)} />
                  <span className="bg-background relative h-2.5 overflow-visible rounded-full border">
                    <span
                      className={cn("absolute inset-y-0 left-0 rounded-full", row.color)}
                      style={{ width: row.width }}
                    />
                    <span
                      className="bg-foreground absolute -top-1 h-4 w-[2.5px] rounded-sm"
                      style={{ left: row.target }}
                    />
                  </span>
                </div>
              ))}
            </div>
          </div>

          <div className="space-y-3">
            <div className="bg-background mx-auto flex h-11 w-11 items-center justify-center rounded-full border shadow-sm">
              <Icons.Target className="text-muted-foreground h-5 w-5" />
            </div>
            <div>
              <h3 className="text-foreground text-[13px] font-semibold">
                {t("insights:insights.rails.no_target_yet")}
              </h3>
              <p className="text-muted-foreground mt-1 text-[12px] leading-relaxed">
                {t("insights:insights.rails.compare_weights")}
              </p>
            </div>
            {onCreateTarget && (
              <Button size="sm" className="gap-2 rounded-full px-4" onClick={onCreateTarget}>
                {t("insights:insights.rails.set_target_allocation")}
                <Icons.ArrowRight className="h-3.5 w-3.5" />
              </Button>
            )}
          </div>
        </div>
      )}
    </Card>
  );
}
