use async_trait::async_trait;
use chrono::Utc;
use rust_decimal::prelude::ToPrimitive;
use rust_decimal::Decimal;
use sha2::{Digest, Sha256};
use std::collections::{HashMap, HashSet, VecDeque};
use std::str::FromStr;
use std::sync::Arc;

use crate::assets::{Asset, AssetServiceTrait};
use crate::errors::{DatabaseError, Error as CoreError, Result as CoreResult, ValidationError};
use crate::fx::{
    denormalization_multiplier, normalize_currency_code, ExchangeRate, FxServiceTrait,
};
use crate::portfolio::holdings::{Holding, HoldingType, HoldingsServiceTrait};
use crate::quotes::{LatestQuoteSnapshot, QuoteServiceTrait};
use crate::taxonomies::{AssetTaxonomyAssignment, TaxonomyServiceTrait};

use super::drift_service::DriftServiceTrait;
use super::model::{
    AllocationTargetConstraint, AllocationWorksheetLineInput, AllocationWorksheetLineResult,
    AllocationWorksheetResult, CalculateAllocationWorksheetInput, ConstraintAction,
    ConstraintEffect, ConstraintSubjectType, WorksheetCategoryExposure, WorksheetCategoryResult,
    WorksheetDirection, WorksheetInputMode, WorksheetPricingSource, WorksheetSourceRecord,
    WorksheetWarning, WorksheetWarningKind,
};
use super::target_service::AllocationTargetServiceTrait;

const UNKNOWN_CATEGORY_ID: &str = "__UNKNOWN__";
const UNKNOWN_CATEGORY_NAME: &str = "Unclassified exposure";

#[async_trait]
pub trait AllocationWorksheetServiceTrait: Send + Sync {
    async fn calculate_worksheet(
        &self,
        input: CalculateAllocationWorksheetInput,
    ) -> CoreResult<AllocationWorksheetResult>;
}

pub struct AllocationWorksheetService {
    allocation_target_service: Arc<dyn AllocationTargetServiceTrait>,
    drift_service: Arc<dyn DriftServiceTrait>,
    holdings_service: Arc<dyn HoldingsServiceTrait>,
    asset_service: Arc<dyn AssetServiceTrait>,
    taxonomy_service: Arc<dyn TaxonomyServiceTrait>,
    quote_service: Arc<dyn QuoteServiceTrait>,
    fx_service: Arc<dyn FxServiceTrait>,
}

impl AllocationWorksheetService {
    #[allow(clippy::too_many_arguments)]
    pub fn new(
        allocation_target_service: Arc<dyn AllocationTargetServiceTrait>,
        drift_service: Arc<dyn DriftServiceTrait>,
        holdings_service: Arc<dyn HoldingsServiceTrait>,
        asset_service: Arc<dyn AssetServiceTrait>,
        taxonomy_service: Arc<dyn TaxonomyServiceTrait>,
        quote_service: Arc<dyn QuoteServiceTrait>,
        fx_service: Arc<dyn FxServiceTrait>,
    ) -> Self {
        Self {
            allocation_target_service,
            drift_service,
            holdings_service,
            asset_service,
            taxonomy_service,
            quote_service,
            fx_service,
        }
    }

    fn invalid(message: impl Into<String>) -> CoreError {
        CoreError::Validation(ValidationError::InvalidInput(message.into()))
    }

    fn line_invalid(line_id: &str, message: impl AsRef<str>) -> CoreError {
        Self::invalid(format!("Worksheet line {line_id}: {}", message.as_ref()))
    }

    fn asset_key(holding: &Holding) -> String {
        holding
            .instrument
            .as_ref()
            .map(|instrument| instrument.id.clone())
            .unwrap_or_else(|| holding.id.clone())
    }

    fn action_matches(direction: &WorksheetDirection, action: &ConstraintAction) -> bool {
        matches!(action, ConstraintAction::Trade)
            || matches!(
                (direction, action),
                (WorksheetDirection::Increase, ConstraintAction::Buy)
                    | (WorksheetDirection::Reduce, ConstraintAction::Sell)
            )
    }

    fn constraint_matches(
        constraint: &AllocationTargetConstraint,
        line: &AllocationWorksheetLineInput,
        exposures: &[WorksheetCategoryExposure],
    ) -> bool {
        if !Self::action_matches(&line.direction, &constraint.action) {
            return false;
        }
        match constraint.subject_type {
            ConstraintSubjectType::Asset => constraint.subject_id == line.asset_id,
            ConstraintSubjectType::Account => constraint.subject_id == line.account_id,
            ConstraintSubjectType::Category => exposures
                .iter()
                .any(|exposure| exposure.category_id == constraint.subject_id),
        }
    }

    fn warning(
        kind: WorksheetWarningKind,
        line_id: Option<&str>,
        suffix: &str,
        message: String,
    ) -> WorksheetWarning {
        let kind_key = format!("{kind:?}").to_ascii_lowercase();
        WorksheetWarning {
            id: format!("{}:{}:{}", kind_key, line_id.unwrap_or("worksheet"), suffix),
            kind,
            line_id: line_id.map(str::to_string),
            message,
            acknowledgement_required: true,
        }
    }

