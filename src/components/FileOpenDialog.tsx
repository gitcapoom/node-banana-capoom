"use client";

import { useState, useEffect, useCallback, useRef } from "react";

interface DirectoryEntry {
  name: string;
  type: "directory" | "file";
  size?: number;
}

interface FileOpenDialogProps {
  onFileSelected: (filePath: string) => void;
  onCancel: () => void;
  initialPath?: string;
  mode?: "file" | "directory";
  /** In file mode, also list non-.json files (images/EXRs) so they can be picked. */
  showAllFiles?: boolean;
}

const STORAGE_KEY = "fileOpenDialog_lastPath";

function formatSize(bytes?: number): string {
  if (!bytes) return "";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export function FileOpenDialog({ onFileSelected, onCancel, initialPath, mode = "file", showAllFiles = false }: FileOpenDialogProps) {
  const isDirectoryMode = mode === "directory";
  const [currentPath, setCurrentPath] = useState<string>(initialPath || "");
  const [pathInput, setPathInput] = useState<string>("");
  const [entries, setEntries] = useState<DirectoryEntry[]>([]);
  const [selectedFile, setSelectedFile] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const pathInputRef = useRef<HTMLInputElement>(null);

  const navigateTo = useCallback(async (dirPath?: string) => {
    setLoading(true);
    setError(null);
    setSelectedFile(null);

    try {
      const searchParams = new URLSearchParams();
      if (dirPath) searchParams.set("path", dirPath);
      if (isDirectoryMode || showAllFiles) searchParams.set("showAllFiles", "true");
      const qs = searchParams.toString();
      const response = await fetch(`/api/list-directory${qs ? `?${qs}` : ""}`);
      const result = await response.json();

      if (!result.success) {
        setError(result.error);
        setLoading(false);
        return;
      }

      setCurrentPath(result.path);
      setPathInput(result.path);
      // In directory mode, only show directories (no files)
      setEntries(isDirectoryMode
        ? result.entries.filter((e: DirectoryEntry) => e.type === "directory")
        : result.entries
      );

      // Remember last browsed path
      try {
        localStorage.setItem(STORAGE_KEY, result.path);
      } catch { /* ignore */ }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load directory");
    } finally {
      setLoading(false);
    }
  }, [isDirectoryMode, showAllFiles]);

  // Load initial directory on mount
  useEffect(() => {
    const startPath = initialPath || (() => {
      try { return localStorage.getItem(STORAGE_KEY) || undefined; } catch { return undefined; }
    })();
    navigateTo(startPath);
  }, [initialPath, navigateTo]);

  const handleEntryClick = useCallback((entry: DirectoryEntry) => {
    if (entry.type === "directory") {
      // Navigate into directory
      const separator = currentPath.includes("/") ? "/" : "\\";
      const newPath = currentPath + separator + entry.name;
      navigateTo(newPath);
    } else {
      // Select the file
      setSelectedFile(entry.name);
    }
  }, [currentPath, navigateTo]);

  const handleEntryDoubleClick = useCallback((entry: DirectoryEntry) => {
    if (entry.type === "file") {
      // Double-click on file = open it
      const separator = currentPath.includes("/") ? "/" : "\\";
      const filePath = currentPath + separator + entry.name;
      onFileSelected(filePath);
    }
  }, [currentPath, onFileSelected]);

  const handleOpen = useCallback(() => {
    if (!selectedFile) return;
    const separator = currentPath.includes("/") ? "/" : "\\";
    const filePath = currentPath + separator + selectedFile;
    onFileSelected(filePath);
  }, [currentPath, selectedFile, onFileSelected]);

  const handleGoUp = useCallback(() => {
    // Go to parent directory
    const normalized = currentPath.replace(/\\/g, "/");
    const lastSlash = normalized.lastIndexOf("/");
    if (lastSlash <= 0) return;

    // For UNC paths (//server/share), don't go above //server
    if (normalized.startsWith("//")) {
      const parts = normalized.split("/").filter(Boolean);
      if (parts.length <= 1) return; // Already at //server level
    }

    const parentPath = currentPath.substring(0, lastSlash) || "/";
    // Preserve original slash style
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
            <path strokeLinecap="round" strokeLinejoin="round" d="M3.75 9.776c.112-.017.227-.026.344-.026h15.812c.117 0 .232.009.344.026m-16.5 0a2.25 2.25 0 00-1.883 2.542l.857 6a2.25 2.25 0 002.227 1.932H19.05a2.25 2.25 0 002.227-1.932l.857-6a2.25 2.25 0 00-1.883-2.542m-16.5 0V6A2.25 2.25 0 016 3.75h3.879a1.5 1.5 0 011.06.44l2.122 2.12a1.5 1.5 0 001.06.44H18A2.25 2.25 0 0120.25 9v.776" />
          </svg>
          <h2 className="text-sm font-medium text-neutral-200">{isDirectoryMode ? "Choose Directory" : "Open Workflow"}</h2>
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
            ref={pathInputRef}
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
              <p className="text-neutral-500 text-sm">{isDirectoryMode ? "No folders in this directory" : "No folders or JSON files in this directory"}</p>
            </div>
          )}

          {!loading && !error && entries.map((entry) => (
            <button
              key={entry.name}
              onClick={() => handleEntryClick(entry)}
              onDoubleClick={() => handleEntryDoubleClick(entry)}
              className={`w-full flex items-center gap-2 px-3 py-1.5 rounded text-left transition-colors ${
                selectedFile === entry.name
                  ? "bg-blue-600/30 text-blue-200"
                  : "hover:bg-neutral-700/50 text-neutral-300"
              }`}
            >
              {entry.type === "directory" ? (
                <svg className="w-4 h-4 text-yellow-500 shrink-0" fill="currentColor" viewBox="0 0 24 24">
                  <path d="M19.5 21a3 3 0 003-3v-4.5a3 3 0 00-3-3h-15a3 3 0 00-3 3V18a3 3 0 003 3h15zM1.5 10.146V6a3 3 0 013-3h5.379a2.25 2.25 0 011.59.659l2.122 2.121c.14.141.331.22.53.22H19.5a3 3 0 013 3v1.146A4.483 4.483 0 0019.5 9h-15a4.483 4.483 0 00-3 1.146z" />
                </svg>
              ) : (
                <svg className="w-4 h-4 text-blue-400 shrink-0" fill="currentColor" viewBox="0 0 24 24">
                  <path fillRule="evenodd" d="M5.625 1.5c-1.036 0-1.875.84-1.875 1.875v17.25c0 1.035.84 1.875 1.875 1.875h12.75c1.035 0 1.875-.84 1.875-1.875V12.75A3.75 3.75 0 0016.5 9h-1.875a1.875 1.875 0 01-1.875-1.875V5.25A3.75 3.75 0 009 1.5H5.625zM7.5 15a.75.75 0 01.75-.75h7.5a.75.75 0 010 1.5h-7.5A.75.75 0 017.5 15zm.75 2.25a.75.75 0 000 1.5H12a.75.75 0 000-1.5H8.25z" clipRule="evenodd" />
                  <path d="M12.971 1.816A5.23 5.23 0 0114.25 5.25v1.875c0 .207.168.375.375.375H16.5a5.23 5.23 0 013.434 1.279 9.768 9.768 0 00-6.963-6.963z" />
                </svg>
              )}
              <span className="flex-1 text-xs truncate">{entry.name}</span>
              {entry.type === "file" && entry.size !== undefined && (
                <span className="text-[10px] text-neutral-500 shrink-0">{formatSize(entry.size)}</span>
              )}
            </button>
          ))}
        </div>

        {/* Footer */}
        <div className="px-4 py-3 border-t border-neutral-700 flex items-center justify-between gap-3">
          <div className="flex-1 min-w-0">
            {isDirectoryMode ? (
              <p className="text-xs text-neutral-400 truncate">
                <span className="text-neutral-200">{currentPath}</span>
              </p>
            ) : selectedFile ? (
              <p className="text-xs text-neutral-400 truncate">
                Selected: <span className="text-neutral-200">{selectedFile}</span>
              </p>
            ) : null}
          </div>
          <div className="flex gap-2 shrink-0">
            <button
              onClick={onCancel}
              className="px-4 py-1.5 text-xs text-neutral-400 hover:text-neutral-200 hover:bg-neutral-700 rounded transition-colors"
            >
              Cancel
            </button>
            {isDirectoryMode ? (
              <button
                onClick={() => onFileSelected(currentPath)}
                disabled={!currentPath}
                className={`px-4 py-1.5 text-xs rounded transition-colors ${
                  currentPath
                    ? "bg-blue-600 hover:bg-blue-500 text-white"
                    : "bg-neutral-700 text-neutral-500 cursor-not-allowed"
                }`}
              >
                Select Folder
              </button>
            ) : (
              <button
                onClick={handleOpen}
                disabled={!selectedFile}
                className={`px-4 py-1.5 text-xs rounded transition-colors ${
                  selectedFile
                    ? "bg-blue-600 hover:bg-blue-500 text-white"
                    : "bg-neutral-700 text-neutral-500 cursor-not-allowed"
                }`}
              >
                Open
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
