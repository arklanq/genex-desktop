/**
 * The `desktop` tool: the computer vocabulary on the person's desktop, behind their consent. Nothing
 * starts before they say yes for the session, each app is asked for once, a no is what the model
 * reads, and a VM's yes covers every app inside it.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { DesktopQuestion, desktopTools } from "../../src/main/core/desktop-tools.ts";
import type { DesktopApp, DesktopDriver } from "../../src/substrate/desktop-driver.ts";
import type { LiveToolResult } from "../../src/substrate/engines/types.ts";
import { tmpDir } from "../helpers/tmp.ts";

const text = (result: LiveToolResult): string => (typeof result === "string" ? result : result.text);

/** A driver over one app in front, recording its input. */
function driverWith(front: DesktopApp) {
  const calls: string[] = [];
  const driver: DesktopDriver = {
    screenshot: async () => ({
      image: Buffer.from("png"),
      mime: "image/png",
      width: 100,
      height: 100,
      screen: { width: 100, height: 100 },
    }),
    focus: async () => ({ app: front, secure: false }),
    move: async () => {},
    click: async (x, y) => {
      calls.push(`click ${x},${y}`);
    },
    mouse: async () => {},
    drag: async () => {},
    scroll: async () => {},
    type: async (t) => {
      calls.push(`type ${t}`);
    },
    press: async (keys) => {
      calls.push(`press ${keys.join("+")}`);
    },
    accessibility: async () => ({}),
    close: async () => {
      calls.push("close");
    },
  };
  return { driver, calls };
}

const NOTES: DesktopApp = { name: "Notes", bundleId: "com.apple.Notes", pid: 9 };

async function toolsWith(
  answers: { session: boolean; apps?: Record<string, boolean> },
  options: { vm?: boolean; failConnects?: number; enabled?: () => boolean } = {},
) {
  const fake = driverWith(NOTES);
  const asked: string[] = [];
  let connects = 0;
  const tools = desktopTools({
    connect: async () => {
      connects += 1;
      if (connects <= (options.failConnects ?? 0)) throw new Error("Accessibility is not granted");
      return fake.driver;
    },
    ask: async (question, app) => {
      asked.push(question === DesktopQuestion.Session ? "session" : `app:${app?.name}`);
      return question === DesktopQuestion.Session ? answers.session : (answers.apps?.[app?.name ?? ""] ?? false);
    },
    ownApp: () => false,
    frameDir: await tmpDir("desktop-tools-"),
    ...(options.vm ? { vm: true } : {}),
    ...(options.enabled ? { enabled: options.enabled } : {}),
  });
  return { tools, fake, asked, connects: () => connects };
}