    fn resolve_fx_source(
        from_currency: &str,
        to_currency: &str,
        rates: &[ExchangeRate],
    ) -> CoreResult<(Decimal, Option<WorksheetPricingSource>, Vec<ExchangeRate>)> {
        let normalized_from = normalize_currency_code(from_currency).to_ascii_uppercase();
        let normalized_to = normalize_currency_code(to_currency).to_ascii_uppercase();
        let source_multiplier = if normalized_from.eq_ignore_ascii_case(from_currency) {
            Decimal::ONE
        } else {
            Decimal::ONE / denormalization_multiplier(from_currency)
        };
        let target_multiplier = denormalization_multiplier(to_currency);
        if normalized_from == normalized_to {
            return Ok((source_multiplier * target_multiplier, None, Vec::new()));
        }

        let mut adjacency = HashMap::<String, Vec<(String, Decimal, usize)>>::new();
        for (index, rate) in rates.iter().enumerate() {
            if rate.rate <= Decimal::ZERO {
                continue;
            }
            let from = normalize_currency_code(&rate.from_currency).to_ascii_uppercase();
            let to = normalize_currency_code(&rate.to_currency).to_ascii_uppercase();
            if from == to {
                continue;
            }
            adjacency
                .entry(from.clone())
                .or_default()
                .push((to.clone(), rate.rate, index));
            adjacency
                .entry(to)
                .or_default()
                .push((from, Decimal::ONE / rate.rate, index));
        }
        for edges in adjacency.values_mut() {
            edges.sort_by(|left, right| {
                left.0
                    .cmp(&right.0)
                    .then_with(|| rates[left.2].id.cmp(&rates[right.2].id))
            });
        }

        let mut queue = VecDeque::from([(normalized_from.clone(), Decimal::ONE, Vec::new())]);
        let mut visited = HashSet::from([normalized_from.clone()]);
        let mut resolved = None;
        while let Some((currency, accumulated_rate, path)) = queue.pop_front() {
            if currency == normalized_to {
                resolved = Some((accumulated_rate, path));
                break;
            }
            for (next_currency, edge_rate, rate_index) in
                adjacency.get(&currency).into_iter().flatten()
            {
                if visited.insert(next_currency.clone()) {
                    let mut next_path = path.clone();
                    next_path.push(*rate_index);
                    queue.push_back((
                        next_currency.clone(),
                        accumulated_rate * *edge_rate,
                        next_path,
                    ));
                }
            }
        }

        let (path_rate, path) = resolved.ok_or_else(|| {
            Self::invalid(format!(
                "No attributable FX rate is available for {from_currency}/{to_currency}"
            ))
        })?;
        let used_rates = path
            .into_iter()
            .map(|index| rates[index].clone())
            .collect::<Vec<_>>();
        let applied_rate = source_multiplier * path_rate * target_multiplier;
        let oldest_timestamp = used_rates
            .iter()
            .map(|rate| rate.timestamp)
            .min()
            .ok_or_else(|| Self::invalid("Resolved FX conversion has no source records"))?;
        let is_stale = used_rates
            .iter()
            .any(|rate| rate.timestamp.date_naive() < Utc::now().date_naive());
        let source_id = used_rates
            .iter()
            .map(|rate| rate.id.as_str())
            .collect::<Vec<_>>()
            .join(">");
        Ok((
            applied_rate,
            Some(WorksheetPricingSource {
                id: source_id,
                source_type: if used_rates.len() == 1 {
                    "fx_rate".to_string()
                } else {
                    "fx_path".to_string()
                },
                value: applied_rate,
                from_currency: from_currency.to_string(),
                to_currency: to_currency.to_string(),
                timestamp: oldest_timestamp.to_rfc3339(),
                is_stale,
            }),
            used_rates,
        ))
    }

    fn resolved_quantity_and_amount(
        line: &AllocationWorksheetLineInput,
        unit_price: Decimal,
        whole_shares_only: bool,
    ) -> CoreResult<(Decimal, Decimal)> {
        if line.value <= Decimal::ZERO {
            return Err(Self::line_invalid(&line.line_id, "value must be positive"));
        }
        if unit_price <= Decimal::ZERO {
            return Err(Self::line_invalid(
                &line.line_id,
                "resolved unit price must be positive",
            ));
        }

        match line.input_mode {
            WorksheetInputMode::Amount => {
                let quantity = if whole_shares_only {
                    (line.value / unit_price).floor()
                } else {
                    line.value / unit_price
                };
                if quantity <= Decimal::ZERO {
                    return Err(Self::line_invalid(
                        &line.line_id,
                        "amount is below one whole unit at the resolved price",
                    ));
                }
                Ok((quantity, quantity * unit_price))
            }
            WorksheetInputMode::Quantity => {
                if whole_shares_only && !line.value.fract().is_zero() {
                    return Err(Self::line_invalid(
                        &line.line_id,
                        "quantity must be a whole number for this target",
                    ));
                }
                Ok((line.value, line.value * unit_price))
            }
        }
    }

    fn category_exposures(
        line: &AllocationWorksheetLineInput,
        amount: Decimal,
        assignments: &[AssetTaxonomyAssignment],
        category_names: &HashMap<String, String>,
    ) -> CoreResult<Vec<WorksheetCategoryExposure>> {
        let total_bps: i32 = assignments.iter().map(|assignment| assignment.weight).sum();
        if total_bps > 10_000 {
            let total_percent = Decimal::from(total_bps) / Decimal::from(100);
            return Err(Self::line_invalid(
                &line.line_id,
                format!(
                    "classification weights total {total_percent}% and cannot exceed 100%; edit the security classification before calculating"
                ),
            ));
        }
        let sign = match line.direction {
            WorksheetDirection::Increase => Decimal::ONE,
            WorksheetDirection::Reduce => -Decimal::ONE,
        };
        let mut exposures = assignments
            .iter()
            .map(|assignment| WorksheetCategoryExposure {
                category_id: assignment.category_id.clone(),
                category_name: category_names
                    .get(&assignment.category_id)
                    .cloned()
                    .unwrap_or_else(|| assignment.category_id.clone()),
                weight_bps: assignment.weight,
                value_delta: sign * amount * Decimal::from(assignment.weight)
                    / Decimal::from(10_000),
                is_unclassified: false,
            })
            .collect::<Vec<_>>();
        if total_bps < 10_000 {
            let residual = 10_000 - total_bps;
            exposures.push(WorksheetCategoryExposure {
                category_id: UNKNOWN_CATEGORY_ID.to_string(),
                category_name: UNKNOWN_CATEGORY_NAME.to_string(),
                weight_bps: residual,
                value_delta: sign * amount * Decimal::from(residual) / Decimal::from(10_000),
                is_unclassified: true,
            });
        }
        Ok(exposures)
    }

