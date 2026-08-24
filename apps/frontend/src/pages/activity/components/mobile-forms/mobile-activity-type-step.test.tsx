import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactNode } from "react";
import { FormProvider, useForm, type UseFormReturn } from "react-hook-form";
import { describe, expect, it, vi } from "vitest";
import { ActivityType } from "@/lib/constants";
import type { NewActivityFormValues } from "../forms/schemas";
import { MobileActivityTypeStep } from "./mobile-activity-type-step";

vi.mock("@wealthfolio/ui/components/ui/scroll-area", () => ({
  ScrollArea: ({ children }: { children: ReactNode }) => <div>{children}</div>,
}));

let form: UseFormReturn<NewActivityFormValues>;

function Harness() {
  form = useForm<NewActivityFormValues>({
    defaultValues: {
      activityType: ActivityType.BUY,
      amount: 105,
    } as NewActivityFormValues,
  });

  return (
    <FormProvider {...form}>
      <MobileActivityTypeStep />
    </FormProvider>
  );
}

describe("MobileActivityTypeStep", () => {
  it("keeps the amount when the selected type does not change", async () => {
    const user = userEvent.setup();
    render(<Harness />);

    await user.click(screen.getByRole("radio", { name: /buy/i }));

    expect(form.getValues("activityType")).toBe(ActivityType.BUY);
    expect(form.getValues("amount")).toBe(105);
  });

  it("clears an amount carried by the previously selected type", async () => {
    const user = userEvent.setup();
    render(<Harness />);

    expect(form.getValues("amount")).toBe(105);
    await user.click(screen.getByRole("radio", { name: /fee/i }));

    expect(form.getValues("activityType")).toBe(ActivityType.FEE);
    expect(form.getValues("amount")).toBeUndefined();
  });
});
