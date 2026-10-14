import { Router } from "express";
import { z } from "zod";
import { handle, parseBody, requireUser } from "../../lib/http.js";
import { requireFirebaseUser } from "../../middleware/authMiddleware.js";
import { sendSuccess } from "../../utils/apiResponse.js";
import { geocode, reverseGeocode } from "./geocode.js";
import { createOrFindLocation, deleteLocation, listLocations, locationInput, requirePro, updateLocation } from "./locationService.js";

/** FR-LB-001 saved places (`/api/locations`) and geocoding (`/api/geocode`). */
export const locationRouter = Router();
locationRouter.use(requireFirebaseUser, requireUser);

// Listing and deleting stay available after a downgrade so people can clean up.
locationRouter.get(
  "/",
  handle(async (req, res) => {
    sendSuccess(res, { locations: await listLocations(req.user.id) });
  }),
);

locationRouter.post(
  "/",
  handle(async (req, res) => {
    requirePro(req.settings);
    const { location, created } = await createOrFindLocation(req.user.id, parseBody(locationInput, req.body));
    sendSuccess(res, { location, created }, created ? "Place saved" : "Place already saved", created ? 201 : 200);
  }),
);

locationRouter.put(
  "/:id",
  handle(async (req, res) => {
    requirePro(req.settings);
    const location = await updateLocation(req.user.id, req.params.id, parseBody(locationInput.partial(), req.body));
    sendSuccess(res, { location }, "Place updated");
  }),
);

locationRouter.delete(
  "/:id",
  handle(async (req, res) => {
    await deleteLocation(req.user.id, req.params.id);
    sendSuccess(res, {}, "Place deleted");
  }),
);

export const geocodeRouter = Router();
geocodeRouter.use(requireFirebaseUser, requireUser);

const coord = (min: number, max: number) => z.coerce.number().min(min).max(max);

geocodeRouter.get(
  "/",
  handle(async (req, res) => {
    const q = z.object({ q: z.string().trim().min(2).max(200), near_lat: coord(-90, 90).optional(), near_lng: coord(-180, 180).optional() }).parse(req.query);
    const near = q.near_lat !== undefined && q.near_lng !== undefined ? { lat: q.near_lat, lng: q.near_lng } : null;
    sendSuccess(res, { results: await geocode(q.q, near, {}, req.settings.timezone) });
  }),
);

geocodeRouter.get(
  "/reverse",
  handle(async (req, res) => {
    const q = z.object({ lat: coord(-90, 90), lng: coord(-180, 180) }).parse(req.query);
    sendSuccess(res, { result: await reverseGeocode(q.lat, q.lng) });
  }),
);
