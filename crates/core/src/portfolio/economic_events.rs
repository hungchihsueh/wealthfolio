use crate::activities::{
    is_cash_symbol, Activity, ACTIVITY_SUBTYPE_BONUS, ACTIVITY_TYPE_BUY, ACTIVITY_TYPE_CREDIT,
    ACTIVITY_TYPE_DEPOSIT, ACTIVITY_TYPE_DIVIDEND, ACTIVITY_TYPE_FEE, ACTIVITY_TYPE_INTEREST,
    ACTIVITY_TYPE_SELL, ACTIVITY_TYPE_SPLIT, ACTIVITY_TYPE_TAX, ACTIVITY_TYPE_TRANSFER_IN,
    ACTIVITY_TYPE_TRANSFER_OUT, ACTIVITY_TYPE_WITHDRAWAL,
};
use crate::assets::Asset;
use crate::fx::currency::{normalize_amount, normalize_currency_code};
use crate::portfolio::valuation::ExternalFlowSource;
use crate::quotes::Quote;
use chrono::NaiveDate;
use rust_decimal::Decimal;
use serde::{Deserialize, Serialize};

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum EconomicEventKind {
    CashFlow,
    ExternalSecurityDeliveryIn,
    ExternalSecurityDeliveryOut,
    InternalSecurityTransfer,
    Trade,
    Income,
    Fee,
    Tax,
    UnknownBoundaryTransfer,
    Other,
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum BasisStatus {
    Complete,
    PartialUnknown,
    Unknown,
    #[default]
    NotApplicable,
}

impl BasisStatus {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Complete => "COMPLETE",
            Self::PartialUnknown => "PARTIAL_UNKNOWN",
            Self::Unknown => "UNKNOWN",
            Self::NotApplicable => "NOT_APPLICABLE",
        }
    }

    pub fn from_code(value: &str) -> Self {
        match value.trim().to_ascii_uppercase().as_str() {
            "COMPLETE" => Self::Complete,
            "PARTIAL_UNKNOWN" | "PARTIAL" => Self::PartialUnknown,
            "UNKNOWN" => Self::Unknown,
            "NOT_APPLICABLE" | "N/A" | "NA" => Self::NotApplicable,
            _ => Self::Unknown,
        }
    }

    pub fn combine(self, next: Self) -> Self {
        match (self, next) {
            (Self::PartialUnknown, _) | (_, Self::PartialUnknown) => Self::PartialUnknown,
            (Self::Complete, Self::Unknown) | (Self::Unknown, Self::Complete) => {
                Self::PartialUnknown
            }
            (Self::Unknown, _) | (_, Self::Unknown) => Self::Unknown,
            (Self::Complete, _) | (_, Self::Complete) => Self::Complete,
            (Self::NotApplicable, Self::NotApplicable) => Self::NotApplicable,
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum TransferBoundary {
    Internal,
    External,
    Unknown,
}

#[derive(Clone, Debug, PartialEq)]
pub struct ResolvedActivityEconomics {
    pub kind: EconomicEventKind,
    pub lot_cost_basis_value: Decimal,
    pub lot_cost_basis_currency: String,
    pub performance_flow_value: Decimal,
    pub performance_flow_currency: String,
    pub performance_flow_source: ExternalFlowSource,
    pub basis_status: BasisStatus,
    pub diagnostics: Vec<String>,
}

#[derive(Clone, Debug, PartialEq)]
pub struct EconomicEventEffect {
    pub activity_id: String,
    pub account_id: String,
    pub asset_id: Option<String>,
    pub date: NaiveDate,
    pub event_kind: EconomicEventKind,
    /// Signed external flow. Positive means contribution; negative means distribution.
    pub external_flow: Decimal,
    pub realized_pnl: Decimal,
    pub unrealized_movement: Decimal,
    pub income: Decimal,
    pub fee: Decimal,
    pub tax: Decimal,
    pub fx_effect: Decimal,
    pub diagnostics: Vec<String>,
}

impl EconomicEventEffect {
    pub fn empty(activity: &Activity, date: NaiveDate, event_kind: EconomicEventKind) -> Self {
        Self {
            activity_id: activity.id.clone(),
            account_id: activity.account_id.clone(),
            asset_id: activity.asset_id.clone(),
            date,
            event_kind,
            external_flow: Decimal::ZERO,
            realized_pnl: Decimal::ZERO,
            unrealized_movement: Decimal::ZERO,
            income: Decimal::ZERO,
            fee: Decimal::ZERO,
            tax: Decimal::ZERO,
            fx_effect: Decimal::ZERO,
            diagnostics: Vec::new(),
        }
    }
}

pub struct ActivityEconomicsResolver;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum LegacyActivityCashClassification {
    Derived,
    Equivalent,
    Final,
    Gross,
    Ambiguous,
    Missing,
    NotApplicable,
}

impl LegacyActivityCashClassification {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Derived => "derived",
            Self::Equivalent => "equivalent",
            Self::Final => "final",
            Self::Gross => "gross_converted",
            Self::Ambiguous => "ambiguous",
            Self::Missing => "missing",
            Self::NotApplicable => "not_applicable",
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct ClassifiedLegacyActivityCash {
    pub classification: LegacyActivityCashClassification,
    pub final_amount: Option<Decimal>,
    pub needs_review: bool,
}

/// Flat inputs used to resolve the cash economics of persisted, imported, and
/// not-yet-persisted activities. Monetary values are magnitudes; activity type
/// supplies normal direction while gross economics resolve exceptional cases.
#[derive(Clone, Copy, Debug)]
pub struct ActivityCashInputs<'a> {
    pub activity_type: &'a str,
    pub is_security_transfer: bool,
    pub quantity: Option<Decimal>,
    pub unit_price: Option<Decimal>,
    pub amount: Option<Decimal>,
    pub fee: Option<Decimal>,
    pub tax: Option<Decimal>,
    pub unit_multiplier: Decimal,
}

#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub struct ResolvedActivityCash {
    /// Authoritative final cash magnitude, including fees and taxes.
    pub amount: Option<Decimal>,
    /// Cash magnitude derived from quantity, price, multiplier, and charges.
    pub expected_amount: Option<Decimal>,
    /// Signed cash movement. Positive is an inflow; negative is an outflow.
    pub signed_cash_effect: Decimal,
    /// Pre-charge economics used for lots, cost basis, and realized P/L.
    pub gross_amount: Option<Decimal>,
    pub amount_was_derived: bool,
}

impl ResolvedActivityCash {
    /// Signed pre-charge economics for external contribution/performance flows.
    pub fn signed_gross_effect(&self) -> Decimal {
        let gross = self.gross_amount.or(self.amount).unwrap_or(Decimal::ZERO);
        if self.signed_cash_effect.is_sign_negative() {
            -gross
        } else if self.signed_cash_effect.is_sign_positive() {
            gross
        } else {
            Decimal::ZERO
        }
    }
}

impl ActivityEconomicsResolver {
    /// Unit multiplier used only for activity cash totals. Bond quotes are
    /// commonly percentages of par, but that convention must not affect
    /// portfolio-wide asset valuation.
    pub fn asset_unit_multiplier(asset: &Asset) -> Decimal {
        if asset.is_bond() {
            asset
                .explicit_contract_multiplier()
                .unwrap_or_else(|| Decimal::new(1, 2))
        } else {
            asset.contract_multiplier()
        }
    }

    pub fn resolve_cash(activity: &Activity, unit_multiplier: Decimal) -> ResolvedActivityCash {
        let inputs = ActivityCashInputs {
            activity_type: activity.effective_type(),
            is_security_transfer: Self::is_security_transfer(activity),
            quantity: activity.quantity,
            unit_price: activity.unit_price,
            amount: activity.amount,
            fee: activity.fee,
            tax: activity.tax,
            unit_multiplier,
        };

        Self::resolve_cash_inputs_with_legacy_compatibility(
            inputs,
            Self::uses_legacy_gross_compatibility(activity),
        )
    }

    /// Resolves the one direction exception that depends on account context.
    /// Investment-account interest is income; credit-card interest increases
    /// the liability and is therefore an outflow.
    pub fn resolve_cash_with_account_context(
        activity: &Activity,
        unit_multiplier: Decimal,
        is_credit_card_account: bool,
    ) -> ResolvedActivityCash {
        let mut resolved = Self::resolve_cash(activity, unit_multiplier);
        if is_credit_card_account && activity.effective_type() == ACTIVITY_TYPE_INTEREST {
            resolved.signed_cash_effect = -resolved.amount.unwrap_or(Decimal::ZERO).abs();
        }
        resolved
    }

    pub fn resolve_cash_inputs_with_legacy_compatibility(
        inputs: ActivityCashInputs<'_>,
        legacy_gross_compatibility: bool,
    ) -> ResolvedActivityCash {
        if legacy_gross_compatibility {
            Self::resolve_legacy_gross_cash_inputs(inputs)
        } else {
            Self::resolve_cash_inputs(inputs)
        }
    }

    pub fn resolve_cash_inputs(inputs: ActivityCashInputs<'_>) -> ResolvedActivityCash {
        if inputs.activity_type == ACTIVITY_TYPE_SPLIT {
            return ResolvedActivityCash::default();
        }

        let fee = inputs.fee.unwrap_or(Decimal::ZERO).abs();
        if inputs.is_security_transfer {
            // Security principal is non-cash, but embedded fees remain cash outflows
            // for compatibility with existing activity rows and rebuilt snapshots.
            return ResolvedActivityCash {
                signed_cash_effect: -fee,
                ..ResolvedActivityCash::default()
            };
        }

        let tax = inputs.tax.unwrap_or(Decimal::ZERO).abs();
        let charges = fee + tax;
        let expected_cash_effect = Self::derived_cash_effect(inputs, fee, tax);
        let expected_amount = expected_cash_effect.map(|amount| amount.abs());
        let supplied_amount = inputs.amount.map(|amount| amount.abs());
        let amount = match supplied_amount {
            Some(amount) if amount.is_zero() => expected_amount.or(Some(Decimal::ZERO)),
            Some(amount) => Some(amount),
            None => expected_amount,
        };
        let amount_was_derived =
            expected_amount.is_some() && supplied_amount.is_none_or(|amount| amount.is_zero());

        let signed_cash_effect = amount
            .map(|amount| {
                let default_effect = Self::type_directed_cash_effect(inputs.activity_type, amount);
                expected_cash_effect
                    .filter(|expected| !expected.is_zero())
                    .map(|expected| {
                        if expected.is_sign_negative() {
                            -amount
                        } else {
                            amount
                        }
                    })
                    .unwrap_or(default_effect)
            })
            .unwrap_or(Decimal::ZERO);

        let gross_amount = amount.and_then(|amount| {
            let gross = match inputs.activity_type {
                ACTIVITY_TYPE_BUY => -signed_cash_effect - charges,
                ACTIVITY_TYPE_SELL
                | ACTIVITY_TYPE_DEPOSIT
                | ACTIVITY_TYPE_DIVIDEND
                | ACTIVITY_TYPE_INTEREST
                | ACTIVITY_TYPE_CREDIT
                | ACTIVITY_TYPE_TRANSFER_IN => signed_cash_effect + charges,
                ACTIVITY_TYPE_WITHDRAWAL | ACTIVITY_TYPE_TRANSFER_OUT => {
                    -signed_cash_effect - charges
                }
                ACTIVITY_TYPE_FEE | ACTIVITY_TYPE_TAX => amount,
                _ => return None,
            };
            (gross >= Decimal::ZERO).then_some(gross)
        });

        ResolvedActivityCash {
            amount,
            expected_amount,
            signed_cash_effect,
            gross_amount,
            amount_was_derived,
        }
    }

    pub fn classify_legacy_cash_inputs(
        inputs: ActivityCashInputs<'_>,
        tolerance: Decimal,
    ) -> ClassifiedLegacyActivityCash {
        if inputs.activity_type == ACTIVITY_TYPE_SPLIT || inputs.is_security_transfer {
            return ClassifiedLegacyActivityCash {
                classification: LegacyActivityCashClassification::NotApplicable,
                final_amount: inputs.amount.map(|amount| amount.abs()),
                needs_review: false,
            };
        }

        let tolerance = tolerance.abs();
        let fee = inputs.fee.unwrap_or(Decimal::ZERO).abs();
        let tax = inputs.tax.unwrap_or(Decimal::ZERO).abs();
        let charges = fee + tax;
        let supplied = inputs.amount.map(|amount| amount.abs());
        let expected_effect = Self::derived_cash_effect(inputs, fee, tax);
        let expected_final = expected_effect.map(|amount| amount.abs());

        if supplied.is_none_or(|amount| amount.is_zero()) {
            return match expected_final {
                Some(final_amount) => ClassifiedLegacyActivityCash {
                    classification: LegacyActivityCashClassification::Derived,
                    final_amount: Some(final_amount),
                    needs_review: false,
                },
                None => ClassifiedLegacyActivityCash {
                    classification: LegacyActivityCashClassification::Missing,
                    final_amount: None,
                    needs_review: true,
                },
            };
        }

        let supplied = supplied.unwrap_or_default();
        if charges.is_zero() {
            return ClassifiedLegacyActivityCash {
                classification: LegacyActivityCashClassification::Equivalent,
                final_amount: Some(supplied),
                needs_review: false,
            };
        }

        if matches!(inputs.activity_type, ACTIVITY_TYPE_FEE | ACTIVITY_TYPE_TAX) {
            return ClassifiedLegacyActivityCash {
                classification: LegacyActivityCashClassification::Final,
                final_amount: Some(supplied),
                needs_review: false,
            };
        }

        let Some(expected_gross) = Self::derived_gross(inputs) else {
            return ClassifiedLegacyActivityCash {
                classification: LegacyActivityCashClassification::Ambiguous,
                final_amount: Some(supplied),
                needs_review: true,
            };
        };
        let Some(expected_final) = expected_final else {
            return ClassifiedLegacyActivityCash {
                classification: LegacyActivityCashClassification::Ambiguous,
                final_amount: Some(supplied),
                needs_review: true,
            };
        };

        let matches_gross = (supplied - expected_gross).abs() <= tolerance;
        let matches_final = (supplied - expected_final).abs() <= tolerance;
        let candidates_equivalent = (expected_gross - expected_final).abs() <= tolerance;

        match (matches_gross, matches_final, candidates_equivalent) {
            (true, true, true) => ClassifiedLegacyActivityCash {
                classification: LegacyActivityCashClassification::Equivalent,
                final_amount: Some(supplied),
                needs_review: false,
            },
            (false, true, _) => ClassifiedLegacyActivityCash {
                classification: LegacyActivityCashClassification::Final,
                final_amount: Some(supplied),
                needs_review: false,
            },
            (true, false, _) => ClassifiedLegacyActivityCash {
                classification: LegacyActivityCashClassification::Gross,
                final_amount: Self::cash_effect_from_gross(
                    inputs.activity_type,
                    supplied,
                    fee,
                    tax,
                )
                .map(|amount| amount.abs()),
                needs_review: false,
            },
            _ => ClassifiedLegacyActivityCash {
                classification: LegacyActivityCashClassification::Ambiguous,
                final_amount: Some(supplied),
                needs_review: true,
            },
        }
    }

    /// Converts a provider trade amount from gross to final cash only when the
    /// supplied value unambiguously matches gross and does not match final cash.
    pub fn reconcile_imported_trade_amount(
        inputs: ActivityCashInputs<'_>,
        tolerance: Decimal,
    ) -> Option<Decimal> {
        let supplied = inputs.amount.map(|amount| amount.abs())?;
        if inputs.is_security_transfer
            || !matches!(inputs.activity_type, ACTIVITY_TYPE_BUY | ACTIVITY_TYPE_SELL)
        {
            return Some(supplied);
        }

        let fee = inputs.fee.unwrap_or(Decimal::ZERO).abs();
        let tax = inputs.tax.unwrap_or(Decimal::ZERO).abs();
        let charges = fee + tax;
        let gross = match (inputs.quantity, inputs.unit_price) {
            (Some(quantity), Some(unit_price)) => {
                quantity.abs()
                    * unit_price.abs()
                    * Self::valid_unit_multiplier(inputs.unit_multiplier)
            }
            _ => return Some(supplied),
        };
        let Some(expected_final) =
            Self::cash_effect_from_gross(inputs.activity_type, gross, fee, tax)
                .map(|amount| amount.abs())
        else {
            return Some(supplied);
        };

        let tolerance = tolerance.abs();
        let matches_gross = (supplied - gross).abs() <= tolerance;
        let matches_final = (supplied - expected_final).abs() <= tolerance;
        if matches_gross && !matches_final {
            match inputs.activity_type {
                ACTIVITY_TYPE_BUY => Some(supplied + charges),
                ACTIVITY_TYPE_SELL => Some((supplied - charges).abs()),
                _ => Some(supplied),
            }
        } else {
            Some(supplied)
        }
    }

    fn derived_cash_effect(
        inputs: ActivityCashInputs<'_>,
        fee: Decimal,
        tax: Decimal,
    ) -> Option<Decimal> {
        match inputs.activity_type {
            ACTIVITY_TYPE_BUY
            | ACTIVITY_TYPE_SELL
            | ACTIVITY_TYPE_DEPOSIT
            | ACTIVITY_TYPE_DIVIDEND
            | ACTIVITY_TYPE_INTEREST
            | ACTIVITY_TYPE_CREDIT
            | ACTIVITY_TYPE_TRANSFER_IN
            | ACTIVITY_TYPE_WITHDRAWAL
            | ACTIVITY_TYPE_TRANSFER_OUT => Self::derived_gross(inputs).and_then(|gross| {
                Self::cash_effect_from_gross(inputs.activity_type, gross, fee, tax)
            }),
            ACTIVITY_TYPE_FEE => (fee > Decimal::ZERO).then_some(-fee),
            // Historical standalone TAX rows sometimes stored the charge in
            // `fee`. Keep that legacy fallback aligned with Activity::charge_amt_for.
            ACTIVITY_TYPE_TAX => (tax > Decimal::ZERO)
                .then_some(-tax)
                .or_else(|| (fee > Decimal::ZERO).then_some(-fee)),
            _ => None,
        }
    }

    fn derived_gross(inputs: ActivityCashInputs<'_>) -> Option<Decimal> {
        let multiplier = Self::valid_unit_multiplier(inputs.unit_multiplier);
        match (inputs.quantity, inputs.unit_price) {
            (Some(quantity), Some(unit_price)) => {
                Some(quantity.abs() * unit_price.abs() * multiplier)
            }
            _ => None,
        }
    }

    fn cash_effect_from_gross(
        activity_type: &str,
        gross: Decimal,
        fee: Decimal,
        tax: Decimal,
    ) -> Option<Decimal> {
        let charges = fee.abs() + tax.abs();
        match activity_type {
            ACTIVITY_TYPE_BUY | ACTIVITY_TYPE_WITHDRAWAL | ACTIVITY_TYPE_TRANSFER_OUT => {
                Some(-(gross.abs() + charges))
            }
            ACTIVITY_TYPE_SELL
            | ACTIVITY_TYPE_DEPOSIT
            | ACTIVITY_TYPE_DIVIDEND
            | ACTIVITY_TYPE_INTEREST
            | ACTIVITY_TYPE_CREDIT
            | ACTIVITY_TYPE_TRANSFER_IN => Some(gross.abs() - charges),
            ACTIVITY_TYPE_FEE => Some(-fee.abs()),
            ACTIVITY_TYPE_TAX => Some(-tax.abs()),
            _ => None,
        }
    }

    fn type_directed_cash_effect(activity_type: &str, amount: Decimal) -> Decimal {
        match activity_type {
            ACTIVITY_TYPE_SELL
            | ACTIVITY_TYPE_DEPOSIT
            | ACTIVITY_TYPE_DIVIDEND
            | ACTIVITY_TYPE_INTEREST
            | ACTIVITY_TYPE_CREDIT
            | ACTIVITY_TYPE_TRANSFER_IN => amount.abs(),
            ACTIVITY_TYPE_BUY
            | ACTIVITY_TYPE_WITHDRAWAL
            | ACTIVITY_TYPE_FEE
            | ACTIVITY_TYPE_TAX
            | ACTIVITY_TYPE_TRANSFER_OUT => -amount.abs(),
            _ => Decimal::ZERO,
        }
    }

    fn uses_legacy_gross_compatibility(activity: &Activity) -> bool {
        activity.needs_review
            && activity
                .metadata
                .as_ref()
                .and_then(|metadata| metadata.get("migrations"))
                .and_then(|migrations| migrations.get("cash_amount_v3_8"))
                .and_then(|migration| migration.get("classification"))
                .and_then(serde_json::Value::as_str)
                == Some(LegacyActivityCashClassification::Ambiguous.as_str())
    }

    fn resolve_legacy_gross_cash_inputs(inputs: ActivityCashInputs<'_>) -> ResolvedActivityCash {
        let Some(gross) = inputs
            .amount
            .map(|amount| amount.abs())
            .filter(|amount| !amount.is_zero())
        else {
            return Self::resolve_cash_inputs(inputs);
        };
        let fee = inputs.fee.unwrap_or(Decimal::ZERO).abs();
        let tax = inputs.tax.unwrap_or(Decimal::ZERO).abs();
        let signed_cash_effect =
            Self::cash_effect_from_gross(inputs.activity_type, gross, fee, tax)
                .unwrap_or(Decimal::ZERO);
        let expected_amount =
            Self::derived_cash_effect(inputs, fee, tax).map(|amount| amount.abs());

        ResolvedActivityCash {
            amount: Some(signed_cash_effect.abs()),
            expected_amount,
            signed_cash_effect,
            gross_amount: Some(gross),
            amount_was_derived: false,
        }
    }

    pub fn compile_activity(
        activity: &Activity,
        quote: Option<&Quote>,
        transfer_boundary: TransferBoundary,
    ) -> ResolvedActivityEconomics {
        Self::compile_activity_with_unit_multiplier(
            activity,
            quote,
            transfer_boundary,
            Decimal::ONE,
        )
    }

    pub fn compile_activity_with_unit_multiplier(
        activity: &Activity,
        quote: Option<&Quote>,
        transfer_boundary: TransferBoundary,
        unit_multiplier: Decimal,
    ) -> ResolvedActivityEconomics {
        let activity_currency = normalize_currency_code(&activity.currency).to_string();
        let kind = Self::event_kind(activity, transfer_boundary);
        let is_security_transfer = Self::is_security_transfer(activity);
        let unit_multiplier = Self::valid_unit_multiplier(unit_multiplier);
        let lot_cost_basis_value = if is_security_transfer {
            Self::lot_cost_basis_value_with_unit_multiplier(activity, unit_multiplier)
        } else {
            Decimal::ZERO
        };
        let lot_cost_basis_uses_legacy_amount =
            is_security_transfer && Self::lot_cost_basis_uses_legacy_amount(activity);
        let mut diagnostics = Vec::new();

        if kind == EconomicEventKind::UnknownBoundaryTransfer {
            diagnostics.push(format!(
                "Transfer activity {} has no valid pair and is not explicitly external.",
                activity.id
            ));
        }

        if kind == EconomicEventKind::InternalSecurityTransfer {
            return ResolvedActivityEconomics {
                kind,
                lot_cost_basis_value,
                lot_cost_basis_currency: activity_currency.clone(),
                performance_flow_value: Decimal::ZERO,
                performance_flow_currency: activity_currency,
                performance_flow_source: ExternalFlowSource::Unknown,
                basis_status: if is_security_transfer {
                    Self::security_transfer_basis_status(activity)
                } else {
                    BasisStatus::NotApplicable
                },
                diagnostics,
            };
        }

        if is_security_transfer {
            if let Some(quote) = quote {
                let (normalized_price, normalized_currency) =
                    normalize_amount(quote.close, &quote.currency);
                let market_value = activity.qty() * normalized_price * unit_multiplier;
                if !market_value.is_zero() {
                    return ResolvedActivityEconomics {
                        kind,
                        lot_cost_basis_value,
                        lot_cost_basis_currency: activity_currency,
                        performance_flow_value: market_value.abs(),
                        performance_flow_currency: normalize_currency_code(normalized_currency)
                            .to_string(),
                        performance_flow_source: if kind
                            == EconomicEventKind::UnknownBoundaryTransfer
                        {
                            ExternalFlowSource::UnknownBoundaryTransfer
                        } else {
                            ExternalFlowSource::QuoteDerivedMarketValue
                        },
                        basis_status: Self::security_transfer_basis_status(activity),
                        diagnostics,
                    };
                }
            }

            if activity.effective_type() == ACTIVITY_TYPE_TRANSFER_OUT {
                diagnostics.push(format!(
                    "Security transfer-out activity {} deferred performance flow to removed lot basis because no transfer-date quote was available.",
                    activity.id
                ));
                return ResolvedActivityEconomics {
                    kind,
                    lot_cost_basis_value,
                    lot_cost_basis_currency: activity_currency.clone(),
                    performance_flow_value: Decimal::ZERO,
                    performance_flow_currency: activity_currency,
                    performance_flow_source: if kind == EconomicEventKind::UnknownBoundaryTransfer {
                        ExternalFlowSource::UnknownBoundaryTransfer
                    } else {
                        ExternalFlowSource::Unknown
                    },
                    basis_status: if lot_cost_basis_value.is_zero() {
                        BasisStatus::Unknown
                    } else {
                        BasisStatus::Complete
                    },
                    diagnostics,
                };
            }

            if !lot_cost_basis_value.is_zero() {
                if lot_cost_basis_uses_legacy_amount {
                    diagnostics.push(format!(
                        "Security transfer activity {} used legacy activity amount as cost basis and performance flow fallback because quote and unit price were unavailable.",
                        activity.id
                    ));
                } else {
                    diagnostics.push(format!(
                        "Security transfer activity {} used cost basis as performance flow fallback because no transfer-date quote was available.",
                        activity.id
                    ));
                }
                return ResolvedActivityEconomics {
                    kind,
                    lot_cost_basis_value,
                    lot_cost_basis_currency: activity_currency.clone(),
                    performance_flow_value: lot_cost_basis_value.abs(),
                    performance_flow_currency: activity_currency,
                    performance_flow_source: if kind == EconomicEventKind::UnknownBoundaryTransfer {
                        ExternalFlowSource::UnknownBoundaryTransfer
                    } else if lot_cost_basis_uses_legacy_amount {
                        ExternalFlowSource::LegacyActivityAmountFallback
                    } else {
                        ExternalFlowSource::CostBasisFallback
                    },
                    basis_status: BasisStatus::Complete,
                    diagnostics,
                };
            }

            if let Some(amount) = activity.amount.filter(|amount| !amount.is_zero()) {
                diagnostics.push(format!(
                    "Security transfer activity {} used legacy activity amount as performance flow fallback because quote and cost basis were unavailable.",
                    activity.id
                ));
                return ResolvedActivityEconomics {
                    kind,
                    lot_cost_basis_value,
                    lot_cost_basis_currency: activity_currency.clone(),
                    performance_flow_value: amount.abs(),
                    performance_flow_currency: activity_currency,
                    performance_flow_source: if kind == EconomicEventKind::UnknownBoundaryTransfer {
                        ExternalFlowSource::UnknownBoundaryTransfer
                    } else {
                        ExternalFlowSource::LegacyActivityAmountFallback
                    },
                    basis_status: BasisStatus::Unknown,
                    diagnostics,
                };
            }

            diagnostics.push(format!(
                "Security transfer activity {} has no quote, cost basis, or legacy amount for performance flow.",
                activity.id
            ));
            return ResolvedActivityEconomics {
                kind,
                lot_cost_basis_value,
                lot_cost_basis_currency: activity_currency.clone(),
                performance_flow_value: Decimal::ZERO,
                performance_flow_currency: activity_currency,
                performance_flow_source: ExternalFlowSource::UnknownBoundaryTransfer,
                basis_status: BasisStatus::Unknown,
                diagnostics,
            };
        }

        if kind == EconomicEventKind::UnknownBoundaryTransfer {
            return ResolvedActivityEconomics {
                kind,
                lot_cost_basis_value,
                lot_cost_basis_currency: activity_currency.clone(),
                performance_flow_value: Decimal::ZERO,
                performance_flow_currency: activity_currency,
                performance_flow_source: ExternalFlowSource::UnknownBoundaryTransfer,
                basis_status: BasisStatus::NotApplicable,
                diagnostics,
            };
        }

        let performance_flow_value = Self::gross_or_legacy_flow_amount(activity);
        let performance_flow_source = if performance_flow_value.is_zero() {
            ExternalFlowSource::Unknown
        } else {
            ExternalFlowSource::CashAmount
        };

        ResolvedActivityEconomics {
            kind,
            lot_cost_basis_value,
            lot_cost_basis_currency: activity_currency.clone(),
            performance_flow_value,
            performance_flow_currency: activity_currency,
            performance_flow_source,
            basis_status: BasisStatus::NotApplicable,
            diagnostics,
        }
    }

    pub fn is_security_transfer(activity: &Activity) -> bool {
        matches!(
            activity.effective_type(),
            ACTIVITY_TYPE_TRANSFER_IN | ACTIVITY_TYPE_TRANSFER_OUT
        ) && activity.asset_id.as_deref().is_some_and(|asset_id| {
            let asset_id = asset_id.trim();
            !asset_id.is_empty() && !is_cash_symbol(asset_id)
        })
    }

    pub fn lot_cost_basis_value(activity: &Activity) -> Decimal {
        Self::lot_cost_basis_value_with_unit_multiplier(activity, Decimal::ONE)
    }

    pub fn lot_cost_basis_value_with_unit_multiplier(
        activity: &Activity,
        unit_multiplier: Decimal,
    ) -> Decimal {
        let quantity = activity.qty();
        let price_basis =
            quantity * activity.price() * Self::valid_unit_multiplier(unit_multiplier);
        if !price_basis.is_zero() {
            return price_basis;
        }

        if activity.effective_type() == ACTIVITY_TYPE_TRANSFER_IN && !quantity.is_zero() {
            activity.amount.unwrap_or(Decimal::ZERO).abs()
        } else {
            Decimal::ZERO
        }
    }

    fn lot_cost_basis_uses_legacy_amount(activity: &Activity) -> bool {
        let unit_price_missing_or_zero = activity
            .unit_price
            .map(|unit_price| unit_price.is_zero())
            .unwrap_or(true);

        activity.effective_type() == ACTIVITY_TYPE_TRANSFER_IN
            && activity.quantity.is_some_and(|qty| !qty.is_zero())
            && unit_price_missing_or_zero
            && activity.amount.is_some_and(|amount| !amount.is_zero())
    }

    pub fn security_transfer_has_book_basis(activity: &Activity) -> bool {
        Self::is_security_transfer(activity)
            && activity.quantity.is_some_and(|qty| !qty.is_zero())
            && (activity.unit_price.is_some_and(|price| !price.is_zero())
                || (activity.effective_type() == ACTIVITY_TYPE_TRANSFER_IN
                    && activity.amount.is_some_and(|amount| !amount.is_zero())))
    }

    fn security_transfer_basis_status(activity: &Activity) -> BasisStatus {
        if Self::security_transfer_has_book_basis(activity) {
            BasisStatus::Complete
        } else {
            BasisStatus::Unknown
        }
    }

    fn event_kind(activity: &Activity, transfer_boundary: TransferBoundary) -> EconomicEventKind {
        match activity.effective_type() {
            ACTIVITY_TYPE_DEPOSIT | ACTIVITY_TYPE_WITHDRAWAL => EconomicEventKind::CashFlow,
            ACTIVITY_TYPE_CREDIT
                if activity.subtype.as_deref().is_some_and(|subtype| {
                    subtype.eq_ignore_ascii_case(ACTIVITY_SUBTYPE_BONUS)
                }) =>
            {
                EconomicEventKind::CashFlow
            }
            ACTIVITY_TYPE_BUY | ACTIVITY_TYPE_SELL => EconomicEventKind::Trade,
            ACTIVITY_TYPE_DIVIDEND | ACTIVITY_TYPE_INTEREST | ACTIVITY_TYPE_CREDIT => {
                EconomicEventKind::Income
            }
            ACTIVITY_TYPE_FEE => EconomicEventKind::Fee,
            ACTIVITY_TYPE_TAX => EconomicEventKind::Tax,
            ACTIVITY_TYPE_TRANSFER_IN | ACTIVITY_TYPE_TRANSFER_OUT => {
                Self::transfer_event_kind(activity, transfer_boundary)
            }
            _ => EconomicEventKind::Other,
        }
    }

    fn transfer_event_kind(
        activity: &Activity,
        transfer_boundary: TransferBoundary,
    ) -> EconomicEventKind {
        match transfer_boundary {
            TransferBoundary::Internal => EconomicEventKind::InternalSecurityTransfer,
            TransferBoundary::Unknown => EconomicEventKind::UnknownBoundaryTransfer,
            TransferBoundary::External => match activity.effective_type() {
                ACTIVITY_TYPE_TRANSFER_IN if Self::is_security_transfer(activity) => {
                    EconomicEventKind::ExternalSecurityDeliveryIn
                }
                ACTIVITY_TYPE_TRANSFER_OUT if Self::is_security_transfer(activity) => {
                    EconomicEventKind::ExternalSecurityDeliveryOut
                }
                _ => EconomicEventKind::CashFlow,
            },
        }
    }

    fn gross_or_legacy_flow_amount(activity: &Activity) -> Decimal {
        Self::resolve_cash(activity, Decimal::ONE)
            .gross_amount
            .or(activity.amount.map(|amount| amount.abs()))
            .unwrap_or(Decimal::ZERO)
    }

    fn valid_unit_multiplier(unit_multiplier: Decimal) -> Decimal {
        if unit_multiplier > Decimal::ZERO {
            unit_multiplier
        } else {
            Decimal::ONE
        }
    }
}

#[cfg(test)]
mod cash_tests {
    use super::*;
    use crate::assets::InstrumentType;
    use rust_decimal_macros::dec;

    fn inputs(activity_type: &'static str) -> ActivityCashInputs<'static> {
        ActivityCashInputs {
            activity_type,
            is_security_transfer: false,
            quantity: Some(dec!(2)),
            unit_price: Some(dec!(10)),
            amount: None,
            fee: Some(dec!(1)),
            tax: Some(dec!(2)),
            unit_multiplier: Decimal::ONE,
        }
    }

    #[test]
    fn bond_multiplier_is_scoped_to_activity_cash() {
        let bond = Asset {
            instrument_type: Some(InstrumentType::Bond),
            ..Default::default()
        };

        assert_eq!(bond.contract_multiplier(), Decimal::ONE);
        assert_eq!(
            ActivityEconomicsResolver::asset_unit_multiplier(&bond),
            dec!(0.01)
        );

        let configured_bond = Asset {
            instrument_type: Some(InstrumentType::Bond),
            metadata: Some(serde_json::json!({ "contractMultiplier": "0.02" })),
            ..Default::default()
        };
        assert_eq!(
            ActivityEconomicsResolver::asset_unit_multiplier(&configured_bond),
            dec!(0.02)
        );
    }

    #[test]
    fn supplied_trade_amount_is_authoritative_and_type_controls_direction() {
        let mut buy = inputs(ACTIVITY_TYPE_BUY);
        buy.amount = Some(dec!(-12));
        let buy = ActivityEconomicsResolver::resolve_cash_inputs(buy);
        assert_eq!(buy.amount, Some(dec!(12)));
        assert_eq!(buy.expected_amount, Some(dec!(23)));
        assert_eq!(buy.signed_cash_effect, dec!(-12));
        assert_eq!(buy.gross_amount, Some(dec!(9)));
        assert!(!buy.amount_was_derived);

        let mut sell = inputs(ACTIVITY_TYPE_SELL);
        sell.amount = Some(dec!(-12));
        let sell = ActivityEconomicsResolver::resolve_cash_inputs(sell);
        assert_eq!(sell.signed_cash_effect, dec!(12));
        assert_eq!(sell.gross_amount, Some(dec!(15)));
    }

    #[test]
    fn imported_trade_reconciliation_changes_only_unambiguous_gross_amounts() {
        let mut gross_buy = inputs(ACTIVITY_TYPE_BUY);
        gross_buy.amount = Some(dec!(20));
        assert_eq!(
            ActivityEconomicsResolver::reconcile_imported_trade_amount(gross_buy, dec!(0.01)),
            Some(dec!(23))
        );

        let mut final_sell = inputs(ACTIVITY_TYPE_SELL);
        final_sell.amount = Some(dec!(17.004));
        assert_eq!(
            ActivityEconomicsResolver::reconcile_imported_trade_amount(final_sell, dec!(0.01)),
            Some(dec!(17.004))
        );

        let mut sub_tolerance_fee = inputs(ACTIVITY_TYPE_BUY);
        sub_tolerance_fee.amount = Some(dec!(20));
        sub_tolerance_fee.fee = Some(dec!(0.005));
        sub_tolerance_fee.tax = None;
        assert_eq!(
            ActivityEconomicsResolver::reconcile_imported_trade_amount(
                sub_tolerance_fee,
                dec!(0.01)
            ),
            Some(dec!(20))
        );

        let mut adjusted_drip = inputs(ACTIVITY_TYPE_BUY);
        adjusted_drip.quantity = Some(dec!(0.001));
        adjusted_drip.unit_price = Some(dec!(589.8108));
        adjusted_drip.amount = Some(dec!(0.30));
        adjusted_drip.fee = None;
        adjusted_drip.tax = None;
        assert_eq!(
            ActivityEconomicsResolver::reconcile_imported_trade_amount(adjusted_drip, dec!(0.01)),
            Some(dec!(0.30))
        );
    }

    #[test]
    fn missing_trade_amount_is_derived_with_multiplier_and_charges() {
        let mut buy = inputs(ACTIVITY_TYPE_BUY);
        buy.unit_multiplier = dec!(100);
        let buy = ActivityEconomicsResolver::resolve_cash_inputs(buy);
        assert_eq!(buy.amount, Some(dec!(2003)));
        assert_eq!(buy.signed_cash_effect, dec!(-2003));
        assert_eq!(buy.gross_amount, Some(dec!(2000)));
        assert!(buy.amount_was_derived);

        let sell = ActivityEconomicsResolver::resolve_cash_inputs(inputs(ACTIVITY_TYPE_SELL));
        assert_eq!(sell.amount, Some(dec!(17)));
        assert_eq!(sell.signed_cash_effect, dec!(17));
        assert_eq!(sell.gross_amount, Some(dec!(20)));
    }

    #[test]
    fn missing_and_zero_amounts_share_the_supported_derivation_contract() {
        let cases = [
            (ACTIVITY_TYPE_BUY, dec!(23), dec!(-23), dec!(20)),
            (ACTIVITY_TYPE_SELL, dec!(17), dec!(17), dec!(20)),
            (ACTIVITY_TYPE_DEPOSIT, dec!(17), dec!(17), dec!(20)),
            (ACTIVITY_TYPE_DIVIDEND, dec!(17), dec!(17), dec!(20)),
            (ACTIVITY_TYPE_INTEREST, dec!(17), dec!(17), dec!(20)),
            (ACTIVITY_TYPE_CREDIT, dec!(17), dec!(17), dec!(20)),
            (ACTIVITY_TYPE_TRANSFER_IN, dec!(17), dec!(17), dec!(20)),
            (ACTIVITY_TYPE_WITHDRAWAL, dec!(23), dec!(-23), dec!(20)),
            (ACTIVITY_TYPE_TRANSFER_OUT, dec!(23), dec!(-23), dec!(20)),
            (ACTIVITY_TYPE_FEE, dec!(1), dec!(-1), dec!(1)),
            (ACTIVITY_TYPE_TAX, dec!(2), dec!(-2), dec!(2)),
        ];

        for (activity_type, amount, signed_cash, gross_amount) in cases {
            for supplied_amount in [None, Some(Decimal::ZERO)] {
                let mut case = inputs(activity_type);
                case.amount = supplied_amount;
                let resolved = ActivityEconomicsResolver::resolve_cash_inputs(case);

                assert_eq!(resolved.amount, Some(amount), "{activity_type}");
                assert_eq!(resolved.signed_cash_effect, signed_cash, "{activity_type}");
                assert_eq!(resolved.gross_amount, Some(gross_amount), "{activity_type}");
                assert!(resolved.amount_was_derived, "{activity_type}");
            }
        }
    }

    #[test]
    fn external_cash_flow_separates_final_cash_from_signed_gross() {
        let mut deposit = inputs(ACTIVITY_TYPE_DEPOSIT);
        deposit.quantity = None;
        deposit.unit_price = None;
        deposit.amount = Some(dec!(97));
        let deposit = ActivityEconomicsResolver::resolve_cash_inputs(deposit);
        assert_eq!(deposit.signed_cash_effect, dec!(97));
        assert_eq!(deposit.gross_amount, Some(dec!(100)));
        assert_eq!(deposit.signed_gross_effect(), dec!(100));

        let mut withdrawal = inputs(ACTIVITY_TYPE_WITHDRAWAL);
        withdrawal.quantity = None;
        withdrawal.unit_price = None;
        withdrawal.amount = Some(dec!(103));
        let withdrawal = ActivityEconomicsResolver::resolve_cash_inputs(withdrawal);
        assert_eq!(withdrawal.signed_cash_effect, dec!(-103));
        assert_eq!(withdrawal.gross_amount, Some(dec!(100)));
        assert_eq!(withdrawal.signed_gross_effect(), dec!(-100));
    }

    #[test]
    fn final_amount_and_gross_contract_matrix() {
        let cases = [
            (ACTIVITY_TYPE_BUY, dec!(23), dec!(-23), dec!(20)),
            (ACTIVITY_TYPE_SELL, dec!(17), dec!(17), dec!(20)),
            (ACTIVITY_TYPE_DEPOSIT, dec!(17), dec!(17), dec!(20)),
            (ACTIVITY_TYPE_DIVIDEND, dec!(17), dec!(17), dec!(20)),
            (ACTIVITY_TYPE_INTEREST, dec!(17), dec!(17), dec!(20)),
            (ACTIVITY_TYPE_CREDIT, dec!(17), dec!(17), dec!(20)),
            (ACTIVITY_TYPE_TRANSFER_IN, dec!(17), dec!(17), dec!(20)),
            (ACTIVITY_TYPE_WITHDRAWAL, dec!(23), dec!(-23), dec!(20)),
            (ACTIVITY_TYPE_TRANSFER_OUT, dec!(23), dec!(-23), dec!(20)),
            (ACTIVITY_TYPE_FEE, dec!(3), dec!(-3), dec!(3)),
            (ACTIVITY_TYPE_TAX, dec!(3), dec!(-3), dec!(3)),
        ];

        for (activity_type, final_amount, signed_cash, gross_amount) in cases {
            let mut case = inputs(activity_type);
            case.amount = Some(final_amount);
            let resolved = ActivityEconomicsResolver::resolve_cash_inputs(case);

            assert_eq!(resolved.amount, Some(final_amount), "{activity_type}");
            assert_eq!(resolved.signed_cash_effect, signed_cash, "{activity_type}");
            assert_eq!(resolved.gross_amount, Some(gross_amount), "{activity_type}");
        }
    }

    #[test]
    fn standalone_charges_and_security_transfers_follow_cash_contract() {
        let mut fee = inputs(ACTIVITY_TYPE_FEE);
        fee.amount = None;
        assert_eq!(
            ActivityEconomicsResolver::resolve_cash_inputs(fee).signed_cash_effect,
            dec!(-1)
        );

        let mut tax = inputs(ACTIVITY_TYPE_TAX);
        tax.amount = None;
        assert_eq!(
            ActivityEconomicsResolver::resolve_cash_inputs(tax).signed_cash_effect,
            dec!(-2)
        );

        let mut legacy_tax = inputs(ACTIVITY_TYPE_TAX);
        legacy_tax.amount = None;
        legacy_tax.tax = None;
        assert_eq!(
            ActivityEconomicsResolver::resolve_cash_inputs(legacy_tax).signed_cash_effect,
            dec!(-1)
        );

        let mut transfer = inputs(ACTIVITY_TYPE_TRANSFER_IN);
        transfer.amount = Some(dec!(25));
        transfer.is_security_transfer = true;
        let transfer = ActivityEconomicsResolver::resolve_cash_inputs(transfer);
        assert_eq!(transfer.amount, None);
        assert_eq!(transfer.gross_amount, None);
        assert_eq!(transfer.signed_cash_effect, dec!(-1));
    }

    #[test]
    fn reported_fractional_drip_buy_trusts_cash_amount_and_preserves_trade_details() {
        let resolved = ActivityEconomicsResolver::resolve_cash_inputs(ActivityCashInputs {
            activity_type: ACTIVITY_TYPE_BUY,
            is_security_transfer: false,
            quantity: Some(dec!(0.001)),
            unit_price: Some(dec!(589.8108)),
            amount: Some(dec!(-0.30)),
            fee: None,
            tax: None,
            unit_multiplier: Decimal::ONE,
        });

        assert_eq!(resolved.amount, Some(dec!(0.30)));
        assert_eq!(resolved.signed_cash_effect, dec!(-0.30));
        assert_eq!(resolved.expected_amount, Some(dec!(0.5898108)));
        assert_eq!(resolved.gross_amount, Some(dec!(0.30)));
        assert!(!resolved.amount_was_derived);
    }

    #[test]
    fn sell_charges_exceeding_proceeds_keep_a_magnitude_but_reverse_cash_direction() {
        let mut sell = inputs(ACTIVITY_TYPE_SELL);
        sell.quantity = Some(dec!(1));
        sell.unit_price = Some(dec!(1));
        sell.fee = Some(dec!(2));
        sell.tax = None;

        let derived = ActivityEconomicsResolver::resolve_cash_inputs(sell);
        assert_eq!(derived.amount, Some(dec!(1)));
        assert_eq!(derived.signed_cash_effect, dec!(-1));
        assert_eq!(derived.gross_amount, Some(dec!(1)));

        sell.amount = Some(dec!(0.75));
        let custom = ActivityEconomicsResolver::resolve_cash_inputs(sell);
        assert_eq!(custom.amount, Some(dec!(0.75)));
        assert_eq!(custom.signed_cash_effect, dec!(-0.75));
    }

    #[test]
    fn legacy_cash_classification_distinguishes_final_gross_and_ambiguous_values() {
        let mut case = inputs(ACTIVITY_TYPE_BUY);

        case.amount = Some(dec!(23));
        let final_value = ActivityEconomicsResolver::classify_legacy_cash_inputs(case, dec!(0.01));
        assert_eq!(
            final_value.classification,
            LegacyActivityCashClassification::Final
        );
        assert_eq!(final_value.final_amount, Some(dec!(23)));
        assert!(!final_value.needs_review);

        case.amount = Some(dec!(20));
        let gross = ActivityEconomicsResolver::classify_legacy_cash_inputs(case, dec!(0.01));
        assert_eq!(
            gross.classification,
            LegacyActivityCashClassification::Gross
        );
        assert_eq!(gross.final_amount, Some(dec!(23)));
        assert!(!gross.needs_review);

        case.amount = Some(dec!(40));
        let ambiguous = ActivityEconomicsResolver::classify_legacy_cash_inputs(case, dec!(0.01));
        assert_eq!(
            ambiguous.classification,
            LegacyActivityCashClassification::Ambiguous
        );
        assert_eq!(ambiguous.final_amount, Some(dec!(40)));
        assert!(ambiguous.needs_review);

        case.amount = None;
        let derived = ActivityEconomicsResolver::classify_legacy_cash_inputs(case, dec!(0.01));
        assert_eq!(
            derived.classification,
            LegacyActivityCashClassification::Derived
        );
        assert_eq!(derived.final_amount, Some(dec!(23)));
    }
}
