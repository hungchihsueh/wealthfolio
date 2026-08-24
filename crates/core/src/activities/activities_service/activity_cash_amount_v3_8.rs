//! One-time activity cash amount migration.
//!
//! Keep the complete migration workflow in this file so it can be removed as a
//! unit once databases created before v3.8 are no longer supported.

use std::collections::{HashMap, HashSet};

use async_trait::async_trait;
use log::{info, warn};
use rust_decimal::Decimal;
use serde_json::{json, Map, Value};

use super::ActivityService;
use crate::{
    activities::{
        Activity, ActivityAmountUpdate, ActivityCashMigrationResult, ActivityServiceTrait,
        ACTIVITY_TYPE_BUY, ACTIVITY_TYPE_DIVIDEND, ACTIVITY_TYPE_INTEREST, ACTIVITY_TYPE_SELL,
    },
    errors::Result,
    fx::currency::currency_rounding_tolerance,
    portfolio::{
        economic_events::{
            ActivityCashInputs, ActivityEconomicsResolver, ClassifiedLegacyActivityCash,
            LegacyActivityCashClassification,
        },
        snapshot::{SnapshotRecalcMode, SnapshotServiceTrait},
        valuation::{ValuationRecalcMode, ValuationServiceTrait},
    },
    settings::SettingsServiceTrait,
};

const MIGRATION_KEY: &str = "migration.activity_cash_amount.v3.8";
const PENDING: &str = "classification_pending";
const COMPLETE: &str = "complete";

/// Classifies legacy cash amounts without allowing migration failures to block
/// startup. Rebuild work is returned to the caller so it can run after startup.
pub async fn run_activity_cash_amount_v3_8(
    settings_service: &dyn SettingsServiceTrait,
    activity_service: &dyn ActivityServiceTrait,
) -> ActivityCashMigrationResult {
    let backend = ServiceMigrationBackend {
        settings_service,
        activity_service,
    };

    run_safely(&backend).await
}

/// Rebuilds only accounts whose stored cash amount changed. Each account is
/// isolated so one bad quote, FX rate, or valuation cannot stop the others.
pub async fn rebuild_activity_cash_amount_v3_8(
    account_ids: Vec<String>,
    snapshot_service: &dyn SnapshotServiceTrait,
    valuation_service: &dyn ValuationServiceTrait,
) {
    let backend = ServiceAccountRebuildBackend {
        snapshot_service,
        valuation_service,
    };
    rebuild_accounts_safely(&backend, &account_ids).await;
}

pub(super) async fn migrate_amounts(
    service: &ActivityService,
) -> Result<ActivityCashMigrationResult> {
    let activities = service
        .activity_repository
        .get_activities_for_cash_amount_migration()?;
    let mut asset_multipliers = HashMap::new();
    let mut affected_account_ids = HashSet::new();
    let mut updates = Vec::new();

    for activity in activities {
        if activity
            .metadata
            .as_ref()
            .and_then(|metadata| metadata.pointer("/migrations/cash_amount_v3_8/classification"))
            .and_then(Value::as_str)
            .is_some()
        {
            continue;
        }
        let classified =
            match migration_cash_unit_multiplier(service, &activity, &mut asset_multipliers) {
                Some(unit_multiplier) => ActivityEconomicsResolver::classify_legacy_cash_inputs(
                    ActivityCashInputs {
                        activity_type: activity.effective_type(),
                        is_security_transfer: ActivityEconomicsResolver::is_security_transfer(
                            &activity,
                        ),
                        quantity: activity.quantity,
                        unit_price: activity.unit_price,
                        amount: activity.amount,
                        fee: activity.fee,
                        tax: activity.tax,
                        unit_multiplier,
                    },
                    currency_rounding_tolerance(&activity.currency),
                ),
                None => unclassifiable_without_multiplier(&activity),
            };

        if classified.classification == LegacyActivityCashClassification::NotApplicable {
            continue;
        }

        let amount_changed = activity.amount != classified.final_amount;
        let needs_review = activity.needs_review || classified.needs_review;
        let review_changed = needs_review != activity.needs_review;
        let metadata = if amount_changed || classified.needs_review {
            Some(migration_metadata(&activity, classified))
        } else {
            activity.metadata.clone()
        };
        let metadata_changed = metadata != activity.metadata;

        if !amount_changed && !review_changed && !metadata_changed {
            continue;
        }

        if amount_changed {
            affected_account_ids.insert(activity.account_id.clone());
        }
        updates.push(ActivityAmountUpdate {
            id: activity.id,
            amount: classified.final_amount,
            metadata,
            needs_review,
        });
    }

    let changed = service
        .activity_repository
        .update_activity_amounts_for_migration(updates)
        .await?;
    let mut affected_account_ids: Vec<String> = affected_account_ids.into_iter().collect();
    affected_account_ids.sort();

    Ok(ActivityCashMigrationResult {
        changed,
        affected_account_ids,
    })
}

