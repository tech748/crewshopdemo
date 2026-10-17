/* Renders a LookupResult (see src/modules/lookup/types.ts). One renderer per `kind`; no branching elsewhere. */
(function () {
  const esc = (s) => String(s).replace(/[&<>"']/g, (m) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[m]));
  const rand = (c) => "R" + (c / 100).toFixed(0);
  const when = (f) => [f.portName && `<b>${esc(f.portName)}</b>`, f.deliveryDate && `delivery ${esc(f.deliveryDate)}`].filter(Boolean).join(" · ");
  const risk = (r) => ({ on_track: '<span class="badge ok">On track for your ship</span>', at_risk: '<span class="badge warn">May not be on time</span>',
    will_miss: '<span class="badge bad">Likely to miss this call</span>' }[r] || "");

  function payment(p, where) {
    if (p.status === "paid") return `<span class="badge ok">${where === "transit" ? "On the way to warehouse · Paid in Full" : "Paid in Full"}</span>`;
    if (p.awaitingStaffPricing) return `<div class="banner">We're confirming the price for this late order and will message you on WhatsApp. No payment is needed yet.</div>`;
    const lead = where === "transit" ? '<span class="badge info">On the way to warehouse</span> ' : "";
    const card = p.options.find((o) => o.type === "card"), cod = p.options.find((o) => o.type === "cod");
    return lead + `<span class="badge warn">Unpaid · ${rand(p.totalCents)}</span>` +
      (card ? (card.url ? `<a class="cta" href="${esc(card.url)}">Pay by card</a>` : `<button class="cta" disabled>Card payment link — coming soon</button>`) : "") +
      (cod ? `<div class="banner">Prefer cash? <b>Pay on Delivery (COD)</b>: ${rand(p.totalCents)} at the ship. Show your handover code to the driver.</div>` : "");
  }
  const order = (title, where) => (r) =>
    `<h2>${title}</h2><p>Order <b>${esc(r.orderCode)}</b> · ${when(r)}</p>${payment(r.payment, where)}${risk(r.arrivalRisk)}`;
  const book = (r, title, lead, cta) => `<h2>${title}</h2><p>${lead}</p><p class="muted">Base price ${rand(r.baseCents)} per parcel.</p><a class="cta" href="${esc(r.bookUrl)}">${cta}</a>`;

  const renderers = {
    in_warehouse_paid: order("Your parcel is here ✅", "warehouse"),
    in_warehouse_unpaid: order("Your parcel is here ✅", "warehouse"),
    in_transit_paid: order("On its way to us", "transit"),
    in_transit_unpaid: order("On its way to us", "transit"),
    in_warehouse_unlinked: (r) => book(r, "Your parcel is here 📦", "We have it, but there's no delivery order yet.", "Book delivery"),
    no_record: (r) => book(r, "No record of this code", "It may not have reached us yet. Declare it and book delivery now so we expect it.", "Declare parcel &amp; book delivery"),
    order_summary: (r) => `<h2>Order ${esc(r.orderCode)}</h2><p>${r.parcels.length} parcel(s) · ${when(r)}</p><ul>${r.parcels.map((p) => `<li>${esc(p.status.replace(/_/g, " "))}</li>`).join("")}</ul>${payment(r.payment, "warehouse")}${risk(r.arrivalRisk)}`,
    needs_second_factor: () => `<h2>One more detail</h2><p>This code matches more than one parcel. Add your surname below and try again.</p>`,
    invalid_code: () => `<h2>That doesn't look like a valid code</h2><p>Check for typos and try again.</p>`,
  };
  const KINDS_WITH_ORDER = ["in_warehouse_paid", "in_warehouse_unpaid", "in_transit_paid", "in_transit_unpaid", "order_summary"];

  async function fetchLookup(code, surname) {
    const q = surname ? "?surname=" + encodeURIComponent(surname) : "";
    const res = await fetch("/v1/lookup/" + encodeURIComponent(code) + q);
    if (res.status === 429) return { kind: "rate_limited" };
    return res.json();
  }
  function render(r) {
    if (r.kind === "rate_limited") return `<div class="card"><h2>Too many tries</h2><p>Please wait a minute.</p></div>`;
    const fn = renderers[r.kind];
    return `<div class="card">${fn ? fn(r) : "<h2>Something went wrong</h2>"}</div>`;
  }
  window.CrewLookup = { esc, fetchLookup, render, KINDS_WITH_ORDER, kinds: Object.keys(renderers) };
})();
