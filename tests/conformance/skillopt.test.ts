/**
 * The SkillOpt outer loop.
 *
 * Two halves are tested: the bounded edit operations (which must never scribble outside their
 * anchors or inside a protected region), and the loop itself — analyst → merge → rank → apply →
 * **gate**, with rejected edits going into a step buffer so dead ideas stop coming back.
 *
 * The gate is the part that makes self-improvement trustworthy rather than hopeful: a candidate
 * that does not clearly win is rejected, and in solo phase an accepted candidate is *staged* for
 * Simeon rather than applied behind his back.
 */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, it } from "node:test";
import { applyEdits, loadSkills, parseSkill } from "../../src/harness-seed/loop/skills.ts";
import { rankEdits, mineValidationTasks, runSkillOpt } from "../../src/harness-seed/loop/skillopt.ts";
import { parseVerdict } from "../../src/harness-seed/loop/judge.ts";
import { customEvents, startRig, waitForLog, type Rig } from "../helpers/studio-rig.ts";
import { studioActivity } from "../../src/shared/studio-activity.ts";
import { tmpDir } from "../helpers/tmp.ts";
import type { FakeReply } from "../helpers/fake-ollama.ts";

const rigs: Rig[] = [];
// Finished scenarios must release their harness and HTTP server before the next
// scenario starts. Cleanup failures are test failures, not ignored background work.
afterEach(async () => {
  for (const rig of rigs.splice(0)) {
    await rig.stop();
    assert.equal(rig.core.host.state, "stopped", "the scenario releases its harness before the next test");
  }
});

// `trainable: true` opts a skill into SkillOpt; the v2 seed marks only the planner's skill.
const SKILL = `---
name: Test skill
description: a skill under optimisation
trainable: true
---

# Rules

- Keep the camera behind the player.

<!-- SLOW_UPDATE -->
Protected: the studio contract must not be edited by an optimisation step.
<!-- SLOW_UPDATE -->

## Notes
`;

