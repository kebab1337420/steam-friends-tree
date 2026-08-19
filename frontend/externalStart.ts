/**
 * A crawl can be started from outside the page — the button the webkit module
 * adds to Steam profile pages goes straight to the backend. The backend then
 * calls into this module, and the page picks the walk up if it is mounted.
 */

export interface ExternalStart {
	steamid: string;
	persona: string;
}

type Listener = (start: ExternalStart) => void;

const listeners = new Set<Listener>();
let last: ExternalStart | null = null;

/** Subscribes to external starts; returns the unsubscribe function. */
export function onExternalStart(listener: Listener): () => void {
	listeners.add(listener);
	return () => {
		listeners.delete(listener);
	};
}

export function emitExternalStart(start: ExternalStart): void {
	last = start;
	for (const listener of listeners) listener(start);
}

/** The most recent external start, for a page mounted after the fact. */
export function lastExternalStart(): ExternalStart | null {
	return last;
}
