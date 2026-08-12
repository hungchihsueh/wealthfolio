# Allocation Targets V2 Specification

Status: Current

Date: 2026-08-08
Audience: Product, frontend, backend, desktop, web

> This specification supersedes [Allocation Targets V1](./v1-spec.md), which is
> retained as a historical record of the automated rebalancing design.

## Decision and rationale

V1 combined descriptive allocation drift with an optimizer that selected
directions, securities, accounts, and sizes and produced suggested manual
trades. V2 deliberately removes that optimizer and replaces it with a
user-authored **Rebalancing worksheet**.

The reasons for the change are:

- Preserve the useful target and drift analytics without having the app
  construct a personalized course of action.
- Ensure every worksheet direction, security, account, and size is chosen by the
  user before any arithmetic is calculated.
- Treat disclosures and acknowledgments as secondary transparency controls, not
  as substitutes for removing selection, ranking, and optimization.
- Keep calculated output factual and reproducible through source records and an
  immutable fingerprint.
- Retain explicit user prohibitions as hard blocks while treating policy and
  data-quality concerns as acknowledgeable warnings.
- Accept the product tradeoff that multi-sleeve construction is manual.
  Automated optimization cannot return without a new product and legal review.

This is a product-risk and architecture decision, not a conclusion that wording
or disclaimers alone determine the regulatory treatment of a feature.

## Product boundary

Wealthfolio lets a user define an allocation target, compare recorded allocation
with that target, and enter an illustrative worksheet. The product does not
select, rank, optimize, recommend, or execute investments.

The dashboard is descriptive:

- Categories follow taxonomy order.
- Copy says above target, below target, or within the selected range.
- No category is labelled a priority, required action, or largest move.
- The dashboard states that targets are user-set and differences are not
  recommendations.

The Rebalancing worksheet is user-authored:

- It starts empty.
- Every direction, security, account, input mode, and size is selected by the
  user.
- It accepts 1–50 lines and retains repeated lines separately.
- It performs arithmetic only and displays neutral current/projected values.
- It has no order execution, broker routing, tax-lot selection, suitability
  assessment, ranking, or optimizer.

The workflow preserves the useful interaction patterns from the V1 planner
without restoring automated construction:

- The primary **Adjust positions** view lists recorded positions and user-added
  tracked securities. Users enter either a direct amount change or a resulting
  portfolio percentage; both directions use the same control.
- Account allocation is progressive and inline. Accounts already holding the
  security appear first, additional selected accounts can be added explicitly,
  and multi-account changes must be fully allocated by the user.
- Increase changes can use any active tracked investment security and any leaf
  account in scope. Reductions can use only accounts with a sufficient recorded
  holding.
- Input changes schedule one authoritative core calculation after a 500 ms
  debounce. The frontend converts the optional Final % editing convenience into
  user-authored amount changes using the same cash-inclusive or cash-exclusive
  denominator model; only the core result is treated as validated. The last
  validated result remains visible but muted while the core reloads holdings,
  targets, classifications, quotes, and FX.
- A **Review adjustments** view replaces the former account editing view. It
  shows the validated account-level Increase/Reduce lines, estimated amounts and
  quantities, price dates, and line warnings.
- Copy and CSV actions are available only from a fresh **Review adjustments**
  result. They are disabled while data is updating or validation has failed.
- Editable worksheet inputs are retained as a versioned, device-local draft per
  target and account scope. Calculated results are never restored; reopening the
  worksheet recalculates the draft against current recorded data.
- The result reuses the useful visual hierarchy of the former planner without
  reintroducing automated construction: the cash controls sit beside a
  current/projected maximum-difference chart, result metrics appear in that
  summary, and warnings collapse into one review strip.
- A **Current · Projected · Target** section uses aligned stacked category bars
  and a neutral values table. Categories retain taxonomy order and color across
  all three bars; the signed Difference column is factual and has no good/bad
  treatment.