    fn bps(value: Decimal, total: Decimal) -> i32 {
        if total <= Decimal::ZERO {
            return 0;
        }
        (value / total * Decimal::from(10_000))
            .round()
            .to_i32()
            .unwrap_or(0)
    }

    fn cash_remaining(
        tracked_cash: Decimal,
        external_contribution: Decimal,
        increase_total: Decimal,
        reduction_total: Decimal,
    ) -> CoreResult<Decimal> {
        let funding = tracked_cash + external_contribution + reduction_total;
        if increase_total > funding {
            let required = increase_total.normalize();
            let available = funding.normalize();
            return Err(Self::invalid(format!(
                "Worksheet increases ({required}) exceed selected cash and reduction proceeds ({available})"
            )));
        }
        Ok(funding - increase_total)
    }

    fn projected_total(
        current_total: Decimal,
        external_contribution: Decimal,
        increase_total: Decimal,
        reduction_total: Decimal,
        includes_cash_category: bool,
    ) -> Decimal {
        if includes_cash_category {
            current_total + external_contribution
        } else {
            current_total + increase_total - reduction_total
        }
    }

    fn source_fingerprint(
        input: &CalculateAllocationWorksheetInput,
        source_records: &[WorksheetSourceRecord],
    ) -> String {
        let source = serde_json::to_vec(&(input, source_records))
            .expect("worksheet fingerprint inputs are serializable");
        hex::encode(Sha256::digest(source))
    }

    fn quote_for_line<'a>(
        line: &AllocationWorksheetLineInput,
        snapshots: &'a HashMap<String, LatestQuoteSnapshot>,
    ) -> CoreResult<(&'a LatestQuoteSnapshot, &'a crate::quotes::Quote)> {
        let snapshot = snapshots.get(&line.asset_id).ok_or_else(|| {
            Self::line_invalid(
                &line.line_id,
                "no quote snapshot is available; refresh the price",
            )
        })?;
        let quote = snapshot.quote.as_ref().ok_or_else(|| {
            let detail = snapshot
                .no_quote_reason
                .as_ref()
                .map(|reason| reason.message.as_str())
                .unwrap_or("refresh or add a manual price");
            Self::line_invalid(&line.line_id, format!("no quote is available; {detail}"))
        })?;
        if quote.close <= Decimal::ZERO {
            return Err(Self::line_invalid(
                &line.line_id,
                "quote must be positive; refresh or correct the price",
            ));
        }
        Ok((snapshot, quote))
    }
}

