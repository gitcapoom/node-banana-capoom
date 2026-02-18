"use client";

import { useState, useEffect, useRef, useCallback } from "react";

interface DirectoryEntry {
  name: string;
}

interface DirectoryListingResponse {
  success: boolean;
  path?: string;
  parent?: string | null;
  separator?: string;
  entries?: DirectoryEntry[];
  error?: string;
}

interface DirectoryBrowserProps {
  isOpen: boolean;
  onClose: () => void;
  onSelect: (path: string) => void;
  initialPath?: string;
}

export function DirectoryBrowser({
  isOpen,
  onClose,
  onSelect,
  initialPath,
}: DirectoryBrowserProps) {
  const [currentPath, setCurrentPath] = useState("");
  const [entries, setEntries] = useState<DirectoryEntry[]>([]);
  const [parent, setParent] = useState<string | null>(null);
  const [separator, setSeparator] = useState("/");
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const panelRef = useRef<HTMLDivElement>(null);

  const fetchDirectory = useCallback(async (path?: string) => {
    setIsLoading(true);
    setError(null);

    try {
      const url = path
        ? `/api/browse-directory?path=${encodeURIComponent(path)}`
        : "/api/browse-directory";

      const response = await fetch(url);
      const data: DirectoryListingResponse = await response.json();

      if (data.success && data.path) {
        setCurrentPath(data.path);
        setEntries(data.entries || []);
        setParent(data.parent ?? null);
        if (data.separator) setSeparator(data.separator);
      } else {
        setError(data.error || "Failed to list directory");
      }
    } catch {
      setError("Failed to connect to server");
    } finally {
      setIsLoading(false);
    }
  }, []);

  // Fetch initial directory when opened
  useEffect(() => {
    if (isOpen) {
      if (initialPath && initialPath.trim()) {
        // Try the initial path first, fall back to home if it fails
        fetchDirectory(initialPath).then(() => {
          // If fetchDirectory set an error, fall back to home
        });
      } else {
        fetchDirectory();
      }
    }
  }, [isOpen]); // eslint-disable-line react-hooks/exhaustive-deps

  // If initial path failed, retry with default
  useEffect(() => {
    if (isOpen && error && currentPath === "") {
      setError(null);
      fetchDirectory();
    }
  }, [error, currentPath, isOpen, fetchDirectory]);

  // Close on click outside
  useEffect(() => {
    if (!isOpen) return;

    const handleClickOutside = (e: MouseEvent) => {
      if (panelRef.current && !panelRef.current.contains(e.target as Node)) {
        onClose();
      }
    };

    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, [isOpen, onClose]);

  // Close on Escape
  useEffect(() => {
    if (!isOpen) return;

    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        onClose();
      }
    };

    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [isOpen, onClose]);

  if (!isOpen) return null;

  const handleNavigate = (dirName: string) => {
    fetchDirectory(currentPath + separator + dirName);
  };

  const handleGoUp = () => {
    if (parent) fetchDirectory(parent);
  };

  const handleSelect = () => {
    onSelect(currentPath);
    onClose();
  };

  // Truncate path display from the left if too long
  const displayPath = currentPath.length > 50
    ? "..." + currentPath.slice(-47)
    : currentPath;

  return (
    <div
      ref={panelRef}
      className="absolute z-50 top-full left-0 right-0 mt-1 bg-neutral-800 border border-neutral-600 rounded-lg shadow-lg overflow-hidden"
    >
      {/* Header with current path and actions */}
      <div className="flex items-center gap-2 px-3 py-2 bg-neutral-900 border-b border-neutral-700">
        <span
          className="flex-1 text-xs text-neutral-400 font-mono truncate"
          title={currentPath}
        >
          {isLoading ? "Loading..." : displayPath || "..."}
        </span>
        <button
          type="button"
          onClick={handleSelect}
          disabled={isLoading || !currentPath}
          className="px-2 py-1 bg-white text-neutral-900 text-xs font-medium rounded hover:bg-neutral-200 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
        >
          Select
        </button>
        <button
          type="button"
          onClick={onClose}
          className="text-neutral-400 hover:text-neutral-100 transition-colors"
          title="Close"
        >
          <svg
            xmlns="http://www.w3.org/2000/svg"
            className="h-4 w-4"
            viewBox="0 0 20 20"
            fill="currentColor"
          >
            <path
              fillRule="evenodd"
              d="M4.293 4.293a1 1 0 011.414 0L10 8.586l4.293-4.293a1 1 0 111.414 1.414L11.414 10l4.293 4.293a1 1 0 01-1.414 1.414L10 11.414l-4.293 4.293a1 1 0 01-1.414-1.414L8.586 10 4.293 5.707a1 1 0 010-1.414z"
              clipRule="evenodd"
            />
          </svg>
        </button>
      </div>

      {/* Error message */}
      {error && (
        <div className="px-3 py-2 text-xs text-red-400 bg-red-900/20 border-b border-neutral-700">
          {error}
          <button
            type="button"
            onClick={() => fetchDirectory(currentPath || undefined)}
            className="ml-2 underline hover:text-red-300"
          >
            Retry
          </button>
        </div>
      )}

      {/* Directory listing */}
      <div className="max-h-48 overflow-y-auto">
        {isLoading ? (
          <div className="px-3 py-3 text-sm text-neutral-500 text-center">
            Loading...
          </div>
        ) : (
          <>
            {/* Parent directory (..) */}
            {parent && (
              <button
                type="button"
                onClick={handleGoUp}
                className="w-full flex items-center gap-2 px-3 py-1.5 text-sm text-neutral-300 hover:bg-neutral-700 transition-colors text-left"
              >
                <svg
                  xmlns="http://www.w3.org/2000/svg"
                  className="h-4 w-4 text-neutral-500 flex-shrink-0"
                  viewBox="0 0 20 20"
                  fill="currentColor"
                >
                  <path
                    fillRule="evenodd"
                    d="M9.707 14.707a1 1 0 01-1.414 0l-4-4a1 1 0 010-1.414l4-4a1 1 0 011.414 1.414L7.414 9H15a1 1 0 110 2H7.414l2.293 2.293a1 1 0 010 1.414z"
                    clipRule="evenodd"
                  />
                </svg>
                ..
              </button>
            )}

            {/* Directory entries */}
            {entries.length === 0 && !parent && (
              <div className="px-3 py-3 text-sm text-neutral-500 text-center">
                Empty directory
              </div>
            )}
            {entries.map((entry) => (
              <button
                key={entry.name}
                type="button"
                onClick={() => handleNavigate(entry.name)}
                className="w-full flex items-center gap-2 px-3 py-1.5 text-sm text-neutral-200 hover:bg-neutral-700 transition-colors text-left"
              >
                <svg
                  xmlns="http://www.w3.org/2000/svg"
                  className="h-4 w-4 text-yellow-500 flex-shrink-0"
                  viewBox="0 0 20 20"
                  fill="currentColor"
                >
                  <path d="M2 6a2 2 0 012-2h5l2 2h5a2 2 0 012 2v6a2 2 0 01-2 2H4a2 2 0 01-2-2V6z" />
                </svg>
                <span className="truncate">{entry.name}</span>
              </button>
            ))}
          </>
        )}
      </div>
    </div>
  );
}
