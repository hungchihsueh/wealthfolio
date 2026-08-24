//! Diagnostics for authoritative activity cash amounts.

use async_trait::async_trait;
use chrono::NaiveDate;
use rust_decimal::Decimal;
use serde_json::json;
use std::collections::hash_map::DefaultHasher;
use std::hash::{Hash, Hasher};

use crate::errors::Result;
use crate::health::model::{
    AffectedItem, DiagnosticDomain, Evidence, HealthCategory, HealthDiagnostic, HealthEntityRef,
    HealthIssue, NavigateAction, Severity,
};
use crate::health::traits::{HealthCheck, HealthContext};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum ActivityCashIssueKind {
    NeedsReview,
    Mismatch,
    Missing,
}

#[derive(Debug, Clone)]
pub struct ActivityCashIssueInfo {
    pub kind: ActivityCashIssueKind,
    pub activity_id: String,
    pub account_name: String,
    pub activity_type: String,
    pub date: NaiveDate,
    pub currency: String,
    pub trusted_amount: Option<Decimal>,
    pub expected_amount: Option<Decimal>,
    pub difference: Option<Decimal>,
    pub quantity: Option<Decimal>,
    pub unit_price: Option<Decimal>,
    pub fee: Decimal,
    pub tax: Decimal,
}

pub struct ActivityCashIntegrityCheck;

impl ActivityCashIntegrityCheck {
    pub fn new() -> Self {
        Self
    }

    pub fn analyze(
        &self,
        findings: &[ActivityCashIssueInfo],
        _ctx: &HealthContext,
    ) -> Vec<HealthIssue> {
        [
            ActivityCashIssueKind::NeedsReview,
            ActivityCashIssueKind::Mismatch,
            ActivityCashIssueKind::Missing,
        ]
        .into_iter()
        .filter_map(|kind| {
            let grouped: Vec<_> = findings
                .iter()
                .filter(|finding| finding.kind == kind)
                .collect();
            (!grouped.is_empty()).then(|| issue_for_findings(kind, &grouped))
        })
        .collect()
    }
}

impl Default for ActivityCashIntegrityCheck {
    fn default() -> Self {
        Self::new()
    }
}

#[async_trait]
impl HealthCheck for ActivityCashIntegrityCheck {
    fn id(&self) -> &'static str {
        "activity_cash_integrity"
    }

    fn category(&self) -> HealthCategory {
        HealthCategory::DataConsistency
    }

    async fn run(&self, _ctx: &HealthContext) -> Result<Vec<HealthIssue>> {
        Ok(Vec::new())
    }
}

const MAX_DETAILS: usize = 20;

fn issue_for_findings(
    kind: ActivityCashIssueKind,
    findings: &[&ActivityCashIssueInfo],
) -> HealthIssue {
    let (code, severity, title, message) = match kind {
        ActivityCashIssueKind::NeedsReview => (
            "activity_cash_needs_review",
            Severity::Warning,
            "Activity cash amounts need review",
            "Wealthfolio preserved these cash amounts because their historical meaning could not be classified safely.",
        ),
        ActivityCashIssueKind::Mismatch => (
            "activity_cash_mismatch",
            Severity::Warning,
            "Cash amounts differ from activity details",
            "Wealthfolio used the trusted cash amounts. Review imported totals when the differences are unexpected.",
        ),
        ActivityCashIssueKind::Missing => (
            "activity_cash_amount_missing",
            Severity::Error,
            "Activity totals are missing",
            "These posted activities have no cash amount and cannot be derived from the available fields.",
        ),
    };
    let navigate = NavigateAction {
        route: "/activities".to_string(),
        query: Some(json!({ "healthContext": "activity" })),
        label: "Review Activities".to_string(),
    };
    let affected_items = findings
        .iter()
        .take(MAX_DETAILS)
        .map(|finding| {
            AffectedItem::activity(
                finding.activity_id.clone(),
                format!(
                    "{} · {} · {}",
                    finding.activity_type, finding.date, finding.account_name
                ),
            )
        })
        .collect();
    let diagnostics = findings
        .iter()
        .take(MAX_DETAILS)
        .map(|finding| diagnostic_for_finding(finding, code, severity))
        .collect();
    let details = format_group_details(kind, findings.len());
    let data_hash = findings_hash(kind, findings);

    HealthIssue::builder()
        .id(code)
        .severity(severity)
        .category(HealthCategory::DataConsistency)
        .code(code)
        .title(title)
        .message(message)
        .affected_count(findings.len() as u32)
        .affected_items(affected_items)
        .navigate_action(navigate)
        .diagnostics(diagnostics)
        .details(details)
        .data_hash(data_hash)
        .build()
}

