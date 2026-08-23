//! One-time activity cash amount migration.
//!
//! Keep the complete migration workflow in this file so it can be removed as a
//! unit once databases created before v3.8 are no longer supported.

use std::collections::{HashMap, HashSet};

use async_trait::async_trait;
use log::{info, warn};
use rust_decimal::Decimal;

use super::ActivityService;
use crate::{
    accounts::AccountServiceTrait,
    activities::{
        compute_activity_idempotency_key, Activity, ActivityAmountUpdate, ActivityServiceTrait,
        ACTIVITY_TYPE_BUY, ACTIVITY_TYPE_DIVIDEND, ACTIVITY_TYPE_INTEREST, ACTIVITY_TYPE_SELL,
        ACTIVITY_TYPE_SPLIT,
    },
    errors::{Error, Result},
    portfolio::{
        economic_events::{ActivityCashInputs, ActivityEconomicsResolver},
        snapshot::{SnapshotRecalcMode, SnapshotServiceTrait},
        valuation::{ValuationRecalcMode, ValuationServiceTrait},
    },
    settings::SettingsServiceTrait,
};

const MIGRATION_KEY: &str = "migration.activity_cash_amount.v3.8";
const PENDING: &str = "rebuild_pending";
const COMPLETE: &str = "complete";

/// Runs the v3.8 cash amount migration without propagating failures to startup.
///
/// A failed attempt is never marked complete and is retried on the next startup.
/// The return value reports whether the migration was already complete or
/// completed successfully during this call.
pub async fn run_activity_cash_amount_v3_8(
    settings_service: &dyn SettingsServiceTrait,
    activity_service: &dyn ActivityServiceTrait,
    account_service: &dyn AccountServiceTrait,
    snapshot_service: &dyn SnapshotServiceTrait,
    valuation_service: &dyn ValuationServiceTrait,
) -> bool {
    let backend = ServiceMigrationBackend {
        settings_service,
        activity_service,
        account_service,
        snapshot_service,
        valuation_service,
    };

    run_safely(&backend).await
}

pub(super) async fn migrate_amounts(service: &ActivityService) -> Result<usize> {
    let activities = service
        .activity_repository
        .get_activities_for_cash_amount_migration()?;
    let existing_key_owner: HashMap<String, String> = activities
        .iter()
        .filter_map(|activity| {
            activity
                .idempotency_key
                .as_ref()
                .map(|key| (key.clone(), activity.id.clone()))
        })
        .collect();
    let mut claimed_recomputed_keys = HashSet::new();
    let mut asset_multipliers = HashMap::new();
    let mut updates = Vec::new();
    let mut changed_activities = Vec::new();

    for activity in activities {
        if activity.effective_type() == ACTIVITY_TYPE_SPLIT
            || ActivityEconomicsResolver::is_security_transfer(&activity)
            || activity.amount.is_some_and(|amount| !amount.is_zero())
        {
            continue;
        }

        let migrated_amount =
            migration_cash_unit_multiplier(service, &activity, &mut asset_multipliers)
                .and_then(|unit_multiplier| {
                    ActivityEconomicsResolver::resolve_cash_inputs(ActivityCashInputs {
                        activity_type: activity.effective_type(),
                        is_security_transfer: false,
                        quantity: activity.quantity,
                        unit_price: activity.unit_price,
                        amount: None,
                        fee: activity.fee,
                        tax: activity.tax,
                        unit_multiplier,
                    })
                    .amount
                })
                .filter(|amount| *amount > Decimal::ZERO);

        if let Some(amount) = migrated_amount {
            let idempotency_key = activity.idempotency_key.as_ref().and_then(|key| {
                if key != &compute_activity_idempotency_key(&activity) {
                    return None;
                }
                let candidate = {
                    let mut migrated = activity.clone();
                    migrated.amount = Some(amount);
                    compute_activity_idempotency_key(&migrated)
                };
                let owned_by_other = existing_key_owner
                    .get(&candidate)
                    .is_some_and(|owner| owner != &activity.id);
                if owned_by_other || !claimed_recomputed_keys.insert(candidate.clone()) {
                    None
                } else {
                    Some(candidate)
                }
            });
            updates.push(ActivityAmountUpdate {
                id: activity.id.clone(),
                amount,
                idempotency_key,
            });
            changed_activities.push(activity);
        }
    }

    let changed = service
        .activity_repository
        .update_activity_amounts_for_migration(updates)
        .await?;
    if changed > 0 {
        let mut account_ids = HashSet::new();
        let mut asset_ids = HashSet::new();
        let mut currencies = HashSet::new();
        for activity in &changed_activities {
            ActivityService::add_activity_to_event_sets(
                activity,
                &mut account_ids,
                &mut asset_ids,
                &mut currencies,
            );
        }
        service.emit_activities_changed(
            account_ids.into_iter().collect(),
            asset_ids.into_iter().collect(),
            currencies.into_iter().collect(),
            ActivityService::earliest_activity_at_utc(&changed_activities),
        );
    }

    Ok(changed)
}

