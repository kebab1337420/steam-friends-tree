import type { TreeEdge, TreeNode } from './api';

export interface LaidOutNode extends TreeNode {
	x: number;
	y: number;
	angle: number;
	radius: number;
	childCount: number;
	collapsed: boolean;
	hidden: boolean;
}

export interface LaidOutLink {
	from: LaidOutNode;
	to: LaidOutNode;
	path: string;
}

export interface Layout {
	nodes: LaidOutNode[];
	links: LaidOutLink[];
	extent: number;
	byId: Map<string, LaidOutNode>;
}

const RING = 240;
/** Arc a leaf needs on its ring before its avatar and name run into the next. */
const MIN_ARC = 46;

/**
 * Radial tidy layout: every node gets an angular slice proportional to the
 * number of leaves below it, and a radius proportional to its depth. Subtrees
 * whose root is in `collapsed` are laid out but flagged hidden, so toggling a
 * branch does not require a new crawl.
 */
export function layoutTree(
	nodes: TreeNode[],
	edges: TreeEdge[],
	rootId: string,
	collapsed: Set<string>,
): Layout {
	const byId = new Map<string, LaidOutNode>();
	for (const node of nodes) {
		byId.set(node.id, {
			...node,
			x: 0,
			y: 0,
			angle: 0,
			radius: 0,
			childCount: 0,
			collapsed: collapsed.has(node.id),
			hidden: false,
		});
	}

	const children = new Map<string, string[]>();
	for (const edge of edges) {
		if (!byId.has(edge.from) || !byId.has(edge.to)) continue;
		const list = children.get(edge.from);
		if (list) list.push(edge.to);
		else children.set(edge.from, [edge.to]);
	}
	for (const [id, list] of children) {
		const node = byId.get(id);
		if (node) node.childCount = list.length;
	}

	const root = byId.get(rootId) ?? byId.values().next().value;
	if (!root) return { nodes: [], links: [], extent: RING, byId };

	// Leaf weight of every visible subtree, computed bottom-up iteratively so a
	// deep graph cannot blow the JS stack.
	const order: string[] = [];
	const stack = [root.id];
	const seen = new Set<string>([root.id]);
	while (stack.length) {
		const id = stack.pop()!;
		order.push(id);
		const node = byId.get(id)!;
		if (node.collapsed) continue;
		for (const child of children.get(id) ?? []) {
			if (seen.has(child)) continue;
			seen.add(child);
			stack.push(child);
		}
	}

	const weight = new Map<string, number>();
	for (let i = order.length - 1; i >= 0; i--) {
		const id = order[i];
		const node = byId.get(id)!;
		const kids = node.collapsed ? [] : (children.get(id) ?? []).filter((c) => seen.has(c));
		let total = 0;
		for (const child of kids) total += weight.get(child) ?? 1;
		weight.set(id, kids.length ? total : 1);
	}

	// Every leaf owns the same slice of the circle, so the first ring has to sit
	// far enough out that a slice is wide enough to hold a node: past a few
	// hundred accounts, fixed rings pile them on top of each other.
	const leaves = weight.get(root.id) ?? 1;
	const firstRing = Math.max(RING, (leaves * MIN_ARC) / (Math.PI * 2));

	let maxDepth = 0;
	const place = (id: string, start: number, end: number, depth: number) => {
		const node = byId.get(id)!;
		const angle = (start + end) / 2;
		const radius = depth === 0 ? 0 : firstRing + (depth - 1) * RING;
		node.angle = angle;
		node.radius = radius;
		node.x = Math.cos(angle) * radius;
		node.y = Math.sin(angle) * radius;
		maxDepth = Math.max(maxDepth, depth);
		if (node.collapsed) return;

		const kids = (children.get(id) ?? []).filter((c) => seen.has(c));
		let cursor = start;
		for (const child of kids) {
			const share = ((weight.get(child) ?? 1) / (weight.get(id) ?? 1)) * (end - start);
			place(child, cursor, cursor + share, depth + 1);
			cursor += share;
		}
	};
	place(root.id, 0, Math.PI * 2, 0);

	for (const node of byId.values()) node.hidden = !seen.has(node.id);

	const links: LaidOutLink[] = [];
	for (const edge of edges) {
		const from = byId.get(edge.from);
		const to = byId.get(edge.to);
		if (!from || !to || from.hidden || to.hidden) continue;
		links.push({ from, to, path: arcPath(from, to) });
	}

	return { nodes: [...byId.values()].filter((n) => !n.hidden), links, extent: (maxDepth + 1) * RING, byId };
}

/** Bundled edge: leaves the parent along its own ring before turning outward. */
function arcPath(from: LaidOutNode, to: LaidOutNode): string {
	const mid = (from.radius + to.radius) / 2;
	const c1x = Math.cos(from.angle) * mid;
	const c1y = Math.sin(from.angle) * mid;
	const c2x = Math.cos(to.angle) * mid;
	const c2y = Math.sin(to.angle) * mid;
	return `M ${from.x} ${from.y} C ${c1x} ${c1y}, ${c2x} ${c2y}, ${to.x} ${to.y}`;
}

/** Chain of nodes from the root down to `id`, root first. */
export function pathToRoot(edges: TreeEdge[], id: string): string[] {
	const parent = new Map<string, string>();
	for (const edge of edges) parent.set(edge.to, edge.from);
	const chain = [id];
	let cursor = id;
	const guard = new Set<string>([id]);
	while (parent.has(cursor)) {
		cursor = parent.get(cursor)!;
		if (guard.has(cursor)) break;
		guard.add(cursor);
		chain.unshift(cursor);
	}
	return chain;
}
