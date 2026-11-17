import { describe, expect, it } from "vitest";
import { clampOffset, clampZoom, coverScale, cropRect, maxOffset } from "../photoCrop";

/** Profile photo crop: the circle is always covered and the crop is the square under it, in photo pixels. */
describe("photo crop", () => {
  it("the photo's short side fills the circle; zoom stays between 1× and 5×", () => {
    expect(coverScale(4000, 3000, 300)).toBe(0.1);
    expect(coverScale(1000, 2000, 300)).toBe(0.3);
    expect([clampZoom(0.5), clampZoom(2), clampZoom(9)]).toEqual([1, 2, 5]);
  });

  it("dragging stops where the circle would show an edge", () => {
    // 4000×3000 at 0.1 → 400×300 on screen over a 300 circle: 50 px of slack sideways, none up/down.
    expect(maxOffset(4000, 3000, 300, 1)).toEqual({ x: 50, y: 0 });
    expect(clampOffset({ x: 80, y: -20 }, 4000, 3000, 300, 1)).toEqual({ x: 50, y: 0 });
    expect(clampOffset({ x: -80, y: 120 }, 4000, 3000, 300, 2)).toEqual({ x: -80, y: 120 });
  });

  it("centred at 1×: the middle square of the short side", () => {
    expect(cropRect(4000, 3000, 300, 1, { x: 0, y: 0 })).toEqual({ originX: 500, originY: 0, width: 3000, height: 3000 });
    expect(cropRect(1000, 2000, 300, 1, { x: 0, y: 0 })).toEqual({ originX: 0, originY: 500, width: 1000, height: 1000 });
  });

  it("dragged fully right shows the photo's left edge; zoomed in takes a smaller square", () => {
    expect(cropRect(4000, 3000, 300, 1, { x: 50, y: 0 })).toEqual({ originX: 0, originY: 0, width: 3000, height: 3000 });
    expect(cropRect(4000, 3000, 300, 1, { x: -999, y: 0 })).toEqual({ originX: 1000, originY: 0, width: 3000, height: 3000 });
    // 2×: the circle covers 1500 px; moved 30 screen px up-left of centre = 150 photo px the other way.
    expect(cropRect(4000, 3000, 300, 2, { x: 30, y: 30 })).toEqual({ originX: 1100, originY: 600, width: 1500, height: 1500 });
  });
});
