"use client";

import { useState } from "react";

// Re-declare types locally (component is peer to SplatViewer, not importing from it)
interface MeshTransform {
  position: { x: number; y: number; z: number };
  rotation: { x: number; y: number; z: number };
  scale: number;
}

interface MeshEntry {
  id: string;
  name: string;
  visible: boolean;
  hasIBL: boolean;
  envMapIntensity: number;
  transform: MeshTransform;
}

type LightType = "point" | "spot" | "rect";

interface LightEntry {
  id: string;
  type: LightType;
  name: string;
  visible: boolean;
  color: string;
  intensity: number;
  position: { x: number; y: number; z: number };
  targetPosition: { x: number; y: number; z: number };
  angle: number;
  penumbra: number;
  width: number;
  height: number;
  rotation: { x: number; y: number; z: number };
}

interface MeshPanelProps {
  meshEntries: MeshEntry[];
  lightEntries: LightEntry[];
  selectedId: string | null;
  gizmoMode: "translate" | "rotate" | "scale";
  onSelectMesh: (id: string) => void;
  onSelectLight: (id: string) => void;
  onGizmoModeChange: (mode: "translate" | "rotate" | "scale") => void;
  onMeshTransformChange: (id: string, t: MeshTransform) => void;
  onMeshVisibilityToggle: (id: string) => void;
  onMeshEnvMapIntensityChange: (id: string, v: number) => void;
  onRemoveMesh: (id: string) => void;
  onCaptureIBL: (id: string) => void;
  onAddMesh: () => void;
  onAddLight: (type: LightType) => void;
  onLightChange: (id: string, partial: Partial<LightEntry>) => void;
  onRemoveLight: (id: string) => void;
}

function NumInput({ label, value, onChange, step = 0.1, width = "w-16" }: {
  label: string; value: number; onChange: (v: number) => void; step?: number; width?: string;
}) {
  return (
    <label className="flex flex-col gap-0.5">
      <span className="text-[8px] text-neutral-500 uppercase">{label}</span>
      <input
        type="number"
        step={step}
        value={Number(value.toFixed(3))}
        onChange={e => onChange(parseFloat(e.target.value) || 0)}
        className={`nodrag nopan ${width} text-[10px] bg-neutral-800 border border-neutral-700 rounded px-1 py-0.5 text-neutral-200`}
      />
    </label>
  );
}

function XyzRow({ label, value, onChange, step }: {
  label: string;
  value: { x: number; y: number; z: number };
  onChange: (v: { x: number; y: number; z: number }) => void;
  step?: number;
}) {
  return (
    <div className="space-y-0.5">
      <span className="text-[8px] text-neutral-500 uppercase">{label}</span>
      <div className="flex gap-1">
        <NumInput label="X" value={value.x} onChange={v => onChange({ ...value, x: v })} step={step} />
        <NumInput label="Y" value={value.y} onChange={v => onChange({ ...value, y: v })} step={step} />
        <NumInput label="Z" value={value.z} onChange={v => onChange({ ...value, z: v })} step={step} />
      </div>
    </div>
  );
}

