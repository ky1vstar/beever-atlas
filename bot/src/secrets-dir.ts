/**
 * Docker/Swarm secrets loader (BEEVER_SECRETS_DIR).
 *
 * Node has no built-in equivalent of pydantic-settings' `secrets_dir`, so this
 * mirrors the backend's behavior: each file in the directory is read as one
 * env var — filename is the var name, file contents (trimmed) is the value.
 * Lowest priority — only applied when the var isn't already set, matching the
 * backend's env > .env > secrets_dir precedence. Call AFTER `dotenv.config()`.
 */

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

const VALID_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

export function loadSecretsDir(dir: string | undefined, env: NodeJS.ProcessEnv = process.env): void {
  if (!dir) return;
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch (err) {
    console.warn(`[secrets] BEEVER_SECRETS_DIR=${dir} is not readable: ${(err as Error).message}`);
    return;
  }
  for (const name of entries) {
    if (!VALID_NAME.test(name) || env[name] !== undefined) continue;
    const path = join(dir, name);
    try {
      if (!statSync(path).isFile()) continue;
      env[name] = readFileSync(path, "utf8").trim();
    } catch (err) {
      console.warn(`[secrets] failed to read ${path}: ${(err as Error).message}`);
    }
  }
}
