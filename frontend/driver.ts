/**
 * The Lua backend has no threads: a crawl only moves forward while something
 * calls get_tree(). The page does that while it is open, which is not enough —
 * a crawl started from the button on a Steam profile page would sit still, and
 * never reach the point where it writes its HTML export.
 *
 * This driver runs for as long as the plugin is loaded, so the walk always
 * finishes whether or not the tree page is on screen.
 */

import { getTree } from './api';

/** A poll also advances the crawl by one slice, so call back promptly. */
const RUNNING_MS = 250;
/** Idle polls only read the status back, which costs the backend nothing. */
const IDLE_MS = 4000;

let timer = 0;
let started = false;

async function tick(): Promise<void> {
	let delay = IDLE_MS;
	try {
		const state = await getTree();
		delay = state.status === 'running' ? RUNNING_MS : IDLE_MS;
	} catch {
		// The backend may still be loading; try again on the slow cadence.
	}
	timer = window.setTimeout(tick, delay);
}

export function startDriver(): void {
	if (started) return;
	started = true;
	void tick();
}

/** Called when a crawl is known to have just started, to skip the idle wait. */
export function wakeDriver(): void {
	if (!started) return startDriver();
	window.clearTimeout(timer);
	void tick();
}
