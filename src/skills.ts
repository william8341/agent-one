/**
 * Skill loader — discovers and loads skill files.
 *
 * Two formats supported:
 *  1. Markdown with YAML frontmatter (name/description in frontmatter)
 *  2. Plain Markdown SKILL.md (name from directory, description from content)
 */
import { readFile } from "node:fs/promises";
import { basename, dirname } from "node:path";
import matter from "gray-matter";
import fg from "fast-glob";
import type { Skill } from "./types.js";

function stringValue(v: unknown): string | undefined {
  return typeof v === "string" && v.trim() ? v.trim() : undefined;
}

/**
 * Extract description from Markdown body:
 *  - first `## 概述` / `## Overview` section content, or
 *  - fallback to first non-heading non-empty non-code line
 */
function extractDescription(content: string): string | undefined {
  const lines = content.split("\n");

  // Try to find ## 概述 or ## Overview section
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!.trim();
    if (/^##\s+(概述|Overview)/i.test(line)) {
      for (let j = i + 1; j < lines.length; j++) {
        const next = lines[j]!.trim();
        if (!next) continue;
        if (next.startsWith("#")) break;
        return next.replace(/^[*_]+|[*_]+$/g, "").slice(0, 200);
      }
    }
  }

  // Fallback: first non-empty, non-heading, non-code-fence line
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#") || trimmed.startsWith("```")) continue;
    return trimmed.replace(/^[*_]+|[*_]+$/g, "").slice(0, 200);
  }

  return undefined;
}

/**
 * Derive skill name from file path.
 *  skills/oracle-adg-switch/SKILL.md  → "oracle-adg-switch"
 *  skills/code-review.md              → "code-review"
 */
function deriveNameFromPath(filePath: string): string {
  const dir = basename(dirname(filePath));
  if (dir === "skills" || dir === ".claude") {
    return basename(filePath, ".md");
  }
  return dir;
}

export async function loadSkills(cwd: string): Promise<Skill[]> {
  const patterns = [
    "skills/**/*.md",
    ".claude/skills/**/*.md",
  ];
  const ignore = [
    "**/output/**",
    "**/node_modules/**",
    "**/__pycache__/**",
  ];
  const skillFiles = await fg(patterns, { cwd, absolute: true, onlyFiles: true, ignore });

  const skills: Skill[] = [];
  for (const file of skillFiles) {
    try {
      const raw = await readFile(file, "utf8");
      const parsed = matter(raw);
      const data = parsed.data as Record<string, unknown>;

      // --- name: frontmatter → directory name fallback
      let name = stringValue(data.name);
      if (!name) {
        name = deriveNameFromPath(file);
      }
      if (!name) continue;

      // --- description: frontmatter → extract from content
      let description = stringValue(data.description);
      if (!description) {
        description = extractDescription(parsed.content) ?? `Skill: ${name}`;
      }

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

  // Deduplicate by name (first one wins — frontmatter version takes priority)
  const seen = new Set<string>();
  const deduped: Skill[] = [];
  for (const s of skills) {
    if (seen.has(s.name)) continue;
    seen.add(s.name);
    deduped.push(s);
  }

  return deduped.sort((a, b) => a.name.localeCompare(b.name));
}
