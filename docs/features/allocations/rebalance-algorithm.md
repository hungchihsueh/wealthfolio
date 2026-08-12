# Allocation Worksheet Arithmetic

This document implements the current
[Allocation Targets V2 specification](./v2-spec.md).

The automated rebalancing algorithm has been retired. This document describes
the replacement arithmetic service in
`crates/core/src/portfolio/allocation_targets/worksheet_service.rs`.

## Inputs and resolution

The user supplies each line's Increase/Reduce direction, tracked security, leaf
account, amount/quantity mode, and positive decimal value. The server then:

1. resolves target and leaf-account scope;
2. reloads holdings, target weights, constraints, classifications, quotes, FX,
   and target policy;
3. resolves quote currency into base currency through a deterministic FX path,
   records every rate used by that path, and applies the contract multiplier;
4. converts amount to quantity or quantity to amount;
5. applies each classification weight to the signed line value;
6. assigns any classification residual to `Unclassified exposure`;
7. applies signed category deltas to current values; and
8. recalculates projected percentages and signed target differences.

There is no candidate selection, sorting by attractiveness, optimization, trade
generation, or execution output.

## Quantity and amount

For a resolved base-currency unit price `P`:

```text
amount mode:   quantity = entered_amount / P
quantity mode: amount   = entered_quantity * P
```

With whole-unit policy, amount-mode quantity is floored and its actual amount is
returned; quantity-mode input must be an integer. Reduction quantities are
aggregated by account/security for the holding-limit check, while original
worksheet lines remain separate in the result and export.

## Denominators and cash

If the selected taxonomy contains a cash category, external contribution enters
the portfolio denominator and net worksheet cash flow changes that cash
category. Otherwise, projected total is current value plus total increases less
total reductions. This retains the existing cash-category allocation behavior
while separately disclosing external capital.

## Fingerprint

The SHA-256 fingerprint is computed from the complete request and a sorted list
of source records. Source records cover target policy, target weights, taxonomy
and categories, selected assets, in-scope holdings, relevant classifications,
constraints, security quotes, the exact FX records used by resolved conversion
paths, and derived drift rows. The same records are returned for audit.

No acknowledgment boolean is accepted by the calculation API. Copy/download is
available only for the current validated result and requires an export-time
confirmation. Input or source changes invalidate that result and dismiss any
pending export.
