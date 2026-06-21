import dotenv from "dotenv";
import { resolve } from "node:path";

// Load env before anything reads process.env (db.ts / auth.ts build their
// clients at import time). `npm run -w` runs with cwd = apps/api, while the
// prod `start` script runs from the repo root, so load both the workspace .env
// and the monorepo-root .env. dotenv never overrides already-set vars, so the
// real process env and the nearest .env win.
dotenv.config();
dotenv.config({ path: resolve(process.cwd(), "../../.env") });