fn unclassifiable_without_multiplier(activity: &Activity) -> ClassifiedLegacyActivityCash {
    let supplied = activity.amount.map(|amount| amount.abs());
    ClassifiedLegacyActivityCash {
        classification: if supplied.is_some_and(|amount| !amount.is_zero()) {
            LegacyActivityCashClassification::Ambiguous
        } else {
            LegacyActivityCashClassification::Missing
        },
        final_amount: supplied.filter(|amount| !amount.is_zero()),
        needs_review: true,
    }
}

fn migration_metadata(activity: &Activity, classified: ClassifiedLegacyActivityCash) -> Value {
    let mut metadata = activity
        .metadata
        .clone()
        .unwrap_or_else(|| Value::Object(Map::new()));
    if !metadata.is_object() {
        metadata = json!({ "legacy_metadata": metadata });
    }
    if let Value::Object(root) = &mut metadata {
        let migrations = root
            .entry("migrations")
            .or_insert_with(|| Value::Object(Map::new()));
        if !migrations.is_object() {
            *migrations = Value::Object(Map::new());
        }
        if let Value::Object(migrations) = migrations {
            migrations.insert(
                "cash_amount_v3_8".to_string(),
                json!({
                    "original_amount": activity.amount.map(|amount| amount.to_string()),
                    "classification": classified.classification.as_str(),
                }),
            );
        }

        let amount_mode = if matches!(
            classified.classification,
            LegacyActivityCashClassification::Derived
                | LegacyActivityCashClassification::Gross
                | LegacyActivityCashClassification::Missing
        ) {
            "calculated"
        } else {
            "custom"
        };
        let cash_amount = root
            .entry("cash_amount")
            .or_insert_with(|| Value::Object(Map::new()));
        if !cash_amount.is_object() {
            *cash_amount = Value::Object(Map::new());
        }
        if let Value::Object(cash_amount) = cash_amount {
            cash_amount.insert("mode".to_string(), json!(amount_mode));
        }
    }
    metadata
}

fn migration_cash_unit_multiplier(
    service: &ActivityService,
    activity: &Activity,
    asset_multipliers: &mut HashMap<String, Option<Decimal>>,
) -> Option<Decimal> {
    let has_supplied_amount = activity.amount.is_some_and(|amount| !amount.is_zero());
    let has_charges = activity.fee.is_some_and(|fee| !fee.is_zero())
        || activity.tax.is_some_and(|tax| !tax.is_zero());
    if has_supplied_amount && !has_charges {
        // Gross and final are equivalent, so the multiplier is irrelevant.
        return Some(Decimal::ONE);
    }
    let requires_asset_multiplier = matches!(
        activity.effective_type(),
        ACTIVITY_TYPE_BUY | ACTIVITY_TYPE_SELL | ACTIVITY_TYPE_DIVIDEND | ACTIVITY_TYPE_INTEREST
    ) && activity.quantity.is_some()
        && activity.unit_price.is_some();
    if !requires_asset_multiplier {
        return Some(Decimal::ONE);
    }

    if let Some(multiplier) = activity
        .metadata
        .as_ref()
        .and_then(ActivityService::contract_multiplier_from_metadata)
    {
        return Some(multiplier);
    }
    let asset_id = activity.asset_id.as_deref()?;
    if let Some(multiplier) = asset_multipliers.get(asset_id) {
        return *multiplier;
    }
    let multiplier = service
        .asset_service
        .get_asset_by_id(asset_id)
        .ok()
        .map(|asset| ActivityEconomicsResolver::asset_unit_multiplier(&asset));
    asset_multipliers.insert(asset_id.to_string(), multiplier);
    multiplier
}

