import { AsyncLocalStorage } from "node:async_hooks";
import type { LimitPriority } from "./rate-limiter";

/**
 * Plan §C.8 — propagate rate-limit priority through ClickUp call sites
 * without threading a parameter through every method signature.
 *
 * Usage:
 *   await runWithPriority("scrum", async () => {
 *     // Any clickup.* call inside this scope uses priority='scrum'
 *     // when acquiring rate-limit tokens. Lifecycle/user-triggered
 *     // calls stay at the default 'normal'.
 *     await this.clickup.createTask(...);
 *   });
 *
 * The limiter call in `clickup-direct.service.ts` reads
 * `currentPriority()` and falls back to `'normal'`.
 */

const storage = new AsyncLocalStorage<LimitPriority>();

export function runWithPriority<T>(
	priority: LimitPriority,
	fn: () => Promise<T>,
): Promise<T> {
	return storage.run(priority, fn);
}

export function currentPriority(): LimitPriority | undefined {
	return storage.getStore();
}
