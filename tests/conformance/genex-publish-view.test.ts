import { test } from "node:test";
import assert from "node:assert/strict";
import {
  offeredTitle,
  PublishGate,
  publishGate,
  publishSteps,
  publishView,
  studioPublishButton,
} from "../../src/renderer/panels/plugins/genex/genex-publish-view.ts";
import {
  GENEX_PLUGIN_ID,
  GENEX_PUBLISH_PANEL,
  type GenexPublishJob,
  type GenexPublishState,
} from "../../src/shared/genex.ts";
import type { PluginInfo } from "../../src/shared/plugins.ts";

const state = (over: Partial<GenexPublishState> = {}): GenexPublishState => ({
  version: 1,
  project: "game",
  connected: true,
  ...over,
});
const job = (over: Partial<GenexPublishJob> = {}): GenexPublishJob => ({
  id: "j1",
  kind: "gallery",
  state: "running",
  phase: "exporting",
  startedAt: "2026-09-30T10:00:00Z",
  ...over,
});

test("the dialog names where the game is and offers one press from there", () => {
  const none = publishView(state());
  assert.equal(none.stage, "none");
  assert.equal(none.primary.label, "Publish");
  assert.equal(none.primary.ariaLabel, "Publish this game on Genex", "the smoke selector stays");
  assert.equal(none.canPublish, true);
  assert.ok(!("secondary" in none), "a draft is no second button beside Publish");

  const draft = publishView(state({ slug: "my-game", status: "draft", draftUrl: "https://x/draft" }));
  assert.equal(draft.stage, "draft");
  assert.equal(draft.primary.label, "Publish");

  const live = publishView(state({ slug: "my-game", status: "published", galleryUrl: "https://x/g" }));
  assert.equal(live.stage, "public");
  assert.equal(live.primary.label, "Publish update");

  const signedOut = publishView(state({ connected: false }));
  assert.equal(signedOut.canPublish, false);
  assert.deepEqual(signedOut.problems, [], "Connect Genex is offered in its place, not reported as a problem");
});

test("Publish asks for what is missing in order: Genex installed, turned on, then an account", () => {
  assert.equal(publishGate(undefined, undefined), PublishGate.Install);
  assert.equal(publishGate({ enabled: false, removed: true }, undefined), PublishGate.Install);
  assert.equal(publishGate({ enabled: false, removed: false }, undefined), PublishGate.TurnOn);
  assert.equal(publishGate({ enabled: true, removed: false }, false), PublishGate.Connect);
  assert.equal(publishGate({ enabled: true, removed: false }, true), PublishGate.Ready);
  assert.equal(
    publishGate({ enabled: true, removed: false }, undefined),
    PublishGate.Ready,
    "unread yet is not asked for",
  );
});

const genex = (over: Partial<PluginInfo> = {}): PluginInfo => ({
  manifest: {
    apiVersion: 3,
    id: GENEX_PLUGIN_ID,
    version: "1.0.0",
    name: "Genex Tools",
    publisher: "Genex",
    description: "t",
    backend: "backend.mjs",
    capabilities: [],
    tools: [],
    skills: [],
    panels: [{ id: GENEX_PUBLISH_PANEL, title: "Publish", file: "publish.html", placement: "project" }],
    settings: [],
    actions: [],
    toolbar: [
      {
        id: "publish",
        label: "Publish",
        ariaLabel: "Publish game",
        target: { kind: "panel", id: GENEX_PUBLISH_PANEL },
      },
    ],
  },
  source: "bundled",
  enabled: true,
  removed: false,
  health: "stopped",
  state: "enabled",
  ...over,
});

test("every open game has Publish on its stage strip, whether Genex is on, off, removed or missing", () => {
  assert.equal(studioPublishButton([genex()], "game"), false, "Genex's own button is the one shown");
  assert.equal(studioPublishButton([genex({ enabled: false, state: "disabled" })], "game"), true);
  assert.equal(studioPublishButton([genex({ enabled: false, removed: true, state: "disabled" })], "game"), true);
  assert.equal(studioPublishButton([], "game"), true);
  assert.equal(studioPublishButton([], null), false, "with no game open there is nothing to publish");
});