describe("bounded edit operations", () => {
  it("applies the four anchored operations", () => {
    const appended = applyEdits(SKILL, [{ op: "append", text: "- New rule: clamp pitch to ±35°." }]);
    assert.equal(appended.applied.length, 1);
    assert.match(appended.text, /clamp pitch to ±35°\.\n$/);

    const inserted = applyEdits(SKILL, [
      { op: "insert_after", anchor: "- Keep the camera behind the player.", text: "- Interpolate camera motion." },
    ]);
    assert.match(inserted.text, /behind the player\.\n- Interpolate camera motion\./);

    const replaced = applyEdits(SKILL, [
      { op: "replace", anchor: "Keep the camera behind the player.", text: "Keep the camera 6–8 units behind." },
    ]);
    assert.match(replaced.text, /6–8 units behind/);
    assert.ok(!replaced.text.includes("behind the player."));

    const deleted = applyEdits(SKILL, [{ op: "delete", anchor: "- Keep the camera behind the player.\n" }]);
    assert.ok(!deleted.text.includes("Keep the camera behind"));
  });

  it("rejects an anchored edit with no anchor — it once landed above the frontmatter", () => {
    const result = applyEdits(SKILL, [
      { op: "insert_after", text: "- Stray rule." },
      { op: "replace", anchor: "  ", text: "x" },
    ]);
    assert.equal(result.applied.length, 0);
    assert.equal(result.text, SKILL);
    assert.match(String(result.rejected[0]!.reason), /needs an anchor/);
  });

  it("rejects an edit whose anchor no longer exists instead of guessing", () => {
    const result = applyEdits(SKILL, [{ op: "replace", anchor: "text that drifted away", text: "x" }]);
    assert.equal(result.applied.length, 0);
    assert.equal(result.text, SKILL, "a failed edit must leave the file untouched");
    assert.match(String(result.rejected[0]!.reason), /anchor not found/);
  });

  it("refuses to edit inside a SLOW_UPDATE region", () => {
    const result = applyEdits(SKILL, [
      { op: "replace", anchor: "Protected: the studio contract must not be edited", text: "hijacked" },
    ]);
    assert.equal(result.applied.length, 0);
    assert.match(String(result.rejected[0]!.reason), /protected region/);
    assert.match(result.text, /Protected: the studio contract/);
  });

  it("applies a batch in order and reports partial success honestly", () => {
    const result = applyEdits(SKILL, [
      { op: "append", text: "- one" },
      { op: "replace", anchor: "nonexistent", text: "two" },
      { op: "append", text: "- three" },
    ]);
    assert.equal(result.applied.length, 2);
    assert.equal(result.rejected.length, 1);
    assert.ok(result.text.indexOf("- one") < result.text.indexOf("- three"));
  });

  it("parses skill frontmatter for the prompt index", () => {
    const skill = parseSkill(SKILL);
    assert.equal(skill.name, "Test skill");
    assert.equal(skill.description, "a skill under optimisation");
    assert.match(skill.body, /^# Rules/);
  });
});

describe("ranking and task mining", () => {
  it("puts failure-driven, concrete edits first", () => {
    const ranked = rankEdits([
      { op: "append", text: "be careful" },
      { op: "replace", anchor: "x", text: "clamp to 35 degrees", priority: "failure" },
      { op: "insert_after", anchor: "y", text: "keep fps above 50" },
    ]);
    assert.equal(ranked[0]!.priority, "failure");
    assert.equal(ranked.at(-1)!.text, "be careful", "vague advice ranks last");
  });

  it("mines replayable sub-tasks from what actually happened", () => {
    const events = [
      {
        data: {
          type: "custom",
          event_type: "run_iteration",
          payload: { iteration: 1, biggest_gap: "no impact feedback", winner: "incumbent", consoleErrors: [] },
        },
      },
      {
        data: {
          type: "custom",
          event_type: "run_iteration",
          payload: { iteration: 2, biggest_gap: "camera too far", winner: "challenger" },
        },
      },
      { data: { type: "messages", messages: [] } },
    ];
    const tasks = mineValidationTasks(events as never, 10);
    assert.equal(tasks.length, 2);
    assert.equal(tasks[0]!.success, false);
    assert.equal(tasks[1]!.success, true);
    assert.equal(tasks[0]!.prompt, "no impact feedback");
  });

  it("never hands a win to an unparseable judge", () => {
    assert.equal(parseVerdict("I think A is nicer, honestly").pick, "tie");
    assert.equal(parseVerdict('```json\n{"pick":"A","biggest_gap":"g"}\n```').pick, "A");
    assert.equal(parseVerdict('sure: {"pick":"B"} — hope that helps').pick, "B");
  });
});

// ── the loop, driven through the real harness process ────────────────────────────────────────
interface SkillOptScript {
  edits: Array<{ op: string; text?: string; anchor?: string }>;
  gate: "accept" | "reject";
}

function makeResponder(script: SkillOptScript) {
  const counts = { analyst: 0, gate: 0 };
  return {
    counts,
    respond: (request: { messages: Array<{ role: string; content: string }> }): FakeReply | null => {
      const text = request.messages.map((m) => m.content).join("\n");
      if (text.includes("SKILL FILE")) {
        counts.analyst++;
        // Only the skill under test gets proposals; the others are left alone, exactly as an
        // analyst with nothing to say about them would behave.
        const target = text.includes("SKILL FILE (threejs-craft.md)");
        return {
          text: JSON.stringify({ edits: target ? script.edits : [], rationale: "scripted analysis" }),
        };
      }
      if (text.includes("VERSION A") && text.includes("VERSION B")) {
        counts.gate++;
        // The candidate is the version carrying the proposed edit. Sections are extracted
        // explicitly: the versions are shuffled per vote, so the judge must recognise the
        // candidate by the edit's own text — matching a hardcoded phrase here once made every
        // test whose edit used different wording a literal coin flip.
        const sectionA = text.split("VERSION A:")[1]?.split("VERSION B:")[0] ?? "";
        const aIsCandidate = script.edits.some((edit) => edit.text && sectionA.includes(edit.text));
        const pick = script.gate === "accept" ? (aIsCandidate ? "A" : "B") : aIsCandidate ? "B" : "A";
        return { text: JSON.stringify({ pick, reason: "scripted gate" }) };
      }
      return { text: "ok" };
    },
  };
}

async function runSkillOptRig(
  script: SkillOptScript,
  prepare?: (rig: Rig) => Promise<void>,
): Promise<{ rig: Rig; counts: { analyst: number; gate: number } }> {
  const { respond, counts } = makeResponder(script);
  const rig = await startRig({ respond });
  rigs.push(rig);
  await prepare?.(rig);

  // Give the studio a single skill to optimise and a run history to learn from.
  const skillsDir = path.join(rig.core.layout.harnessWs, "skills");
  for (const name of ["game-contract", "threejs-craft", "unattended-runs", "self-improvement"]) {
    await writeFile(
      path.join(skillsDir, `${name}.md`),
      name === "threejs-craft" ? SKILL : "---\nname: x\ndescription: y\n---\n",
    );
  }
  await rig.core.append([
    {
      type: "custom",
      event_type: "run_iteration",
      payload: { iteration: 1, biggest_gap: "camera swings wildly on impact", winner: "incumbent", consoleErrors: [] },
    },
    {
      type: "custom",
      event_type: "run_iteration",
      payload: { iteration: 2, biggest_gap: "camera still swings", winner: "incumbent", consoleErrors: [] },
    },
    {
      type: "custom",
      event_type: "run_iteration",
      payload: { iteration: 3, biggest_gap: "rings hard to see", winner: "challenger" },
    },
    {
      type: "custom",
      event_type: "run_iteration",
      payload: { iteration: 4, biggest_gap: "ring contrast fixed", winner: "challenger" },
    },
  ]);
  await rig.core.host.dispatch({ type: "skillopt_start", threadId: rig.core.mainThread }, 90_000);
  return { rig, counts };
}

describe("skillopt: the gate", () => {
  it("stages an accepted proposal for review instead of editing the live skill", async () => {
    const { rig, counts } = await runSkillOptRig(
      {
        edits: [{ op: "append", text: "- Clamp pitch to ±35° and clamp camera swing to 4°/frame." }],
        gate: "accept",
      },
      // Self-improving is default-ON now (A6) — this test exercises the review path, so the
      // user has explicitly switched it off.
      async (r) => {
        await r.core.updateSettings({ selfImproving: false });
      },
    );
    // Only trainable skills are considered: the fixture (threejs-craft, trainable) and the
    // seed's planner skill. Builder skills were retired from SkillOpt in the v2 rework.
    assert.equal(counts.analyst, 2, "only trainable skills are considered");
    assert.equal(counts.gate, 3, "only the skill with a proposal is gated, by three blind votes");

    const events = await waitForLog(
      rig.core,
      (log) => log.some((e) => e.data.type === "custom" && e.data.event_type === "skillopt_staged"),
      20_000,
      "skillopt_staged",
    );
    const staged = (await rig.core.store.readArtifact(rig.core.mainThread, "skillopt_staged")) as Array<{
      skill: string;
      proposedText: string;
      gate: { votes: string };
    }>;
    assert.equal(staged.length, 1);
    assert.match(staged[0]!.proposedText, /Clamp pitch to ±35°/);
    assert.match(staged[0]!.gate.votes, /3\/3/);

    // The live skill is untouched until a human accepts.
    const live = await readFile(path.join(rig.core.layout.harnessWs, "skills", "threejs-craft.md"), "utf8");
    assert.ok(!live.includes("Clamp pitch"), "solo phase: nothing lands without review");
    assert.equal(customEvents(events, "skillopt_accepted").length, 0);
  });

  it("rejects a candidate that does not clearly win, and remembers why", async () => {
    const { rig, counts } = await runSkillOptRig({
      edits: [{ op: "append", text: "- Clamp pitch to ±35°, probably." }],
      gate: "reject",
    });
    assert.equal(counts.gate, 3);
    const events = await waitForLog(
      rig.core,
      (log) => log.some((e) => e.data.type === "custom" && e.data.event_type === "skillopt_rejected"),
      20_000,
      "skillopt_rejected",
    );
    const rejected = customEvents(events, "skillopt_rejected")[0]!;
    assert.match(String((rejected.gate as { reason: string }).reason), /not a strict improvement/);

    // The step buffer stops the same dead edit from being proposed forever.
    const buffer = (await rig.core.store.readArtifact(rig.core.mainThread, "skillopt_step_buffer")) as Array<{
      skill: string;
      why_rejected: string;
    }>;
    assert.ok(buffer.length >= 1);
    assert.match(buffer[0]!.why_rejected, /not a strict improvement/);

    const staged = (await rig.core.store.readArtifact(rig.core.mainThread, "skillopt_staged")) ?? [];
    assert.equal((staged as unknown[]).length, 0);
  });

  it("applies a staged proposal only when a human accepts it", async () => {
    const { rig } = await runSkillOptRig(
      {
        edits: [{ op: "append", text: "- Clamp pitch to ±35° and clamp camera swing to 4°/frame." }],
        gate: "accept",
      },
      // The review path exists for users who turned self-improving off (it is default-ON, A6).
      async (r) => {
        await r.core.updateSettings({ selfImproving: false });
      },
    );
    await waitForLog(
      rig.core,
      (log) => log.some((e) => e.data.type === "custom" && e.data.event_type === "skillopt_staged"),
      20_000,
      "skillopt_staged",
    );

    const accepted = await rig.core.acceptStagedProposal(0);
    assert.equal(accepted.skill, "threejs-craft");

    const live = await readFile(path.join(rig.core.layout.harnessWs, "skills", "threejs-craft.md"), "utf8");
    assert.match(live, /Clamp pitch to ±35°/, "the approved edit is now the studio's actual skill");
    const best = await readFile(path.join(rig.core.layout.harnessWs, "skills", "threejs-craft.best.md"), "utf8");
    assert.equal(best, live, "best_skill keeps the accepted version");

    const events = await rig.core.store.listEvents(rig.core.mainThread);
    const record = customEvents(events, "skillopt_accepted")[0]!;
    assert.equal(record.approvedBy, "human");
    assert.ok(record.snapshot_id, "the approval is snapshotted, so it can be rolled back");
    assert.deepEqual(await rig.core.store.readArtifact(rig.core.mainThread, "skillopt_staged"), []);
  });

  it("remembers a proposal the human threw away so it is not proposed again", async () => {
    const { rig } = await runSkillOptRig(
      {
        edits: [{ op: "append", text: "- Clamp pitch to ±35°, maybe." }],
        gate: "accept",
      },
      async (r) => {
        await r.core.updateSettings({ selfImproving: false });
      },
    );
    await waitForLog(
      rig.core,
      (log) => log.some((e) => e.data.type === "custom" && e.data.event_type === "skillopt_staged"),
      20_000,
      "skillopt_staged",
    );
    await rig.core.discardStagedProposal(0, "too vague");

    const live = await readFile(path.join(rig.core.layout.harnessWs, "skills", "threejs-craft.md"), "utf8");
    assert.ok(!live.includes("Clamp pitch"));
    const buffer = (await rig.core.store.readArtifact(rig.core.mainThread, "skillopt_step_buffer")) as Array<{
      why_rejected: string;
    }>;
    assert.equal(buffer.at(-1)?.why_rejected, "too vague");
  });

  it("auto-apply mode lands a winning proposal the moment it is staged", async () => {
    const { rig } = await runSkillOptRig(
      {
        edits: [{ op: "append", text: "- Widen FOV with speed; compress ring spacing ahead." }],
        gate: "accept",
      },
      // The user flipped the switch before walking away.
      async (r) => {
        const settings = await r.core.updateSettings({ selfImproving: true });
        assert.equal(settings.selfImproving, true);
      },
    );

    // The staged notify triggers the sweep asynchronously — wait for the log to show it landed.
    const events = await waitForLog(
      rig.core,
      (log) => log.some((e) => e.data.type === "custom" && e.data.event_type === "skillopt_accepted"),
      20_000,
      "auto skillopt_accepted",
    );
    const record = customEvents(events, "skillopt_accepted")[0]!;
    assert.equal(record.approvedBy, "auto", "nobody clicked Apply");
    assert.ok(record.snapshot_id, "auto-applied changes are still snapshotted first");

    const live = await readFile(path.join(rig.core.layout.harnessWs, "skills", "threejs-craft.md"), "utf8");
    assert.ok(live.includes("Widen FOV with speed"), "the live skill actually changed");
    assert.deepEqual(await rig.core.store.readArtifact(rig.core.mainThread, "skillopt_staged"), []);
    assert.ok(
      rig.events.some((e) => e.type === "skillopt.autoApplied"),
      "the UI hears about it",
    );

    // Turning the setting on also sweeps anything already waiting.
    await rig.core.store.writeArtifact(rig.core.mainThread, "skillopt_staged", [
      {
        skill: "threejs-craft",
        file: "skills/threejs-craft.md",
        proposedText: `${live}\n- Also test at 120 fps.\n`,
        currentText: live,
        gate: { accept: true, votes: "3-0", reason: "test" },
        edits: [],
        rationale: "swept on enable",
        at: new Date().toISOString(),
      },
    ]);
    await rig.core.updateSettings({ selfImproving: true });
    await waitForLog(rig.core, (log) => customEvents(log, "skillopt_accepted").length >= 2, 20_000, "sweep on enable");
    assert.deepEqual(await rig.core.store.readArtifact(rig.core.mainThread, "skillopt_staged"), []);

    // The choice survives a relaunch: it is on disk, not in the conversation.
    const persisted = JSON.parse(await readFile(path.join(rig.userData, "settings.json"), "utf8")) as {
      selfImproving: boolean;
    };
    assert.equal(persisted.selfImproving, true);
  });

  it("does nothing when there is no run history to learn from — but says so", async () => {
    const { respond } = makeResponder({ edits: [], gate: "reject" });
    const rig = await startRig({ respond });
    rigs.push(rig);
    await rig.core.host.dispatch({ type: "skillopt_start", threadId: rig.core.mainThread }, 60_000);
    const events = await rig.core.store.listEvents(rig.core.mainThread);
    assert.equal(customEvents(events, "skillopt_staged").length, 0);
    assert.equal(customEvents(events, "skillopt_accepted").length, 0);
    // An empty pass still leaves a visible trace — a button that says nothing feels broken.
    const pass = customEvents(events, "skillopt_pass").at(-1)!;
    assert.match(String(pass.note), /nothing to learn from yet/);
    assert.equal(pass.tasks, 0);
  });

  it("mines chat-build evidence out of the per-game threads", async () => {
    const { respond, counts } = makeResponder({ edits: [], gate: "reject" });
    const rig = await startRig({ respond });
    rigs.push(rig);
    const skillsDir = path.join(rig.core.layout.harnessWs, "skills");
    for (const name of ["game-contract", "threejs-craft", "unattended-runs", "self-improvement"]) {
      await writeFile(
        path.join(skillsDir, `${name}.md`),
        name === "threejs-craft" ? SKILL : "---\nname: x\ndescription: y\n---\n",
      );
    }

    // The evidence lives where it happened: chat builds logged in their game's own thread.
    // Two of them: the analyst learns from one and the gate tests on the other.
    const gameThread = await rig.core.threadForGame("pong");
    assert.notEqual(gameThread, rig.core.mainThread);
    await rig.core.append(
      [
        {
          type: "custom",
          event_type: "build_observation",
          payload: { brief: "make pong", ok: true, consoleErrors: 3, summary: "shipped with console errors" },
        },
        {
          type: "custom",
          event_type: "build_observation",
          payload: { brief: "add a score", ok: true, consoleErrors: 0, summary: "clean" },
        },
      ],
      gameThread,
    );

    await rig.core.host.dispatch({ type: "skillopt_start", threadId: rig.core.mainThread }, 90_000);
    assert.ok(counts.analyst >= 1, "evidence in a game thread must reach the analyst");
    const pass = customEvents(await rig.core.listAllEvents(), "skillopt_pass").at(-1)!;
    assert.equal(pass.tasks, 2, "the pass reports exactly what it mined");
  });

  it("learns from one half of the evidence and tests on the other, swapping sides between votes", async () => {
    const workspace = path.join(await tmpDir("skillopt-split-"), "ws");
    await mkdir(path.join(workspace, "skills"), { recursive: true });
    await writeFile(path.join(workspace, "skills", "camera.md"), SKILL);
    const gaps = ["gap one", "gap two", "gap three", "gap four"];
    const history = gaps.map((gap, i) => ({
      id: String(i + 1),
      data: {
        type: "custom",
        event_type: "run_iteration",
        payload: { iteration: i + 1, winner: "incumbent", biggest_gap: gap },
      },
    }));
    const analystSaw: string[] = [];
    const gateSaw: string[] = [];
    const candidateSides: boolean[] = [];
    const gateProvenance: unknown[] = [];
    const ctx = {
      workspace,
      cancelled: false,
      setStatus() {},
      notify() {},
      async call(method: string, params: Record<string, unknown>) {
        if (method === "thread.list") return [];
        if (method === "events.list") return history;
        if (method === "artifact.read") return [];
        if (method === "artifact.write" || method === "events.append") return true;
        if (method === "engine.complete") {
          const text = (params.messages as Array<{ content: string }>)[0]!.content;
          if (text.includes("SKILL FILE")) {
            analystSaw.push(text);
            return {
              message: {
                content: JSON.stringify({
                  edits: [{ op: "append", text: "- Keep the horizon level." }],
                  rationale: "r",
                }),
              },
            };
          }
          // The analyst wrote no plain words, so one call asks for them; it is not a gate vote.
          if (text.includes("PROPOSED EDITS")) return { message: { content: "{}" } };
          gateSaw.push(text);
          const rubricSha = createHash("sha256").update(String(params.systemPrompt)).digest("hex");
          gateProvenance.push([params.provenance, rubricSha]);
          const sectionA = text.split("VERSION A:")[1]?.split("VERSION B:")[0] ?? "";
          candidateSides.push(sectionA.includes("Keep the horizon level"));
          return { message: { content: JSON.stringify({ pick: "tie", reason: "same" }) } };
        }
        throw new Error(`unexpected call ${method}`);
      },
    };
    await runSkillOpt(ctx as never, { threadId: "t1" });
    assert.ok(analystSaw[0]!.includes("gap one") && analystSaw[0]!.includes("gap three"));
    assert.ok(
      !analystSaw[0]!.includes("gap two") && !analystSaw[0]!.includes("gap four"),
      "the analyst never sees the held-out half",
    );
    assert.ok(
      gateSaw.every((text) => text.includes("gap two") && text.includes("gap four") && !text.includes("gap one")),
    );
    assert.deepEqual(
      candidateSides.slice(1),
      [!candidateSides[0], candidateSides[0]],
      "the candidate changes sides between votes",
    );
    assert.equal(gateProvenance.length, 3);
    for (const entry of gateProvenance) {
      const [provenance, rubricSha] = entry as [unknown, string];
      assert.deepEqual(
        provenance,
        { role: "skillopt-gate", promptSha256: rubricSha },
        "the host records the gate's votes",
      );
    }
  });

  it("books every model call of a pass as improvement work, so the budget ledger can refuse it while a build runs", async () => {
    const workspace = path.join(await tmpDir("skillopt-class-"), "ws");
    await mkdir(path.join(workspace, "skills"), { recursive: true });
    await writeFile(path.join(workspace, "skills", "camera.md"), SKILL);
    const history = ["gap one", "gap two", "gap three", "gap four"].map((gap, i) => ({
      id: String(i + 1),
      data: {
        type: "custom",
        event_type: "run_iteration",
        payload: { iteration: i + 1, winner: "incumbent", biggest_gap: gap },
      },
    }));
    const classes: unknown[] = [];
    const ctx = {
      workspace,
      cancelled: false,
      setStatus() {},
      notify() {},
      async call(method: string, params: Record<string, unknown>) {
        if (method === "thread.list") return [];
        if (method === "events.list") return history;
        if (method === "artifact.read") return [];
        if (method === "artifact.write" || method === "events.append") return true;
        if (method === "engine.complete") {
          classes.push(params.class);
          const text = (params.messages as Array<{ content: string }>)[0]!.content;
          if (text.includes("SKILL FILE")) {
            return {
              message: {
                content: JSON.stringify({
                  edits: [{ op: "append", text: "- Keep the horizon level." }],
                  rationale: "r",
                }),
              },
            };
          }
          if (text.includes("PROPOSED EDITS")) return { message: { content: "{}" } };
          return { message: { content: JSON.stringify({ pick: "tie", reason: "same" }) } };
        }
        throw new Error(`unexpected call ${method}`);
      },
    };
    await runSkillOpt(ctx as never, { threadId: "t1" });
    assert.ok(classes.length >= 3, "the analyst, its plain words and the gate votes all reached the engine");
    assert.deepEqual(
      [...new Set(classes)],
      ["improvement"],
      "an untagged call is booked as user work and slips past the improvement budget",
    );
  });

  it("golden-boot-glory: a skill serves every game, so the analyst proposes no rule for one sport or game and the gate counts one against a version", async () => {
    const workspace = path.join(await tmpDir("skillopt-general-"), "ws");
    await mkdir(path.join(workspace, "skills"), { recursive: true });
    await writeFile(path.join(workspace, "skills", "camera.md"), SKILL);
    const history = ["gap one", "gap two", "gap three", "gap four"].map((gap, i) => ({
      id: String(i + 1),
      data: {
        type: "custom",
        event_type: "run_iteration",
        payload: { iteration: i + 1, winner: "incumbent", biggest_gap: gap },
      },
    }));
    const systemPrompts = { analyst: [] as string[], gate: [] as string[] };
    const ctx = {
      workspace,
      cancelled: false,
      setStatus() {},
      notify() {},
      async call(method: string, params: Record<string, unknown>) {
        if (method === "thread.list") return [];
        if (method === "events.list") return history;
        if (method === "artifact.read") return [];
        if (method === "artifact.write" || method === "events.append") return true;
        if (method === "engine.complete") {
          const text = (params.messages as Array<{ content: string }>)[0]!.content;
          if (text.includes("SKILL FILE")) {
            systemPrompts.analyst.push(String(params.systemPrompt));
            const edits = [{ op: "append", text: "- Keep the horizon level." }];
            return { message: { content: JSON.stringify({ edits, rationale: "r" }) } };
          }
          // The analyst wrote no plain words, so one call asks for them; it is not a gate vote.
          if (text.includes("PROPOSED EDITS")) return { message: { content: "{}" } };
          systemPrompts.gate.push(String(params.systemPrompt));
          return { message: { content: JSON.stringify({ pick: "tie", reason: "same" }) } };
        }
        throw new Error(`unexpected call ${method}`);
      },
    };
    await runSkillOpt(ctx as never, { threadId: "t1" });
    assert.ok(systemPrompts.analyst.length > 0 && systemPrompts.gate.length > 0);
    for (const prompt of [...systemPrompts.analyst, ...systemPrompts.gate])
      assert.match(prompt, /every (kind of )?game/i, "the skill is for every game");
    assert.match(systemPrompts.analyst[0]!, /one (genre|sport)/i);
    assert.match(systemPrompts.gate[0]!, /one (genre|sport)/i);
  });

  it("a one-sided history is not enough to test a change, so nothing is asked of the analyst", async () => {
    const workspace = path.join(await tmpDir("skillopt-thin-"), "ws");
    await mkdir(path.join(workspace, "skills"), { recursive: true });
    await writeFile(path.join(workspace, "skills", "camera.md"), SKILL);
    let completions = 0;
    const ctx = {
      workspace,
      cancelled: false,
      setStatus() {},
      notify() {},
      async call(method: string) {
        if (method === "thread.list") return [];
        if (method === "events.list")
          return [
            {
              id: "1",
              data: {
                type: "custom",
                event_type: "run_iteration",
                payload: { iteration: 1, winner: "incumbent", biggest_gap: "only one" },
              },
            },
          ];
        if (method === "artifact.read") return [];
        if (method === "artifact.write" || method === "events.append") return true;
        if (method === "engine.complete") {
          completions++;
          return { message: { content: "{}" } };
        }
        throw new Error(`unexpected call ${method}`);
      },
    };
    await runSkillOpt(ctx as never, { threadId: "t1" });
    assert.equal(completions, 0);
  });

  it("asks the host whether it may learn, and an older host without the switch means yes", async () => {
    const { learningOn } = await import("../../src/harness-seed/loop/learning.ts");
    assert.equal(await learningOn({ call: async () => false } as never), false);
    assert.equal(await learningOn({ call: async () => true } as never), true);
    assert.equal(
      await learningOn({
        call: async () => {
          throw new Error("unknown substrate method: learning.enabled");
        },
      } as never),
      true,
    );
  });

  it("a skill's .best.md archive is history, not a second live skill", async () => {
    // The first accepted pass on the live install doubled every optimised skill at the next
    // boot: applyAccepted writes `<slug>.best.md` alongside the skill, and loadSkills read both.
    const workspace = path.join(await tmpDir("skills-best-"), "ws");
    await mkdir(path.join(workspace, "skills"), { recursive: true });
    await writeFile(path.join(workspace, "skills", "camera.md"), SKILL);
    await writeFile(path.join(workspace, "skills", "camera.best.md"), SKILL);
    const skills = await loadSkills(workspace);
    assert.equal(skills.length, 1, "the archive copy must not load as a live skill");
    assert.match(skills[0]!.slug, /^camera$/);
  });

  it("stop means stop — a cancelled pass ends between calls, says so, and still logs its trace", async () => {
    // A pass is minutes of local-model time per skill; the first live run proved the stop
    // button silently did not reach it. Driven directly so the cancel can land mid-flight.
    const workspace = path.join(await tmpDir("skillopt-cancel-"), "ws");
    await mkdir(path.join(workspace, "skills"), { recursive: true });
    await writeFile(path.join(workspace, "skills", "camera.md"), SKILL);
    await writeFile(
      path.join(workspace, "skills", "feedback.md"),
      "---\nname: Feedback\ndescription: impact rules\ntrainable: true\n---\n- Impacts register.\n",
    );

    const appended: Array<{ batch: Array<{ event_type?: string; payload?: Record<string, unknown> }> }> = [];
    const statuses: string[] = [];
    let completions = 0;
    let stopped = false;
    const ctx = {
      workspace,
      get cancelled() {
        return stopped;
      },
      setStatus(next: string) {
        statuses.push(next);
      },
      notify() {},
      async call(method: string, params: Record<string, unknown>) {
        if (method === "thread.list") return [];
        if (method === "events.list")
          return [
            {
              id: "1",
              data: {
                type: "custom",
                event_type: "run_iteration",
                payload: { iteration: 1, winner: "incumbent", biggest_gap: "no feedback on impact" },
              },
            },
            {
              id: "2",
              data: {
                type: "custom",
                event_type: "run_iteration",
                payload: { iteration: 2, winner: "incumbent", biggest_gap: "still no feedback" },
              },
            },
          ];
        if (method === "artifact.read") return [];
        if (method === "artifact.write") return true;
        if (method === "events.append") {
          appended.push(params as never);
          return "head";
        }
        if (method === "engine.complete") {
          completions++;
          stopped = true; // the user presses Stop while the analyst call is in flight
          return {
            message: { content: JSON.stringify({ edits: [{ op: "append", text: "- New rule." }], rationale: "r" }) },
          };
        }
        throw new Error(`unexpected call ${method}`);
      },
    };

    const report = await runSkillOpt(ctx as never, { threadId: "t1" });
    assert.match(String(report.note), /stopped by the user after 1 of 2 skills/);
    assert.equal(completions, 1, "no further model calls are spent after the stop");
    assert.match(statuses[0]!, /^self-improving · /, "the pass narrates which skill it is on");
    const passEvent = appended.at(-1)!.batch[0]!;
    assert.equal(passEvent.event_type, "skillopt_pass", "even a stopped pass leaves its visible trace");
    assert.match(String(passEvent.payload?.note), /stopped by the user/);
  });

  it("self-improves on the engine that ran the run, not the local default", async () => {
    // The model that made the mistakes is the one that studies them. A pass with no explicit
    // engine falls back to the engine of the last run on record; only an engine-less history
    // lands on the local model.
    const workspace = path.join(await tmpDir("skillopt-engine-"), "ws");
    await mkdir(path.join(workspace, "skills"), { recursive: true });
    await writeFile(path.join(workspace, "skills", "camera.md"), SKILL);

    const completions: Array<{ engine?: string; model?: string }> = [];
    const makeCtx = (events: unknown[]) => ({
      workspace,
      cancelled: false,
      setStatus() {},
      notify() {},
      async call(method: string, params: Record<string, unknown>) {
        if (method === "thread.list") return [];
        if (method === "events.list") return events;
        if (method === "artifact.read") return [];
        if (method === "artifact.write") return true;
        if (method === "events.append") return "head";
        if (method === "engine.complete") {
          completions.push({ engine: params.engine as string, model: params.model as string });
          return { message: { content: JSON.stringify({ edits: [], rationale: "" }) } };
        }
        throw new Error(`unexpected call ${method}`);
      },
    });
    const history = [
      {
        id: "1",
        data: {
          type: "custom",
          event_type: "run_started",
          payload: { runId: "r1", engine: "claude-code", model: "opus-x" },
        },
      },
      {
        id: "2",
        data: {
          type: "custom",
          event_type: "run_iteration",
          payload: { iteration: 1, winner: "incumbent", biggest_gap: "flat lighting" },
        },
      },
      {
        id: "3",
        data: {
          type: "custom",
          event_type: "run_iteration",
          payload: { iteration: 2, winner: "incumbent", biggest_gap: "still flat" },
        },
      },
    ];

    // No explicit engine: the pass inherits the run's engine from the log.
    await runSkillOpt(makeCtx(history) as never, { threadId: "t1" });
    assert.equal(completions.at(-1)!.engine, "claude-code", "the pass runs on the run's engine");
    assert.equal(completions.at(-1)!.model, "opus-x", "and on the run's model");

    // A cross-provider run stores the builder model beside the orchestrator engine.
    const crossed = [
      {
        id: "1",
        data: {
          type: "custom",
          event_type: "run_started",
          payload: {
            runId: "r2",
            engine: "codex",
            model: "sonnet",
            builderEngine: "claude-code",
            roles: { planner: "gpt-5.6-sol", builder: "sonnet", judge: "gpt-5.5" },
          },
        },
      },
      ...history.slice(1),
    ];
    await runSkillOpt(makeCtx(crossed) as never, { threadId: "t1" });
    assert.equal(completions.at(-1)!.engine, "codex");
    assert.equal(completions.at(-1)!.model, "gpt-5.6-sol", "manual improvement uses a model on its provider");

    // An explicit engine wins over the log, and does not drag the old run's model along.
    await runSkillOpt(makeCtx(history) as never, { threadId: "t1", engine: "ollama" });
    assert.equal(completions.at(-1)!.engine, "ollama");
    assert.equal(completions.at(-1)!.model, undefined, "the run's model never leaks onto another engine");

    // No run in the log at all: the local model stays the floor.
    await runSkillOpt(makeCtx(history.slice(1)) as never, { threadId: "t1" });
    assert.equal(completions.at(-1)!.engine, "ollama");
  });
});

// ── applying and undoing what Studio learned, through the real core ──────────────────────────
describe("skillopt: applying and undoing a learned change", () => {
  const FILE = "skills/facet-decomposition.md";
  const staged = (base: string, text: string, at: string) => {
    const edits = [{ op: "append", text }];
    return {
      skill: "facet-decomposition",
      file: FILE,
      currentText: base,
      proposedText: applyEdits(base, edits).text,
      edits,
      gate: { accept: true, votes: "3/3 for the candidate", reason: "test" },
      rationale: "test",
      title: text,
      at,
    };
  };
  const start = async () => {
    const rig = await startRig({ respond: () => ({ text: "ok" }) });
    rigs.push(rig);
    await rig.core.updateSettings({ selfImproving: false });
    const file = path.join(rig.core.layout.harnessWs, FILE);
    return { rig, file, base: await readFile(file, "utf8") };
  };

  it("two approvals of one file both land — the second no longer erases the first", async () => {
    const { rig, file, base } = await start();
    // A healthy version to inherit from: skills are read, never run, so a change to one is as healthy.
    await rig.core.snapshot("harness", "baseline", undefined, true);
    const first = staged(base, "- Keep ownership explicit.", "2026-09-03T01:33:06.000Z");
    const second = staged(base, "- Attach held props to a hand.", "2026-09-03T17:41:54.000Z");
    await rig.core.store.writeArtifact(rig.core.mainThread, "skillopt_staged", [first, second]);
    // As the review block applies an included pair: newest first, each named by what it is.
    await rig.core.acceptStagedProposal(1, "human", { at: second.at, skill: second.skill });
    await rig.core.acceptStagedProposal(0, "human", { at: first.at, skill: first.skill });

    const live = await readFile(file, "utf8");
    assert.match(live, /Keep ownership explicit/);
    assert.match(live, /Attach held props to a hand/);
    assert.equal(
      await readFile(path.join(rig.core.layout.harnessWs, "skills", "facet-decomposition.best.md"), "utf8"),
      live,
    );
    assert.deepEqual(await rig.core.store.readArtifact(rig.core.mainThread, "skillopt_staged"), []);

    const accepted = customEvents(await rig.core.listAllEvents(), "skillopt_accepted");
    assert.equal(accepted.length, 2);
    for (const record of accepted) {
      assert.ok(record.post_snapshot_id, "every applied change has its own after-snapshot");
      assert.equal(
        rig.core.snapshotIndex.get(String(record.post_snapshot_id))?.healthy,
        true,
        "…which a later rewind keeps",
      );
    }
    // Each row's exact edit is its own change, nothing else.
    const changes = await rig.core.selfChangeList();
    const edit = (id: unknown) => changes.find((change) => change.from === id)!;
    assert.match(edit(accepted[0]!.snapshot_id).diff, /\+- Attach held props/);
    assert.doesNotMatch(edit(accepted[0]!.snapshot_id).diff, /Keep ownership/);
    assert.equal(edit(accepted[1]!.snapshot_id).file, FILE);
  });

  it("refuses a suggestion that no longer fits, and one that points outside the instructions", async () => {
    const { rig, file, base } = await start();
    const stale = {
      ...staged(base, "- x", "2026-09-01T00:00:00.000Z"),
      currentText: "an older text",
      edits: [{ op: "replace", anchor: "a line that is gone", text: "new" }],
      proposedText: "anything",
    };
    const escaping = {
      skill: "../../../evil",
      file: "../../../evil.md",
      proposedText: "pwned",
      currentText: "",
      gate: {},
      rationale: "",
      at: "2026-09-01T00:00:01.000Z",
    };
    await rig.core.store.writeArtifact(rig.core.mainThread, "skillopt_staged", [stale, escaping]);
    await assert.rejects(rig.core.acceptStagedProposal(0, "human", { at: stale.at }), /no longer fits/);
    await assert.rejects(rig.core.acceptStagedProposal(1, "human", { at: escaping.at }), /damaged/);
    assert.equal(await readFile(file, "utf8"), base, "nothing was written");
    await assert.rejects(readFile(path.join(rig.core.layout.harnessWs, "../../../evil.md"), "utf8"));
    assert.equal(
      ((await rig.core.store.readArtifact(rig.core.mainThread, "skillopt_staged")) as unknown[]).length,
      2,
      "both still wait for the person",
    );
  });

  it("automatic mode sets a suggestion that no longer fits aside and applies the one behind it", async () => {
    const { rig, file, base } = await start();
    const stale = {
      ...staged(base, "- x", "2026-09-01T00:00:00.000Z"),
      currentText: "an older text",
      edits: [{ op: "replace", anchor: "a line that is gone", text: "new" }],
      proposedText: "anything",
    };
    const good = staged(base, "- Look through the player's eyes.", "2026-09-01T00:00:01.000Z");
    await rig.core.store.writeArtifact(rig.core.mainThread, "skillopt_staged", [stale, good]);
    await rig.core.updateSettings({ selfImproving: true });
    await waitForLog(
      rig.core,
      (log) =>
        customEvents(log, "skillopt_accepted").length === 1 && customEvents(log, "skillopt_rejected").length === 1,
      20_000,
      "sweep",
    );
    assert.match(await readFile(file, "utf8"), /Look through the player's eyes/);
    assert.deepEqual(await rig.core.store.readArtifact(rig.core.mainThread, "skillopt_staged"), []);
    assert.equal(customEvents(await rig.core.listAllEvents(), "skillopt_rejected")[0]!.by, "auto");
    const buffer = ((await rig.core.store.readArtifact(rig.core.mainThread, "skillopt_step_buffer")) ??
      []) as unknown[];
    assert.equal(buffer.length, 0, "a stale suggestion is not an idea anyone refused");
  });

  it("Undo this change takes back that one change and leaves the later one in place", async () => {
    const { rig, file, base } = await start();
    const first = staged(base, "- Keep ownership explicit.", "2026-09-03T01:33:06.000Z");
    await rig.core.store.writeArtifact(rig.core.mainThread, "skillopt_staged", [first]);
    await rig.core.acceptStagedProposal(0, "human", { at: first.at });
    const second = staged(await readFile(file, "utf8"), "- Attach held props to a hand.", "2026-09-03T17:41:54.000Z");
    await rig.core.store.writeArtifact(rig.core.mainThread, "skillopt_staged", [second]);
    await rig.core.acceptStagedProposal(0, "human", { at: second.at });
    // A night's lesson written after both: history, not part of either change.
    const lessons = path.join(rig.core.layout.harnessWs, "library", "games", "pong.md");
    await mkdir(path.dirname(lessons), { recursive: true });
    await writeFile(lessons, "- The bridge rounds were kept.\n");

    const [older] = customEvents(await rig.core.listAllEvents(), "skillopt_accepted");
    await rig.core.undoSelfChange(String(older!.snapshot_id));

    const live = await readFile(file, "utf8");
    assert.doesNotMatch(live, /Keep ownership explicit/);
    assert.match(live, /Attach held props to a hand/, "the later change stays");
    assert.equal(await readFile(lessons, "utf8"), "- The bridge rounds were kept.\n");
    assert.equal(
      await readFile(path.join(rig.core.layout.harnessWs, "skills", "facet-decomposition.best.md"), "utf8"),
      live,
    );

    const activity = studioActivity(await rig.core.activityEvents()).filter((item) => item.kind === "improvement");
    assert.deepEqual(
      activity.map((item) => [item.title, item.status]),
      [
        ["- Attach held props to a hand.", "Applied"],
        ["- Keep ownership explicit.", "Undone"],
      ],
    );
    const buffer = (await rig.core.store.readArtifact(rig.core.mainThread, "skillopt_step_buffer")) as Array<{
      why_rejected: string;
    }>;
    assert.match(buffer.at(-1)!.why_rejected, /undid it/, "the analyst hears an undo like a discard");
    await assert.rejects(rig.core.undoSelfChange(String(older!.snapshot_id)), /already undone/);
    assert.equal(rig.core.host.state, "ready", "an instruction change is undone without restarting the harness");
  });
});
