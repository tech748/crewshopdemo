export type ArrivalRisk = "on_track" | "at_risk" | "will_miss";

export interface RiskInput {
  now: Date;
  vesselEta: Date;
  cutoffHours: number;
  handlingBufferHours: number;
  warnWindowHours: number;
  parcelReceived: boolean;
  /** Customer/sender estimate of warehouse arrival; undefined = unknown (widest uncertainty). */
  expectedWarehouseArrival?: Date;
}
const H = 3_600_000;

/**
 * Parcel must be in warehouse by (ETA - cutoff). Not-yet-received parcels also need the
 * handling buffer on top of their expected arrival.
 */
export function arrivalRisk(i: RiskInput): ArrivalRisk {
  if (i.parcelReceived) return "on_track";
  const deadline = i.vesselEta.getTime() - i.cutoffHours * H;
  const now = i.now.getTime();
  if (now >= deadline) return "will_miss";
  if (!i.expectedWarehouseArrival) {
    return "at_risk"; // unknown warehouse arrival is never "on_track"
  }
  const ready = i.expectedWarehouseArrival.getTime() + i.handlingBufferHours * H;
  if (ready > deadline) return "will_miss";
  if (ready > deadline - i.warnWindowHours * H) return "at_risk";
  return "on_track";
}
