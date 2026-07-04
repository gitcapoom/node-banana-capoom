import { NextRequest, NextResponse } from "next/server";
import { readFile, readdir, mkdir } from "fs/promises";
import path from "path";
import { validateWorkflowPath } from "@/utils/pathValidation";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Prompt-skill library: scans a folder of Markdown "skills" (prompt-engineering
 * instruction bundles) and returns each one's name/description (from YAML
 * frontmatter) plus its body (the instructions). The LLM Generate node loads a
 * skill's body into its system prompt. Two per-entry layouts are accepted:
 *   - a bare `<name>.md` file, or
 *   - a `<name>/SKILL.md` folder (Anthropic Agent-Skills layout).
 * Default folder: <project>/prompt-skills (i.e. process.cwd() — the app's
 * install dir; git-ignored, created on first scan so the user has somewhere to
 * drop files). A `path` query param overrides it (traversal-guarded via
 * validateWorkflowPath; must already exist) — use it to point at a shared
 * folder across the dev/deploy installs.
 *
 * This only ever reads the *instruction text* — bundled scripts/resources and
 * any agent-only directives in the body are irrelevant to a plain LLM call.
 */

const MAX_SKILL_BYTES = 512 * 1024; // skip pathologically large files
const MD_RE = /\.(md|markdown)$/i;

interface PromptSkill {
  id: string;
  name: string;
  description: string;
  body: string;
}

/** Pull `name` / `description` from a leading `---` YAML frontmatter block and
 *  return them plus the body with the frontmatter stripped. Tolerant and
 *  line-based (no YAML dependency): handles the common `key: value` case,
 *  quoted or bare. A folded/multi-line value degrades to its first line, which
 *  is fine — `description` is only a tooltip. */
function parseFrontmatter(raw: string): { name?: string; description?: string; body: string } {
  if (!raw.startsWith("---")) return { body: raw };
  const m = raw.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?/);
  if (!m) return { body: raw };
  const body = raw.slice(m[0].length);
  const lines = m[1].split(/\r?\n/);
  const out: { name?: string; description?: string } = {};
  for (let i = 0; i < lines.length; i++) {
    const kv = lines[i].match(/^([A-Za-z_][\w-]*)\s*:\s*(.*)$/);
    if (!kv) continue;
    const key = kv[1].toLowerCase();
    if (key !== "name" && key !== "description") continue;
    let val = kv[2].trim();
    if (/^[>|][+-]?\d*$/.test(val)) {
      // YAML block scalar (folded `>` / literal `|`): value is the indented
      // lines that follow. Join to a single line — good enough for a tooltip.
      const parts: string[] = [];
      for (let j = i + 1; j < lines.length; j++) {
        if (lines[j].trim() === "") { parts.push(""); continue; }
        if (/^\s/.test(lines[j])) { parts.push(lines[j].trim()); i = j; }
        else break;
      }
      val = parts.join(" ").replace(/\s+/g, " ").trim();
    } else if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1);
    }
    out[key as "name" | "description"] = val;
  }
  return { ...out, body };
}

async function readSkillFile(filePath: string, id: string, fallbackName: string): Promise<PromptSkill | null> {
  try {
    const raw = await readFile(filePath, "utf8");
    if (raw.length > MAX_SKILL_BYTES) return null;
    const { name, description, body } = parseFrontmatter(raw);
    const trimmedBody = body.trim();
    if (!trimmedBody) return null; // nothing usable as a system prompt
    return {
      id,
      name: (name && name.trim()) || fallbackName,
      description: (description && description.trim()) || "",
      body: trimmedBody,
    };
  } catch {
    return null;
  }
}

export async function GET(req: NextRequest) {
  const override = req.nextUrl.searchParams.get("path");
  let folder: string;
  if (override) {
    const v = validateWorkflowPath(override);
    if (!v.valid) {
      return NextResponse.json({ success: false, error: v.error || "Invalid path" }, { status: 400 });
    }
    folder = override;
  } else {
    folder = path.join(process.cwd(), "prompt-skills");
    try { await mkdir(folder, { recursive: true }); } catch { /* best effort — still try to read */ }
  }

  let entries;
  try {
    entries = await readdir(folder, { withFileTypes: true });
  } catch (e) {
    const err = e as NodeJS.ErrnoException;
    if (err?.code === "ENOENT") {
      return NextResponse.json({ success: true, path: folder, skills: [] });
    }
    return NextResponse.json(
      { success: false, path: folder, error: err?.message || "Could not read skills folder" },
      { status: 500 },
    );
  }

  const skills: PromptSkill[] = [];
  for (const ent of entries) {
    if (ent.isFile() && MD_RE.test(ent.name)) {
      const s = await readSkillFile(path.join(folder, ent.name), ent.name, ent.name.replace(MD_RE, ""));
      if (s) skills.push(s);
    } else if (ent.isDirectory()) {
      // Agent-Skills layout: <name>/SKILL.md (any case).
      try {
        const sub = await readdir(path.join(folder, ent.name), { withFileTypes: true });
        const skillMd = sub.find((f) => f.isFile() && f.name.toLowerCase() === "skill.md");
        if (skillMd) {
          const s = await readSkillFile(path.join(folder, ent.name, skillMd.name), ent.name, ent.name);
          if (s) skills.push(s);
        }
      } catch { /* skip unreadable subdir */ }
    }
  }

  skills.sort((a, b) => a.name.localeCompare(b.name));
  return NextResponse.json({ success: true, path: folder, skills });
}
