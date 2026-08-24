import { DECIMAL_PRECISION } from "@/lib/constants";
import { roundDecimal } from "@/lib/utils";
import { useAmountFormatting } from "@wealthfolio/ui";
import { useEffect, useMemo, useRef, useState } from "react";
import { useFormContext, useFormState } from "react-hook-form";
import { useTranslation } from "react-i18next";
import { AmountInput } from "./amount-input";

interface TradeTotalInputProps {
  side: "buy" | "sell" | "income";
  calculatedAmount: number;
  initialAmount?: number | null;
  initialAmountMode?: "calculated" | "custom";
  currency?: string;
  variant?: "desktop" | "mobile";
  label?: string;
  helpText?: string;
  "data-testid"?: string;
}

interface TradeTotalFormValues {
  amount?: number | null;
  amountMode?: "calculated" | "custom";
  amountConfirmed?: boolean;
}

/**
 * A trade's final cash total. New values follow the trade calculation until the
 * user edits the total; supplied/imported totals remain authoritative.
 */
export function TradeTotalInput({
  side,
  calculatedAmount,
  initialAmount,
  initialAmountMode,
  currency,
  variant = "desktop",
  label: labelOverride,
  helpText: helpTextOverride,
  "data-testid": dataTestId,
}: TradeTotalInputProps) {
  const { t } = useTranslation(["activity"]);
  const formatting = useAmountFormatting();
  const { control, getFieldState, resetField, setValue, watch } =
    useFormContext<TradeTotalFormValues>();
  const formState = useFormState({ control, name: "amount" });
  const amount = watch("amount");
  const hasInitialAmount = Number(initialAmount) > 0;
  const initialIsCustom = hasInitialAmount && initialAmountMode !== "calculated";
  const [preserveInitialAmount, setPreserveInitialAmount] = useState(initialIsCustom);
  const hasInitializedAmount = useRef(false);
  const previousCalculatedAmount = useRef(calculatedAmount);

  const normalizedCalculatedAmount = useMemo(() => {
    if (!Number.isFinite(calculatedAmount) || calculatedAmount === 0) return undefined;
    return roundDecimal(Math.abs(calculatedAmount), DECIMAL_PRECISION);
  }, [calculatedAmount]);

  const hasEnteredAmount = Number(amount) > 0;
  const isCustom =
    hasEnteredAmount && (preserveInitialAmount || getFieldState("amount", formState).isDirty);

  useEffect(() => {
    setPreserveInitialAmount(initialIsCustom);
    setValue("amountMode", initialIsCustom ? "custom" : "calculated");
    setValue("amountConfirmed", false);
    if (!hasInitializedAmount.current && !initialIsCustom) {
      resetField("amount", { defaultValue: normalizedCalculatedAmount });
    }
    hasInitializedAmount.current = true;
  }, [initialAmount, initialIsCustom, normalizedCalculatedAmount, resetField, setValue]);

  useEffect(() => {
    if (previousCalculatedAmount.current === calculatedAmount) return;
    previousCalculatedAmount.current = calculatedAmount;
    setPreserveInitialAmount(false);
    setValue("amountMode", "calculated");
    setValue("amountConfirmed", false);
    resetField("amount", { defaultValue: normalizedCalculatedAmount });
  }, [calculatedAmount, normalizedCalculatedAmount, resetField, setValue]);

  const useCalculatedTotal = () => {
    setPreserveInitialAmount(false);
    setValue("amountMode", "calculated");
    setValue("amountConfirmed", false);
    resetField("amount", { defaultValue: normalizedCalculatedAmount });
  };

  const label =
    labelOverride ??
    (side === "buy" ? t("activity:form.total_debit") : t("activity:form.total_credit"));
  const helpText =
    helpTextOverride ??
    (side === "buy" ? t("activity:form.help_total_debit") : t("activity:form.help_total_credit"));
  const numericAmount = Number(amount);
  const displayedAmount = numericAmount > 0 ? numericAmount : normalizedCalculatedAmount;
  const formattedCalculatedAmount = normalizedCalculatedAmount
    ? formatting.formatAmount(normalizedCalculatedAmount, currency ?? "", Boolean(currency))
    : null;

  return (
    <div className={variant === "mobile" ? "space-y-1.5" : "space-y-1"}>
      <AmountInput<TradeTotalFormValues>
        name="amount"
        label={label}
        labelHelpText={helpText}
        currency={currency}
        placeholder={normalizedCalculatedAmount?.toString() ?? "0.00"}
        data-testid={dataTestId}
        onValueChange={(value) => {
          if (value == null) {
            setPreserveInitialAmount(false);
            setValue("amountMode", "calculated");
            setValue("amountConfirmed", false);
          } else {
            setValue("amountMode", "custom");
            setValue("amountConfirmed", true);
          }
        }}
        onBlur={() => {
          if (!hasEnteredAmount) {
            resetField("amount", { defaultValue: normalizedCalculatedAmount });
          }
        }}
      />
      <div className="text-muted-foreground flex min-h-5 flex-wrap items-center gap-x-2 text-xs">
        <span>
          {isCustom ? t("activity:form.total_custom") : t("activity:form.total_calculated")}
        </span>
        {isCustom && formattedCalculatedAmount && (
          <>
            <span aria-hidden="true">·</span>
            <span>
              {t("activity:form.calculated_from_trade", {
                amount: formattedCalculatedAmount,
              })}
            </span>
            <button
              type="button"
              className="text-primary hover:text-primary/80 font-medium underline-offset-4 hover:underline"
              onClick={useCalculatedTotal}
            >
              {t("activity:form.use_calculated_total")}
            </button>
          </>
        )}
      </div>
      {side !== "income" && displayedAmount && displayedAmount > 0 ? (
        <p className="text-muted-foreground text-xs">
          {t("activity:form.cash_effect")}: {side === "buy" || calculatedAmount < 0 ? "−" : "+"}
          {formatting.formatAmount(displayedAmount, currency ?? "", Boolean(currency))}
        </p>
      ) : null}
    </div>
  );
}