fn diagnostic_for_finding(
    finding: &ActivityCashIssueInfo,
    code: &str,
    severity: Severity,
) -> HealthDiagnostic {
    let mut diagnostic =
        HealthDiagnostic::new(code.to_ascii_uppercase(), code, format_details(finding))
            .domain(DiagnosticDomain::Ledger)
            .severity(severity)
            .date(finding.date.to_string())
            .entity(
                HealthEntityRef::new("activity", finding.activity_id.clone())
                    .label(finding.activity_type.clone())
                    .route(format!(
                        "/activities?activity={}",
                        urlencoding::encode(&finding.activity_id)
                    )),
            )
            .evidence(Evidence::new("Currency", finding.currency.clone()))
            .evidence(Evidence::new("Quantity", decimal_text(finding.quantity)))
            .evidence(Evidence::new(
                "Unit price",
                decimal_text(finding.unit_price),
            ))
            .evidence(Evidence::new("Fee", finding.fee.to_string()))
            .evidence(Evidence::new("Tax", finding.tax.to_string()));

    if let Some(amount) = finding.trusted_amount {
        diagnostic = diagnostic.evidence(Evidence::new("Trusted cash amount", amount.to_string()));
    }
    if let Some(amount) = finding.expected_amount {
        diagnostic = diagnostic.evidence(Evidence::new("Expected amount", amount.to_string()));
    }
    if let Some(difference) = finding.difference {
        diagnostic = diagnostic.evidence(Evidence::new("Difference", difference.to_string()));
    }
    diagnostic
}

fn decimal_text(value: Option<Decimal>) -> String {
    value
        .map(|value| value.to_string())
        .unwrap_or_else(|| "—".to_string())
}

fn format_details(finding: &ActivityCashIssueInfo) -> String {
    match finding.kind {
        ActivityCashIssueKind::NeedsReview => format!(
            "Stored cash amount: {} {}\nExpected from available activity details: {} {}\nQuantity: {}\nUnit price: {}\nFee: {}\nTax: {}\n\nConfirm the final cash total in the activity editor. Until then, Wealthfolio preserves the prior economic behavior.",
            decimal_text(finding.trusted_amount),
            finding.currency,
            decimal_text(finding.expected_amount),
            finding.currency,
            decimal_text(finding.quantity),
            decimal_text(finding.unit_price),
            finding.fee,
            finding.tax,
        ),
        ActivityCashIssueKind::Mismatch => format!(
            "Trusted cash amount: {} {}\nExpected from quantity × price and charges: {} {}\nDifference: {} {}\nQuantity: {}\nUnit price: {}\nFee: {}\nTax: {}\n\nWealthfolio used the trusted cash amount.",
            decimal_text(finding.trusted_amount),
            finding.currency,
            decimal_text(finding.expected_amount),
            finding.currency,
            decimal_text(finding.difference),
            finding.currency,
            decimal_text(finding.quantity),
            decimal_text(finding.unit_price),
            finding.fee,
            finding.tax,
        ),
        ActivityCashIssueKind::Missing => format!(
            "Quantity: {}\nUnit price: {}\nFee: {}\nTax: {}\n\nEnter a Total to make this activity calculable.",
            decimal_text(finding.quantity),
            decimal_text(finding.unit_price),
            finding.fee,
            finding.tax,
        ),
    }
}

fn format_group_details(kind: ActivityCashIssueKind, count: usize) -> String {
    let description = match kind {
        ActivityCashIssueKind::NeedsReview => {
            "have historical cash amounts that could not be classified safely"
        }
        ActivityCashIssueKind::Mismatch => {
            "have trusted totals that differ from their quantity, price, fees, or taxes"
        }
        ActivityCashIssueKind::Missing => {
            "have no usable total and cannot be derived from their available fields"
        }
    };
    let shown = count.min(MAX_DETAILS);
    if shown == count {
        format!("{count} activities {description}.")
    } else {
        format!("{count} activities {description}. Showing the first {shown}.")
    }
}

