/**
 * Whether this computer runs Git, asked before Play runs it for a player: off a Mac yes, and on a
 * Mac only where the `git` on the app's PATH is a real one, since /usr/bin/git there only stands in
 * for Apple's developer tools and, without them, asks the person to install them. A PATH entry that
 * is not absolute is never searched.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { type HostGitProbe, hostGitRuns, thisComputersGit } from "../../src/substrate/git-policy.ts";

const CLT = "/Library/Developer/CommandLineTools";

/** A computer whose runnable files and developer folder the test names, every look recorded. */
function probe(overrides: Partial<HostGitProbe> & { files?: readonly string[] } = {}) {
  const looked: string[] = [];
  const files = new Set(overrides.files ?? []);
  const computer: HostGitProbe = {
    platform: "darwin",
    path: "/usr/bin:/bin:/usr/sbin:/sbin",
    runnable: async (file) => {
      looked.push(file);
      return files.has(file);
    },
    developerDir: async () => null,
    ...overrides,
  };
  return { computer, looked };
}

describe("whether this computer runs Git", () => {
  it("answers by where git is and, on a Mac's stand-in, by Apple's developer tools", async () => {
    const cases: Array<[string, Parameters<typeof probe>[0], boolean]> = [
      ["Linux, without a look", { platform: "linux" }, true],
      ["Windows, without a look", { platform: "win32" }, true],
      [
        "a Mac with the Command Line Tools",
        { files: ["/usr/bin/git", `${CLT}/usr/bin/git`], developerDir: async () => CLT },
        true,
      ],
      ["a Mac without developer tools", { files: ["/usr/bin/git"] }, false],
      [
        "a Mac whose developer folder holds no git",
        { files: ["/usr/bin/git"], developerDir: async () => "/nonexistent-developer-tools" },
        false,
      ],
      [
        "a Mac with its own git first on the PATH",
        { path: "/opt/homebrew/bin:/usr/bin", files: ["/opt/homebrew/bin/git"] },
        true,
      ],
      ["a Mac with no git at all", { path: "/bin:/usr/sbin" }, false],
      ["a Mac whose PATH is empty", { path: "" }, false],
    ];
    for (const [why, overrides, runs] of cases) assert.equal(await hostGitRuns(probe(overrides).computer), runs, why);
  });

  it("never searches a PATH entry that is not absolute", async () => {
    const { computer, looked } = probe({
      path: ".::bin:./tools:../up:/usr/bin",
      files: ["git", "bin/git", "/usr/bin/git"],
    });
    assert.equal(await hostGitRuns(computer), false, "only /usr/bin's stand-in, with no developer tools");
    assert.deepEqual(looked, ["/usr/bin/git"]);
  });

  it("asks this Mac's own xcode-select, which a missing developer folder answers with no git", {
    skip: process.platform !== "darwin",
  }, async () => {
    const env = { ...process.env, DEVELOPER_DIR: "/nonexistent-developer-tools", PATH: "/usr/bin:/bin" };
    assert.equal(await hostGitRuns(thisComputersGit(env)), false);
  });
});
