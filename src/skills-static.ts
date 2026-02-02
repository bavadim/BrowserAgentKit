import type { SkillModuleMap } from "./types";
import { Skill } from "./skill";

export function loadSkillsFromModules(modules: SkillModuleMap): Skill[] {
	const entries = Object.entries(modules).sort(([a], [b]) => a.localeCompare(b));
	return entries.map(([path, markdown]) => Skill.fromMarkdown(markdown, path));
}
