"use client";

import { useState, useEffect, useCallback, useRef } from "react";

interface DirectoryEntry {
  name: string;
  type: "directory" | "file";
  size?: number;
}

interface FileSaveDialogProps {
  onSave: (directoryPath: string, filename: string) => void;
  onCancel: () => void;
  initialPath?: string;
  defaultFilename?: string;
}

const STORAGE_KEY = "fileSaveDialog_lastPath";

function formatSize(bytes?: number): string {
  if (!bytes) return "";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export function FileSaveDialog({ onSave, onCancel, initialPath, defaultFilename }: FileSaveDialogProps) {
  const [currentPath, setCurrentPath] = useState<string>(initialPath || "");
  const [pathInput, setPathInput] = useState<string>("");
  const [entries, setEntries] = useState<DirectoryEntry[]>([]);
  const [filename, setFilename] = useState<string>(defaultFilename || "output");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const filenameInputRef = useRef<HTMLInputElement>(null);

  const navigateTo = useCallback(async (dirPath?: string) => {
    setLoading(true);
    setError(null);

    try {
      const params = new URLSearchParams();
      if (dirPath) params.set("path", dirPath);
      params.set("showAllFiles", "true");
      const response = await fetch(`/api/list-directory?${params.toString()}`);
      const result = await response.json();

      if (!result.success) {
        setError(result.error);
        setLoading(false);
        return;
      }

      setCurrentPath(result.path);
      setPathInput(result.path);
      setEntries(result.entries);

      try {
        localStorage.setItem(STORAGE_KEY, result.path);
      } catch { /* ignore */ }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load directory");
    } finally {
      setLoading(false);
    }
  }, []);

  // Load initial directory on mount
  useEffect(() => {
    const startPath = initialPath || (() => {
      try { return localStorage.getItem(STORAGE_KEY) || undefined; } catch { return undefined; }
    })();
    navigateTo(startPath);
  }, [initialPath, navigateTo]);

  const handleEntryClick = useCallback((entry: DirectoryEntry) => {
    if (entry.type === "directory") {
      const separator = currentPath.includes("/") ? "/" : "\\";
      const newPath = currentPath + separator + entry.name;
      navigateTo(newPath);
    } else {
      // Clicking an existing file sets the filename to that name (for overwrite)
      setFilename(entry.name.replace(/\.[^.]+$/, ""));
    }
  }, [currentPath, navigateTo]);

  const handleEntryDoubleClick = useCallback((entry: DirectoryEntry) => {
    if (entry.type === "directory") {
      const separator = currentPath.includes("/") ? "/" : "\\";
      const newPath = currentPath + separator + entry.name;
      navigateTo(newPath);
    }
  }, [currentPath, navigateTo]);

  const handleSave = useCallback(() => {
    if (!filename.trim()) return;
    onSave(currentPath, filename.trim());
  }, [currentPath, filename, onSave]);

  const handleGoUp = useCallback(() => {
    const normalized = currentPath.replace(/\\/g, "/");
    const lastSlash = normalized.lastIndexOf("/");
    if (lastSlash <= 0) return;

    if (normalized.startsWith("//")) {
      const parts = normalized.split("/").filter(Boolean);
      if (parts.length <= 1) return;
    }

    const parentPath = currentPath.substring(0, lastSlash) || "/";
    navigateTo(parentPath);
  }, [currentPath, navigateTo]);

  const handlePathSubmit = useCallback((e: React.FormEvent) => {
    e.preventDefault();
    if (pathInput.trim()) {
      navigateTo(pathInput.trim());
    }
  }, [pathInput, navigateTo]);

  const handleKeyDown = useCallback((e: React.KeyboardEvent) => {
    if (e.key === "Escape") {
      onCancel();
    }
  }, [onCancel]);

  return (
    <div
      className="fixed inset-0 z-[200] flex items-center justify-center bg-black/60 backdrop-blur-sm"
      onClick={onCancel}
      onKeyDown={handleKeyDown}
    >
      <div
        className="w-full max-w-2xl mx-4 bg-neutral-800 rounded-xl border border-neutral-700 shadow-2xl flex flex-col"
        style={{ height: "70vh", maxHeight: "600px" }}
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="px-4 py-3 border-b border-neutral-700 flex items-center gap-2">
          <svg className="w-5 h-5 text-neutral-400 shrink-0" fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" d="M3 16.5v2.25A2.25 2.25 0 005.25 21h13.5A2.25 2.25 0 0021 18.75V16.5M16.5 12L12 16.5m0 0L7.5 12m4.5 4.5V3" />
          </svg>
          <h2 className="text-sm font-medium text-neutral-200">Save Output</h2>
        </div>

        {/* Path bar */}
        <form onSubmit={handlePathSubmit} className="px-3 py-2 border-b border-neutral-700 flex gap-2">
          <button
            type="button"
            onClick={handleGoUp}
            className="px-2 py-1 text-xs text-neutral-400 hover:text-neutral-200 hover:bg-neutral-700 rounded transition-colors shrink-0"
            title="Go to parent folder"
          >
            <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" d="M4.5 15.75l7.5-7.5 7.5 7.5" />
            </svg>
          </button>
          <input
            type="text"
            value={pathInput}
            onChange={(e) => setPathInput(e.target.value)}
            className="flex-1 bg-neutral-900 border border-neutral-600 rounded px-2 py-1 text-xs text-neutral-200 font-mono focus:outline-none focus:border-blue-500"
            placeholder="Enter path..."
          />
          <button
            type="submit"
            className="px-3 py-1 text-xs bg-neutral-700 hover:bg-neutral-600 text-neutral-200 rounded transition-colors"
          >
            Go
          </button>
        </form>

        {/* File listing */}
        <div className="flex-1 overflow-y-auto px-1 py-1">
          {loading && (
            <div className="flex items-center justify-center h-full">
              <div className="w-5 h-5 border-2 border-blue-500 border-t-transparent rounded-full animate-spin" />
            </div>
          )}

          {error && (
            <div className="flex items-center justify-center h-full px-4">
              <div className="text-center">
                <p className="text-red-400 text-sm">{error}</p>
                <button
                  onClick={() => navigateTo()}
                  className="mt-2 text-xs text-blue-400 hover:text-blue-300"
                >
                  Go to home directory
                </button>
              </div>
            </div>
          )}

          {!loading && !error && entries.length === 0 && (
            <div className="flex items-center justify-center h-full">
              <p className="text-neutral-500 text-sm">Empty directory</p>
            </div>
          )}

          {!loading && !error && entries.map((entry) => (
            <button
              key={entry.name}
              onClick={() => handleEntryClick(entry)}
              onDoubleClick={() => handleEntryDoubleClick(entry)}
              className="w-full flex items-center gap-2 px-3 py-1.5 rounded text-left transition-colors hover:bg-neutral-700/50 text-neutral-300"
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
              {entry.type === "file" && entry.size !== undefined && (
                <span className="text-[10px] text-neutral-500 shrink-0">{formatSize(entry.size)}</span>
              )}
            </button>
          ))}
        </div>

        {/* Filename input + Save/Cancel */}
        <div className="px-4 py-3 border-t border-neutral-700 space-y-3">
          <div className="flex items-center gap-2">
            <label className="text-xs text-neutral-400 shrink-0">File name:</label>
            <input
              ref={filenameInputRef}
              type="text"
              value={filename}
              onChange={(e) => setFilename(e.target.value)}
              className="flex-1 bg-neutral-900 border border-neutral-600 rounded px-2 py-1.5 text-xs text-neutral-200 focus:outline-none focus:border-blue-500"
              placeholder="Enter filename..."
              onKeyDown={(e) => { if (e.key === "Enter") handleSave(); }}
            />
          </div>
          <div className="flex items-center justify-end gap-2">
            <button
              onClick={onCancel}
              className="px-4 py-1.5 text-xs text-neutral-400 hover:text-neutral-200 hover:bg-neutral-700 rounded transition-colors"
            >
              Cancel
            </button>
            <button
              onClick={handleSave}
              disabled={!filename.trim()}
              className={`px-4 py-1.5 text-xs rounded transition-colors ${
                filename.trim()
                  ? "bg-blue-600 hover:bg-blue-500 text-white"
                  : "bg-neutral-700 text-neutral-500 cursor-not-allowed"
              }`}
            >
              Save
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
