import type { PointerEvent as ReactPointerEvent } from 'react';
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import {
	currentUserSteamId,
	exportHtml,
	getConfig,
	getTree,
	resolveAccount,
	setApiKey,
	startCrawl,
	stopCrawl,
	type TreeState,
} from './api';
import { lastExternalStart, onExternalStart } from './externalStart';
import { layoutTree, pathToRoot } from './layout';
import { injectStyles } from './styles';

const EMPTY: TreeState = {
	status: 'idle',
	error: '',
	root: '',
	root_status: 'pending',
	expanded: 0,
	queued: 0,
	retries: 0,
	truncated: false,
	nodes: [],
	edges: [],
	export_path: '',
	export_opened: false,
};

const POLL_MS = 900;
/** Past this many accounts the SVG scene stops being comfortable to drive. */
const HEAVY_BUDGET = 2000;
/** Labels are noise below this zoom, and expensive above this node count. */
const LABEL_MIN_ZOOM = 0.45;
const LABEL_MAX_NODES = 400;
/** A pointer that moved further than this was panning, not clicking. */
const DRAG_SLOP = 4;

export function FriendsTreePage() {
	const [state, setState] = useState<TreeState>(EMPTY);
	const [hasKey, setHasKey] = useState(true);
	const [keyInput, setKeyInput] = useState('');
	const [rootInput, setRootInput] = useState('');
	const [bounded, setBounded] = useState(true);
	const [depth, setDepth] = useState(2);
	const [budget, setBudget] = useState(400);
	const [friendsCap, setFriendsCap] = useState(0);
	const [notice, setNotice] = useState('');
	const [selected, setSelected] = useState<string | null>(null);
	const [collapsed, setCollapsed] = useState<Set<string>>(new Set());

	const [zoom, setZoom] = useState(0.6);
	const [pan, setPan] = useState({ x: 0, y: 0 });
	const [dragging, setDragging] = useState(false);
	const [size, setSize] = useState({ w: 1200, h: 800 });

	const canvasRef = useRef<HTMLDivElement | null>(null);
	const dragRef = useRef<{ x: number; y: number; px: number; py: number; moved: number } | null>(
		null,
	);
	const suppressClick = useRef(false);
	// Read by the wheel listener, which is attached once and must not close over
	// stale zoom/pan values.
	const viewRef = useRef({ zoom, pan });
	viewRef.current = { zoom, pan };

	useEffect(() => {
		injectStyles();
	}, []);

	useEffect(() => {
		getConfig().then((cfg) => {
			setHasKey(cfg.has_key);
			setRootInput(cfg.last_root || currentUserSteamId());
		});
		getTree().then(setState);
	}, []);

	// A crawl started from a Steam profile page runs backend-side without the
	// page knowing: adopt its root and start polling again.
	useEffect(() => {
		const adopt = (start: { steamid: string }) => {
			if (start.steamid) setRootInput(start.steamid);
			getTree().then(setState);
		};
		const pending = lastExternalStart();
		if (pending) adopt(pending);
		return onExternalStart(adopt);
	}, []);

	// Poll only while the backend is actually walking the graph.
	useEffect(() => {
		if (state.status !== 'running') return;
		let alive = true;
		let timer = 0;
		// Each poll also advances the crawl backend-side, so the next one is
		// scheduled after the previous answer instead of on a fixed interval:
		// requests never pile up when a slice runs long.
		const tick = () => {
			getTree()
				.then((next) => {
					if (alive) setState(next);
				})
				.finally(() => {
					if (alive) timer = window.setTimeout(tick, POLL_MS);
				});
		};
		timer = window.setTimeout(tick, POLL_MS);
		return () => {
			alive = false;
			window.clearTimeout(timer);
		};
	}, [state.status]);

	/**
	 * Fallback for when the backend could not spawn the browser itself: Steam's
	 * own openers first, then a plain window.
	 */
	const openPage = useCallback((path: string) => {
		const url = 'file:///' + path.replace(/\\/g, '/').replace(/^\/+/, '');
		const client = (window as any).SteamClient;
		if (client?.System?.OpenInSystemBrowser) client.System.OpenInSystemBrowser(url);
		else if (client?.URL?.ExecuteSteamURL) client.URL.ExecuteSteamURL('steam://openurl_external/' + url);
		else window.open(url, '_blank');
	}, []);

	// The backend writes the page as soon as a walk ends; open it once, and say
	// where it landed.
	const openedPath = useRef('');
	useEffect(() => {
		if (!state.export_path || state.export_path === openedPath.current) return;
		openedPath.current = state.export_path;
		setNotice('Page ecrite : ' + state.export_path);
		if (!state.export_opened) openPage(state.export_path);
	}, [state.export_path, state.export_opened, openPage]);

	// Keep the drawing area's real size, so culling and recentring are exact.
	useLayoutEffect(() => {
		const element = canvasRef.current;
		if (!element) return;
		const measure = () =>
			setSize({ w: element.clientWidth || 1200, h: element.clientHeight || 800 });
		measure();
		const observer = new ResizeObserver(measure);
		observer.observe(element);
		return () => observer.disconnect();
	}, []);

	const layout = useMemo(
		() => layoutTree(state.nodes, state.edges, state.root, collapsed),
		[state.nodes, state.edges, state.root, collapsed],
	);

	const half = layout.extent + 120;

	const recenter = useCallback(
		(nextZoom?: number) => {
			const z = nextZoom ?? 0.6;
			setZoom(z);
			setPan({ x: size.w / 2 - half * z, y: size.h / 2 - half * z });
		},
		[half, size.h, size.w],
	);

	// Zoom on the wheel has to be a non-passive native listener: React routes
	// onWheel through a passive root listener, where preventDefault is ignored.
	useEffect(() => {
		const element = canvasRef.current;
		if (!element) return;
		const onWheel = (event: WheelEvent) => {
			event.preventDefault();
			const { zoom: z, pan: p } = viewRef.current;
			const next = Math.min(3, Math.max(0.05, z * (event.deltaY < 0 ? 1.12 : 1 / 1.12)));
			const rect = element.getBoundingClientRect();
			const cx = event.clientX - rect.left;
			const cy = event.clientY - rect.top;
			// Keep whatever sits under the cursor pinned to the cursor.
			setPan({
				x: cx - ((cx - p.x) * next) / z,
				y: cy - ((cy - p.y) * next) / z,
			});
			setZoom(next);
		};
		element.addEventListener('wheel', onWheel, { passive: false });
		return () => element.removeEventListener('wheel', onWheel);
	}, []);

	// Frame the new tree once per crawl, without fighting the user's own panning.
	const centeredRoot = useRef('');
	useEffect(() => {
		if (!state.root || state.root === centeredRoot.current) return;
		centeredRoot.current = state.root;
		recenter();
	}, [state.root, recenter]);

	const highlighted = useMemo(
		() => new Set(selected ? pathToRoot(state.edges, selected) : []),
		[selected, state.edges],
	);

	// Only draw what is on screen: a full tree at the maximum budget is tens of
	// thousands of SVG elements, redrawn at every poll.
	const view = useMemo(() => {
		const margin = 120;
		const onScreen = (x: number, y: number) => {
			const sx = pan.x + (half + x) * zoom;
			const sy = pan.y + (half + y) * zoom;
			return sx > -margin && sx < size.w + margin && sy > -margin && sy < size.h + margin;
		};
		const nodes = layout.nodes.filter((node) => onScreen(node.x, node.y));
		const visible = new Set(nodes.map((node) => node.id));
		const links = layout.links.filter(
			(link) => visible.has(link.from.id) || visible.has(link.to.id),
		);
		const labels = zoom >= LABEL_MIN_ZOOM && nodes.length <= LABEL_MAX_NODES;
		return { nodes, links, labels, hidden: layout.nodes.length - nodes.length };
	}, [layout, pan.x, pan.y, zoom, half, size.w, size.h]);

	const launch = useCallback(
		async (rawRoot: string) => {
			setNotice('');
			const query = rawRoot.trim();
			if (!query) {
				setNotice('Renseigne un compte de depart.');
				return;
			}
			const resolved = await resolveAccount(query);
			if (!resolved.ok || !resolved.steamid) {
				setNotice(resolved.error || 'Compte introuvable.');
				return;
			}
			setCollapsed(new Set());
			setSelected(null);
			const started = await startCrawl({
				root: resolved.steamid,
				max_depth: depth,
				unlimited: !bounded,
				node_budget: budget,
				friends_per_node: friendsCap,
			});
			if (!started.ok) {
				setNotice(started.error);
				return;
			}
			setRootInput(resolved.steamid);
			setState({ ...EMPTY, status: 'running', root: resolved.steamid });
			recenter();
		},
		[bounded, budget, depth, friendsCap, recenter],
	);

	/** Writes the tree to a standalone page and asks Steam to open it. */
	const exportPage = async () => {
		const answer = await exportHtml();
		if (!answer.ok || !answer.path) {
			setNotice(answer.error || 'Export impossible.');
			return;
		}
		setNotice('Page ecrite : ' + answer.path);
		openedPath.current = answer.path;
		if (!answer.opened) openPage(answer.path);
	};

	const saveKey = async () => {
		const saved = await setApiKey(keyInput);
		if (!saved.ok) {
			setNotice(saved.error || 'Cle refusee.');
			return;
		}
		setNotice('');
		setKeyInput('');
		setHasKey((await getConfig()).has_key);
	};

	const toggleCollapse = (id: string) => {
		setCollapsed((prev) => {
			const next = new Set(prev);
			if (next.has(id)) next.delete(id);
			else next.add(id);
			return next;
		});
	};

	const onPointerDown = (event: ReactPointerEvent) => {
		(event.currentTarget as HTMLElement).setPointerCapture(event.pointerId);
		dragRef.current = { x: event.clientX, y: event.clientY, px: pan.x, py: pan.y, moved: 0 };
		suppressClick.current = false;
		setDragging(true);
	};

	const onPointerMove = (event: ReactPointerEvent) => {
		const origin = dragRef.current;
		if (!origin) return;
		const dx = event.clientX - origin.x;
		const dy = event.clientY - origin.y;
		origin.moved = Math.max(origin.moved, Math.abs(dx) + Math.abs(dy));
		setPan({ x: origin.px + dx, y: origin.py + dy });
	};

	const onPointerUp = () => {
		// A pan that ends over a node must not select it.
		suppressClick.current = (dragRef.current?.moved ?? 0) > DRAG_SLOP;
		dragRef.current = null;
		setDragging(false);
	};

	const selectNode = (id: string) => {
		if (suppressClick.current) return;
		setSelected(id);
	};

	const selectedNode = selected ? layout.byId.get(selected) : undefined;
	const running = state.status === 'running';
	const rootPrivate = state.root_status === 'private' && state.nodes.length <= 1;
	const heavy = budget > HEAVY_BUDGET;

	return (
		<div className="sft-page">
			<div className="sft-side">
				<h2>Arbre des amis</h2>

				{!hasKey && (
					<div className="sft-group">
						<label>Cle Steam Web API</label>
						<div className="sft-row">
							<input
								className="sft-input"
								value={keyInput}
								onChange={(e) => setKeyInput(e.currentTarget.value)}
								placeholder="32 caracteres hexadecimaux"
							/>
							<button className="sft-btn" onClick={saveKey}>
								OK
							</button>
						</div>
						<div className="sft-hint">
							A recuperer sur steamcommunity.com/dev/apikey. Stockee en local dans
							config.json, jamais envoyee ailleurs qu'a l'API Steam.
						</div>
					</div>
				)}

				<div className="sft-group">
					<label>Racine de l'arbre</label>
					<div className="sft-row">
						<input
							className="sft-input"
							value={rootInput}
							onChange={(e) => setRootInput(e.currentTarget.value)}
							placeholder="SteamID64, pseudo d'URL ou lien de profil"
						/>
						<button
							className="sft-btn"
							onClick={() => setRootInput(currentUserSteamId())}
							disabled={!currentUserSteamId()}
						>
							Moi
						</button>
					</div>
				</div>

				<div className="sft-group">
					<label>Fin de l'arbre</label>
					<div className="sft-choice">
						<button className={bounded ? 'sft-on' : ''} onClick={() => setBounded(true)}>
							Profondeur fixe
						</button>
						<button className={bounded ? '' : 'sft-on'} onClick={() => setBounded(false)}>
							Sans fin
						</button>
					</div>
					{bounded ? (
						<>
							<div className="sft-row">
								<input
									className="sft-input"
									type="range"
									min={1}
									max={6}
									value={depth}
									onChange={(e) => setDepth(Number(e.currentTarget.value))}
								/>
								<span>{depth}</span>
							</div>
							<div className="sft-hint">
								L'arbre s'arrete a {depth} niveau{depth > 1 ? 'x' : ''} d'amis autour de la
								racine.
							</div>
						</>
					) : (
						<div className="sft-hint">
							Le graphe d'amis n'a pas de fin naturelle : l'exploration continue jusqu'au
							budget de comptes ci-dessous, ou jusqu'a ce que tu l'arretes.
						</div>
					)}
				</div>

				<div className="sft-group">
					<label>Budget de comptes</label>
					<input
						className="sft-input"
						type="number"
						min={1}
						max={20000}
						value={budget}
						onChange={(e) => setBudget(Math.max(1, Number(e.currentTarget.value) || 1))}
					/>
					<div className="sft-hint">
						Une requete API par compte explore, environ {formatDuration(budget)} au total.
					</div>
					{heavy && (
						<div className="sft-warn" style={{ marginTop: 8 }}>
							Au-dela de {HEAVY_BUDGET} comptes, l'affichage devient lourd : les libelles
							disparaissent et seuls les noeuds a l'ecran sont dessines.
						</div>
					)}
				</div>

				<div className="sft-group">
					<label>Amis gardes par compte</label>
					<input
						className="sft-input"
						type="number"
						min={0}
						value={friendsCap}
						onChange={(e) => setFriendsCap(Math.max(0, Number(e.currentTarget.value) || 0))}
					/>
					<div className="sft-hint">0 = tous les amis.</div>
				</div>

				<div className="sft-group sft-row">
					<button
						className="sft-btn sft-primary"
						onClick={() => launch(rootInput)}
						disabled={running || !hasKey}
					>
						{running ? 'Exploration...' : "Construire l'arbre"}
					</button>
					{running && (
						<button className="sft-btn sft-danger" onClick={() => stopCrawl()}>
							Stop
						</button>
					)}
					<button className="sft-btn" onClick={exportPage} disabled={state.nodes.length === 0}>
						Exporter en HTML
					</button>
				</div>

				{notice && <div className="sft-group sft-error">{notice}</div>}
				{state.status === 'error' && <div className="sft-group sft-error">{state.error}</div>}
				{rootPrivate && (
					<div className="sft-group sft-warn">
						La liste d'amis de ce compte est privee : impossible de construire l'arbre a partir
						de lui.
					</div>
				)}
				{state.truncated && !running && (
					<div className="sft-group sft-warn">
						Arbre tronque : une limite (profondeur, budget ou amis par compte) a ete atteinte.
					</div>
				)}

				<div className="sft-group sft-stats">
					<span>Comptes</span>
					<span>{state.nodes.length}</span>
					<span>Explores</span>
					<span>{state.expanded}</span>
					<span>En attente</span>
					<span>{state.queued}</span>
					<span>Liens</span>
					<span>{state.edges.length}</span>
					{state.retries > 0 && (
						<>
							<span>Reessais API</span>
							<span>{state.retries}</span>
						</>
					)}
					{view.hidden > 0 && (
						<>
							<span>Hors cadre</span>
							<span>{view.hidden}</span>
						</>
					)}
				</div>
			</div>

			<div
				ref={canvasRef}
				className={`sft-canvas${dragging ? ' sft-drag' : ''}`}
				onPointerDown={onPointerDown}
				onPointerMove={onPointerMove}
				onPointerUp={onPointerUp}
				onPointerCancel={onPointerUp}
			>
				{layout.nodes.length === 0 ? (
					<div className="sft-empty">Choisis une racine et construis l'arbre.</div>
				) : (
					<svg width="100%" height="100%">
						<g transform={`translate(${pan.x}, ${pan.y}) scale(${zoom})`}>
							<g transform={`translate(${half}, ${half})`}>
								{view.links.map((link) => (
									<path
										key={`${link.from.id}-${link.to.id}`}
										className={`sft-link${
											highlighted.has(link.from.id) && highlighted.has(link.to.id)
												? ' sft-hot'
												: ''
										}`}
										d={link.path}
									/>
								))}
								{view.nodes.map((node) => {
									const classes = ['sft-node'];
									if (node.id === state.root) classes.push('sft-root');
									if (node.collapsed) classes.push('sft-collapsed');
									if (node.status === 'private') classes.push('sft-private');
									if (node.status === 'failed') classes.push('sft-failed');
									if (node.id === selected) classes.push('sft-sel');
									const flip = Math.cos(node.angle) < 0;
									return (
										<g
											key={node.id}
											className={classes.join(' ')}
											transform={`translate(${node.x}, ${node.y})`}
											onClick={() => selectNode(node.id)}
											onDoubleClick={() => toggleCollapse(node.id)}
										>
											<circle r={node.id === state.root ? 14 : 8} />
											{view.labels && node.avatar && (
												<image
													href={node.avatar}
													x={-8}
													y={-8}
													width={16}
													height={16}
													clipPath="circle(8px at 8px 8px)"
												/>
											)}
											{view.labels && (
												<text
													x={flip ? -14 : 14}
													textAnchor={flip ? 'end' : 'start'}
													transform={`rotate(${
														(node.angle * 180) / Math.PI + (flip ? 180 : 0)
													})`}
												>
													{node.name || node.id}
												</text>
											)}
										</g>
									);
								})}
							</g>
						</g>
					</svg>
				)}

				{selectedNode && (
					<div className="sft-detail">
						<div className="sft-row" style={{ marginBottom: 8 }}>
							{selectedNode.avatar && <img src={selectedNode.avatar} alt="" />}
							<div>
								<div className="sft-name">{selectedNode.name || selectedNode.id}</div>
								<div className="sft-meta">
									niveau {selectedNode.depth} · {selectedNode.childCount} branche
									{selectedNode.childCount > 1 ? 's' : ''}
									{selectedNode.friends !== null && ` sur ${selectedNode.friends} amis`}
									{selectedNode.status === 'private' && ' · profil prive'}
									{selectedNode.status === 'failed' && ' · lecture echouee'}
									{selectedNode.status === 'pending' && ' · non explore'}
								</div>
							</div>
						</div>
						<button className="sft-btn" onClick={() => launch(selectedNode.id)}>
							Prendre comme racine
						</button>
						<button className="sft-btn" onClick={() => toggleCollapse(selectedNode.id)}>
							{selectedNode.collapsed ? 'Deplier' : 'Replier'} la branche
						</button>
						{selectedNode.url && (
							<button
								className="sft-btn"
								onClick={() => window.open(selectedNode.url, '_blank')}
							>
								Ouvrir le profil
							</button>
						)}
					</div>
				)}

				<div className="sft-zoom">
					<button className="sft-btn" onClick={() => setZoom((z) => Math.min(3, z * 1.2))}>
						+
					</button>
					<button className="sft-btn" onClick={() => setZoom((z) => Math.max(0.05, z / 1.2))}>
						−
					</button>
					<button className="sft-btn" onClick={() => recenter()}>
						Recentrer
					</button>
				</div>
			</div>
		</div>
	);
}

/** Rough wall-clock cost of a crawl: one request per account, plus its pause. */
function formatDuration(accounts: number): string {
	const seconds = Math.ceil(accounts * 0.42);
	if (seconds < 90) return `${seconds} s`;
	const minutes = Math.round(seconds / 60);
	if (minutes < 90) return `${minutes} min`;
	return `${(minutes / 60).toFixed(1)} h`;
}
