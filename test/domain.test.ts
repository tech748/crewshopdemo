import { describe, it, expect } from "vitest";
import { nextParcelStatus, nextOrderStatus, IllegalTransition } from "../src/domain/stateMachine.js";
import { arrivalRisk } from "../src/domain/arrivalRisk.js";
import { normaliseCode, generateOrderCode } from "../src/domain/codes.js";

describe("state machines", () => {
  it("walks the happy parcel path", () => {
    let s = nextParcelStatus("expected", "receive");
    s = nextParcelStatus(s, "mark_ready"); s = nextParcelStatus(s, "dispatch");
    expect(nextParcelStatus(s, "deliver")).toBe("delivered");
  });
  it("rejects illegal transitions", () => {
    expect(() => nextParcelStatus("delivered", "receive")).toThrow(IllegalTransition);
    expect(() => nextOrderStatus("draft", "payment_received")).toThrow(IllegalTransition);
  });
  it("manual review must be approved before payment", () => {
    expect(nextOrderStatus("manual_review", "approve_manual")).toBe("awaiting_payment");
  });
  it("COD needs recipient verification", () => {
    expect(nextOrderStatus("draft", "submit_cod")).toBe("cod_pending_verification");
    expect(nextOrderStatus("cod_pending_verification", "recipient_verified")).toBe("confirmed");
  });
});

const base = { cutoffHours: 24, handlingBufferHours: 24, warnWindowHours: 12, parcelReceived: false };
const d = (iso: string) => new Date(iso);
describe("arrivalRisk", () => {
  const eta = d("2026-11-10T12:00:00Z"); // deadline = 9 Nov 12:00
  it("received parcel is on track", () =>
    expect(arrivalRisk({ ...base, now: d("2026-11-09T20:00:00Z"), vesselEta: eta, parcelReceived: true })).toBe("on_track"));
  it("past deadline and not received = will_miss", () =>
    expect(arrivalRisk({ ...base, now: d("2026-11-09T12:00:00Z"), vesselEta: eta })).toBe("will_miss"));
  it("expected arrival + 24h buffer beyond deadline = will_miss", () =>
    expect(arrivalRisk({ ...base, now: d("2026-11-01T00:00:00Z"), vesselEta: eta, expectedWarehouseArrival: d("2026-11-08T18:00:00Z") })).toBe("will_miss"));
  it("comfortably early = on_track", () =>
    expect(arrivalRisk({ ...base, now: d("2026-11-01T00:00:00Z"), vesselEta: eta, expectedWarehouseArrival: d("2026-11-04T00:00:00Z") })).toBe("on_track"));
  it("tight margin = at_risk", () =>
    expect(arrivalRisk({ ...base, now: d("2026-11-01T00:00:00Z"), vesselEta: eta, expectedWarehouseArrival: d("2026-11-08T06:00:00Z") })).toBe("at_risk"));
  it("unknown arrival is never on_track", () =>
    expect(arrivalRisk({ ...base, now: d("2026-11-01T00:00:00Z"), vesselEta: eta })).toBe("at_risk"));
});

describe("codes", () => {
  it("normalises", () => expect(normaliseCode(" 1z 999-aa1 0123456784 ")).toBe("1Z999AA10123456784"));
  it("rejects junk", () => expect(normaliseCode("ab")).toBeNull());
  it("order codes avoid ambiguous chars", () => {
    for (let i = 0; i < 200; i++) expect(generateOrderCode()).toMatch(/^CR[2-9A-HJKMNP-Z]{6}$/);
  });
});

import { codRiskFlags } from "../src/domain/codRisk.js";
describe("codRiskFlags", () => {
  it("flags first-time and tight ETA; never blocks", () =>
    expect(codRiskFlags({ totalCents: 8500, recipientPriorCompletedOrders: 0, vesselEtaWithinHours: 30, softThresholdCents: null }))
      .toEqual(["first_time_recipient", "tight_eta"]));
  it("no flags for a repeat customer with time", () =>
    expect(codRiskFlags({ totalCents: 8500, recipientPriorCompletedOrders: 3, vesselEtaWithinHours: 200, softThresholdCents: null })).toEqual([]));
});
