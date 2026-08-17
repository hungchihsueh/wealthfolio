import type { ActivityDetails } from "@/lib/types";
import { ActivityStatus, ActivityType } from "@/lib/constants";
import { render, screen } from "@testing-library/react";
import React from "react";
import { describe, expect, it, vi } from "vitest";
import { ActivityDetailSheet } from "./activity-detail-sheet";

vi.mock("@wealthfolio/ui", () => ({
  Badge: ({ children }: { children: React.ReactNode }) => <span>{children}</span>,
  Button: ({ children }: { children: React.ReactNode }) => <button>{children}</button>,
  Icons: {
    AlertCircle: () => null,
    ArrowLeftRight: () => null,
    BarChart: () => null,
    DollarSign: () => null,
    FileText: () => null,
    Info: () => null,
    Receipt: () => null,
  },
  PriceDisplay: ({ value }: { value: number }) => <span data-testid="price-display">{value}</span>,
  Separator: () => <hr />,
  Sheet: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  SheetContent: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  SheetHeader: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  SheetTitle: ({ children }: { children: React.ReactNode }) => <h2>{children}</h2>,
}));

vi.mock("@wealthfolio/ui/components/financial/amount-display", () => ({
  AmountDisplay: ({ value }: { value: number }) => (
    <span data-testid="amount-display">{value}</span>
  ),
}));

function activity(overrides: Partial<ActivityDetails>): ActivityDetails {
  return {
    id: "activity-1",
    activityType: ActivityType.BUY,
    status: ActivityStatus.POSTED,
    date: new Date("2026-03-31T12:00:00Z"),
    quantity: "1",
    unitPrice: "100",
    amount: "100",
    fee: null,
    tax: null,
    currency: "USD",
    needsReview: false,
    createdAt: new Date("2026-03-31T12:00:00Z"),
    updatedAt: new Date("2026-03-31T12:00:00Z"),
    assetId: "AAPL",
    accountId: "account-1",
    accountName: "Brokerage",
    accountCurrency: "USD",
    assetSymbol: "AAPL",
    ...overrides,
  };
}

describe("ActivityDetailSheet cash totals", () => {
  it("does not invent a zero cash total for a security transfer", () => {
    render(
      <ActivityDetailSheet
        activity={activity({
          activityType: ActivityType.TRANSFER_IN,
          quantity: "10",
          unitPrice: "50",
          amount: null,
        })}
        open
        onOpenChange={() => undefined}
      />,
    );

    expect(screen.queryAllByTestId("amount-display")).toHaveLength(0);
    expect(screen.getAllByText("—").length).toBeGreaterThanOrEqual(2);
  });

  it("shows signed cash effect in the summary and unsigned total in the details", () => {
    render(
      <ActivityDetailSheet
        activity={activity({ activityType: ActivityType.BUY, amount: "100" })}
        open
        onOpenChange={() => undefined}
      />,
    );

    expect(screen.getAllByTestId("amount-display").map((node) => node.textContent)).toEqual([
      "-100",
      "100",
    ]);
  });
});
