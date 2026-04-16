/**
 * Local persistent solution memory under ~/.agent-one/solutions/
 * Human-editable Markdown + YAML frontmatter.
 */
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import matter from "gray-matter";
import { AGENT_ONE_DIR } from "./agent-one-config.js";

export const SOLUTIONS_DIR = path.join(AGENT_ONE_DIR, "solutions");

export type SolutionFrontmatter = {
  id: string;
  title: string;
  tags: string[];
  private: boolean;
  created: string;
};

function ensureDir(): void {
  fs.mkdirSync(SOLUTIONS_DIR, { recursive: true });
}

function randomSuffix(): string {
  return Math.random().toString(36).slice(2, 8);
}

function normalizeTags(tags: string[]): string[] {
  const out = new Set<string>();
  for (const t of tags) {
    const s = t.trim().toLowerCase().replace(/\s+/g, "-");
    if (s) out.add(s);
  }
  return Array.from(out).sort();
}

export async function listSolutionFiles(): Promise<string[]> {
  if (!fs.existsSync(SOLUTIONS_DIR)) return [];
  const names = await fsp.readdir(SOLUTIONS_DIR);
  return names.filter((n) => n.endsWith(".md")).map((n) => path.join(SOLUTIONS_DIR, n));
}

export type ParsedSolution = {
  filePath: string;
  id: string;
  title: string;
  tags: string[];
  private: boolean;
  created: string;
  problem: string;
  solution: string;
  fullText: string;
};

async function parseFile(filePath: string): Promise<ParsedSolution | null> {
  try {
    const raw = await fsp.readFile(filePath, "utf8");
    const { data, content } = matter(raw);
    const d = data as Record<string, unknown>;
    const id =
      typeof d.id === "string" && d.id.length > 0
        ? d.id
        : path.basename(filePath, ".md");
    const title = typeof d.title === "string" ? d.title : id;
    const tags = Array.isArray(d.tags)
      ? (d.tags as unknown[]).filter((x): x is string => typeof x === "string")
      : [];
    const isPrivate = d.private === true;
    const created = typeof d.created === "string" ? d.created : "";
    const sections = splitProblemSolution(content);
    return {
      filePath,
      id,
      title,
      tags,
      private: isPrivate,
      created,
      problem: sections.problem,
      solution: sections.solution,
      fullText: content,
    };
  } catch {
    return null;
  }
}

function splitProblemSolution(content: string): { problem: string; solution: string } {
  const problemMatch = content.match(/##\s*Problem\s*([\s\S]*?)(?=##\s*Solution|$)/i);
  const solutionMatch = content.match(/##\s*Solution\s*([\s\S]*)/i);
  return {
    problem: problemMatch?.[1]?.trim() ?? "",
    solution: solutionMatch?.[1]?.trim() ?? content.trim(),
  };
}

function scoreEntry(p: ParsedSolution, terms: string[]): number {
  if (terms.length === 0) return 1;
  const hay = `${p.title}\n${p.problem}\n${p.solution}\n${p.tags.join(" ")}`.toLowerCase();
  let score = 0;
  for (const t of terms) {
    if (hay.includes(t)) score += 1;
  }
  return score;
}

export async function searchSolutions(args: {
  query: string;
  tags?: string[];
  includePrivate: boolean;
  limit: number;
}): Promise<string> {
  const files = await listSolutionFiles();
  const entries: ParsedSolution[] = [];
  for (const fp of files) {
    const p = await parseFile(fp);
    if (!p) continue;
    if (p.private && !args.includePrivate) continue;
    entries.push(p);
  }

  const terms = args.query
    .trim()
    .toLowerCase()
    .split(/\s+/)
    .filter(Boolean);
  const tagFilter = normalizeTags(args.tags ?? []);

  let scored = entries.map((p) => {
    if (tagFilter.length > 0) {
      const set = new Set(p.tags.map((t) => t.toLowerCase()));
      if (!tagFilter.every((t) => set.has(t))) {
        return { p, score: 0 };
      }
    }
    return { p, score: scoreEntry(p, terms) };
  });

  if (terms.length > 0) {
    scored = scored.filter((x) => x.score > 0);
  }
  scored.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    return (b.p.created || "").localeCompare(a.p.created || "");
  });

  const top = scored.slice(0, args.limit).map((x) => x.p);
  if (top.length === 0) {
    return terms.length > 0 || tagFilter.length > 0
      ? "No matching solution memories found."
      : "No solution memories stored yet. Use memory_save after fixing a problem.";
  }

  const lines: string[] = [`Found ${top.length} solution(s):\n`];
  for (const p of top) {
    lines.push(`### ${p.id}: ${p.title}`);
    lines.push(`- tags: ${p.tags.join(", ") || "(none)"}`);
    lines.push(`- created: ${p.created || "unknown"}`);
    if (p.private) lines.push(`- visibility: private (not shown in default search)`);
    lines.push("");
    lines.push("**Problem (excerpt)**");
    lines.push(p.problem.slice(0, 1500) + (p.problem.length > 1500 ? "\n...(truncated)" : ""));
    lines.push("");
    lines.push("**Solution (excerpt)**");
    lines.push(p.solution.slice(0, 2000) + (p.solution.length > 2000 ? "\n...(truncated)" : ""));
    lines.push("\n---\n");
  }
  return lines.join("\n");
}

export async function saveSolution(args: {
  title: string;
  problem: string;
  solution: string;
  tags: string[];
  markPrivate: boolean;
}): Promise<{ id: string; path: string }> {
  ensureDir();
  const id = `sol-${Date.now()}-${randomSuffix()}`;
  const tags = normalizeTags(args.tags);
  const created = new Date().toISOString();
  const body = [
    "---",
    `id: ${id}`,
    `title: ${JSON.stringify(args.title)}`,
    `tags: [${tags.map((t) => JSON.stringify(t)).join(", ")}]`,
    `private: ${args.markPrivate}`,
    `created: ${created}`,
    "---",
    "",
    "## Problem",
    "",
    args.problem.trim(),
    "",
    "## Solution",
    "",
    args.solution.trim(),
    "",
  ].join("\n");

  const fileName = `${id}.md`;
  const filePath = path.join(SOLUTIONS_DIR, fileName);
  await fsp.writeFile(filePath, body, "utf8");
  return { id, path: filePath };
}

export async function deleteSolution(id: string): Promise<{ ok: boolean; message: string }> {
  ensureDir();
  const files = await listSolutionFiles();
  for (const fp of files) {
    const p = await parseFile(fp);
    if (p && p.id === id) {
      await fsp.unlink(fp);
      return { ok: true, message: `Deleted solution ${id}` };
    }
  }
  return { ok: false, message: `No solution with id: ${id}` };
}