describe("the desktop tool", () => {
  it("is the computer vocabulary under its own name, so a session can also hold its game's computer", async () => {
    const { tools } = await toolsWith({ session: true });
    assert.equal(tools.liveTools[0]?.name, "desktop");
    assert.match(tools.liveTools[0]!.description, /person's computer/);
    assert.match(text(await tools.onLiveTool("computer", { action: "screenshot" })), /unknown tool/);
  });

  it("starts nothing until the person says yes for the session; a no is what the model reads", async () => {
    const { tools, fake, asked, connects } = await toolsWith({ session: false });
    const answer = text(await tools.onLiveTool("desktop", { action: "left_click", coordinate: "10,10" }));
    assert.match(answer, /did not allow computer control/);
    await tools.onLiveTool("desktop", { action: "screenshot" });
    assert.equal(connects(), 0, "the driver never started");
    assert.deepEqual(fake.calls, []);
    assert.deepEqual(asked, ["session"], "a no for the session is not asked again");
  });

  it("asks once per app: an allowed app takes input, a declined one never does", async () => {
    const allowed = await toolsWith({ session: true, apps: { Notes: true } });
    await allowed.tools.onLiveTool("desktop", { action: "screenshot" });
    await allowed.tools.onLiveTool("desktop", { action: "left_click", coordinate: "10,10" });
    await allowed.tools.onLiveTool("desktop", { action: "type", text: "hi" });
    assert.deepEqual(allowed.fake.calls, ["click 10,10", "type hi"]);
    assert.deepEqual(allowed.asked, ["session", "app:Notes"]);

    const declined = await toolsWith({ session: true, apps: { Notes: false } });
    await declined.tools.onLiveTool("desktop", { action: "screenshot" });
    const answer = text(await declined.tools.onLiveTool("desktop", { action: "left_click", coordinate: "10,10" }));
    assert.match(answer, /did not allow Notes/);
    await declined.tools.onLiveTool("desktop", { action: "type", text: "hi" });
    assert.deepEqual(declined.fake.calls, []);
    assert.deepEqual(declined.asked, ["session", "app:Notes"], "a declined app is not asked again");
  });

  it("in a VM, the session's yes covers every app inside it", async () => {
    const { tools, fake, asked } = await toolsWith({ session: true }, { vm: true });
    await tools.onLiveTool("desktop", { action: "screenshot" });
    await tools.onLiveTool("desktop", { action: "left_click", coordinate: "10,10" });
    assert.deepEqual(fake.calls, ["click 10,10"]);
    assert.deepEqual(asked, ["session"]);
  });

  it("a stop during a call is what that call answers: the person stopped computer control", async () => {
    const { tools, fake } = await toolsWith({ session: true, apps: { Notes: true } });
    await tools.onLiveTool("desktop", { action: "screenshot" });
    const waiting = tools.onLiveTool("desktop", { action: "wait", duration: 0.2 });
    await tools.release();
    assert.match(text(await waiting), /the person stopped computer control/);
    assert.deepEqual(fake.calls, ["close"]);
  });

  it("after a yes for the session, a connection that failed is retried on the next call, never asked again", async () => {
    const { tools, fake, asked, connects } = await toolsWith(
      { session: true, apps: { Notes: true } },
      { failConnects: 2 },
    );
    const first = text(await tools.onLiveTool("desktop", { action: "screenshot" }));
    assert.match(first, /computer control is not available: Accessibility is not granted/);
    const second = text(await tools.onLiveTool("desktop", { action: "screenshot" }));
    assert.match(second, /Accessibility is not granted/, "a retry that fails again says the same reason");
    await tools.onLiveTool("desktop", { action: "screenshot" });
    await tools.onLiveTool("desktop", { action: "left_click", coordinate: "10,10" });
    assert.equal(connects(), 3, "each call retried the connection until it held");
    assert.deepEqual(fake.calls, ["click 10,10"]);
    assert.deepEqual(asked, ["session", "app:Notes"], "the session's yes was asked for once");
  });

  it("turned off in Settings, the next call is refused in words and reaches nothing", async () => {
    let on = true;
    const { tools, fake, connects } = await toolsWith({ session: true, apps: { Notes: true } }, { enabled: () => on });
    await tools.onLiveTool("desktop", { action: "screenshot" });
    on = false;
    const answer = await tools.onLiveTool("desktop", { action: "left_click", coordinate: "10,10" });
    assert.equal(typeof answer, "string", "an answer, never an error");
    assert.match(text(answer), /computer control is off in Settings/);
    assert.match(text(answer), /Settings → Permissions/);
    assert.deepEqual(fake.calls, [], "the click never reached the driver");
    on = true;
    await tools.onLiveTool("desktop", { action: "left_click", coordinate: "10,10" });
    assert.deepEqual(fake.calls, ["click 10,10"], "turned back on, the next call works");
    assert.equal(connects(), 1);
  });

  it("turned off while the session's card waits, a yes connects nothing", async () => {
    let on = true;
    const fake = driverWith(NOTES);
    let connects = 0;
    const tools = desktopTools({
      connect: async () => {
        connects += 1;
        return fake.driver;
      },
      ask: async () => {
        on = false;
        return true;
      },
      ownApp: () => false,
      enabled: () => on,
      frameDir: await tmpDir("desktop-tools-"),
    });
    const answer = text(await tools.onLiveTool("desktop", { action: "screenshot" }));
    assert.match(answer, /computer control is off in Settings/);
    assert.equal(connects, 0, "the driver never started");
  });

  it("stops the driver on release, and the next call asks for the session again", async () => {
    const { tools, fake, asked } = await toolsWith({ session: true, apps: { Notes: true } });
    await tools.onLiveTool("desktop", { action: "screenshot" });
    await tools.release();
    assert.deepEqual(fake.calls, ["close"]);
    await tools.onLiveTool("desktop", { action: "screenshot" });
    assert.deepEqual(asked, ["session", "session"], "a stop ends the session's yes");
  });
});
