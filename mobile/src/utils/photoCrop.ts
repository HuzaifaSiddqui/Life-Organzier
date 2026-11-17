/**
 * Profile photo crop (screens/profile/PhotoCropScreen.tsx): the photo is shown behind a circle of diameter `frame`,
 * at least big enough to cover it (cover scale × zoom), and can be dragged but never so far that the circle shows an
 * edge. The crop is the square around the circle, in the photo's own pixels. Pure; the gesture code runs the same
 * functions as worklets.
 */

export const MAX_ZOOM = 5;

/** The scale that makes the photo just cover the frame (its short side = the frame). */
export function coverScale(width: number, height: number, frame: number): number {
  "worklet";
  return width > 0 && height > 0 ? Math.max(frame / width, frame / height) : 1;
}

export function clampZoom(zoom: number): number {
  "worklet";
  return Math.min(MAX_ZOOM, Math.max(1, zoom));
}

/** The furthest the photo's centre may move from the frame's centre, per axis, at a zoom. */
export function maxOffset(width: number, height: number, frame: number, zoom: number): { x: number; y: number } {
  "worklet";
  const s = coverScale(width, height, frame) * zoom;
  return { x: Math.max(0, (width * s - frame) / 2), y: Math.max(0, (height * s - frame) / 2) };
}

export function clampOffset(offset: { x: number; y: number }, width: number, height: number, frame: number, zoom: number): { x: number; y: number } {
  "worklet";
  const m = maxOffset(width, height, frame, zoom);
  // `+ 0` turns -0 into 0.
  return { x: Math.min(m.x, Math.max(-m.x, offset.x)) + 0, y: Math.min(m.y, Math.max(-m.y, offset.y)) + 0 };
}

/** The square (in photo pixels) under the circle. Whole pixels, inside the photo. */
export function cropRect(width: number, height: number, frame: number, zoom: number, offset: { x: number; y: number }): { originX: number; originY: number; width: number; height: number } {
  const z = clampZoom(zoom);
  const o = clampOffset(offset, width, height, frame, z);
  const s = coverScale(width, height, frame) * z;
  const size = Math.min(width, height, Math.round(frame / s));
  const left = (width * s) / 2 - o.x - frame / 2;
  const top = (height * s) / 2 - o.y - frame / 2;
  const originX = Math.min(width - size, Math.max(0, Math.round(left / s)));
  const originY = Math.min(height - size, Math.max(0, Math.round(top / s)));
  return { originX, originY, width: size, height: size };
}
