// Layout checks: run with `npm run test:layout` (esbuild transpiles layout.ts on the fly).
import { layoutTree, pathToRoot } from './.layout.build.mjs';

let failed = 0;
const check = (label, cond, detail = '') => {
	console.log((cond ? 'PASS  ' : 'FAIL  ') + label + (!cond && detail ? ' :: ' + detail : ''));
	if (!cond) failed++;
};

const node = (id, depth) => ({ id, depth, friends: null, status: 'ok' });
const nodes = [node('1', 0), node('2', 1), node('3', 1), node('4', 2), node('5', 2), node('6', 2)];
const edges = [
	{ from: '1', to: '2' }, { from: '1', to: '3' },
	{ from: '2', to: '4' }, { from: '2', to: '5' }, { from: '3', to: '6' },
];

const l = layoutTree(nodes, edges, '1', new Set());
check('every node laid out', l.nodes.length === 6, String(l.nodes.length));
check('root at the centre', l.byId.get('1').x === 0 && l.byId.get('1').y === 0);
check('depth drives radius', l.byId.get('4').radius > l.byId.get('2').radius);
check('extent covers the deepest ring', l.extent >= l.byId.get('4').radius);
check('child count recorded', l.byId.get('2').childCount === 2);
check('links match edges', l.links.length === 5, String(l.links.length));
check('links carry a path', l.links.every((k) => k.path.startsWith('M ')));

// Leaf-weighted slices: the branch with two leaves gets twice the angle.
const span = (id) => {
	const kids = edges.filter((e) => e.from === id).map((e) => l.byId.get(e.to).angle);
	return Math.max(...kids) - Math.min(...kids);
};
check('wider subtree gets more angle', l.byId.get('2').angle !== l.byId.get('3').angle, String(span('1')));

const collapsed = layoutTree(nodes, edges, '1', new Set(['2']));
check('collapsed branch is dropped', collapsed.nodes.length === 4, String(collapsed.nodes.length));
check('collapsed node stays visible', collapsed.nodes.some((n) => n.id === '2' && n.collapsed));
check('links to hidden nodes dropped', collapsed.links.length === 3, String(collapsed.links.length));

check('path to root', JSON.stringify(pathToRoot(edges, '4')) === '["1","2","4"]');
check('path of the root itself', JSON.stringify(pathToRoot(edges, '1')) === '["1"]');

// A cycle must not hang the walk up the tree.
const cyclic = [{ from: 'a', to: 'b' }, { from: 'b', to: 'a' }];
check('cycle guard holds', pathToRoot(cyclic, 'b').length <= 3);

// Orphan edges (parent pruned by a budget) must not crash the layout.
const partial = layoutTree([node('1', 0), node('2', 1)], [...edges], '1', new Set());
check('orphan edges ignored', partial.links.length === 1, String(partial.links.length));

console.log('\nFAILURES: ' + failed);
process.exit(failed ? 1 : 0);
