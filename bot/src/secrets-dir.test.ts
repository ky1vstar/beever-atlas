import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { loadSecretsDir } from "./secrets-dir.js";

function withTmpDir(fn: (dir: string) => void): void {
  const dir = mkdtempSync(join(tmpdir(), "secrets-test-"));
  try {
    fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe("loadSecretsDir", () => {
  it("is a no-op when dir is undefined", () => {
    const env: NodeJS.ProcessEnv = {};
    loadSecretsDir(undefined, env);
    assert.deepEqual(env, {});
  });

  it("is a no-op when the dir does not exist", () => {
    const env: NodeJS.ProcessEnv = {};
    loadSecretsDir("/nonexistent/path", env);
    assert.deepEqual(env, {});
  });

  it("loads a file's trimmed contents into the matching var", () => {
    withTmpDir((dir) => {
      writeFileSync(join(dir, "GOOGLE_API_KEY"), "AIza-secret\n");
      const env: NodeJS.ProcessEnv = {};
      loadSecretsDir(dir, env);
      assert.equal(env.GOOGLE_API_KEY, "AIza-secret");
    });
  });

  it("does not override an already-set var (env wins over secrets_dir)", () => {
    withTmpDir((dir) => {
      writeFileSync(join(dir, "GOOGLE_API_KEY"), "from-file");
      const env: NodeJS.ProcessEnv = { GOOGLE_API_KEY: "from-env" };
      loadSecretsDir(dir, env);
      assert.equal(env.GOOGLE_API_KEY, "from-env");
    });
  });

  it("skips filenames that are not valid env var names", () => {
    withTmpDir((dir) => {
      writeFileSync(join(dir, "..data"), "junk");
      writeFileSync(join(dir, "lower-case-not-var"), "junk");
      const env: NodeJS.ProcessEnv = {};
      loadSecretsDir(dir, env);
      assert.deepEqual(env, {});
    });
  });

  it("skips subdirectories", () => {
    withTmpDir((dir) => {
      mkdtempSync(join(dir, "SUBDIR_"));
      const env: NodeJS.ProcessEnv = {};
      loadSecretsDir(dir, env);
      assert.deepEqual(env, {});
    });
  });
});
