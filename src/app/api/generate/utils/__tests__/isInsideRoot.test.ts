/**
 * Path containment for media references.
 *
 * This existed as `candidate.startsWith(validation.resolved)`, which is a text
 * comparison rather than a path one. validateWorkflowPath returns its resolved
 * path with FORWARD slashes — "C:/Users/..." and "//server/share/..." — while
 * path.join builds candidates with backslashes on Windows. The prefix test was
 * therefore false for EVERY Windows path, drive-letter and UNC alike, so
 * findMediaFile skipped every candidate before it ever touched the filesystem
 * and reported "not found in the project's inputs folder" for files that were
 * present.
 *
 * The suite stayed green because the test for findMediaFile mocks the validator
 * with path.resolve(), which returns backslashes — the mock disagreed with the
 * real thing in exactly the way that mattered. That mock now normalises too.
 */

import { describe, it, expect } from "vitest";
import path from "node:path";
import { isInsideRoot } from "../resolveMediaRefs";

// Built from parts so no escape handling can mangle them.
const win = (...parts: string[]) => parts.join("\\");
const UNC_ROOT = win("", "", "server", "share", "Projects", "AD");
const DRIVE_ROOT = win("C:", "Users", "capoom", "proj");

describe("isInsideRoot", () => {
  it("accepts a child when the root uses forward slashes and the candidate backslashes", () => {
    // The exact mismatch that broke this: same location, different separators.
    const root = "C:/Users/capoom/proj";
    const candidate = win("C:", "Users", "capoom", "proj", "inputs", "a.png");
    expect(isInsideRoot(root, candidate)).toBe(true);
  });

  it("accepts a child under a UNC root with mismatched separators", () => {
    const root = "//server/share/Projects/AD";
    const candidate = win("", "", "server", "share", "Projects", "AD", "inputs", "a.png");
    expect(isInsideRoot(root, candidate)).toBe(true);
  });

  it("accepts the root itself", () => {
    expect(isInsideRoot(DRIVE_ROOT, DRIVE_ROOT)).toBe(true);
  });

  it("rejects a sibling that merely shares a name prefix", () => {
    // A plain startsWith would accept this: "C:/Users/capoom/proj-evil"
    // begins with "C:/Users/capoom/proj".
    expect(isInsideRoot("C:/Users/capoom/proj", win("C:", "Users", "capoom", "proj-evil", "a.png"))).toBe(false);
  });

  it("rejects an escape above the root", () => {
    expect(isInsideRoot("C:/Users/capoom/proj", win("C:", "Users", "capoom", "other", "a.png"))).toBe(false);
    expect(isInsideRoot("C:/Users/capoom/proj", win("C:", "Users", "a.png"))).toBe(false);
  });

  it("rejects a different drive or share", () => {
    expect(isInsideRoot("C:/Users/capoom/proj", win("D:", "elsewhere", "a.png"))).toBe(false);
    expect(isInsideRoot(UNC_ROOT, win("", "", "other", "share", "a.png"))).toBe(false);
  });

  it("agrees with path.relative about what is inside", () => {
    // Property check rather than another hand-written case: anything joined
    // onto the root is inside it, however the root was spelled.
    for (const root of [DRIVE_ROOT, DRIVE_ROOT.replace(/\\/g, "/"), UNC_ROOT, UNC_ROOT.replace(/\\/g, "/")]) {
      for (const tail of [["inputs", "a.png"], ["generations", "b.mp4"], ["x"]]) {
        expect(isInsideRoot(root, path.join(root, ...tail))).toBe(true);
      }
    }
  });
});
