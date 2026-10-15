import { drizzle } from "drizzle-orm/node-postgres";
import * as schema from "./schema";

// pg connects lazily, so importing this at build time does not need a database.
export const db = drizzle(process.env.DATABASE_URL!, { schema });
