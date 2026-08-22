import { ActivityType } from "@/lib/constants";
import type { ActivityDetails } from "@/lib/types";

export function getMobileActivityAssetId(activity?: Partial<ActivityDetails>): string | undefined {
  return activity?.assetSymbol?.trim() || activity?.assetId?.trim() || undefined;
}

export function allocateInternalSecurityTransferFee(
  fee: number | null | undefined,
  editedActivityType?: string,
): { transferOutFee: number | null | undefined; transferInFee: number | null | undefined } {
  return editedActivityType === ActivityType.TRANSFER_IN
    ? { transferOutFee: undefined, transferInFee: fee }
    : { transferOutFee: fee, transferInFee: undefined };
}