fn migration_cash_unit_multiplier(
    service: &ActivityService,
    activity: &Activity,
    asset_multipliers: &mut HashMap<String, Option<Decimal>>,
) -> Option<Decimal> {
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
    async fn migrate_amounts(&self) -> Result<usize>;
    fn non_archived_account_ids(&self) -> Result<Vec<String>>;
    async fn rebuild_holdings(&self, account_ids: &[String]) -> Result<()>;
    async fn rebuild_valuations(&self, account_ids: &[String]) -> Result<usize>;
}

struct ServiceMigrationBackend<'a> {
    settings_service: &'a dyn SettingsServiceTrait,
    activity_service: &'a dyn ActivityServiceTrait,
    account_service: &'a dyn AccountServiceTrait,
    snapshot_service: &'a dyn SnapshotServiceTrait,
    valuation_service: &'a dyn ValuationServiceTrait,
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

    async fn migrate_amounts(&self) -> Result<usize> {
        self.activity_service.migrate_activity_cash_amounts().await
    }

    fn non_archived_account_ids(&self) -> Result<Vec<String>> {
        Ok(self
            .account_service
            .get_non_archived_accounts()?
            .into_iter()
            .map(|account| account.id)
            .collect())
    }

    async fn rebuild_holdings(&self, account_ids: &[String]) -> Result<()> {
        self.snapshot_service
            .recalculate_holdings_snapshots(Some(account_ids), SnapshotRecalcMode::Full)
            .await
            .map(|_| ())
    }

    async fn rebuild_valuations(&self, account_ids: &[String]) -> Result<usize> {
        self.valuation_service
            .calculate_valuation_histories(account_ids, ValuationRecalcMode::Full)
            .await
            .map(|outcome| outcome.failures.len())
    }
}

async fn run_safely(backend: &dyn MigrationBackend) -> bool {
    match try_run(backend).await {
        Ok(Some(migrated)) => {
            info!("Backfilled missing cash amounts for {migrated} activities");
            true
        }
        Ok(None) => true,
        Err(error) => {
            warn!("Activity cash amount migration failed and will retry next startup: {error}");
            false
        }
    }
}

async fn try_run(backend: &dyn MigrationBackend) -> Result<Option<usize>> {
    if backend.get_state()?.as_deref() == Some(COMPLETE) {
        return Ok(None);
    }

    // Write the pending marker before touching activity rows. If any later step
    // fails, the complete workflow is safe to retry on the next startup.
    backend.set_state(PENDING).await?;
    let migrated = backend.migrate_amounts().await?;
    let account_ids = backend.non_archived_account_ids()?;

    if !account_ids.is_empty() {
        backend.rebuild_holdings(&account_ids).await?;
        let valuation_failures = backend.rebuild_valuations(&account_ids).await?;
        if valuation_failures > 0 {
            return Err(Error::Unexpected(format!(
                "valuation rebuild failed for {valuation_failures} account(s)"
            )));
        }
    }

    backend.set_state(COMPLETE).await?;
    Ok(Some(migrated))
}

