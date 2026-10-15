import { expect, it } from "vitest";
import {
  parseFloatingPatch,
  readFloatingPreferences,
} from "../apps/browser-extension/src/floating-preferences.js";

it("restores bounded positions and recovers from corrupt stored preferences", () => {
  expect(
    readFloatingPreferences({ side: "left", y: 0.2, autoHide: false }),
  ).toEqual({ side: "left", y: 0.2, autoHide: false });
  expect(
    readFloatingPreferences({ side: "offscreen", y: Infinity, autoHide: "no" }),
  ).toEqual({ side: "right", y: 0.68, autoHide: true });
});
it("rejects invalid preference writes and unrelated settings", () => {
  for (const patch of [
    null,
    [],
    { side: "top" },
    { y: -0.1 },
    { y: 1.1 },
    { y: NaN },
    { autoHide: "false" },
    { apiKey: "unexpected" },
  ])
    expect(() => parseFloatingPatch(patch)).toThrow();
  expect(parseFloatingPatch({ side: "right", y: 1 })).toEqual({
    side: "right",
    y: 1,
  });
  expect(parseFloatingPatch({ autoHide: false })).toEqual({ autoHide: false });
});
