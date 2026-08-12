import { calculateAllocationWorksheet } from "@/adapters";
import type { AccountScope, AllocationWorksheetLineInput, WorksheetCashInput } from "@/lib/types";
import { useMutation } from "@tanstack/react-query";

export interface AllocationWorksheetRequest {
  targetId: string;
  filter: AccountScope;
  cash: WorksheetCashInput;
  lines: AllocationWorksheetLineInput[];
}

export function useAllocationWorksheet() {
  return useMutation({
    mutationFn: ({ targetId, filter, cash, lines }: AllocationWorksheetRequest) =>
      calculateAllocationWorksheet(targetId, cash, lines, filter),
  });
}