#[cfg(test)]
mod tests {
    use std::sync::Mutex;

    use super::*;

    #[derive(Clone, Copy, Debug, PartialEq, Eq)]
    enum FailureStage {
        ReadState,
        MarkPending,
        MigrateAmounts,
        LoadAccounts,
        RebuildHoldings,
        RebuildValuations,
        MarkComplete,
    }

    struct MockBackend {
        state: Mutex<Option<String>>,
        failure: Option<FailureStage>,
        account_ids: Vec<String>,
        valuation_failures: usize,
    }

    impl MockBackend {
        fn new() -> Self {
            Self {
                state: Mutex::new(None),
                failure: None,
                account_ids: vec!["account-1".to_string()],
                valuation_failures: 0,
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
            let mut current = self
                .state
                .lock()
                .map_err(|_| Error::Unexpected("migration state lock poisoned".to_string()))?;
            *current = Some(state.to_string());
            Ok(())
        }

        async fn migrate_amounts(&self) -> Result<usize> {
            self.error(FailureStage::MigrateAmounts)?;
            Ok(2)
        }

        fn non_archived_account_ids(&self) -> Result<Vec<String>> {
            self.error(FailureStage::LoadAccounts)?;
            Ok(self.account_ids.clone())
        }

        async fn rebuild_holdings(&self, _account_ids: &[String]) -> Result<()> {
            self.error(FailureStage::RebuildHoldings)
        }

        async fn rebuild_valuations(&self, _account_ids: &[String]) -> Result<usize> {
            self.error(FailureStage::RebuildValuations)?;
            Ok(self.valuation_failures)
        }
    }

    #[tokio::test]
    async fn completes_successfully() {
        let backend = MockBackend::new();

        assert!(run_safely(&backend).await);
        assert_eq!(backend.state().as_deref(), Some(COMPLETE));
    }

    #[tokio::test]
    async fn skips_an_already_completed_migration() {
        let backend = MockBackend {
            state: Mutex::new(Some(COMPLETE.to_string())),
            failure: Some(FailureStage::MigrateAmounts),
            account_ids: vec!["account-1".to_string()],
            valuation_failures: 0,
        };

        assert!(run_safely(&backend).await);
        assert_eq!(backend.state().as_deref(), Some(COMPLETE));
    }

    #[tokio::test]
    async fn completes_without_rebuild_when_there_are_no_accounts() {
        let backend = MockBackend {
            account_ids: Vec::new(),
            failure: Some(FailureStage::RebuildHoldings),
            ..MockBackend::new()
        };

        assert!(run_safely(&backend).await);
        assert_eq!(backend.state().as_deref(), Some(COMPLETE));
    }

    #[tokio::test]
    async fn service_errors_do_not_escape_or_mark_the_migration_complete() {
        for stage in [
            FailureStage::ReadState,
            FailureStage::MarkPending,
            FailureStage::MigrateAmounts,
            FailureStage::LoadAccounts,
            FailureStage::RebuildHoldings,
            FailureStage::RebuildValuations,
            FailureStage::MarkComplete,
        ] {
            let backend = MockBackend::failing_at(stage);

            assert!(!run_safely(&backend).await, "stage {stage:?}");
            assert_ne!(
                backend.state().as_deref(),
                Some(COMPLETE),
                "stage {stage:?}"
            );
        }
    }

    #[tokio::test]
    async fn partial_valuation_failures_leave_the_migration_pending() {
        let backend = MockBackend {
            valuation_failures: 1,
            ..MockBackend::new()
        };

        assert!(!run_safely(&backend).await);
        assert_eq!(backend.state().as_deref(), Some(PENDING));
    }
}
