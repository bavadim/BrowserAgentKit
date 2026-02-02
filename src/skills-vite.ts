/// <reference types="node" />
import fs from "node:fs";
import path from "node:path";
import type { Plugin } from "vite";

export type CodexSkillPluginOptions = {
	root?: string;
	mode?: "dom" | "raw";
	include?: {
		references?: boolean;
		scripts?: boolean;
	};
	extensions?: {
		skillFile?: string;
	};
};

type SkillResource = {
	skillName: string;
	kind: "prompt" | "reference" | "script";
	relativePath: string;
	content: string;
};

const DEFAULT_ROOT = "./skills";
const DEFAULT_SKILL_FILE = "SKILL.md";
const SKILLS_VIRTUAL_ID = "browseragentkit/skills";
const RESOLVED_VIRTUAL_ID = `\0${SKILLS_VIRTUAL_ID}`;

export function codexSkillPlugin(options: CodexSkillPluginOptions = {}): Plugin {
	const rootDir = options.root ?? DEFAULT_ROOT;
	const mode = options.mode ?? "dom";
	const include = {
		references: options.include?.references !== false,
		scripts: options.include?.scripts !== false,
	};
	const skillFileName = options.extensions?.skillFile ?? DEFAULT_SKILL_FILE;
	let projectRoot = process.cwd();
	let skills: SkillResource[] = [];

	function readText(filePath: string): string {
		return fs.readFileSync(filePath, "utf8");
	}

	function isDirectory(filePath: string): boolean {
		return fs.existsSync(filePath) && fs.statSync(filePath).isDirectory();
	}

	function findSkillFiles(baseDir: string): string[] {
		const results: string[] = [];
		const entries = fs.readdirSync(baseDir, { withFileTypes: true });
		for (const entry of entries) {
			const fullPath = path.join(baseDir, entry.name);
			if (entry.isDirectory()) {
				results.push(...findSkillFiles(fullPath));
				continue;
			}
			if (entry.isFile() && entry.name === skillFileName) {
				results.push(fullPath);
			}
		}
		return results;
	}

	function extractSkillName(markdown: string, filePath: string): string {
		const match = markdown.match(/^---\s*\n([\s\S]*?)\n---\s*\n?/);
		if (!match) {
			throw new Error(`Skill markdown must start with YAML frontmatter: ${filePath}`);
		}
		const frontmatterText = match[1] ?? "";
		for (const line of frontmatterText.split(/\r?\n/)) {
			const trimmed = line.trim();
			if (!trimmed || trimmed.startsWith("#")) {
				continue;
			}
			const separatorIndex = trimmed.indexOf(":");
			if (separatorIndex === -1) {
				continue;
			}
			const key = trimmed.slice(0, separatorIndex).trim();
			const value = trimmed.slice(separatorIndex + 1).trim();
			if (key === "name") {
				return value.replace(/^"|"$/g, "").replace(/^'|'$/g, "");
			}
		}
		throw new Error(`Skill frontmatter must include name: ${filePath}`);
	}

	function collectFolderResources(skillFolder: string, skillName: string): SkillResource[] {
		const items: SkillResource[] = [];
		const skillPath = path.join(skillFolder, skillFileName);
		const prompt = readText(skillPath);
		items.push({
			skillName,
			kind: "prompt",
			relativePath: skillFileName,
			content: prompt,
		});

		function collectNested(dir: string, kind: "reference" | "script"): void {
			if (!isDirectory(dir)) {
				return;
			}
			const entries = fs.readdirSync(dir, { withFileTypes: true });
			for (const entry of entries) {
				const fullPath = path.join(dir, entry.name);
				if (entry.isDirectory()) {
					collectNested(fullPath, kind);
					continue;
				}
				if (!entry.isFile()) {
					continue;
				}
				const relPath = path.posix.relative(skillFolder, fullPath);
				items.push({
					skillName,
					kind,
					relativePath: relPath,
					content: readText(fullPath),
				});
			}
		}

		if (include.references) {
			collectNested(path.join(skillFolder, "references"), "reference");
		}
		if (include.scripts) {
			collectNested(path.join(skillFolder, "scripts"), "script");
		}

		return items;
	}

	function loadAllSkills(rootPath: string): SkillResource[] {
		if (!fs.existsSync(rootPath)) {
			return [];
		}
		const skillFiles = findSkillFiles(rootPath);
		const resources: SkillResource[] = [];
		for (const skillPath of skillFiles) {
			const skillFolder = path.dirname(skillPath);
			const markdown = readText(skillPath);
			const skillName = extractSkillName(markdown, skillPath);
			resources.push(...collectFolderResources(skillFolder, skillName));
		}
		return resources;
	}

	function escapeHtml(value: string): string {
		return value
			.replace(/&/g, "&amp;")
			.replace(/</g, "&lt;")
			.replace(/>/g, "&gt;");
	}

	function buildDomPayload(resources: SkillResource[]): string {
		const nodes = resources.map((resource) => {
			const attrs = [
				`type="text/plain"`,
				`data-skill="${escapeHtml(resource.skillName)}"`,
				`data-kind="${resource.kind}"`,
				`data-path="${escapeHtml(resource.relativePath)}"`,
			];
			return `<script ${attrs.join(" ")}>${escapeHtml(resource.content)}</script>`;
		});
		return `<div id="bak-skills-root" hidden>${nodes.join("")}</div>`;
	}

	return {
		name: "browseragentkit:codex-skills",
		enforce: "pre",
		configResolved(config) {
			projectRoot = config.root ? path.resolve(config.root) : process.cwd();
		},
		buildStart() {
			const rootPath = path.resolve(projectRoot, rootDir);
			skills = loadAllSkills(rootPath);
		},
		resolveId(id) {
			if (id === SKILLS_VIRTUAL_ID && mode === "raw") {
				return RESOLVED_VIRTUAL_ID;
			}
			return null;
		},
		load(id) {
			if (id !== RESOLVED_VIRTUAL_ID) {
				return null;
			}
			const payload = skills
				.filter((resource) => resource.kind === "prompt")
				.map((resource) => {
					const key = path.posix.join(resource.skillName, resource.relativePath);
					return `  ${JSON.stringify(key)}: ${JSON.stringify(resource.content)}`;
				})
				.join(",\n");
			return `export default {\n${payload}\n};`;
		},
		transformIndexHtml(html) {
			if (mode !== "dom") {
				return html;
			}
			const payload = buildDomPayload(skills);
			return html.replace("</body>", `${payload}</body>`);
		},
	};
}
