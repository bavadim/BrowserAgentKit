import { defineConfig } from "vite";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export default defineConfig({
	root: path.resolve(__dirname, "examples"),
	server: {
		port: 5173,
		open: true,
		fs: {
			allow: [__dirname],
		},
	},
	resolve: {
		alias: {
			browseragentkit: path.resolve(__dirname, "src/index.ts"),
		},
	},
});
