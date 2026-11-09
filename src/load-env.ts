import { existsSync } from "node:fs";

// Side-effect import for entry points: loads .env when present. Real
// environment variables win because loadEnvFile does not override them.
if (existsSync(".env")) process.loadEnvFile(".env");
