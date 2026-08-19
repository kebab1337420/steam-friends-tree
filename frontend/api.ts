import { callable } from '@steambrew/client';

export type NodeStatus = 'pending' | 'ok' | 'private' | 'failed';

export interface TreeNode {
	id: string;
	depth: number;
	friends: number | null;
	status: NodeStatus;
	name?: string;
	avatar?: string;
	url?: string;
	state?: number;
	visibility?: number;
}

export interface TreeEdge {
	from: string;
	to: string;
}

export interface TreeState {
	status: 'idle' | 'running' | 'done' | 'stopped' | 'error';
	error: string;
	root: string;
	root_status: NodeStatus;
	expanded: number;
	queued: number;
	retries: number;
	truncated: boolean;
	nodes: TreeNode[];
	edges: TreeEdge[];
	/** Set once the standalone page has been written for this walk. */
	export_path: string;
	/** True when the backend already handed the page to the browser. */
	export_opened: boolean;
}

/** A type alias, not an interface: callable() requires an index-signature fit. */
export type CrawlOptions = {
	root: string;
	/** Ignored when unlimited is true. */
	max_depth: number;
	/** Keep walking until the node budget runs out. */
	unlimited: boolean;
	node_budget: number;
	/** 0 = keep every friend of a node. */
	friends_per_node: number;
};

const _getConfig = callable<[], string>('get_config');
const _setApiKey = callable<[{ api_key: string }], string>('set_api_key');
const _resolveAccount = callable<[{ query: string }], string>('resolve_account');
// The options travel as one JSON string: Millennium delivers a call's arguments
// positionally, so a multi-field payload must not rely on their order.
const _startCrawl = callable<[{ options: string }], string>('start_crawl');
const _stopCrawl = callable<[], string>('stop_crawl');
const _getTree = callable<[], string>('get_tree');
const _exportHtml = callable<[], string>('export_html');

export interface PluginConfig {
	has_key: boolean;
	last_root: string;
	max_node_budget: number;
	max_depth: number;
}

export const getConfig = async (): Promise<PluginConfig> => JSON.parse(await _getConfig());

export const setApiKey = async (api_key: string): Promise<{ ok: boolean; error?: string }> =>
	JSON.parse(await _setApiKey({ api_key }));

export const resolveAccount = async (
	query: string,
): Promise<{ ok: boolean; steamid?: string; error?: string }> =>
	JSON.parse(await _resolveAccount({ query }));

export const startCrawl = async (opts: CrawlOptions): Promise<{ ok: boolean; error: string }> =>
	JSON.parse(await _startCrawl({ options: JSON.stringify(opts) }));

/** Writes the tree to a standalone HTML page and answers with its path. */
export const exportHtml = async (): Promise<{
	ok: boolean;
	path?: string;
	opened?: boolean;
	error?: string;
}> =>
	JSON.parse(await _exportHtml());

export const stopCrawl = async (): Promise<void> => {
	await _stopCrawl();
};

export const getTree = async (): Promise<TreeState> => {
	const state: TreeState = JSON.parse(await _getTree());
	// An empty Lua table serialises as {}, so normalise before the page maps over it.
	if (!Array.isArray(state.nodes)) state.nodes = [];
	if (!Array.isArray(state.edges)) state.edges = [];
	return state;
};

/** SteamID64 of the account currently signed in to the client, if we can find it. */
export function currentUserSteamId(): string {
	const w = window as any;
	let candidates: unknown[] = [];
	try {
		candidates = [
			w?.App?.m_CurrentUser?.strSteamID,
			w?.g_StoreUser?.strSteamId,
			w?.LoginStore?.m_strSteamID,
			w?.SteamClient?.User?.GetSteamID?.(),
		];
	} catch {
		return '';
	}
	for (const value of candidates) {
		const text = String(value ?? '');
		if (/^\d{17}$/.test(text)) return text;
	}
	return '';
}