#[async_trait]
trait MigrationBackend: Send + Sync {
    fn get_state(&self) -> Result<Option<String>>;
    async fn set_state(&self, state: &str) -> Result<()>;
    async fn migrate_amounts(&self) -> Result<ActivityCashMigrationResult>;
}

struct ServiceMigrationBackend<'a> {
    settings_service: &'a dyn SettingsServiceTrait,
    activity_service: &'a dyn ActivityServiceTrait,
}

#[async_trait]
impl MigrationBackend for ServiceMigrationBackend<'_> {
    fn get_state(&self) -> Result<Option<String>> {
        self.settings_service.get_setting_value(MIGRATION_KEY)
    }

    async fn set_state(&self, state: &str) -> Result<()> {
        self.settings_service
            .set_setting_value(MIGRATION_KEY, state)
            .await
    }

    async fn migrate_amounts(&self) -> Result<ActivityCashMigrationResult> {
        self.activity_service.migrate_activity_cash_amounts().await
    }
}

async fn run_safely(backend: &dyn MigrationBackend) -> ActivityCashMigrationResult {
    match try_run(backend).await {
        Ok(Some(result)) => {
            info!(
                "Classified legacy cash amounts for {} activities; {} account(s) need rebuilding",
                result.changed,
                result.affected_account_ids.len()
            );
            result
        }
        Ok(None) => ActivityCashMigrationResult::default(),
        Err(error) => {
            warn!("Activity cash amount migration failed and will retry next startup: {error}");
            ActivityCashMigrationResult::default()
        }
    }
}

async fn try_run(backend: &dyn MigrationBackend) -> Result<Option<ActivityCashMigrationResult>> {
    if backend.get_state()?.as_deref() == Some(COMPLETE) {
        return Ok(None);
    }

    backend.set_state(PENDING).await?;
    let result = backend.migrate_amounts().await?;
    // Classification completion is independent of derived valuation success.
    if let Err(error) = backend.set_state(COMPLETE).await {
        // The data transaction already committed. Still return affected
        // accounts for rebuilding; the idempotent classifier will retry the
        // completion marker on the next startup.
        warn!("Cash amount classification committed but its completion marker failed: {error}");
    }
    Ok(Some(result))
}

#[async_trait]
trait AccountRebuildBackend: Send + Sync {
    async fn rebuild_holdings(&self, account_id: &str) -> Result<()>;
    async fn rebuild_valuation(&self, account_id: &str) -> Result<usize>;
}

struct ServiceAccountRebuildBackend<'a> {
    snapshot_service: &'a dyn SnapshotServiceTrait,
    valuation_service: &'a dyn ValuationServiceTrait,
}

#[async_trait]
impl AccountRebuildBackend for ServiceAccountRebuildBackend<'_> {
    async fn rebuild_holdings(&self, account_id: &str) -> Result<()> {
        self.snapshot_service
            .recalculate_holdings_snapshots(
                Some(&[account_id.to_string()]),
                SnapshotRecalcMode::Full,
            )
            .await
            .map(|_| ())
    }

    async fn rebuild_valuation(&self, account_id: &str) -> Result<usize> {
        self.valuation_service
            .calculate_valuation_histories(&[account_id.to_string()], ValuationRecalcMode::Full)
            .await
            .map(|outcome| outcome.failures.len())
    }
}

async fn rebuild_accounts_safely(backend: &dyn AccountRebuildBackend, account_ids: &[String]) {
    for account_id in account_ids {
        if let Err(error) = backend.rebuild_holdings(account_id).await {
            warn!(
                "Cash amount migration holdings rebuild failed for account {account_id}: {error}"
            );
            continue;
        }
        match backend.rebuild_valuation(account_id).await {
            Ok(0) => {}
            Ok(failures) => warn!(
                "Cash amount migration valuation rebuild reported {failures} failure(s) for account {account_id}"
            ),
            Err(error) => warn!(
                "Cash amount migration valuation rebuild failed for account {account_id}: {error}"
            ),
        }
    }
}

#[cfg(test)]
mod tests {
    use std::sync::Mutex;

    use crate::errors::Error;

    use super::*;

    #[derive(Clone, Copy, Debug, PartialEq, Eq)]
    enum FailureStage {
        ReadState,
        MarkPending,
        MigrateAmounts,
        MarkComplete,
    }

