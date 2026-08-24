import { ActivityType } from "@/lib/constants";
import type { ActivityDetails } from "@/lib/types";

export function getMobileActivityAssetId(activity?: Partial<ActivityDetails>): string | undefined {
  return activity?.assetSymbol?.trim() || activity?.assetId?.trim() || undefined;
}

export function getMobileActivityAmount(activity?: Partial<ActivityDetails>): number | undefined {
  const magnitude = (value: string | number | null | undefined): number | undefined => {
    const parsed = Number(value);
    return Number.isFinite(parsed) && Math.abs(parsed) > 0 ? Math.abs(parsed) : undefined;
  };

  const amount = magnitude(activity?.amount);
  if (amount !== undefined) return amount;
  if (activity?.activityType === ActivityType.FEE) return magnitude(activity.fee);
  if (activity?.activityType === ActivityType.TAX) {
    return magnitude(activity.tax) ?? magnitude(activity.fee);
  }
  return undefined;
}

export function allocateInternalSecurityTransferFee(
  fee: number | null | undefined,
  _editedActivityType?: string,
): { transferOutFee: number | null | undefined; transferInFee: number | null | undefined } {
  return { transferOutFee: fee, transferInFee: null };
}