#[async_trait]
impl AllocationWorksheetServiceTrait for AllocationWorksheetService {
    async fn calculate_worksheet(
        &self,
        input: CalculateAllocationWorksheetInput,
    ) -> CoreResult<AllocationWorksheetResult> {
        if input.lines.is_empty() || input.lines.len() > 50 {
            return Err(Self::invalid(
                "Worksheet must contain between 1 and 50 lines",
            ));
        }
        if input.cash.tracked_cash_to_use < Decimal::ZERO
            || input.cash.external_contribution < Decimal::ZERO
        {
            return Err(Self::invalid("Worksheet cash values must be non-negative"));
        }
        let mut line_ids = HashSet::new();
        for line in &input.lines {
            if line.line_id.trim().is_empty() || !line_ids.insert(line.line_id.as_str()) {
                return Err(Self::invalid(
                    "Every worksheet line must have a unique lineId",
                ));
            }
            if !input.account_ids.contains(&line.account_id) {
                return Err(Self::line_invalid(
                    &line.line_id,
                    "selected account is outside the resolved scope",
                ));
            }
        }

        let target = self
            .allocation_target_service
            .get_target(&input.target_id)?
            .ok_or_else(|| {
                CoreError::Database(DatabaseError::NotFound(format!(
                    "AllocationTarget {} not found",
                    input.target_id
                )))
            })?;
        if !target.allow_sells
            && input
                .lines
                .iter()
                .any(|line| matches!(line.direction, WorksheetDirection::Reduce))
        {
            return Err(Self::invalid(
                "This target disables reductions; enable reduction rows in worksheet guardrails",
            ));
        }

        let drift = self
            .drift_service
            .get_drift_report_for_target(
                &input.target_id,
                &input.account_ids,
                &input.base_currency,
                &input.aggregated_account_id,
            )
            .await?;
        if input.cash.tracked_cash_to_use > drift.deployable_cash {
            return Err(Self::invalid(format!(
                "Tracked cash selected ({}) exceeds observed deployable cash ({})",
                input.cash.tracked_cash_to_use, drift.deployable_cash
            )));
        }

        let asset_ids = input
            .lines
            .iter()
            .map(|line| line.asset_id.clone())
            .collect::<HashSet<_>>()
            .into_iter()
            .collect::<Vec<_>>();
        let assets = self
            .asset_service
            .get_assets_by_asset_ids(&asset_ids)
            .await?;
        let assets_by_id = assets
            .into_iter()
            .map(|asset| (asset.id.clone(), asset))
            .collect::<HashMap<_, _>>();
        let quote_snapshots = self.quote_service.get_latest_quotes_snapshot(&asset_ids)?;
        let assignments = self
            .taxonomy_service
            .get_asset_assignments_for_assets(&asset_ids)?;
        let assignments_by_asset = assignments
            .iter()
            .filter(|assignment| assignment.taxonomy_id == target.taxonomy_id)
            .cloned()
            .fold(HashMap::<String, Vec<_>>::new(), |mut map, assignment| {
                map.entry(assignment.asset_id.clone())
                    .or_default()
                    .push(assignment);
                map
            });
        let taxonomy = self
            .taxonomy_service
            .get_taxonomy(&target.taxonomy_id)?
            .ok_or_else(|| Self::invalid("Target taxonomy no longer exists"))?;
        let category_names = taxonomy
            .categories
            .iter()
            .map(|category| (category.id.clone(), category.name.clone()))
            .collect::<HashMap<_, _>>();
        let mut category_order = taxonomy.categories.clone();
        category_order.sort_by_key(|category| category.sort_order);
        let fx_rates = self.fx_service.get_latest_exchange_rates()?;
        let constraints = self
            .allocation_target_service
            .list_target_constraints(&input.target_id)?;

        let mut holdings_by_account = HashMap::<String, Vec<Holding>>::new();
        for account_id in &input.account_ids {
            holdings_by_account.insert(
                account_id.to_string(),
                self.holdings_service
                    .get_holdings(account_id, &input.base_currency)
                    .await?,
            );
        }

        let mut warnings = Vec::new();
        if input.cash.external_contribution > Decimal::ZERO {
            warnings.push(Self::warning(
                WorksheetWarningKind::ExternalContribution,
                None,
                "external-cash",
                format!(
                    "Includes {} of hypothetical cash not currently recorded.",
                    input.cash.external_contribution
                ),
            ));
        }

        let min_line_amount = Decimal::from_str(&target.min_trade_amount)
            .unwrap_or(Decimal::ZERO)
            .max(Decimal::ZERO);
        let mut results = Vec::with_capacity(input.lines.len());
        let mut reduction_qty_by_position = HashMap::<(String, String), Decimal>::new();
        let mut used_fx_rates = HashMap::<String, ExchangeRate>::new();

        for line in &input.lines {
            let asset: &Asset = assets_by_id.get(&line.asset_id).ok_or_else(|| {
                Self::line_invalid(&line.line_id, "selected tracked security no longer exists")
            })?;
            if !asset.is_active || !asset.kind.is_investment() {
                return Err(Self::line_invalid(
                    &line.line_id,
                    "selected asset is not an active tracked investment security",
                ));
            }
            let (snapshot, quote) = Self::quote_for_line(line, &quote_snapshots)?;
            let (fx_rate, fx_source, line_fx_rates) = Self::resolve_fx_source(
                quote.currency.as_str(),
                input.base_currency.as_str(),
                &fx_rates,
            )?;
            for rate in line_fx_rates {
                used_fx_rates.insert(rate.id.clone(), rate);
            }
            let multiplier = asset.contract_multiplier();
            let unit_price = quote.close * fx_rate * multiplier;
            let (quantity, amount) =
                Self::resolved_quantity_and_amount(line, unit_price, target.whole_shares_only)?;
            let line_assignments = assignments_by_asset
                .get(&line.asset_id)
                .map(Vec::as_slice)
                .unwrap_or(&[]);
            let exposures =
                Self::category_exposures(line, amount, line_assignments, &category_names)?;

            if matches!(line.direction, WorksheetDirection::Reduce) {
                let owned = holdings_by_account
                    .get(&line.account_id)
                    .into_iter()
                    .flatten()
                    .filter(|holding| {
                        holding.holding_type != HoldingType::Cash
                            && Self::asset_key(holding) == line.asset_id
                    })
                    .map(|holding| holding.quantity)
                    .sum::<Decimal>();
                let key = (line.account_id.clone(), line.asset_id.clone());
                let reduced = reduction_qty_by_position.entry(key).or_default();
                *reduced += quantity;
                if *reduced > owned {
                    return Err(Self::line_invalid(
                        &line.line_id,
                        format!(
                            "reduction exceeds the {owned} units currently held in this account"
                        ),
                    ));
                }
            }

            for constraint in constraints
                .iter()
                .filter(|constraint| Self::constraint_matches(constraint, line, &exposures))
            {
                match constraint.effect {
                    ConstraintEffect::Block => {
                        return Err(Self::line_invalid(
                            &line.line_id,
                            format!(
                                "blocked by your worksheet constraint{}",
                                constraint
                                    .reason
                                    .as_deref()
                                    .map(|reason| format!(": {reason}"))
                                    .unwrap_or_default()
                            ),
                        ));
                    }
                    ConstraintEffect::Avoid => warnings.push(Self::warning(
                        WorksheetWarningKind::AvoidConstraint,
                        Some(&line.line_id),
                        &constraint.id,
                        format!(
                            "This line conflicts with your Avoid constraint{}.",
                            constraint
                                .reason
                                .as_deref()
                                .map(|reason| format!(" ({reason})"))
                                .unwrap_or_default()
                        ),
                    )),
                }
            }
            if snapshot.is_stale {
                warnings.push(Self::warning(
                    WorksheetWarningKind::StaleQuote,
                    Some(&line.line_id),
                    &quote.id,
                    format!(
                        "Uses a dated security price from {}.",
                        quote.timestamp.date_naive()
                    ),
                ));
            }
            if let Some(fx) = fx_source.as_ref().filter(|source| source.is_stale) {
                warnings.push(Self::warning(
                    WorksheetWarningKind::StaleFx,
                    Some(&line.line_id),
                    &fx.id,
                    format!("Uses a dated FX rate from {}.", fx.timestamp),
                ));
            }
            let classified_bps: i32 = line_assignments.iter().map(|item| item.weight).sum();
            if classified_bps == 0 {
                warnings.push(Self::warning(
                    WorksheetWarningKind::UnclassifiedAsset,
                    Some(&line.line_id),
                    &line.asset_id,
                    "The security is unclassified; its full value is shown as unclassified exposure."
                        .to_string(),
                ));
            } else if classified_bps < 10_000 {
                warnings.push(Self::warning(
                    WorksheetWarningKind::PartialClassification,
                    Some(&line.line_id),
                    &line.asset_id,
                    format!(
                        "The security is classified for {classified_bps} bps; the remaining {} bps is shown as unclassified exposure.",
                        10_000 - classified_bps
                    ),
                ));
            }
            if min_line_amount > Decimal::ZERO && amount < min_line_amount {
                warnings.push(Self::warning(
                    WorksheetWarningKind::BelowMinimumLine,
                    Some(&line.line_id),
                    "minimum-line",
                    format!(
                        "Resolved amount {amount} is below your worksheet minimum of {min_line_amount}."
                    ),
                ));
            }

            results.push(AllocationWorksheetLineResult {
                line_id: line.line_id.clone(),
                direction: line.direction.clone(),
                asset_id: line.asset_id.clone(),
                account_id: line.account_id.clone(),
                symbol: asset
                    .display_code
                    .clone()
                    .or_else(|| asset.instrument_symbol.clone())
                    .unwrap_or_else(|| asset.id.clone()),
                name: asset.name.clone().unwrap_or_default(),
                input_mode: line.input_mode.clone(),
                input_value: line.value,
                quantity,
                unit_price,
                estimated_amount: amount,
                contract_multiplier: multiplier,
                quote_source: WorksheetPricingSource {
                    id: quote.id.clone(),
                    source_type: "security_quote".to_string(),
                    value: quote.close,
                    from_currency: quote.currency.clone(),
                    to_currency: quote.currency.clone(),
                    timestamp: quote.timestamp.to_rfc3339(),
                    is_stale: snapshot.is_stale,
                },
                fx_source,
                category_exposures: exposures,
            });
        }

        let increase_total = results
            .iter()
            .filter(|line| matches!(line.direction, WorksheetDirection::Increase))
            .map(|line| line.estimated_amount)
            .sum::<Decimal>();
        let reduction_total = results
            .iter()
            .filter(|line| matches!(line.direction, WorksheetDirection::Reduce))
            .map(|line| line.estimated_amount)
            .sum::<Decimal>();
        let cash_remaining = Self::cash_remaining(
            input.cash.tracked_cash_to_use,
            input.cash.external_contribution,
            increase_total,
            reduction_total,
        )?;

        if let Some(max_turnover_bps) = target.max_turnover_bps {
            let turnover_bps = Self::bps(reduction_total, drift.total_value);
            if turnover_bps > max_turnover_bps {
                warnings.push(Self::warning(
                    WorksheetWarningKind::TurnoverExceeded,
                    None,
                    "turnover",
                    format!(
                        "Reductions equal {turnover_bps} bps of current value, above your {max_turnover_bps} bps worksheet guardrail."
                    ),
                ));
            }
        }

        let weights = self
            .allocation_target_service
            .list_weights_for_target(&input.target_id)?;
        let target_bps_by_category = weights
            .iter()
            .map(|weight| (weight.category_id.clone(), weight.target_bps))
            .collect::<HashMap<_, _>>();
        let mut current_values = drift
            .rows
            .iter()
            .map(|row| (row.category_id.clone(), row.current_value))
            .collect::<HashMap<_, _>>();
        let mut projected_values = current_values.clone();
        for line in &results {
            for exposure in &line.category_exposures {
                *projected_values
                    .entry(exposure.category_id.clone())
                    .or_default() += exposure.value_delta;
            }
        }
        let cash_category_ids = drift
            .rows
            .iter()
            .filter(|row| row.is_cash)
            .map(|row| row.category_id.clone())
            .collect::<Vec<_>>();
        let total_includes_cash = !cash_category_ids.is_empty();
        if total_includes_cash {
            let cash_delta = input.cash.external_contribution - increase_total + reduction_total;
            if let Some(category_id) = cash_category_ids.first() {
                let projected = projected_values.entry(category_id.clone()).or_default();
                *projected += cash_delta;
                if *projected < Decimal::ZERO {
                    return Err(Self::invalid(
                        "Worksheet would make the tracked cash category negative",
                    ));
                }
            }
        }
        let projected_total = Self::projected_total(
            drift.total_value,
            input.cash.external_contribution,
            increase_total,
            reduction_total,
            total_includes_cash,
        );

        let mut ordered_ids = category_order
            .iter()
            .map(|category| category.id.clone())
            .collect::<Vec<_>>();
        for category_id in current_values
            .keys()
            .chain(projected_values.keys())
            .chain(target_bps_by_category.keys())
        {
            if !ordered_ids.contains(category_id) {
                ordered_ids.push(category_id.clone());
            }
        }
        if ordered_ids.contains(&UNKNOWN_CATEGORY_ID.to_string()) {
            ordered_ids.retain(|id| id != UNKNOWN_CATEGORY_ID);
            ordered_ids.push(UNKNOWN_CATEGORY_ID.to_string());
        }
        let drift_by_id = drift
            .rows
            .iter()
            .map(|row| (row.category_id.as_str(), row))
            .collect::<HashMap<_, _>>();
        let mut categories = Vec::new();
        for category_id in ordered_ids {
            let current_value = current_values.remove(&category_id).unwrap_or_default();
            let projected_value = projected_values.remove(&category_id).unwrap_or_default();
            let target_bps = target_bps_by_category
                .get(&category_id)
                .copied()
                .unwrap_or(0);
            if current_value == Decimal::ZERO
                && projected_value == Decimal::ZERO
                && !target_bps_by_category.contains_key(&category_id)
            {
                continue;
            }
            let current_bps = Self::bps(current_value, drift.total_value);
            let projected_bps = Self::bps(projected_value, projected_total);
            let drift_row = drift_by_id.get(category_id.as_str()).copied();
            categories.push(WorksheetCategoryResult {
                category_id: category_id.clone(),
                category_name: if category_id == UNKNOWN_CATEGORY_ID {
                    UNKNOWN_CATEGORY_NAME.to_string()
                } else {
                    category_names
                        .get(&category_id)
                        .cloned()
                        .or_else(|| drift_row.map(|row| row.category_name.clone()))
                        .unwrap_or_else(|| category_id.clone())
                },
                color: drift_row
                    .map(|row| row.color.clone())
                    .unwrap_or_else(|| "#94a3b8".to_string()),
                target_bps,
                current_value,
                projected_value,
                current_bps,
                projected_bps,
                current_difference_bps: current_bps - target_bps,
                projected_difference_bps: projected_bps - target_bps,
                is_cash: drift_row.map(|row| row.is_cash).unwrap_or(false),
                is_unclassified: category_id == UNKNOWN_CATEGORY_ID,
            });
        }

        let target_ids = target_bps_by_category.keys().collect::<HashSet<_>>();
        let max_difference_bps_before = categories
            .iter()
            .filter(|category| target_ids.contains(&category.category_id))
            .map(|category| category.current_difference_bps.unsigned_abs() as i32)
            .max()
            .unwrap_or(0);
        let max_difference_bps_after = categories
            .iter()
            .filter(|category| target_ids.contains(&category.category_id))
            .map(|category| category.projected_difference_bps.unsigned_abs() as i32)
            .max()
            .unwrap_or(0);

        let mut source_asset_ids = asset_ids.clone();
        for holding in holdings_by_account.values().flatten() {
            if holding.holding_type != HoldingType::Cash {
                source_asset_ids.push(Self::asset_key(holding));
            }
        }
        source_asset_ids.sort();
        source_asset_ids.dedup();
        let source_assignments = self
            .taxonomy_service
            .get_asset_assignments_for_assets(&source_asset_ids)?;
        let source_quotes = self
            .quote_service
            .get_latest_quotes_snapshot(&source_asset_ids)?;
        let mut source_records = vec![WorksheetSourceRecord {
            source_type: "allocation_target".to_string(),
            id: target.id.clone(),
            version: target.updated_at.clone(),
            details: format!(
                "taxonomy={};band={:?}/{};relative={};reductions={};whole_shares={};minimum={};turnover={:?}",
                target.taxonomy_id,
                target.band_type,
                target.drift_band_bps,
                target.relative_factor_bps,
                target.allow_sells,
                target.whole_shares_only,
                target.min_trade_amount,
                target.max_turnover_bps,
            ),
        }];
        source_records.push(WorksheetSourceRecord {
            source_type: "taxonomy".to_string(),
            id: taxonomy.taxonomy.id.clone(),
            version: taxonomy.taxonomy.updated_at.and_utc().to_rfc3339(),
            details: format!(
                "name={};scope={}",
                taxonomy.taxonomy.name, taxonomy.taxonomy.scope
            ),
        });
        for weight in &weights {
            source_records.push(WorksheetSourceRecord {
                source_type: "target_weight".to_string(),
                id: weight.id.clone(),
                version: weight.updated_at.clone(),
                details: format!(
                    "category={};bps={};required={};locked={}",
                    weight.category_id, weight.target_bps, weight.is_required, weight.is_locked
                ),
            });
        }
        for category in &taxonomy.categories {
            source_records.push(WorksheetSourceRecord {
                source_type: "taxonomy_category".to_string(),
                id: category.id.clone(),
                version: category.updated_at.and_utc().to_rfc3339(),
                details: format!(
                    "name={};parent={:?};order={};color={}",
                    category.name, category.parent_id, category.sort_order, category.color
                ),
            });
        }
        for asset in assets_by_id.values() {
            source_records.push(WorksheetSourceRecord {
                source_type: "asset".to_string(),
                id: asset.id.clone(),
                version: asset.updated_at.and_utc().to_rfc3339(),
                details: format!(
                    "active={};kind={:?};currency={};multiplier={}",
                    asset.is_active,
                    asset.kind,
                    asset.quote_ccy,
                    asset.contract_multiplier()
                ),
            });
        }
        for holding in holdings_by_account.values().flatten() {
            source_records.push(WorksheetSourceRecord {
                source_type: "holding".to_string(),
                id: holding.id.clone(),
                version: holding.as_of_date.to_string(),
                details: format!(
                    "account={};asset={};quantity={};value={};price={:?}",
                    holding.account_id,
                    Self::asset_key(holding),
                    holding.quantity,
                    holding.market_value.base,
                    holding.price
                ),
            });
        }
        for assignment in source_assignments
            .iter()
            .filter(|assignment| assignment.taxonomy_id == target.taxonomy_id)
        {
            source_records.push(WorksheetSourceRecord {
                source_type: "classification".to_string(),
                id: assignment.id.clone(),
                version: assignment.updated_at.and_utc().to_rfc3339(),
                details: format!(
                    "asset={};category={};bps={};source={}",
                    assignment.asset_id,
                    assignment.category_id,
                    assignment.weight,
                    assignment.source
                ),
            });
        }
        for constraint in &constraints {
            source_records.push(WorksheetSourceRecord {
                source_type: "constraint".to_string(),
                id: constraint.id.clone(),
                version: constraint.updated_at.clone(),
                details: format!(
                    "subject={}:{};action={};effect={}",
                    constraint.subject_type.as_str(),
                    constraint.subject_id,
                    constraint.action.as_str(),
                    constraint.effect.as_str()
                ),
            });
        }
        for (asset_id, snapshot) in source_quotes {
            if let Some(quote) = snapshot.quote {
                source_records.push(WorksheetSourceRecord {
                    source_type: "security_quote".to_string(),
                    id: quote.id,
                    version: quote.timestamp.to_rfc3339(),
                    details: format!(
                        "asset={};close={};currency={};source={}",
                        asset_id, quote.close, quote.currency, quote.data_source
                    ),
                });
            }
        }
        for rate in used_fx_rates.values() {
            source_records.push(WorksheetSourceRecord {
                source_type: "fx_rate".to_string(),
                id: rate.id.clone(),
                version: rate.timestamp.to_rfc3339(),
                details: format!(
                    "pair={}/{};rate={};source={}",
                    rate.from_currency, rate.to_currency, rate.rate, rate.source
                ),
            });
        }
        for row in &drift.rows {
            source_records.push(WorksheetSourceRecord {
                source_type: "drift_row".to_string(),
                id: row.category_id.clone(),
                version: "derived".to_string(),
                details: format!(
                    "current_value={};current_bps={};target_bps={};cash={}",
                    row.current_value, row.current_bps, row.target_bps, row.is_cash
                ),
            });
        }
        source_records.sort_by(|left, right| {
            left.source_type
                .cmp(&right.source_type)
                .then_with(|| left.id.cmp(&right.id))
                .then_with(|| left.version.cmp(&right.version))
                .then_with(|| left.details.cmp(&right.details))
        });
        source_records.dedup_by(|left, right| {
            left.source_type == right.source_type
                && left.id == right.id
                && left.version == right.version
                && left.details == right.details
        });
        warnings.sort_by(|a, b| a.id.cmp(&b.id));
        warnings.dedup_by(|a, b| a.id == b.id);
        let source_fingerprint = Self::source_fingerprint(&input, &source_records);

        Ok(AllocationWorksheetResult {
            target_id: target.id,
            target_name: target.name,
            base_currency: input.base_currency,
            calculated_at: Utc::now().to_rfc3339(),
            source_fingerprint,
            resolved_account_ids: input.account_ids,
            observed_tracked_cash: drift.deployable_cash,
            tracked_cash_to_use: input.cash.tracked_cash_to_use,
            external_contribution: input.cash.external_contribution,
            increase_total,
            reduction_total,
            cash_remaining,
            max_difference_bps_before,
            max_difference_bps_after,
            lines: results,
            categories,
            warnings,
            source_records,
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use rust_decimal_macros::dec;

    fn line(mode: WorksheetInputMode, value: Decimal) -> AllocationWorksheetLineInput {
        AllocationWorksheetLineInput {
            line_id: "line-1".to_string(),
            direction: WorksheetDirection::Increase,
            asset_id: "asset-1".to_string(),
            account_id: "account-1".to_string(),
            input_mode: mode,
            value,
        }
    }

    fn request() -> CalculateAllocationWorksheetInput {
        CalculateAllocationWorksheetInput {
            target_id: "target-1".to_string(),
            cash: crate::portfolio::allocation_targets::WorksheetCashInput {
                tracked_cash_to_use: dec!(10),
                external_contribution: Decimal::ZERO,
            },
            lines: vec![line(WorksheetInputMode::Amount, dec!(10))],
            account_ids: vec!["account-1".to_string()],
            base_currency: "USD".to_string(),
            aggregated_account_id: "all".to_string(),
        }
    }

    fn fx_rate(id: &str, from: &str, to: &str, rate: Decimal) -> ExchangeRate {
        ExchangeRate {
            id: id.to_string(),
            from_currency: from.to_string(),
            to_currency: to.to_string(),
            rate,
            source: "manual".to_string(),
            timestamp: Utc::now(),
        }
    }

    #[test]
    fn amount_mode_floors_whole_units() {
        let (quantity, amount) = AllocationWorksheetService::resolved_quantity_and_amount(
            &line(WorksheetInputMode::Amount, dec!(250)),
            dec!(100),
            true,
        )
        .unwrap();
        assert_eq!(quantity, dec!(2));
        assert_eq!(amount, dec!(200));
    }

    #[test]
    fn quantity_mode_rejects_fractional_whole_units() {
        let result = AllocationWorksheetService::resolved_quantity_and_amount(
            &line(WorksheetInputMode::Quantity, dec!(1.5)),
            dec!(100),
            true,
        );
        assert!(result.is_err());
    }

    #[test]
    fn missing_classification_becomes_unknown_exposure() {
        let exposures = AllocationWorksheetService::category_exposures(
            &line(WorksheetInputMode::Amount, dec!(100)),
            dec!(100),
            &[],
            &HashMap::new(),
        )
        .unwrap();
        assert_eq!(exposures.len(), 1);
        assert_eq!(exposures[0].category_id, UNKNOWN_CATEGORY_ID);
        assert_eq!(exposures[0].weight_bps, 10_000);
        assert_eq!(exposures[0].value_delta, dec!(100));
    }

    #[test]
    fn partial_classification_keeps_known_and_residual_exposure() {
        let now = Utc::now().naive_utc();
        let assignments = vec![AssetTaxonomyAssignment {
            id: "assignment-1".to_string(),
            asset_id: "asset-1".to_string(),
            taxonomy_id: "taxonomy".to_string(),
            category_id: "equity".to_string(),
            weight: 6500,
            source: "manual".to_string(),
            created_at: now,
            updated_at: now,
        }];
        let exposures = AllocationWorksheetService::category_exposures(
            &line(WorksheetInputMode::Amount, dec!(100)),
            dec!(100),
            &assignments,
            &HashMap::from([("equity".to_string(), "Equity".to_string())]),
        )
        .unwrap();

        assert_eq!(exposures.len(), 2);
        assert_eq!(exposures[0].weight_bps, 6500);
        assert_eq!(exposures[0].value_delta, dec!(65));
        assert_eq!(exposures[1].category_id, UNKNOWN_CATEGORY_ID);
        assert_eq!(exposures[1].weight_bps, 3500);
        assert_eq!(exposures[1].value_delta, dec!(35));
    }

    #[test]
    fn fingerprint_changes_with_inputs_and_each_source_version() {
        let records = vec![WorksheetSourceRecord {
            source_type: "security_quote".to_string(),
            id: "quote-1".to_string(),
            version: "2026-01-01T00:00:00Z".to_string(),
            details: "close=100".to_string(),
        }];
        let original = AllocationWorksheetService::source_fingerprint(&request(), &records);

        let mut input_changed = request();
        input_changed.cash.external_contribution = dec!(1);
        assert_ne!(
            original,
            AllocationWorksheetService::source_fingerprint(&input_changed, &records)
        );

        let mut source_changed = records.clone();
        source_changed[0].version = "2026-01-02T00:00:00Z".to_string();
        assert_ne!(
            original,
            AllocationWorksheetService::source_fingerprint(&request(), &source_changed)
        );

        source_changed[0].version = records[0].version.clone();
        source_changed[0].details = "close=101".to_string();
        assert_ne!(
            original,
            AllocationWorksheetService::source_fingerprint(&request(), &source_changed)
        );
    }

    #[test]
    fn overclassified_security_is_rejected() {
        let assignments = vec![
            AssetTaxonomyAssignment {
                id: "a".to_string(),
                asset_id: "asset-1".to_string(),
                taxonomy_id: "taxonomy".to_string(),
                category_id: "one".to_string(),
                weight: 6000,
                source: "manual".to_string(),
                created_at: Utc::now().naive_utc(),
                updated_at: Utc::now().naive_utc(),
            },
            AssetTaxonomyAssignment {
                id: "b".to_string(),
                asset_id: "asset-1".to_string(),
                taxonomy_id: "taxonomy".to_string(),
                category_id: "two".to_string(),
                weight: 5000,
                source: "manual".to_string(),
                created_at: Utc::now().naive_utc(),
                updated_at: Utc::now().naive_utc(),
            },
        ];
        assert!(AllocationWorksheetService::category_exposures(
            &line(WorksheetInputMode::Amount, dec!(100)),
            dec!(100),
            &assignments,
            &HashMap::new(),
        )
        .is_err());
    }

    #[test]
    fn fx_resolution_attributes_a_direct_or_inverse_rate() {
        let rates = vec![fx_rate("eur-usd", "EUR", "USD", dec!(1.1))];

        let (direct, direct_source, direct_records) =
            AllocationWorksheetService::resolve_fx_source("EUR", "USD", &rates).unwrap();
        assert_eq!(direct, dec!(1.1));
        assert_eq!(direct_source.unwrap().id, "eur-usd");
        assert_eq!(direct_records.len(), 1);

        let (inverse, inverse_source, inverse_records) =
            AllocationWorksheetService::resolve_fx_source("USD", "EUR", &rates).unwrap();
        assert_eq!(inverse, Decimal::ONE / dec!(1.1));
        assert_eq!(inverse_source.unwrap().id, "eur-usd");
        assert_eq!(inverse_records.len(), 1);
    }

    #[test]
    fn fx_resolution_attributes_every_rate_in_a_cross_currency_path() {
        let rates = vec![
            fx_rate("eur-usd", "EUR", "USD", dec!(1.1)),
            fx_rate("usd-cad", "USD", "CAD", dec!(1.35)),
            fx_rate("aud-nzd", "AUD", "NZD", dec!(1.08)),
        ];

        let (rate, source, records) =
            AllocationWorksheetService::resolve_fx_source("EUR", "CAD", &rates).unwrap();

        assert_eq!(rate, dec!(1.485));
        assert_eq!(source.unwrap().source_type, "fx_path");
        assert_eq!(
            records
                .iter()
                .map(|record| record.id.as_str())
                .collect::<Vec<_>>(),
            vec!["eur-usd", "usd-cad"]
        );
    }

    #[test]
    fn funding_combines_tracked_external_and_reduction_proceeds() {
        assert_eq!(
            AllocationWorksheetService::cash_remaining(dec!(100), dec!(25), dec!(160), dec!(50))
                .unwrap(),
            dec!(15)
        );
        assert!(AllocationWorksheetService::cash_remaining(
            dec!(100),
            Decimal::ZERO,
            dec!(151),
            dec!(50)
        )
        .is_err());
    }

    #[test]
    fn projected_total_respects_cash_category_denominator_behavior() {
        assert_eq!(
            AllocationWorksheetService::projected_total(
                dec!(1000),
                dec!(100),
                dec!(250),
                dec!(50),
                true
            ),
            dec!(1100)
        );
        assert_eq!(
            AllocationWorksheetService::projected_total(
                dec!(1000),
                dec!(100),
                dec!(250),
                dec!(50),
                false
            ),
            dec!(1200)
        );
    }
}
