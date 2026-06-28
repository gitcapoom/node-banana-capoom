"use client";

import { useState, useEffect, useCallback } from "react";

/**
 * In-viewer file dialog (save / open), mirroring the main app's FileSaveDialog /
 * FileOpenDialog (same /api/list-directory endpoint) but self-contained in the
 * splat-viewer subtree (no @/ imports). Save mode returns (dir, filename); open
 * mode returns an absolute file path.
 */

interface Entry {
  name: string;
  type: "directory" | "file";
}

export function FileDialog({
  mode,
  initialPath,
  extension = ".json",
  defaultFilename = "scene",
  onSave,
  onOpen,
  onCancel,
}: {
  mode: "save" | "open";
  initialPath?: string;
  extension?: string;
  defaultFilename?: string;
  onSave?: (dir: string, filename: string) => void;
  onOpen?: (filePath: string) => void;
  onCancel: () => void;
}) {
  const [currentPath, setCurrentPath] = useState<string>(initialPath || "");
  const [pathInput, setPathInput] = useState<string>(initialPath || "");
  const [entries, setEntries] = useState<Entry[]>([]);
  const [filename, setFilename] = useState<string>(defaultFilename);
  const [selectedFile, setSelectedFile] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const navigateTo = useCallback(async (dirPath?: string) => {
    setLoading(true);
    setError(null);
    setSelectedFile(null);
    try {
      const params = new URLSearchParams();
      if (dirPath) params.set("path", dirPath);
      params.set("showAllFiles", "true");
      const res = await fetch(`/api/list-directory?${params.toString()}`);
      const result = await res.json();
      if (!result.success) {
        setError(result.error || "Failed to list directory");
        setLoading(false);
        return;
      }
      setCurrentPath(result.path);
      setPathInput(result.path);
      const all = result.entries as Entry[];
      const dirs = all.filter((e) => e.type === "directory");
      const files = all.filter((e) => e.type === "file" && e.name.toLowerCase().endsWith(extension));
      setEntries([...dirs, ...files]);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to load directory");
    } finally {
      setLoading(false);
    }
  }, [extension]);

  useEffect(() => { navigateTo(initialPath || undefined); }, [initialPath, navigateTo]);

  const sep = currentPath.includes("\\") ? "\\" : "/";
  const cleanDir = currentPath.replace(/[\\/]+$/, "");

  const goUp = useCallback(() => {
    const norm = currentPath.replace(/\\/g, "/");
    const i = norm.lastIndexOf("/");
    if (i <= 0) return;
    navigateTo(currentPath.substring(0, i) || "/");
  }, [currentPath, navigateTo]);

  const onEntry = (e: Entry) => {
    if (e.type === "directory") {
      navigateTo(cleanDir + sep + e.name);
    } else if (mode === "open") {
      setSelectedFile(e.name);
    } else {
      setFilename(e.name.replace(/\.[^.]+$/, "")); // save: click a file to reuse its name
    }
  };

  const confirm = () => {
    if (mode === "save") {
      if (!filename.trim()) return;
      onSave?.(cleanDir, filename.trim());
    } else {
      if (!selectedFile) return;
      onOpen?.(cleanDir + sep + selectedFile);
    }
  };

  const canConfirm = mode === "save" ? !!filename.trim() : !!selectedFile;

  return (
    <div
      className="fixed inset-0 z-[200] flex items-center justify-center bg-black/60 backdrop-blur-sm"
      onClick={onCancel}
      onKeyDown={(e) => { if (e.key === "Escape") onCancel(); }}
    >
      <div
        className="w-full max-w-2xl mx-4 bg-neutral-800 rounded-xl border border-neutral-700 shadow-2xl flex flex-col"
        style={{ height: "70vh", maxHeight: "600px" }}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="px-4 py-3 border-b border-neutral-700 flex items-center gap-2">
          <h2 className="text-sm font-medium text-neutral-200">{mode === "save" ? "Save scene" : "Open scene"}</h2>
        </div>

        <form
          onSubmit={(e) => { e.preventDefault(); if (pathInput.trim()) navigateTo(pathInput.trim()); }}
          className="px-3 py-2 border-b border-neutral-700 flex gap-2"
        >
          <button type="button" onClick={goUp} title="Parent folder"
            className="px-2 py-1 text-xs text-neutral-400 hover:text-neutral-200 hover:bg-neutral-700 rounded transition-colors shrink-0">
            <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" d="M4.5 15.75l7.5-7.5 7.5 7.5" />
            </svg>
          </button>
          <input
            type="text"
            value={pathInput}
            onChange={(e) => setPathInput(e.target.value)}
            placeholder="Enter path…"
            className="flex-1 bg-neutral-900 border border-neutral-600 rounded px-2 py-1 text-xs text-neutral-200 font-mono focus:outline-none focus:border-indigo-500"
          />
          <button type="submit" className="px-3 py-1 text-xs bg-neutral-700 hover:bg-neutral-600 text-neutral-200 rounded transition-colors">Go</button>
        </form>

        <div className="flex-1 overflow-y-auto px-1 py-1">
          {loading && (
            <div className="flex items-center justify-center h-full">
              <div className="w-5 h-5 border-2 border-indigo-500 border-t-transparent rounded-full animate-spin" />
            </div>
          )}
          {error && (
            <div className="flex items-center justify-center h-full px-4 text-center">
              <div>
                <p className="text-red-400 text-sm">{error}</p>
                <button onClick={() => navigateTo()} className="mt-2 text-xs text-indigo-400 hover:text-indigo-300">Go to home directory</button>
              </div>
            </div>
          )}
          {!loading && !error && entries.length === 0 && (
            <div className="flex items-center justify-center h-full"><p className="text-neutral-500 text-sm">Empty folder</p></div>
          )}
          {!loading && !error && entries.map((entry) => {
            const isSel = mode === "open" && entry.type === "file" && selectedFile === entry.name;
            return (
              <button
                key={`${entry.type}:${entry.name}`}
                onClick={() => onEntry(entry)}
                onDoubleClick={() => { if (entry.type === "file" && mode === "open") { setSelectedFile(entry.name); onOpen?.(cleanDir + sep + entry.name); } }}
                className={`w-full flex items-center gap-2 px-3 py-1.5 rounded text-left transition-colors ${
                  isSel ? "bg-indigo-600/40 text-white" : "hover:bg-neutral-700/50 text-neutral-300"
                }`}
              >
                {entry.type === "directory" ? (
                  <svg className="w-4 h-4 text-yellow-500 shrink-0" fill="currentColor" viewBox="0 0 24 24">
                    <path d="M19.5 21a3 3 0 003-3v-4.5a3 3 0 00-3-3h-15a3 3 0 00-3 3V18a3 3 0 003 3h15zM1.5 10.146V6a3 3 0 013-3h5.379a2.25 2.25 0 011.59.659l2.122 2.121c.14.141.331.22.53.22H19.5a3 3 0 013 3v1.146A4.483 4.483 0 0019.5 9h-15a4.483 4.483 0 00-3 1.146z" />
                  </svg>
                ) : (
                  <svg className="w-4 h-4 text-neutral-500 shrink-0" fill="currentColor" viewBox="0 0 24 24">
                    <path fillRule="evenodd" d="M5.625 1.5c-1.036 0-1.875.84-1.875 1.875v17.25c0 1.035.84 1.875 1.875 1.875h12.75c1.035 0 1.875-.84 1.875-1.875V12.75A3.75 3.75 0 0016.5 9h-1.875a1.875 1.875 0 01-1.875-1.875V5.25A3.75 3.75 0 009 1.5H5.625z" clipRule="evenodd" />
                  </svg>
                )}
                <span className="flex-1 text-xs truncate">{entry.name}</span>
              </button>
            );
          })}
        </div>

        <div className="px-4 py-3 border-t border-neutral-700 space-y-2">
          {mode === "save" && (
            <div className="flex items-center gap-2">
              <label className="text-xs text-neutral-400 shrink-0">Name:</label>
              <input
                type="text"
                value={filename}
                onChange={(e) => setFilename(e.target.value)}
                onKeyDown={(e) => { if (e.key === "Enter") confirm(); }}
                placeholder="scene name…"
                className="flex-1 bg-neutral-900 border border-neutral-600 rounded px-2 py-1.5 text-xs text-neutral-200 focus:outline-none focus:border-indigo-500"
              />
              <span className="text-[11px] text-neutral-500 shrink-0">{extension}</span>
            </div>
          )}
          <div className="flex items-center justify-between gap-2">
            <span className="text-[11px] text-neutral-500 truncate font-mono" title={currentPath}>{currentPath || "—"}</span>
            <div className="flex items-center gap-2 shrink-0">
              <button onClick={onCancel} className="px-4 py-1.5 text-xs text-neutral-400 hover:text-neutral-200 hover:bg-neutral-700 rounded transition-colors">Cancel</button>
              <button
                onClick={confirm}
                disabled={!canConfirm}
                className={`px-4 py-1.5 text-xs rounded transition-colors ${
                  canConfirm ? "bg-indigo-600 hover:bg-indigo-500 text-white" : "bg-neutral-700 text-neutral-500 cursor-not-allowed"
                }`}
              >
                {mode === "save" ? "Save" : "Open"}
              </button>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
