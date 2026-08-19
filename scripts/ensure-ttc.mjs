/**
 * @steambrew/ttc 3.3.7 publishes its sources without dist/, so the
 * millennium-ttc binary its package.json points at is missing after a plain
 * install. Build it once from the sources that shipped with it.
 */
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';

const ttc = path.resolve('node_modules', '@steambrew', 'ttc');
if (!existsSync(path.join(ttc, 'dist', 'index.js')) && existsSync(path.join(ttc, 'src', 'index.ts'))) {
	console.log('[ensure-ttc] building @steambrew/ttc from source');
	execFileSync('npx', ['rollup', '-c'], { cwd: ttc, stdio: 'inherit', shell: true });
}
