import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import sharp from "sharp";

// Files go to a temporary folder, not backend/storage.
process.env.STORAGE_DIR = mkdtempSync(path.join(tmpdir(), "lo-storage-"));

const { prisma } = await import("../src/config/db.js");
const { googlePhoto, normalisePhoto, photoAtSignIn, removePhoto, setPhoto } = await import("../src/modules/users/photoService.js");
const { syncUserFromFirebase } = await import("../src/modules/users/userService.js");
const { avatarDir, removeUserFiles } = await import("../src/lib/storage.js");
const { dbAvailable } = await import("./fixtures.js");
const skip = !dbAvailable && "no database";

const png = (w: number, h: number) => sharp({ create: { width: w, height: h, channels: 3, background: "#3366cc" } }).png().toBuffer();

test("photo rules: Google photos at 400 px; the user's own choice is never overwritten at sign-in", () => {
  assert.equal(googlePhoto("https://lh3.googleusercontent.com/a/ACg8=s96-c"), "https://lh3.googleusercontent.com/a/ACg8=s400-c");
  assert.equal(googlePhoto("https://example.test/me.jpg"), "https://example.test/me.jpg");
  assert.equal(googlePhoto("http://insecure.test/me.jpg"), null);
  assert.equal(googlePhoto(null), null);

  const google = "https://lh3.googleusercontent.com/a/X=s96-c";
  assert.equal(photoAtSignIn(null, google), "https://lh3.googleusercontent.com/a/X=s400-c", "new account: Google photo");
  assert.equal(photoAtSignIn({ photoUrl: null, photoChosen: false }, google), "https://lh3.googleusercontent.com/a/X=s400-c");
  assert.equal(photoAtSignIn({ photoUrl: "/media/avatars/u-1.jpg", photoChosen: true }, google), undefined, "uploaded: kept");
  assert.equal(photoAtSignIn({ photoUrl: null, photoChosen: true }, google), undefined, "removed: stays removed");
  assert.equal(photoAtSignIn({ photoUrl: "https://old", photoChosen: false }, null), undefined, "no photo in the token: unchanged");
});

test("uploads become a 512 px square JPEG; junk and huge files are refused", async () => {
  const out = await normalisePhoto((await png(1200, 800)).toString("base64"));
  const meta = await sharp(out).metadata();
  assert.deepEqual([meta.format, meta.width, meta.height], ["jpeg", 512, 512]);
  await assert.rejects(normalisePhoto(Buffer.from("not an image").toString("base64")), /couldn't be read/);
  await assert.rejects(normalisePhoto(Buffer.alloc(1_600_000, 1).toString("base64")), /too large/);
});

test("set, replace and remove a photo; sign-in keeps the choice; account deletion removes the files", { skip }, async () => {
  const user = await prisma.user.create({ data: { firebaseUid: `test-${randomUUID()}`, email: `ci-${randomUUID()}@example.test`, photoUrl: "https://lh3.googleusercontent.com/a/X=s400-c" } });
  try {
    const first = await setPhoto(user.id, (await png(600, 600)).toString("base64"));
    assert.match(first.photoUrl ?? "", /^\/media\/avatars\/[\w-]+-[0-9a-f]{24}\.jpg$/);
    assert.equal(first.photoChosen, true);
    const second = await setPhoto(user.id, (await png(300, 500)).toString("base64"));
    const file = (u: string | null) => path.join(avatarDir(), path.basename(u ?? ""));
    assert.ok(existsSync(file(second.photoUrl)));
    assert.ok(!existsSync(file(first.photoUrl)), "the old photo is deleted");

    // Signing in again with Google doesn't bring the Google photo back.
    const again = await syncUserFromFirebase({ firebaseUid: user.firebaseUid, email: user.email, photoUrl: "https://lh3.googleusercontent.com/a/Y=s96-c" });
    assert.equal(again.photoUrl, second.photoUrl);

    const removed = await removePhoto(user.id);
    assert.equal(removed.photoUrl, null);
    assert.ok(!existsSync(file(second.photoUrl)));
    const later = await syncUserFromFirebase({ firebaseUid: user.firebaseUid, email: user.email, photoUrl: "https://lh3.googleusercontent.com/a/Y=s96-c" });
    assert.equal(later.photoUrl, null, "removed stays removed");

    await setPhoto(user.id, (await png(100, 100)).toString("base64"));
    await removeUserFiles(user.id);
    assert.equal((await import("node:fs")).readdirSync(avatarDir()).filter((n) => n.startsWith(user.id)).length, 0);
  } finally {
    await prisma.user.delete({ where: { id: user.id } });
  }
});