test("a running attempt shows its steps: every publish tests the draft before it goes live", () => {
  assert.deepEqual(publishSteps(job({ phase: "creating-project" })), ["prepare", "upload", "test", "live"]);
  assert.deepEqual(publishSteps(job({ kind: "draft", phase: "uploading" })), ["prepare", "upload", "test"]);

  const testing = publishView(state({ slug: "g", job: job({ phase: "verifying-deployment" }) }));
  assert.equal(testing.running, true);
  assert.equal(testing.canPublish, false, "nothing else starts while one runs");
  assert.equal(testing.phase, "Making sure it plays");
  assert.equal(testing.status, "Publishing…");
  assert.deepEqual(
    testing.steps.map((s) => [s.step, s.state]),
    [
      ["prepare", "done"],
      ["upload", "done"],
      ["test", "current"],
      ["live", "next"],
    ],
  );
  const promoting = publishView(state({ slug: "g", status: "published", job: job({ phase: "promoting" }) }));
  assert.equal(promoting.phase, "Going live");
  assert.equal(promoting.steps.at(-1)?.state, "current");
});

test("a live game shows its link and when it was updated", () => {
  const now = Date.parse("2026-10-06T12:00:00Z");
  const live = publishView(
    state({
      slug: "g",
      status: "published",
      galleryUrl: "https://genex.games/world/g",
      lastPublishAt: "2026-10-06T11:58:00Z",
      job: job({ state: "done", phase: "ready" }),
    }),
    now,
  );
  assert.equal(live.link, "https://genex.games/world/g");
  assert.equal(live.status, "Live · updated 2m ago");
  assert.equal(live.failure, null);
  assert.equal(
    publishView(state({ slug: "g", galleryUrl: "https://genex.games/world/g" })).link,
    null,
    "a draft has no public link",
  );
});

test("a failed attempt is said calmly, its raw error kept only as details for support", () => {
  const failed = publishView(
    state({ job: job({ state: "failed", phase: "failed", error: "fixture: HTTP 502 at /api" }) }),
  );
  assert.equal(failed.outcome, "failed");
  assert.deepEqual(failed.problems, [], "the raw error is no problem line");
  assert.equal(failed.failure?.title, "It didn't go online this time");
  assert.match(failed.failure?.text ?? "", /Your game is safe and nothing changed/);
  assert.equal(failed.failure?.details, "fixture: HTTP 502 at /api");
  assert.equal(failed.primary.label, "Try again");
  assert.equal(failed.canPublish, true, "a failed attempt can be tried again");

  const listedFailed = publishView(
    state({ slug: "g", status: "published", job: job({ state: "failed", phase: "failed", error: "x" }) }),
  );
  assert.match(listedFailed.failure?.text ?? "", /players still get the version they had/);
});

test("an upload whose outcome is unknown offers Check again and the person's own word, never a silent retry", () => {
  const unknown = publishView(
    state({ slug: "g", job: job({ state: "unresolved", phase: "unresolved", kind: "draft", error: "lost" }) }),
  );
  assert.equal(unknown.running, false);
  assert.equal(unknown.unresolved, true);
  assert.equal(unknown.outcome, "unresolved");
  assert.deepEqual(
    unknown.extra.map((b) => [b.label, b.action]),
    [
      ["Check again", "publish-status"],
      ["I checked — allow a new upload", "publish-allow-upload"],
    ],
  );
  assert.equal(unknown.canPublish, false);
  assert.match(unknown.failure?.text ?? "", /couldn’t tell whether the upload reached Genex/);

  const terms = publishView(state({ terms: { accepted: false, acceptUrl: "https://x/terms" } }));
  assert.deepEqual(terms.problems, ["Review the updated Genex terms in your browser before publishing."]);
  assert.equal(terms.terms?.action, "terms", "the one press is reviewing them");
  assert.equal(publishView(state()).terms, null);
});

test("the name offered is the listed one, else Studio's title for the game, else its folder name as words", () => {
  assert.equal(offeredTitle(state({ title: "Rain Circuit" }), "Racing", "racing-demo"), "Rain Circuit");
  assert.equal(
    offeredTitle(state(), "Hyper-Realistic Racing", "hyper-realistic-racing-demo"),
    "Hyper-Realistic Racing",
  );
  assert.equal(offeredTitle(null, undefined, "hyper-realistic-racing-demo"), "Hyper Realistic Racing Demo");
  assert.equal(offeredTitle(null, "   ", "rain_circuit"), "Rain Circuit");
});
