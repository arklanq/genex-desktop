/**
 * A game's `backend` declaration in studio.json. The file sits in a folder agents write, so a
 * declaration that is not plain is refused with a reason, never half-used.
 */
import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, it } from "node:test";
import {
  DEFAULT_BACKEND_BOOT_MS,
  DEFAULT_BACKEND_HEALTH,
  MAX_BACKEND_BOOT_MS,
  MIN_BACKEND_BOOT_MS,
} from "../../src/shared/game-backend.ts";
import { parseBackendDeclaration, readBackendDeclaration } from "../../src/substrate/game-backend-spec.ts";
import { tmpDir } from "../helpers/tmp.ts";

describe("a game's backend declaration", () => {
  it("reads a plain declaration, filling the health path, docker and boot time it leaves out", () => {
    assert.deepEqual(parseBackendDeclaration({ command: " bun run server ", port: 3001 }), {
      declared: true,
      spec: {
        command: "bun run server",
        port: 3001,
        health: DEFAULT_BACKEND_HEALTH,
        docker: false,
        bootMs: DEFAULT_BACKEND_BOOT_MS,
      },
    });
    assert.deepEqual(
      parseBackendDeclaration({ command: "bun x", port: 8787, health: "/api/health", docker: true, bootMs: 90_000 }),
      {
        declared: true,
        spec: { command: "bun x", port: 8787, health: "/api/health", docker: true, bootMs: 90_000 },
      },
    );
  });

  it("clamps the boot time to its range", () => {
    const short = parseBackendDeclaration({ command: "x", port: 3001, bootMs: 1 });
    const long = parseBackendDeclaration({ command: "x", port: 3001, bootMs: 10 * MAX_BACKEND_BOOT_MS });
    assert.ok("spec" in short && "spec" in long);
    assert.equal(short.spec.bootMs, MIN_BACKEND_BOOT_MS);
    assert.equal(long.spec.bootMs, MAX_BACKEND_BOOT_MS);
  });

  it("declares nothing when the field is absent or null", () => {
    assert.deepEqual(parseBackendDeclaration(undefined), { declared: false });
    assert.deepEqual(parseBackendDeclaration(null), { declared: false });
  });

  it("refuses a declaration it cannot use, naming the field", () => {
    const cases: Array<[unknown, RegExp]> = [
      ["bun run server", /must be an object/],
      [[{ command: "x", port: 3001 }], /must be an object/],
      [{ port: 3001 }, /backend\.command/],
      [{ command: "   ", port: 3001 }, /backend\.command/],
      [{ command: 42, port: 3001 }, /backend\.command/],
      [{ command: "x".repeat(1001), port: 3001 }, /backend\.command/],
      [{ command: "x" }, /backend\.port/],
      [{ command: "x", port: "3001" }, /backend\.port/],
      [{ command: "x", port: 3001.5 }, /backend\.port/],
      // Below 1024 needs root; from 40000 up the preview serves bundled games' files.
      [{ command: "x", port: 80 }, /backend\.port/],
      [{ command: "x", port: 1023 }, /backend\.port/],
      [{ command: "x", port: 40000 }, /backend\.port/],
      [{ command: "x", port: 65535 }, /backend\.port/],
      [{ command: "x", port: 3001, health: "health" }, /backend\.health/],
      [{ command: "x", port: 3001, health: "/health?x=1" }, /backend\.health/],
      [{ command: "x", port: 3001, health: "//attacker.example/" }, /backend\.health/],
      [{ command: "x", port: 3001, health: "/a b" }, /backend\.health/],
      [{ command: "x", port: 3001, docker: "yes" }, /backend\.docker/],
      [{ command: "x", port: 3001, bootMs: "60s" }, /backend\.bootMs/],
      [{ command: "x", port: 3001, bootMs: Number.NaN }, /backend\.bootMs/],
    ];
    for (const [raw, reason] of cases) {
      const declaration = parseBackendDeclaration(raw);
      assert.ok("problem" in declaration, JSON.stringify(raw));
      assert.match(declaration.problem, reason, JSON.stringify(raw));
    }
  });

  it("reads the declaration from the game folder's studio.json, and none from a folder without one", async () => {
    const dir = await tmpDir("studio-backend-spec-");
    assert.deepEqual(await readBackendDeclaration(dir), { declared: false });
    await writeFile(path.join(dir, "studio.json"), "{ not json");
    assert.deepEqual(await readBackendDeclaration(dir), { declared: false });
    await writeFile(
      path.join(dir, "studio.json"),
      JSON.stringify({ backend: { command: "bun run server", port: 3001 } }),
    );
    const declaration = await readBackendDeclaration(dir);
    assert.ok("spec" in declaration);
    assert.equal(declaration.spec.port, 3001);
  });
});
