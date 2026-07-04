"use client";

import { useCallback, useEffect, useState } from "react";

/**
 * Prompt-skill picker for the LLM Generate node. Lists Markdown "skills" from a
 * folder (via /api/prompt-skills) and, on selection, hands the chosen skill's
 * instructions up to the node so they populate the system prompt. A native
 * <select> is used deliberately — its dropdown renders in the browser's top
 * layer and is never clipped by the node's rounded/overflow container.
 */

interface PromptSkill {
  id: string;
  name: string;
  description: string;
  body: string;
}

const FOLDER_KEY = "node-banana-prompt-skills-dir";

// Module-level cache so mounting many LLM nodes triggers one scan per folder,
// and re-opening a node is instant. Refresh() busts it.
const cache = new Map<string, { skills: PromptSkill[]; path: string }>();
const inflight = new Map<string, Promise<{ skills: PromptSkill[]; path: string }>>();

async function loadSkills(folder: string, force = false): Promise<{ skills: PromptSkill[]; path: string }> {
  const key = folder || "";
  if (!force && cache.has(key)) return cache.get(key)!;
  if (!force && inflight.has(key)) return inflight.get(key)!;
  const p = (async () => {
    const qs = folder ? `?path=${encodeURIComponent(folder)}` : "";
    const res = await fetch(`/api/prompt-skills${qs}`);
    const json = await res.json();
    if (!json?.success) throw new Error(json?.error || "Failed to load skills");
    const result = { skills: (json.skills ?? []) as PromptSkill[], path: (json.path ?? "") as string };
    cache.set(key, result);
    return result;
  })();
  inflight.set(key, p);
  try {
    return await p;
  } finally {
    inflight.delete(key);
  }
}

export function PromptSkillPicker({
  activeSkillName,
  onApply,
  onClear,
}: {
  activeSkillName?: string;
  onApply: (skill: { name: string; body: string }) => void;
  onClear: () => void;
}) {
  const [folder, setFolder] = useState<string>("");
  const [skills, setSkills] = useState<PromptSkill[]>([]);
  const [resolvedPath, setResolvedPath] = useState<string>("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [showFolder, setShowFolder] = useState(false);
  const [folderInput, setFolderInput] = useState("");

  // Read the persisted folder once on mount.
  useEffect(() => {
    try {
      const saved = localStorage.getItem(FOLDER_KEY) ?? "";
      setFolder(saved);
      setFolderInput(saved);
    } catch { /* localStorage unavailable — use default folder */ }
  }, []);

  const fetchSkills = useCallback(async (f: string, force = false) => {
    setLoading(true);
    setError(null);
    try {
      const res = await loadSkills(f, force);
      setSkills(res.skills);
      setResolvedPath(res.path);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to load skills");
      setSkills([]);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { fetchSkills(folder); }, [folder, fetchSkills]);

  const handleSelect = useCallback((e: React.ChangeEvent<HTMLSelectElement>) => {
    const id = e.target.value;
    if (id === "__none__") { onClear(); return; }
    if (id === "__active__") return; // synthetic option for an out-of-folder skill
    const s = skills.find((x) => x.id === id);
    if (s) onApply({ name: s.name, body: s.body });
  }, [skills, onApply, onClear]);

  const handleRefresh = useCallback(() => { fetchSkills(folder, true); }, [folder, fetchSkills]);

  const applyFolder = useCallback(() => {
    const f = folderInput.trim();
    try { localStorage.setItem(FOLDER_KEY, f); } catch { /* ignore */ }
    setFolder(f);
    setShowFolder(false);
  }, [folderInput]);

  // Which <option> is selected: the active skill's id if it's in the current
  // folder, a synthetic marker if the active skill lives elsewhere, else none.
  const activeMatch = activeSkillName ? skills.find((s) => s.name === activeSkillName) : undefined;
  const selectValue = activeSkillName ? (activeMatch ? activeMatch.id : "__active__") : "__none__";

  return (
    <div className="flex flex-col gap-1 w-full">
      <div className="flex items-center gap-1">
        <select
          value={selectValue}
          onChange={handleSelect}
          title="Load a prompt skill's instructions into the system prompt"
          className="nodrag nopan flex-1 min-w-0 text-[11px] py-1 px-2 bg-[#1a1a1a] rounded-md focus:outline-none focus:ring-1 focus:ring-neutral-600 text-white"
        >
          <option value="__none__">— Prompt skill: none —</option>
          {activeSkillName && !activeMatch && (
            <option value="__active__">{activeSkillName} (not in folder)</option>
          )}
          {skills.map((s) => (
            <option key={s.id} value={s.id} title={s.description}>{s.name}</option>
          ))}
        </select>
        <button
          type="button"
          onClick={handleRefresh}
          title="Rescan the skills folder"
          className="nodrag nopan shrink-0 text-[11px] px-1.5 py-1 rounded bg-neutral-800 hover:bg-neutral-700 text-neutral-300"
        >⟳</button>
        <button
          type="button"
          onClick={() => setShowFolder((v) => !v)}
          title="Change the skills folder"
          className={`nodrag nopan shrink-0 text-[11px] px-1.5 py-1 rounded ${showFolder ? "bg-neutral-700 text-white" : "bg-neutral-800 hover:bg-neutral-700 text-neutral-300"}`}
        >📁</button>
      </div>

      {showFolder && (
        <div className="flex items-center gap-1">
          <input
            type="text"
            value={folderInput}
            onChange={(e) => setFolderInput(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter") applyFolder(); }}
            placeholder={resolvedPath || "absolute path to skills folder (blank = default)"}
            className="nodrag nopan flex-1 min-w-0 text-[10px] py-1 px-2 bg-[#1a1a1a] rounded-md focus:outline-none focus:ring-1 focus:ring-neutral-600 text-white font-mono"
          />
          <button
            type="button"
            onClick={applyFolder}
            className="nodrag nopan shrink-0 text-[10px] px-2 py-1 rounded bg-neutral-700 hover:bg-neutral-600 text-white"
          >Load</button>
        </div>
      )}

      {loading && <span className="text-[10px] text-neutral-500">Loading skills…</span>}
      {error && <span className="text-[10px] text-red-400" title={error}>Skills error: {error}</span>}
      {!loading && !error && skills.length === 0 && (
        <span className="text-[10px] text-neutral-500 break-all" title={resolvedPath}>
          No skills yet. Drop .md files in: {resolvedPath || "<project>/prompt-skills"}
        </span>
      )}
    </div>
  );
}
