import "../src/load-env.js";
import { loadConfig } from "../src/config.js";
import { createPool } from "../src/db/pool.js";
import { migrate, resetSchema } from "../src/db/migrate.js";

const config = loadConfig();
const pool = createPool(config.databaseUrl, 2);
try {
  if (process.argv.includes("--reset")) {
    if (config.env === "production") throw new Error("refusing to reset a production database");
    await resetSchema(pool);
    console.log("schema reset");
  }
  const applied = await migrate(pool, console.log);
  console.log(applied.length ? `${applied.length} migration(s) applied` : "database is up to date");
} finally {
  await pool.end();
}
