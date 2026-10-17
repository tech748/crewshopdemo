/**
 * Public lookup contract. `kind` is the discriminant; the UI renders by kind (public/assets/lookup-render.js).
 * Scenarios 1-6 map to the order-linked / unlinked kinds below. No PII is ever returned (no names, no addresses).
 */
export interface PaymentInfo {
  status: "paid" | "unpaid";
  totalCents: number;
  currency: string;
  /** Unpaid only. `card` url is null until Paystack lands (M7). Empty while an order awaits staff pricing. */
  options: ({ type: "card"; url: string | null } | { type: "cod" })[];
  awaitingStaffPricing: boolean;
}
export interface OrderFacts {
  orderCode: string;
  portName: string | null;
  deliveryDate: string | null; // ISO date of the vessel ETA at the port
  arrivalRisk: string | null;
  payment: PaymentInfo;
}
export type LookupResult =
  | ({ kind: "in_warehouse_paid" } & OrderFacts)           // 1
  | ({ kind: "in_warehouse_unpaid" } & OrderFacts)         // 2 (COD or card)
  | ({ kind: "in_transit_paid" } & OrderFacts)             // 3
  | ({ kind: "in_transit_unpaid" } & OrderFacts)           // 4
  | { kind: "in_warehouse_unlinked"; bookUrl: string; prefill: { parcelCodes: string[] }; baseCents: number } // 5
  | { kind: "no_record"; bookUrl: string; baseCents: number }                                              // 6
  | ({ kind: "order_summary"; parcels: { status: string }[] } & OrderFacts) // customer typed our own order code
  | { kind: "needs_second_factor" }
  | { kind: "invalid_code" };
export type LookupKind = LookupResult["kind"];