export default function MeshPanel({
  meshEntries, lightEntries, selectedId, gizmoMode,
  onSelectMesh, onSelectLight, onGizmoModeChange,
  onMeshTransformChange, onMeshVisibilityToggle, onMeshEnvMapIntensityChange,
  onRemoveMesh, onCaptureIBL, onAddMesh,
  onAddLight, onLightChange, onRemoveLight,
}: MeshPanelProps) {
  const [tab, setTab] = useState<"meshes" | "lights">("meshes");
  const [expandedId, setExpandedId] = useState<string | null>(null);

  const gizmoButtons: { mode: "translate" | "rotate" | "scale"; title: string; icon: React.ReactNode }[] = [
    {
      mode: "translate",
      title: "Translate (move)",
      icon: (
        <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
          <path strokeLinecap="round" strokeLinejoin="round" d="M8 7h8M12 3v18M5 12H3m18 0h-2M7 7l-4 4 4 4M17 7l4 4-4 4" />
        </svg>
      ),
    },
    {
      mode: "rotate",
      title: "Rotate",
      icon: (
        <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
          <path strokeLinecap="round" strokeLinejoin="round" d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
        </svg>
      ),
    },
    {
      mode: "scale",
      title: "Scale",
      icon: (
        <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
          <path strokeLinecap="round" strokeLinejoin="round" d="M4 8V4m0 0h4M4 4l5 5m11-1V4m0 0h-4m4 0l-5 5M4 16v4m0 0h4m-4 0l5-5m11 5l-5-5m5 5v-4m0 4h-4" />
        </svg>
      ),
    },
  ];

  return (
    <div className="bg-black/70 backdrop-blur-md rounded-lg p-3 w-64 max-h-[70vh] flex flex-col gap-2 pointer-events-auto select-none">
      {/* Header + tabs */}
      <div className="flex items-center gap-1">
        <button
          onClick={() => setTab("meshes")}
          className={`flex-1 text-[10px] py-1 rounded transition-colors ${tab === "meshes" ? "bg-neutral-700 text-white" : "text-neutral-500 hover:text-neutral-300"}`}
        >
          Meshes ({meshEntries.length})
        </button>
        <button
          onClick={() => setTab("lights")}
          className={`flex-1 text-[10px] py-1 rounded transition-colors ${tab === "lights" ? "bg-neutral-700 text-white" : "text-neutral-500 hover:text-neutral-300"}`}
        >
          Lights ({lightEntries.length})
        </button>
      </div>

      {/* Gizmo mode bar — shown when something is selected */}
      {selectedId && (
        <div className="flex items-center gap-1 border border-neutral-700 rounded p-1">
          {gizmoButtons.map(({ mode, title, icon }) => (
            <button
              key={mode}
              onClick={() => onGizmoModeChange(mode)}
              title={title}
              className={`flex-1 flex items-center justify-center h-6 rounded transition-colors ${
                gizmoMode === mode ? "bg-indigo-600 text-white" : "text-neutral-400 hover:text-white"
              }`}
            >
              {icon}
            </button>
          ))}
        </div>
      )}

      {/* Content */}
      <div className="flex-1 overflow-y-auto space-y-1 min-h-0">
        {tab === "meshes" && (
          <>
            {meshEntries.length === 0 && (
              <p className="text-[10px] text-neutral-600 text-center py-4">Drop .glb / .obj or click Add</p>
            )}
            {meshEntries.map(entry => (
              <div key={entry.id} className={`rounded border ${entry.id === selectedId ? "border-indigo-500" : "border-neutral-700"}`}>
                <div className="flex items-center gap-1.5 p-1.5">
                  {/* Visibility */}
                  <button onClick={() => onMeshVisibilityToggle(entry.id)} className="text-neutral-500 hover:text-white shrink-0" title={entry.visible ? "Hide" : "Show"}>
                    {entry.visible
                      ? <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}><path strokeLinecap="round" strokeLinejoin="round" d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" /><path strokeLinecap="round" strokeLinejoin="round" d="M2.458 12C3.732 7.943 7.523 5 12 5c4.478 0 8.268 2.943 9.542 7-1.274 4.057-5.064 7-9.542 7-4.477 0-8.268-2.943-9.542-7z" /></svg>
                      : <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}><path strokeLinecap="round" strokeLinejoin="round" d="M13.875 18.825A10.05 10.05 0 0112 19c-4.478 0-8.268-2.943-9.543-7a9.97 9.97 0 011.563-3.029m5.858.908a3 3 0 114.243 4.243M9.878 9.878l4.242 4.242M9.88 9.88l-3.29-3.29m7.532 7.532l3.29 3.29M3 3l3.59 3.59m0 0A9.953 9.953 0 0112 5c4.478 0 8.268 2.943 9.543 7a10.025 10.025 0 01-4.132 5.411m0 0L21 21" /></svg>
                    }
                  </button>
                  {/* Name — click to select */}
                  <button
                    onClick={() => onSelectMesh(entry.id)}
                    className="flex-1 text-left text-[10px] text-neutral-200 truncate hover:text-white"
                  >
                    {entry.name}
                  </button>
                  {/* Expand */}
                  <button
                    onClick={() => setExpandedId(expandedId === entry.id ? null : entry.id)}
                    className="text-neutral-500 hover:text-white shrink-0"
                  >
                    <svg className={`w-3 h-3 transition-transform ${expandedId === entry.id ? "rotate-180" : ""}`} fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                      <path strokeLinecap="round" strokeLinejoin="round" d="M19 9l-7 7-7-7" />
                    </svg>
                  </button>
                  {/* Remove */}
                  <button onClick={() => onRemoveMesh(entry.id)} className="text-neutral-500 hover:text-red-400 shrink-0" title="Remove">
                    <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}><path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" /></svg>
                  </button>
                </div>
                {expandedId === entry.id && (
                  <div className="border-t border-neutral-700 p-2 space-y-2">
                    <XyzRow
                      label="Position"
                      value={entry.transform.position}
                      onChange={pos => onMeshTransformChange(entry.id, { ...entry.transform, position: pos })}
                    />
                    <XyzRow
                      label="Rotation °"
                      value={entry.transform.rotation}
                      onChange={rot => onMeshTransformChange(entry.id, { ...entry.transform, rotation: rot })}
                      step={1}
                    />
                    <NumInput
                      label="Scale"
                      value={entry.transform.scale}
                      onChange={s => onMeshTransformChange(entry.id, { ...entry.transform, scale: Math.max(0.0001, s) })}
                      step={0.1}
                      width="w-full"
                    />
                    {/* IBL */}
                    <div className="pt-1 border-t border-neutral-700 space-y-1">
                      <button
                        onClick={() => onCaptureIBL(entry.id)}
                        className="w-full text-[10px] bg-neutral-700 hover:bg-neutral-600 text-neutral-200 rounded px-2 py-1 transition-colors"
                        title="Capture 360 environment from mesh center and apply as IBL"
                      >
                        {entry.hasIBL ? "Re-capture IBL" : "Capture IBL"}
                      </button>
                      {entry.hasIBL && (
                        <label className="flex items-center gap-2">
                          <span className="text-[9px] text-neutral-500 shrink-0 w-14">IBL {entry.envMapIntensity.toFixed(2)}</span>
                          <input
                            type="range" min={0} max={3} step={0.05}
                            value={entry.envMapIntensity}
                            onChange={e => onMeshEnvMapIntensityChange(entry.id, parseFloat(e.target.value))}
                            className="nodrag nopan flex-1 accent-indigo-500"
                          />
                        </label>
                      )}
                    </div>
                  </div>
                )}
              </div>
            ))}
          </>
        )}

        {tab === "lights" && (
          <>
            {lightEntries.length === 0 && (
              <p className="text-[10px] text-neutral-600 text-center py-2">No lights yet</p>
            )}
            {lightEntries.map(entry => (
              <div key={entry.id} className={`rounded border ${entry.id === selectedId ? "border-indigo-500" : "border-neutral-700"}`}>
                <div className="flex items-center gap-1.5 p-1.5">
                  <button onClick={() => onLightChange(entry.id, { visible: !entry.visible })} className="text-neutral-500 hover:text-white shrink-0">
                    {entry.visible
                      ? <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}><path strokeLinecap="round" strokeLinejoin="round" d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" /><path strokeLinecap="round" strokeLinejoin="round" d="M2.458 12C3.732 7.943 7.523 5 12 5c4.478 0 8.268 2.943 9.542 7-1.274 4.057-5.064 7-9.542 7-4.477 0-8.268-2.943-9.542-7z" /></svg>
                      : <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}><path strokeLinecap="round" strokeLinejoin="round" d="M13.875 18.825A10.05 10.05 0 0112 19c-4.478 0-8.268-2.943-9.543-7a9.97 9.97 0 011.563-3.029m5.858.908a3 3 0 114.243 4.243M9.878 9.878l4.242 4.242M9.88 9.88l-3.29-3.29m7.532 7.532l3.29 3.29M3 3l3.59 3.59m0 0A9.953 9.953 0 0112 5c4.478 0 8.268 2.943 9.543 7a10.025 10.025 0 01-4.132 5.411m0 0L21 21" /></svg>
                    }
                  </button>
                  <button onClick={() => onSelectLight(entry.id)} className="flex-1 text-left text-[10px] text-neutral-200 truncate hover:text-white">
                    {entry.name}
                    <span className="ml-1 text-neutral-500">{entry.type}</span>
                  </button>
                  <button onClick={() => setExpandedId(expandedId === entry.id ? null : entry.id)} className="text-neutral-500 hover:text-white shrink-0">
                    <svg className={`w-3 h-3 transition-transform ${expandedId === entry.id ? "rotate-180" : ""}`} fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                      <path strokeLinecap="round" strokeLinejoin="round" d="M19 9l-7 7-7-7" />
                    </svg>
                  </button>
                  <button onClick={() => onRemoveLight(entry.id)} className="text-neutral-500 hover:text-red-400 shrink-0">
                    <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}><path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" /></svg>
                  </button>
                </div>
                {expandedId === entry.id && (
                  <div className="border-t border-neutral-700 p-2 space-y-2">
                    <div className="flex items-center gap-2">
                      <span className="text-[9px] text-neutral-500 w-14">Color</span>
                      <input
                        type="color"
                        value={entry.color}
                        onChange={e => onLightChange(entry.id, { color: e.target.value })}
                        className="nodrag nopan w-8 h-6 cursor-pointer rounded bg-transparent border border-neutral-700"
                      />
                    </div>
                    <label className="flex items-center gap-2">
                      <span className="text-[9px] text-neutral-500 shrink-0 w-14">Intensity</span>
                      <input
                        type="range" min={0} max={20} step={0.1}
                        value={entry.intensity}
                        onChange={e => onLightChange(entry.id, { intensity: parseFloat(e.target.value) })}
                        className="nodrag nopan flex-1 accent-yellow-500"
                      />
                      <span className="text-[9px] text-neutral-400 w-6">{entry.intensity.toFixed(1)}</span>
                    </label>
                    <XyzRow
                      label="Position"
                      value={entry.position}
                      onChange={pos => onLightChange(entry.id, { position: pos })}
                    />
                    {entry.type === "spot" && (
                      <>
                        <XyzRow
                          label="Target"
                          value={entry.targetPosition}
                          onChange={t => onLightChange(entry.id, { targetPosition: t })}
                        />
                        <label className="flex items-center gap-2">
                          <span className="text-[9px] text-neutral-500 shrink-0 w-14">Angle°</span>
                          <input type="range" min={1} max={89} step={1}
                            value={Math.round((entry.angle * 180) / Math.PI)}
                            onChange={e => onLightChange(entry.id, { angle: (parseInt(e.target.value) * Math.PI) / 180 })}
                            className="nodrag nopan flex-1 accent-yellow-500"
                          />
                          <span className="text-[9px] text-neutral-400 w-6">{Math.round((entry.angle * 180) / Math.PI)}°</span>
                        </label>
                        <label className="flex items-center gap-2">
                          <span className="text-[9px] text-neutral-500 shrink-0 w-14">Penumbra</span>
                          <input type="range" min={0} max={1} step={0.05}
                            value={entry.penumbra}
                            onChange={e => onLightChange(entry.id, { penumbra: parseFloat(e.target.value) })}
                            className="nodrag nopan flex-1 accent-yellow-500"
                          />
                          <span className="text-[9px] text-neutral-400 w-6">{entry.penumbra.toFixed(2)}</span>
                        </label>
                      </>
                    )}
                    {entry.type === "rect" && (
                      <>
                        <div className="flex gap-2">
                          <NumInput label="Width" value={entry.width} onChange={v => onLightChange(entry.id, { width: Math.max(0.1, v) })} step={0.1} />
                          <NumInput label="Height" value={entry.height} onChange={v => onLightChange(entry.id, { height: Math.max(0.1, v) })} step={0.1} />
                        </div>
                        <XyzRow label="Rotation °" value={entry.rotation} onChange={r => onLightChange(entry.id, { rotation: r })} step={1} />
                      </>
                    )}
                  </div>
                )}
              </div>
            ))}
          </>
        )}
      </div>

      {/* Footer action buttons */}
      {tab === "meshes" && (
        <button
          onClick={onAddMesh}
          className="w-full text-[10px] bg-neutral-700 hover:bg-neutral-600 text-neutral-200 rounded px-2 py-1.5 transition-colors"
        >
          + Add Mesh (.glb / .obj)
        </button>
      )}
      {tab === "lights" && (
        <div className="flex gap-1">
          <button onClick={() => onAddLight("point")} className="flex-1 text-[10px] bg-neutral-700 hover:bg-neutral-600 text-neutral-200 rounded px-1 py-1.5 transition-colors" title="Add point light">Point</button>
          <button onClick={() => onAddLight("spot")} className="flex-1 text-[10px] bg-neutral-700 hover:bg-neutral-600 text-neutral-200 rounded px-1 py-1.5 transition-colors" title="Add spot light">Spot</button>
          <button onClick={() => onAddLight("rect")} className="flex-1 text-[10px] bg-neutral-700 hover:bg-neutral-600 text-neutral-200 rounded px-1 py-1.5 transition-colors" title="Add rect area light">Rect</button>
        </div>
      )}
    </div>
  );
}
