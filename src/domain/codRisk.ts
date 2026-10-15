/** System FLAGS only. A human approves or declines (founder decision: no hard cap). */
export interface CodRiskInput {
  totalCents: number;
  recipientPriorCompletedOrders: number;
  vesselEtaWithinHours: number; // hours from now until ETA
  softThresholdCents: number | null; // null = no value flag
}
export function codRiskFlags(i: CodRiskInput): string[] {
  const f: string[] = [];
  if (i.recipientPriorCompletedOrders === 0) f.push("first_time_recipient");
  if (i.softThresholdCents !== null && i.totalCents > i.softThresholdCents) f.push("high_value");
  if (i.vesselEtaWithinHours < 48) f.push("tight_eta");
  return f;
}
