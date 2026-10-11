// Wraps a worktree's own vite config with a private cacheDir. Worktrees share node_modules through a junction,
// so without this every Vite server rewrites the same node_modules/.vite/deps and the others answer 504 "Outdated Optimize Dep".
//   WT_VITE_CACHE=<dir> npx vite --config <this file> --port <port> --strictPort   (run from the worktree)
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import path from "node:path";

export default async (env) => {
	const root = process.cwd();
	const vite = await import(pathToFileURL(createRequire(path.join(root, "package.json")).resolve("vite")).href);
	const loaded = await vite.loadConfigFromFile(env, undefined, root);
	return vite.mergeConfig(loaded?.config ?? {}, { cacheDir: process.env.WT_VITE_CACHE });
};
