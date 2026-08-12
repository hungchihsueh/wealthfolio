import { useMemo } from "react";
import { Button, Card, CardContent, CardHeader, CardTitle, CardDescription } from "@wealthfolio/ui";
import { useTranslation } from "react-i18next";
import type { TFunction } from "i18next";
import type { DriftReport, DriftRow } from "@/lib/types";
import {
  allocationTargetColorForRow,
  buildAllocationTargetColorMap,
} from "./allocation-target-colors";
import { formatPp, formatRoundedCurrency } from "./drift-copy";
import { isOutOfBand } from "./drift-row-utils";

interface DriftDriversCardProps {
  report: DriftReport;
  statusDescription: string;
  bandLabel?: string | null;
  onWorksheetClick?: () => void;
}

function formatPercent(bps: number, decimals = 1): string {
  const pct = bps / 100;
  return Number.isInteger(pct) ? pct.toFixed(0) : pct.toFixed(decimals);
}

function buildDriver(row: DriftRow, currency: string, t: TFunction) {
  const current = formatPercent(row.currentBps);
  const target = formatPercent(row.targetBps);
  const absDelta = Math.abs(row.valueDelta);
  const amount = formatRoundedCurrency(absDelta, currency);
  const drift = formatPp(row.driftBps);

  if (row.status === "not_targeted") {
    return {
      title: t("allocation:drivers.outsideTargetTitle", { category: row.categoryName }),
      detail: t("allocation:drivers.notTargetedDetail", { current, amount }),
      drift,
    };
  }

  if (row.status === "overweight") {
    return {
      title: t("allocation:drivers.aboveTargetTitle", { category: row.categoryName }),
      detail: t("allocation:drivers.overweightDetail", { current, target, amount }),
      drift,
    };
  }
  return {
    title: t("allocation:drivers.belowTargetTitle", { category: row.categoryName }),
    detail: t("allocation:drivers.underweightDetail", { current, target, amount }),
    drift,
  };
}

export function DriftDriversCard({
  report,
  statusDescription,
  bandLabel,
  onWorksheetClick,
}: DriftDriversCardProps) {
  const { t } = useTranslation();
  const colorByCategory = useMemo(() => buildAllocationTargetColorMap(report.rows), [report.rows]);
  const oobRows = report.rows.filter(isOutOfBand);
  const visibleRows = oobRows.slice(0, 3);
  const remainingRows = oobRows.slice(3);
  const showWorksheetCta = !!onWorksheetClick;

  return (
    <Card className="flex h-full flex-col">
      <CardHeader className="pb-4">
        <CardTitle className="text-base">{t("allocation:drivers.title")}</CardTitle>
        <CardDescription>
          {statusDescription}
          {bandLabel && (
            <>
              {" · "}
              <span className="text-muted-foreground">{bandLabel}</span>
            </>
          )}
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-1 flex-col">
        {oobRows.length === 0 ? (
          <p className="text-muted-foreground py-6 text-center text-[13px]">
            {t("allocation:drivers.withinSelectedRange", { status: statusDescription })}
          </p>
        ) : (
          <ul className="space-y-3">
            {visibleRows.map((row, index) => {
              const driver = buildDriver(row, report.baseCurrency, t);
              const rowColor = allocationTargetColorForRow(row, colorByCategory, index);
              return (
                <li key={row.categoryId} className="bg-muted/35 rounded-lg px-3.5 py-3">
                  <div className="flex items-start justify-between gap-3">
                    <div className="flex min-w-0 items-center gap-2.5">
                      <span
                        className="h-2.5 w-2.5 shrink-0 rounded-sm"
                        style={{ backgroundColor: rowColor }}
                      />
                      <p className="text-foreground truncate text-[13px] font-semibold leading-snug">
                        {driver.title}
                      </p>
                    </div>
                    <span className="text-muted-foreground shrink-0 text-[12.5px] font-semibold tabular-nums">
                      {driver.drift}
                    </span>
                  </div>
                  <p className="text-muted-foreground mt-2 truncate pl-7 text-[12px] leading-relaxed">
                    {driver.detail}
                  </p>
                </li>
              );
            })}
            {remainingRows.length > 0 && (
              <li className="bg-muted/20 text-muted-foreground rounded-lg px-3.5 py-2.5 text-[11.5px] leading-relaxed">
                <span className="text-foreground font-medium">
                  {t("allocation:drivers.moreOutsideTarget", { count: remainingRows.length })}
                </span>
                <span className="px-1.5">·</span>
                {remainingRows
                  .map((row) => {
                    return `${row.categoryName} ${formatPp(row.driftBps)}`;
                  })
                  .join(" · ")}
              </li>
            )}
          </ul>
        )}
        {showWorksheetCta && (
          <div className="mt-auto pt-4">
            <Button size="sm" onClick={onWorksheetClick} className="w-fit">
              {t("allocation:drivers.openWorksheet")}
            </Button>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
