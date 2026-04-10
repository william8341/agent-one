/**
 * Skill loader — discovers and loads Markdown skill files with YAML frontmatter.
 */
import { readFile } from "node:fs/promises";
import matter from "gray-matter";
import fg from "fast-glob";
import type { Skill } from "./types.js";

function stringValue(v: unknown): string | undefined {
  return typeof v === "string" && v.trim() ? v.trim() : undefined;
}

export async function loadSkills(cwd: string): Promise<Skill[]> {
  // Search in project-level and user-level skill directories
  const patterns = ["skills/**/*.md", ".claude/skills/**/*.md"];
  const skillFiles = await fg(patterns, { cwd, absolute: true, onlyFiles: true });

  const skills: Skill[] = [];
  for (const file of skillFiles) {
    try {
      const raw = await readFile(file, "utf8");
      const parsed = matter(raw);
      const data = parsed.data as Record<string, unknown>;

      const name = stringValue(data.name);
      const description = stringValue(data.description);
      if (!name || !description) continue;

      skills.push({
        name,
        description,
        whenToUse: stringValue(data["when-to-use"]),
        allowedTools: Array.isArray(data["allowed-tools"])
          ? (data["allowed-tools"] as unknown[]).filter((x): x is string => typeof x === "string")
          : undefined,
        systemPrompt: parsed.content.trim(),
      });
    } catch {
      // skip invalid files
    }
  }

  return skills.sort((a, b) => a.name.localeCompare(b.name));
}
