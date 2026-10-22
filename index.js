/** Persistent bundle entry. All Host effects are owned by the Loader context. */
import { HOST_INJECT, installHost } from './host.js';
export const inject = HOST_INJECT;
export async function apply(ctx) {
  // installHost returns a test/service handle; Cordis apply must not return that object as an effect.
  await installHost(ctx);
}
