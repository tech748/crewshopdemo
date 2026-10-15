import pg from "pg";
import { env } from "../config.js";
export const pool = new pg.Pool({ connectionString: env.DATABASE_URL });
export type Db = Pick<pg.Pool, "query">;
