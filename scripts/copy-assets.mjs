// tsc only emits .js; the migrator and dashboard read these files at runtime.
import { cpSync } from "node:fs";

cpSync("src/db/migrations", "dist/db/migrations", { recursive: true });
cpSync("src/dashboard/dashboard.html", "dist/dashboard/dashboard.html");