    struct MockBackend {
        state: Mutex<Option<String>>,
        failure: Option<FailureStage>,
    }

    impl MockBackend {
        fn new() -> Self {
            Self {
                state: Mutex::new(None),
                failure: None,
            }
        }

        fn failing_at(stage: FailureStage) -> Self {
            Self {
                failure: Some(stage),
                ..Self::new()
            }
        }

        fn error(&self, stage: FailureStage) -> Result<()> {
            if self.failure == Some(stage) {
                Err(Error::Unexpected(format!("failure at {stage:?}")))
            } else {
                Ok(())
            }
        }

        fn state(&self) -> Option<String> {
            self.state.lock().ok().and_then(|state| state.clone())
        }
    }

    #[async_trait]
    impl MigrationBackend for MockBackend {
        fn get_state(&self) -> Result<Option<String>> {
            self.error(FailureStage::ReadState)?;
            Ok(self.state())
        }

        async fn set_state(&self, state: &str) -> Result<()> {
            let stage = if state == PENDING {
                FailureStage::MarkPending
            } else {
                FailureStage::MarkComplete
            };
            self.error(stage)?;
            *self
                .state
                .lock()
                .map_err(|_| Error::Unexpected("migration state lock poisoned".to_string()))? =
                Some(state.to_string());
            Ok(())
        }

        async fn migrate_amounts(&self) -> Result<ActivityCashMigrationResult> {
            self.error(FailureStage::MigrateAmounts)?;
            Ok(ActivityCashMigrationResult {
                changed: 2,
                affected_account_ids: vec!["account-1".to_string()],
            })
        }
    }

    #[tokio::test]
    async fn completes_classification_before_rebuild_work() {
        let backend = MockBackend::new();

        let result = run_safely(&backend).await;

        assert_eq!(result.changed, 2);
        assert_eq!(backend.state().as_deref(), Some(COMPLETE));
    }

    #[tokio::test]
    async fn skips_an_already_completed_migration() {
        let backend = MockBackend {
            state: Mutex::new(Some(COMPLETE.to_string())),
            failure: Some(FailureStage::MigrateAmounts),
        };

        assert_eq!(run_safely(&backend).await, Default::default());
    }

    #[tokio::test]
    async fn classification_errors_do_not_escape_or_mark_complete() {
        for stage in [
            FailureStage::ReadState,
            FailureStage::MarkPending,
            FailureStage::MigrateAmounts,
        ] {
            let backend = MockBackend::failing_at(stage);

            assert_eq!(run_safely(&backend).await, Default::default());
            assert_ne!(
                backend.state().as_deref(),
                Some(COMPLETE),
                "stage {stage:?}"
            );
        }

        let backend = MockBackend::failing_at(FailureStage::MarkComplete);
        let result = run_safely(&backend).await;
        assert_eq!(result.changed, 2);
        assert_eq!(result.affected_account_ids, vec!["account-1"]);
        assert_ne!(backend.state().as_deref(), Some(COMPLETE));
    }

    struct MockRebuildBackend {
        calls: Mutex<Vec<String>>,
        failing_holdings_account: Option<String>,
    }

    #[async_trait]
    impl AccountRebuildBackend for MockRebuildBackend {
        async fn rebuild_holdings(&self, account_id: &str) -> Result<()> {
            self.calls
                .lock()
                .expect("calls lock")
                .push(format!("holdings:{account_id}"));
            if self.failing_holdings_account.as_deref() == Some(account_id) {
                Err(Error::Unexpected("holdings failure".to_string()))
            } else {
                Ok(())
            }
        }

        async fn rebuild_valuation(&self, account_id: &str) -> Result<usize> {
            self.calls
                .lock()
                .expect("calls lock")
                .push(format!("valuation:{account_id}"));
            Ok(0)
        }
    }

    #[tokio::test]
    async fn account_rebuild_failures_are_isolated() {
        let backend = MockRebuildBackend {
            calls: Mutex::new(Vec::new()),
            failing_holdings_account: Some("bad".to_string()),
        };

        rebuild_accounts_safely(&backend, &["bad".to_string(), "good".to_string()]).await;

        assert_eq!(
            *backend.calls.lock().expect("calls lock"),
            vec!["holdings:bad", "holdings:good", "valuation:good"]
        );
    }
}
