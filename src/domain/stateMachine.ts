/** Single place where lifecycle transitions are validated. */
export type ParcelStatus =
  | "expected" | "in_transit" | "received" | "ready"
  | "out_for_delivery" | "delivered" | "exception";
export type ParcelEvent =
  | "declare_in_transit" | "receive" | "mark_ready" | "dispatch"
  | "deliver" | "raise_exception" | "resolve_exception";

const parcelTable: Record<ParcelStatus, Partial<Record<ParcelEvent, ParcelStatus>>> = {
  expected: { declare_in_transit: "in_transit", receive: "received", raise_exception: "exception" },
  in_transit: { receive: "received", raise_exception: "exception" },
  received: { mark_ready: "ready", raise_exception: "exception" },
  ready: { dispatch: "out_for_delivery", raise_exception: "exception" },
  out_for_delivery: { deliver: "delivered", raise_exception: "exception" },
  delivered: {},
  exception: { resolve_exception: "received" },
};

export class IllegalTransition extends Error {
  constructor(public entity: string, public from: string, public event: string) {
    super(`Illegal ${entity} transition: ${from} --${event}-->`);
  }
}

export function nextParcelStatus(from: ParcelStatus, event: ParcelEvent): ParcelStatus {
  const to = parcelTable[from][event];
  if (!to) throw new IllegalTransition("parcel", from, event);
  return to;
}

export type OrderStatus =
  | "draft" | "manual_review" | "awaiting_payment" | "cod_pending_verification"
  | "confirmed" | "completed" | "cancelled" | "refunded";
export type OrderEvent =
  | "submit_prepaid" | "submit_cod" | "flag_manual" | "approve_manual"
  | "payment_received" | "recipient_verified" | "complete" | "cancel" | "refund";

const orderTable: Record<OrderStatus, Partial<Record<OrderEvent, OrderStatus>>> = {
  draft: { submit_prepaid: "awaiting_payment", submit_cod: "cod_pending_verification", flag_manual: "manual_review", cancel: "cancelled" },
  manual_review: { approve_manual: "awaiting_payment", cancel: "cancelled" },
  awaiting_payment: { payment_received: "confirmed", cancel: "cancelled" },
  cod_pending_verification: { recipient_verified: "confirmed", cancel: "cancelled" },
  confirmed: { complete: "completed", cancel: "cancelled", refund: "refunded" },
  completed: { refund: "refunded" },
  cancelled: {},
  refunded: {},
};

export function nextOrderStatus(from: OrderStatus, event: OrderEvent): OrderStatus {
  const to = orderTable[from][event];
  if (!to) throw new IllegalTransition("order", from, event);
  return to;
}
