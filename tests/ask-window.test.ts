import { expect, it } from "vitest";
import { placeAskWindow } from "../packages/ui-shared/src/ask-window.js";
it("opens alongside the source, flips at the right edge and shrinks to available side space", () => {
  const viewport = { width: 1400, height: 900 };
  expect(
    placeAskWindow({ left: 100, right: 500, top: 100, bottom: 200 }, viewport),
  ).toMatchObject({ side: "right", left: 512, top: 100, width: 420 });
  expect(
    placeAskWindow({ left: 900, right: 1300, top: 100, bottom: 200 }, viewport),
  ).toMatchObject({ side: "left", left: 468, top: 100, width: 420 });
  expect(
    placeAskWindow({ left: 300, right: 1000, top: 100, bottom: 200 }, viewport),
  ).toMatchObject({ side: "right", left: 1012, width: 376 });
});
it("uses space below or above a wide paragraph without covering its source", () => {
  const viewport = { width: 800, height: 900 };
  const below = placeAskWindow(
    { left: 20, right: 780, top: 100, bottom: 200 },
    viewport,
  );
  expect(below.side).toBe("below");
  expect(below.top).toBe(212);
  const above = placeAskWindow(
    { left: 20, right: 780, top: 700, bottom: 750 },
    viewport,
  );
  expect(above.side).toBe("above");
  expect(above.top + above.height).toBeLessThan(700);
});
it("keeps narrow, short and offscreen anchors inside the viewport and falls back to an edge", () => {
  for (const viewport of [
    { width: 390, height: 600 },
    { width: 1280, height: 360 },
    { width: 800, height: 900 },
  ]) {
    for (const anchor of [
      null,
      { left: -100, right: 200, top: -200, bottom: -100 },
      { left: 900, right: 1600, top: 1200, bottom: 1400 },
    ]) {
      const box = placeAskWindow(anchor, viewport);
      expect(box.left).toBeGreaterThanOrEqual(12);
      expect(box.top).toBeGreaterThanOrEqual(12);
      expect(box.left + box.width).toBeLessThanOrEqual(viewport.width - 12);
      expect(box.top + box.height).toBeLessThanOrEqual(viewport.height - 12);
    }
  }
  expect(placeAskWindow(null, { width: 1280, height: 900 })).toMatchObject({
    side: "edge",
    left: 848,
    top: 228,
  });
});
