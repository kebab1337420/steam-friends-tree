import { definePlugin, toaster } from '@steambrew/client';
import { FriendsTreePage } from './TreePage';
import { startDriver, wakeDriver } from './driver';
import { emitExternalStart } from './externalStart';
import { injectStyles } from './styles';

/** Sidebar icon: a two-level tree, echoing the radial layout of the page. */
function TreeIcon() {
	return (
		<svg width="18" height="18" viewBox="0 0 18 18" fill="none" aria-hidden="true">
			<path
				d="M9 4.6v2.6M9 7.2 4.4 11M9 7.2 13.6 11"
				stroke="currentColor"
				strokeWidth="1.3"
				strokeLinecap="round"
			/>
			<circle cx="9" cy="3.2" r="1.9" fill="currentColor" />
			<circle cx="4" cy="12.4" r="1.7" fill="currentColor" />
			<circle cx="14" cy="12.4" r="1.7" fill="currentColor" />
		</svg>
	);
}

export default definePlugin(() => {
	injectStyles();
	// Keeps any crawl moving, including one started from a profile page while
	// the tree page itself is closed.
	startDriver();

	// Millennium turns a title/icon/content triple into its own entry in the
	// client's plugin navigation, which is where the tree lives.
	return {
		title: 'Arbre des amis',
		icon: <TreeIcon />,
		content: <FriendsTreePage />,
		onDismount: () => {
			document.getElementById('steam-friends-tree-css')?.remove();
		},
	} as any;
});

/**
 * Called by the backend when a crawl is started from the button on a Steam
 * profile page. Millennium invokes exported functions positionally, but older
 * builds hand over a single object, so both shapes are accepted.
 */
type StartPayload = string | string[] | { steamid?: string; persona?: string };

export function notifyTreeStarted(steamid: StartPayload, persona?: string): void {
	// The backend sends the pair as a list; Millennium may also deliver it as an
	// object or as two plain arguments, so all three shapes are accepted.
	const pair = Array.isArray(steamid)
		? { steamid: steamid[0], persona: steamid[1] }
		: typeof steamid === 'object'
			? steamid
			: { steamid, persona };
	const id = String(pair?.steamid ?? '');
	const name = pair?.persona || id;

	emitExternalStart({ steamid: id, persona: name });
	wakeDriver();
	toaster.toast({
		title: 'Arbre des amis',
		body: `Traçage lancé depuis le profil de ${name}.`,
		logo: <TreeIcon />,
	});
}