fn finding_hash(finding: &ActivityCashIssueInfo) -> String {
    let mut hasher = DefaultHasher::new();
    finding.activity_id.hash(&mut hasher);
    finding.kind.hash(&mut hasher);
    finding
        .trusted_amount
        .map(|value| value.to_string())
        .hash(&mut hasher);
    finding
        .expected_amount
        .map(|value| value.to_string())
        .hash(&mut hasher);
    finding
        .difference
        .map(|value| value.to_string())
        .hash(&mut hasher);
    finding
        .quantity
        .map(|value| value.to_string())
        .hash(&mut hasher);
    finding
        .unit_price
        .map(|value| value.to_string())
        .hash(&mut hasher);
    finding.fee.to_string().hash(&mut hasher);
    finding.tax.to_string().hash(&mut hasher);
    format!("{:x}", hasher.finish())
}

fn findings_hash(kind: ActivityCashIssueKind, findings: &[&ActivityCashIssueInfo]) -> String {
    let mut hasher = DefaultHasher::new();
    kind.hash(&mut hasher);
    for finding in findings {
        finding_hash(finding).hash(&mut hasher);
    }
    format!("{:x}", hasher.finish())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::health::HealthConfig;
    use rust_decimal_macros::dec;

    fn context() -> HealthContext {
        HealthContext::new(HealthConfig::default(), "USD", 1_000.0)
    }

    #[test]
    fn mismatch_warns_and_explains_that_trusted_cash_was_used() {
        let issues = ActivityCashIntegrityCheck::new().analyze(
            &[ActivityCashIssueInfo {
                kind: ActivityCashIssueKind::Mismatch,
                activity_id: "drip-buy".to_string(),
                account_name: "Brokerage".to_string(),
                activity_type: "BUY".to_string(),
                date: NaiveDate::from_ymd_opt(2026, 3, 31).unwrap(),
                currency: "USD".to_string(),
                trusted_amount: Some(dec!(0.30)),
                expected_amount: Some(dec!(0.5898108)),
                difference: Some(dec!(-0.2898108)),
                quantity: Some(dec!(0.001)),
                unit_price: Some(dec!(589.8108)),
                fee: Decimal::ZERO,
                tax: Decimal::ZERO,
            }],
            &context(),
        );

        assert_eq!(issues.len(), 1);
        assert_eq!(issues[0].severity, Severity::Warning);
        assert_eq!(issues[0].code.as_deref(), Some("activity_cash_mismatch"));
        assert!(issues[0]
            .details
            .as_deref()
            .unwrap()
            .contains("trusted totals"));
        assert_eq!(
            issues[0]
                .navigate_action
                .as_ref()
                .map(|action| action.label.as_str()),
            Some("Review Activities")
        );
    }

    #[test]
    fn missing_cash_amount_is_an_error() {
        let issues = ActivityCashIntegrityCheck::new().analyze(
            &[ActivityCashIssueInfo {
                kind: ActivityCashIssueKind::Missing,
                activity_id: "missing".to_string(),
                account_name: "Brokerage".to_string(),
                activity_type: "BUY".to_string(),
                date: NaiveDate::from_ymd_opt(2026, 3, 31).unwrap(),
                currency: "USD".to_string(),
                trusted_amount: None,
                expected_amount: None,
                difference: None,
                quantity: Some(dec!(0.001)),
                unit_price: None,
                fee: Decimal::ZERO,
                tax: Decimal::ZERO,
            }],
            &context(),
        );

        assert_eq!(issues[0].severity, Severity::Error);
        assert_eq!(
            issues[0].code.as_deref(),
            Some("activity_cash_amount_missing")
        );
    }

    #[test]
    fn findings_are_grouped_by_kind() {
        let findings: Vec<_> = (0..25)
            .map(|index| ActivityCashIssueInfo {
                kind: ActivityCashIssueKind::Mismatch,
                activity_id: format!("activity-{index}"),
                account_name: "Brokerage".to_string(),
                activity_type: "BUY".to_string(),
                date: NaiveDate::from_ymd_opt(2026, 3, 31).unwrap(),
                currency: "USD".to_string(),
                trusted_amount: Some(dec!(1)),
                expected_amount: Some(dec!(2)),
                difference: Some(dec!(-1)),
                quantity: Some(dec!(1)),
                unit_price: Some(dec!(2)),
                fee: Decimal::ZERO,
                tax: Decimal::ZERO,
            })
            .collect();

        let issues = ActivityCashIntegrityCheck::new().analyze(&findings, &context());

        assert_eq!(issues.len(), 1);
        assert_eq!(issues[0].affected_count, 25);
        assert_eq!(
            issues[0].affected_items.as_ref().map(Vec::len),
            Some(MAX_DETAILS)
        );
        assert_eq!(
            issues[0].diagnostics.as_ref().map(Vec::len),
            Some(MAX_DETAILS)
        );
    }
}
