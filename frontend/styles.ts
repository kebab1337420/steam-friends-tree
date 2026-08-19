const CSS = `
.sft-page { display: flex; height: 100%; width: 100%; color: #c7d5e0; font-size: 13px; background: #1b2838; }
.sft-side { width: 300px; flex: 0 0 300px; padding: 16px; overflow-y: auto; background: #17212c; border-right: 1px solid #000; }
.sft-side h2 { margin: 0 0 12px; font-size: 16px; color: #fff; }
.sft-group { margin-bottom: 18px; }
.sft-group > label { display: block; margin-bottom: 6px; color: #8f98a0; text-transform: uppercase; font-size: 11px; letter-spacing: .5px; }
.sft-row { display: flex; gap: 6px; align-items: center; }
.sft-input { flex: 1; min-width: 0; padding: 7px 9px; border: 1px solid #000; border-radius: 3px; background: #101822; color: #dfe3e6; }
.sft-btn { padding: 7px 12px; border: none; border-radius: 3px; background: #3d6c8d; color: #fff; cursor: pointer; white-space: nowrap; }
.sft-btn:hover { background: #4a83aa; }
.sft-btn.sft-primary { background: #5c7e10; }
.sft-btn.sft-primary:hover { background: #6f9a14; }
.sft-btn.sft-danger { background: #8d3d3d; }
.sft-btn:disabled { background: #2a3f4f; color: #6b7883; cursor: default; }
.sft-choice { display: flex; gap: 8px; margin-bottom: 8px; }
.sft-choice button { flex: 1; padding: 8px; border: 1px solid #000; border-radius: 3px; background: #22323f; color: #b8c4cf; cursor: pointer; }
.sft-choice button.sft-on { background: #3d6c8d; color: #fff; }
.sft-hint { margin-top: 6px; color: #6b7883; font-size: 11px; line-height: 1.4; }
.sft-stats { display: grid; grid-template-columns: 1fr auto; gap: 4px 10px; }
.sft-stats span:nth-child(even) { color: #fff; text-align: right; }
.sft-error { padding: 8px; border-radius: 3px; background: #52252a; color: #ffb3b3; }
.sft-warn { padding: 8px; border-radius: 3px; background: #4a3c1d; color: #f0d79a; }
.sft-canvas { position: relative; flex: 1; overflow: hidden; cursor: grab; }
.sft-canvas.sft-drag { cursor: grabbing; }
.sft-link { fill: none; stroke: #3a556b; stroke-width: 1.4px; }
.sft-link.sft-hot { stroke: #66c0f4; stroke-width: 2.4px; }
.sft-node { cursor: pointer; }
.sft-node circle { stroke: #0e1620; stroke-width: 2px; fill: #2a475e; }
.sft-node.sft-root circle { fill: #5c7e10; }
.sft-node.sft-collapsed circle { fill: #8d6a1f; }
.sft-node.sft-private circle { fill: #4a2f3a; }
.sft-node.sft-failed circle { fill: #6b3b1d; }
.sft-node.sft-pending circle { fill: #22323f; }
.sft-node.sft-sel circle { stroke: #66c0f4; stroke-width: 3px; }
.sft-node text { fill: #c7d5e0; font-size: 11px; dominant-baseline: middle; pointer-events: none; }
.sft-detail { position: absolute; right: 16px; top: 16px; width: 240px; padding: 12px; border-radius: 4px; background: rgba(23,33,44,.96); border: 1px solid #000; }
.sft-detail img { width: 48px; height: 48px; border-radius: 3px; }
.sft-detail .sft-name { font-weight: 600; color: #fff; margin-bottom: 2px; }
.sft-detail .sft-meta { color: #8f98a0; font-size: 11px; margin-bottom: 10px; }
.sft-detail .sft-btn { width: 100%; margin-top: 6px; }
.sft-zoom { position: absolute; left: 16px; bottom: 16px; display: flex; gap: 6px; }
.sft-empty { position: absolute; inset: 0; display: flex; align-items: center; justify-content: center; color: #56707f; }
`;

let injected = false;

export function injectStyles(): void {
	if (injected) return;
	injected = true;
	const style = document.createElement('style');
	style.id = 'steam-friends-tree-css';
	style.textContent = CSS;
	document.head.appendChild(style);
}
