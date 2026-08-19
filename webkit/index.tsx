/**
 * Injected into Steam's web pages: adds a "Tracer l'arbre d'amis" button to
 * profile pages, which starts a crawl rooted on the profile being viewed.
 *
 * This module runs in an isolated world, so page globals such as
 * g_rgProfileData are out of reach; the account is read from the URL, and
 * otherwise from the profile data embedded in the page's own scripts.
 */

import { callable } from '@steambrew/webkit';

// One JSON string, so the call does not depend on how Millennium orders the
// arguments it forwards to the backend.
const startFromProfile = callable<[{ options: string }], string>('start_from_profile');
const exportHtml = callable<[], string>('export_html');
const resolveAccount = callable<[{ query: string }], string>('resolve_account');

const BUTTON_ID = 'sft-profile-button';
const EXPORT_ID = 'sft-profile-export';
const STYLE_ID = 'sft-profile-style';

const STYLES = `
#${BUTTON_ID}, #${EXPORT_ID} { cursor: pointer; margin-left: 6px; }
#${EXPORT_ID}[data-busy='1'] { opacity: 0.6; pointer-events: none; }
#${EXPORT_ID}[data-state='error'] { color: #e06666; }
#${BUTTON_ID}[data-busy='1'] { opacity: 0.6; pointer-events: none; }
#${BUTTON_ID} .sft-label { display: inline-flex; align-items: center; gap: 6px; }
#${BUTTON_ID} svg { flex: none; }
#${BUTTON_ID}[data-state='error'] { color: #e06666; }
`;

const ICON = `
<svg width="14" height="14" viewBox="0 0 18 18" fill="none" aria-hidden="true">
	<path d="M9 4.6v2.6M9 7.2 4.4 11M9 7.2 13.6 11" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/>
	<circle cx="9" cy="3.2" r="1.9" fill="currentColor"/>
	<circle cx="4" cy="12.4" r="1.7" fill="currentColor"/>
	<circle cx="14" cy="12.4" r="1.7" fill="currentColor"/>
</svg>`;

/** SteamID64 of the profile on screen, resolving a vanity URL if needed. */
async function profileSteamId(): Promise<{ steamid: string; error?: string }> {
	const fromUrl = location.pathname.match(/\/profiles\/(\d{17})/);
	if (fromUrl) return { steamid: fromUrl[1] };

	// Profile pages embed g_rgProfileData; the isolated world cannot read the
	// page's globals, but it can still read the script element they sit in.
	for (const script of Array.from(document.scripts)) {
		const text = script.textContent ?? '';
		if (!text.includes('g_rgProfileData')) continue;
		const match = text.match(/"steamid"\s*:\s*"(\d{17})"/);
		if (match) return { steamid: match[1] };
	}

	const vanity = location.pathname.match(/\/id\/([^/?#]+)/);
	if (vanity) {
		const answer = JSON.parse(await resolveAccount({ query: decodeURIComponent(vanity[1]) }));
		if (answer.ok && answer.steamid) return { steamid: String(answer.steamid) };
		return { steamid: '', error: answer.error };
	}
	return { steamid: '' };
}

/** The persona name, used only to make the confirmation readable. */
function personaName(): string {
	const heading = document.querySelector('.actual_persona_name, .profile_header .persona_name');
	return heading?.textContent?.trim() ?? '';
}

function setLabel(button: HTMLElement, text: string, state = ''): void {
	button.dataset.state = state;
	const label = button.querySelector('.sft-label');
	if (label) label.innerHTML = `${ICON}<span>${text}</span>`;
}

async function onClick(button: HTMLElement): Promise<void> {
	button.dataset.busy = '1';
	setLabel(button, 'Lecture du profil…');
	try {
		const profile = await profileSteamId();
		if (!profile.steamid) {
			setLabel(button, profile.error || 'Compte introuvable', 'error');
			return;
		}
		const steamid = profile.steamid;

		const answer = JSON.parse(await startFromProfile({ options: JSON.stringify({ steamid, persona: personaName() }) }));
		if (answer.ok) {
			setLabel(button, 'Arbre en cours — onglet Arbre des amis');
		} else {
			setLabel(button, answer.error || 'Echec du lancement', 'error');
		}
	} catch (error) {
		setLabel(button, 'Echec du lancement', 'error');
		console.error('[steam-friends-tree]', error);
	} finally {
		button.dataset.busy = '';
		// Back to the idle label, so the button stays usable on the same page.
		window.setTimeout(() => setLabel(button, "Tracer l'arbre d'amis"), 6000);
	}
}

function buildButton(): HTMLElement {
	const button = document.createElement('a');
	button.id = BUTTON_ID;
	button.className = 'btn_profile_action btn_medium';
	button.setAttribute('role', 'button');
	button.innerHTML = '<span class="sft-label"></span>';
	setLabel(button, "Tracer l'arbre d'amis");
	button.addEventListener('click', (event) => {
		event.preventDefault();
		void onClick(button);
	});
	return button;
}

/**
 * Sits next to the crawl button: writes the tree currently held by the backend
 * to its HTML page, which the backend then opens in the browser.
 */
function buildExportButton(): HTMLElement {
	const button = document.createElement('a');
	button.id = EXPORT_ID;
	button.className = 'btn_profile_action btn_medium';
	button.setAttribute('role', 'button');
	button.innerHTML = '<span class="sft-label"></span>';
	setLabel(button, 'Exporter en HTML');

	button.addEventListener('click', async (event) => {
		event.preventDefault();
		button.dataset.busy = '1';
		setLabel(button, 'Export…');
		try {
			const answer = JSON.parse(await exportHtml());
			if (answer.ok) setLabel(button, 'Page ouverte dans le navigateur');
			else setLabel(button, answer.error || 'Export impossible', 'error');
		} catch (error) {
			setLabel(button, 'Export impossible', 'error');
			console.error('[steam-friends-tree]', error);
		} finally {
			button.dataset.busy = '';
			window.setTimeout(() => setLabel(button, 'Exporter en HTML'), 6000);
		}
	});
	return button;
}

/** Profile pages only, and never twice on the same one. */
function mount(): void {
	if (!/^\/(id|profiles)\//.test(location.pathname)) return;
	if (document.getElementById(BUTTON_ID)) return;

	const host =
		document.querySelector('.profile_header_actions') ??
		document.querySelector('.profile_header_badgeinfo') ??
		document.querySelector('.profile_header_summary');
	if (!host) return;

	if (!document.getElementById(STYLE_ID)) {
		const style = document.createElement('style');
		style.id = STYLE_ID;
		style.textContent = STYLES;
		document.head.appendChild(style);
	}
	host.appendChild(buildButton());
	host.appendChild(buildExportButton());
}

export default function WebkitMain(): void {
	if (location.hostname !== 'steamcommunity.com') return;

	mount();
	// Steam swaps parts of the profile header in after load, and moving between
	// profiles does not always reload the document.
	const observer = new MutationObserver(() => mount());
	observer.observe(document.documentElement, { childList: true, subtree: true });
}
