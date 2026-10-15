import { z } from "zod";
import { normaliseCode } from "../../domain/codes.js";

const e164 = z.string().regex(/^\+[1-9]\d{7,14}$/, "Phone must be in international format, e.g. +639171234567");
const parcelCode = z.string().transform((s, ctx) => {
  const n = normaliseCode(s);
  if (!n) { ctx.addIssue({ code: "custom", message: `Invalid parcel code: ${s}` }); return z.NEVER; }
  return n;
});
const person = z.object({ fullName: z.string().trim().min(2).max(120), phone: e164, email: z.string().email().optional() });

export const QuoteRequest = z.object({
  parcelCodes: z.array(parcelCode).min(1).max(20).transform((a) => [...new Set(a)]),
  portCode: z.string().min(3).max(10),
  eta: z.coerce.date(),
  promoCode: z.string().max(30).optional(),
});
export const BookingCreate = QuoteRequest.extend({
  vesselName: z.string().trim().min(2).max(80),
  vesselImo: z.string().regex(/^\d{7}$/).optional(),
  recipient: person,
  payer: person.optional(), // omitted = payer is the recipient
  paymentMethod: z.enum(["prepaid", "cod"]),
  consent: z.object({ transactional: z.literal(true), marketing: z.boolean().default(false), wordingVersion: z.string().min(1) }),
  requestManualReview: z.boolean().default(false),
  source: z.enum(["web", "whatsapp", "partner", "staff"]).default("web"),
});
export type BookingCreateInput = z.infer<typeof BookingCreate>;
export type QuoteRequestInput = z.infer<typeof QuoteRequest>;
