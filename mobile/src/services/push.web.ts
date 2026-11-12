/**
 * Web / desktop build of services/push.ts. There is no push channel on desktop: the app pulls changes with the
 * regular sync (on focus and on its timer), which meets FR-MS-003's "within minutes". Same exports, all no-ops.
 */

export async function registerForPush(): Promise<void> {}

export async function unregisterPush(): Promise<void> {}

export function flushPushQueue(): Promise<void> {
  return Promise.resolve();
}

export function startPushListeners(): () => void {
  return () => undefined;
}
