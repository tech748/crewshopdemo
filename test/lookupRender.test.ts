import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import vm from "node:vm";

// Load the browser renderer in a sandbox and check every LookupResult kind renders the content its scenario requires.
const win: Record<string, any> = {};
vm.runInNewContext(readFileSync("public/assets/lookup-render.js", "utf8"), { window: win, fetch: () => { throw new Error("no network"); } });
const { render, kinds } = win.CrewLookup as { render: (r: unknown) => string; kinds: string[] };
const facts = { orderCode: "CRK7M2QX", portName: "Durban", deliveryDate: "2026-11-01", arrivalRisk: "on_track" };
const paid = { status: "paid", totalCents: 17000, currency: "ZAR", options: [], awaitingStaffPricing: false };
const unpaid = { status: "unpaid", totalCents: 17000, currency: "ZAR", options: [{ type: "card", url: null }, { type: "cod" }], awaitingStaffPricing: false };

describe("lookup renderer (render-by-kind)", () => {
  it("has a renderer for every kind in the union", () =>
    expect(kinds.sort()).toEqual(["in_transit_paid", "in_transit_unpaid", "in_warehouse_paid", "in_warehouse_unlinked", "in_warehouse_unpaid",
      "invalid_code", "needs_second_factor", "no_record", "order_summary"]));
  it("1: here + paid shows port, date, Paid in Full", () => {
    const h = render({ kind: "in_warehouse_paid", ...facts, payment: paid });
    expect(h).toContain("Durban"); expect(h).toContain("2026-11-01"); expect(h).toContain("Paid in Full");
  });
  it("2: here + unpaid shows card payment and Pay on Delivery (COD)", () => {
    const h = render({ kind: "in_warehouse_unpaid", ...facts, payment: unpaid });
    expect(h).toContain("Card payment link"); expect(h).toContain("Pay on Delivery (COD)"); expect(h).toContain("Durban");
  });
  it("2: a real Paystack url becomes a Pay by card link", () => {
    const h = render({ kind: "in_warehouse_unpaid", ...facts, payment: { ...unpaid, options: [{ type: "card", url: "https://paystack.com/pay/x" }, { type: "cod" }] } });
    expect(h).toContain('href="https://paystack.com/pay/x"'); expect(h).toContain("Pay by card");
  });
  it("3: in transit + paid", () => expect(render({ kind: "in_transit_paid", ...facts, payment: paid })).toContain("On the way to warehouse · Paid in Full"));
  it("4: in transit + unpaid shows on-the-way, card and COD", () => {
    const h = render({ kind: "in_transit_unpaid", ...facts, payment: unpaid });
    expect(h).toContain("On the way to warehouse"); expect(h).toContain("Pay on Delivery (COD)"); expect(h).toContain("Durban");
  });
  it("5: unlinked in warehouse links to the prefilled R85 form", () => {
    const h = render({ kind: "in_warehouse_unlinked", bookUrl: "/book?code=X1", prefill: { parcelCodes: ["X1"] }, baseCents: 8500 });
    expect(h).toContain('href="/book?code=X1"'); expect(h).toContain("R85");
  });
  it("6: no record links to the declare form", () => expect(render({ kind: "no_record", bookUrl: "/book?code=X2", baseCents: 8500 })).toContain("Declare parcel"));
  it("manual-review order shows no pay options, only the pending-price notice", () => {
    const h = render({ kind: "in_warehouse_unpaid", ...facts, payment: { ...unpaid, options: [], awaitingStaffPricing: true } });
    expect(h).not.toContain("Pay by card"); expect(h).not.toContain("COD"); expect(h).toContain("confirming the price");
  });
  it("escapes HTML in server-provided strings", () =>
    expect(render({ kind: "in_warehouse_paid", ...facts, portName: "<img src=x onerror=alert(1)>", payment: paid })).not.toContain("<img"));
  it("rate-limit response renders", () => expect(render({ kind: "rate_limited" })).toContain("Too many tries"));
});
