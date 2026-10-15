import { z } from "zod";

/** Environment (secrets, infra). */
const Env = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  PORT: z.coerce.number().default(3000),
  DATABASE_URL: z.string().default("postgres://localhost:5432/crew"),
  PII_ENCRYPTION_KEY: z.string().min(32).optional(),
});
export const env = Env.parse(process.env);

/**
 * Business rules. Defaults reflect decisions made with the founder.
 * Money is integer cents of ZAR to avoid float errors.
 */
export const business = {
  pricePerParcelCents: 8500, // R85
  currency: "ZAR" as const,
  defaultCutoffHours: 24, // online bookings; per-port override in `port.cutoff_hours`
  handlingBufferHours: 0, // founder: the 24h cut-off is the AGGREGATE (handling included), not stacked
  warnWindowHours: 12,
  /** null = no cap (founder decision). Kept configurable: COD is a cash-theft/no-show risk. */
  codCapCents: null as number | null,
  /** null = never auto-delete (founder decision). Erasure-on-request still supported (POPIA s24 / GDPR Art.17). */
  retentionMonths: null as number | null,
} as const;