- The account-level review is never labelled as proposed, suggested, or
  generated trades. It states that the changes were entered by the user,
  quantities are estimates, and nothing is submitted or executed.

## Cash inputs

The UI presents one **Cash to deploy** amount. Up to the observed deployable
cash is treated as tracked cash; any excess is disclosed as unrecorded
hypothetical cash. The transport keeps those values explicit as two decimal
strings:

```ts
interface WorksheetCashInput {
  trackedCashToUse: string;
  externalContribution: string;
}
```

Observed deployable cash is read-only. Selected tracked cash cannot exceed it.
External contribution is unrestricted and non-negative, is explicitly labelled
hypothetical, and produces an acknowledgeable warning. Increases must be funded
by selected tracked cash, hypothetical external cash, and reduction proceeds.
The cash control offers a direct amount, slider, and 25%/50%/75%/All shortcuts;
it starts at zero and changes only through user input.

## Calculation request

```ts
interface CalculateAllocationWorksheetRequest {
  targetId: string;
  filter: AccountScope;
  cash: WorksheetCashInput;
  lines: Array<{
    lineId: string;
    direction: "increase" | "reduce";
    assetId: string;
    accountId: string;
    inputMode: "amount" | "quantity";
    value: string;
  }>;
}
```

The server resolves account scope, holdings, classifications, security prices,
FX, target weights, constraints, and target policy. The result includes the
resolved lines, category values and percentages, signed target differences,
unclassified residuals, warnings, resolved leaf accounts, and every source
record included in the immutable SHA-256 fingerprint.

## Validation policy

Hard errors are limited to impossible or unverifiable arithmetic, scope
violations, and explicit user prohibitions:

- malformed or non-positive line values;
- missing/invalid security price or FX conversion;
- an account outside resolved scope;
- a reduction exceeding the current position;
- a fractional quantity under whole-unit policy;
- classifications above 10,000 basis points;
- selected tracked cash above observed cash;
- unfunded increases or more than 50 rows;
- a matching `Block` constraint; or
- a reduction when reductions are disabled.

The result is still calculated for stale prices or FX, incomplete
classification, hypothetical external cash, minimum-line and turnover policy
breaches, and matching `Avoid` constraints. Warnings remain visible in the
result. Copy/download requires an export-time confirmation bound to the current
result; there are no persistent warning or disclosure checkboxes.

## Classification

Assignment weights are integer basis points. Totals below 10,000 create an
explicit `Unclassified exposure` residual. A fully unclassified security has a
10,000-basis-point residual. Totals above 10,000 are rejected as a
data-integrity error.

## Targets and examples

Example titles are generated from category weights. Examples have no risk or
featured badge, are sorted alphabetically, and may show factual source/effective
date text. Selecting an example populates editable weights; saving the target is
the user's affirmative action, with no separate consent checkbox.

Every saved target is selected by the user. The app does not persist or infer
how its initial weights were entered. Results and exports therefore describe it
only as the target selected by the user.

## Disclosures and exports

A versioned disclosure gates first use. The limitations disclosure is available
in a compact expandable section with every result and travels with CSV/clipboard
exports. Copying or downloading opens one confirmation dialog that tells the
user to review warnings and recorded data. The user-facing export is
intentionally concise: a target/date/funding header, the validated account-level
adjustments, any warnings, and a concise contextual limitations disclosure.
Internal fingerprints and source records remain part of the calculated result
but are not exposed as noisy IDs in the readable export.

Input or source changes invalidate the result and dismiss a pending export.

## Compatibility

- Desktop command: `calculate_allocation_worksheet`.
- Web API: `POST /api/v1/allocation-targets/worksheet/calculate`.
- The former web endpoint `POST /api/v1/allocation-targets/rebalance/calculate`
  returns `410 Gone` for one release with the replacement path and performs no
  calculation.
- The former Tauri command and optimizer types are removed because desktop
  frontend and backend ship together.
- Allocation target/worksheet types are not exported by the addon SDK.

Automated allocation construction or optimization cannot be reintroduced without
a new product and legal review.
