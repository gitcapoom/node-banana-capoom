"use client";

import { useState } from "react";

// Re-declare types locally (peer component to SplatViewer)
interface MeshTransform {
  position: { x: number; y: number; z: number };
  rotation: { x: number; y: number; z: number };
  scale: number;
}

interface MeshEntry {
  id: string;
  name: string;
  visible: boolean;
  transform: MeshTransform;
  fileData?: string;
  overlay?: boolean;
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
  lockTarget: boolean;
  width: number;
  height: number;
  rotation: { x: number; y: number; z: number };
}

interface IblEntry {
  id: string;
  name: string;
  visible: boolean;
  position: { x: number; y: number; z: number };
  radius: number;
  ramp: number;
  intensity: number;
  lift: number;
  gain: number;
  gamma: number;
}

interface MeshPanelProps {
  meshEntries: MeshEntry[];
  lightEntries: LightEntry[];
  iblEntries: IblEntry[];
  selectedId: string | null;
  selectedSpotTargetId: string | null;
  gizmoMode: "translate" | "rotate" | "scale";
  gizmoSpace: "world" | "local";
  onSelectMesh: (id: string) => void;
  onSelectLight: (id: string) => void;
  onSelectSpotTarget: (id: string) => void;
  onGizmoModeChange: (mode: "translate" | "rotate" | "scale") => void;
  onGizmoSpaceChange: (space: "world" | "local") => void;
  onMeshTransformChange: (id: string, t: MeshTransform) => void;
  onMeshVisibilityToggle: (id: string) => void;
  onMeshOverlayToggle: (id: string) => void;
  onRemoveMesh: (id: string) => void;
  onCaptureIblFromMesh: (meshId: string) => void;
  onAddMesh: () => void;
  onAddLight: (type: LightType) => void;
  onLightChange: (id: string, partial: Partial<LightEntry>) => void;
  onRemoveLight: (id: string) => void;
  onIblChange: (id: string, partial: Partial<IblEntry>) => void;
  onCaptureIblAtCamera: () => void;
  onRemoveIbl: (id: string) => void;
}

// ─── Sub-components ───────────────────────────────────────────────

// NumInput with local state to allow intermediate negative values (e.g. typing "-" or "1.")
function NumInput({ label, value, onChange, step = 0.1, width = "w-16", min }: {
  label: string; value: number; onChange: (v: number) => void;
  step?: number; width?: string; min?: number;
}) {
  const [raw, setRaw] = useState<string | null>(null);
  const displayVal = raw !== null ? raw : Number(value.toFixed(3)).toString();

  return (
    <label className="flex flex-col gap-0.5">
      <span className="text-[8px] text-neutral-500 uppercase">{label}</span>
      <input
        type="number"
        step={step}
        min={min}
        value={displayVal}
        onChange={e => {
          setRaw(e.target.value);
          const parsed = parseFloat(e.target.value);
          if (!isNaN(parsed)) onChange(parsed);
        }}
        onBlur={() => setRaw(null)}
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

// Single-value slider row with numeric input alongside (supports negative)
function SliderRow({ label, value, onChange, min, max, step = 0.01 }: {
  label: string; value: number; onChange: (v: number) => void;
  min: number; max: number; step?: number;
}) {
  const [raw, setRaw] = useState<string | null>(null);
  const displayVal = raw !== null ? raw : Number(value.toFixed(3)).toString();
  return (
    <div className="flex items-center gap-2">
      <span className="text-[9px] text-neutral-500 shrink-0 w-10">{label}</span>
      <input type="range" min={min} max={max} step={step}
        value={Math.max(min, Math.min(max, value))}
        onChange={e => onChange(parseFloat(e.target.value))}
        className="nodrag nopan flex-1 accent-teal-500" />
      <input
        type="number"
        step={step}
        value={displayVal}
        onChange={e => {
          setRaw(e.target.value);
          const parsed = parseFloat(e.target.value);
          if (!isNaN(parsed)) onChange(parsed);
        }}
        onBlur={() => setRaw(null)}
        className="nodrag nopan w-14 text-[10px] bg-neutral-800 border border-neutral-700 rounded px-1 py-0.5 text-neutral-200"
      />
    </div>
  );
}

const EyeOnIcon = () => (
  <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
    <path strokeLinecap="round" strokeLinejoin="round" d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
    <path strokeLinecap="round" strokeLinejoin="round" d="M2.458 12C3.732 7.943 7.523 5 12 5c4.478 0 8.268 2.943 9.542 7-1.274 4.057-5.064 7-9.542 7-4.477 0-8.268-2.943-9.542-7z" />
  </svg>
);
const EyeOffIcon = () => (
  <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
    <path strokeLinecap="round" strokeLinejoin="round" d="M13.875 18.825A10.05 10.05 0 0112 19c-4.478 0-8.268-2.943-9.543-7a9.97 9.97 0 011.563-3.029m5.858.908a3 3 0 114.243 4.243M9.878 9.878l4.242 4.242M9.88 9.88l-3.29-3.29m7.532 7.532l3.29 3.29M3 3l3.59 3.59m0 0A9.953 9.953 0 0112 5c4.478 0 8.268 2.943 9.543 7a10.025 10.025 0 01-4.132 5.411m0 0L21 21" />
  </svg>
);
const XIcon = () => (
  <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
    <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
  </svg>
);
// "Always on top" — stacked layers, drawn through everything (locator-style)
const TopIcon = () => (
  <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
    <path strokeLinecap="round" strokeLinejoin="round" d="M12 3l9 5-9 5-9-5 9-5z" />
    <path strokeLinecap="round" strokeLinejoin="round" d="M3 12l9 5 9-5M3 16.5l9 5 9-5" opacity={0.5} />
  </svg>
);
const ChevronIcon = ({ open }: { open: boolean }) => (
  <svg className={`w-3 h-3 transition-transform ${open ? "rotate-180" : ""}`} fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
    <path strokeLinecap="round" strokeLinejoin="round" d="M19 9l-7 7-7-7" />
  </svg>
);

const gizmoButtons: { mode: "translate" | "rotate" | "scale"; title: string }[] = [
  { mode: "translate", title: "Translate" },
  { mode: "rotate", title: "Rotate" },
  { mode: "scale", title: "Scale" },
];

// ─── Main component ───────────────────────────────────────────────

export default function MeshPanel({
  meshEntries, lightEntries, iblEntries,
  selectedId, selectedSpotTargetId, gizmoMode, gizmoSpace,
  onSelectMesh, onSelectLight, onSelectSpotTarget,
  onGizmoModeChange, onGizmoSpaceChange,
  onMeshTransformChange, onMeshVisibilityToggle, onMeshOverlayToggle, onRemoveMesh, onCaptureIblFromMesh, onAddMesh,
  onAddLight, onLightChange, onRemoveLight,
  onIblChange, onCaptureIblAtCamera, onRemoveIbl,
}: MeshPanelProps) {
  const [tab, setTab] = useState<"meshes" | "lights" | "ibl">("meshes");
  const [expandedId, setExpandedId] = useState<string | null>(null);

  return (
    <div className="bg-black/70 backdrop-blur-md rounded-lg p-3 w-64 max-h-[80vh] flex flex-col gap-2 pointer-events-auto select-none">
      {/* Tabs */}
      <div className="flex items-center gap-1">
        <button onClick={() => setTab("meshes")} className={`flex-1 text-[10px] py-1 rounded transition-colors ${tab === "meshes" ? "bg-neutral-700 text-white" : "text-neutral-500 hover:text-neutral-300"}`}>
          Meshes ({meshEntries.length})
        </button>
        <button onClick={() => setTab("lights")} className={`flex-1 text-[10px] py-1 rounded transition-colors ${tab === "lights" ? "bg-neutral-700 text-white" : "text-neutral-500 hover:text-neutral-300"}`}>
          Lights ({lightEntries.length})
        </button>
        <button onClick={() => setTab("ibl")} className={`flex-1 text-[10px] py-1 rounded transition-colors ${tab === "ibl" ? "bg-neutral-700 text-white" : "text-neutral-500 hover:text-neutral-300"}`}>
          IBL ({iblEntries.length})
        </button>
      </div>

      {/* Gizmo mode + space bar (shown when something is selected) */}
      {selectedId && (
        <div className="flex items-center gap-1 border border-neutral-700 rounded p-1">
          {gizmoButtons.map(({ mode, title }) => (
            <button key={mode} onClick={() => onGizmoModeChange(mode)} title={title}
              className={`flex-1 text-[9px] h-6 rounded transition-colors ${gizmoMode === mode ? "bg-indigo-600 text-white" : "text-neutral-400 hover:text-white"}`}
            >
              {title[0]}
            </button>
          ))}
          <div className="w-px h-4 bg-neutral-600 mx-0.5" />
          <button
            onClick={() => onGizmoSpaceChange(gizmoSpace === "world" ? "local" : "world")}
            title={gizmoSpace === "world" ? "World space (click for local)" : "Local space (click for world)"}
            className={`text-[9px] px-1.5 h-6 rounded transition-colors ${gizmoSpace === "local" ? "bg-amber-600 text-white" : "text-neutral-400 hover:text-white"}`}
          >
            {gizmoSpace === "world" ? "W" : "L"}
          </button>
        </div>
      )}

      {/* Content */}
      <div className="flex-1 overflow-y-auto space-y-1 min-h-0">

        {/* ── Meshes tab ── */}
        {tab === "meshes" && (
          <>
            {meshEntries.length === 0 && (
              <p className="text-[10px] text-neutral-600 text-center py-4">Drop .glb / .obj or click Add</p>
            )}
            {meshEntries.map(entry => (
              <div key={entry.id} className={`rounded border ${entry.id === selectedId ? "border-indigo-500" : "border-neutral-700"}`}>
                <div className="flex items-center gap-1.5 p-1.5">
                  <button onClick={() => onMeshVisibilityToggle(entry.id)} className="text-neutral-500 hover:text-white shrink-0">
                    {entry.visible ? <EyeOnIcon /> : <EyeOffIcon />}
                  </button>
                  <button onClick={() => onSelectMesh(entry.id)} className="flex-1 text-left text-[10px] text-neutral-200 truncate hover:text-white">
                    {entry.name}
                  </button>
                  <button onClick={() => onMeshOverlayToggle(entry.id)}
                    title={entry.overlay ? "Always on top: ON (click to clip behind splat)" : "Always on top: OFF (draw through splat)"}
                    className={`shrink-0 ${entry.overlay ? "text-amber-400" : "text-neutral-600 hover:text-neutral-300"}`}>
                    <TopIcon />
                  </button>
                  <button onClick={() => setExpandedId(expandedId === entry.id ? null : entry.id)} className="text-neutral-500 hover:text-white shrink-0">
                    <ChevronIcon open={expandedId === entry.id} />
                  </button>
                  <button onClick={() => onRemoveMesh(entry.id)} className="text-neutral-500 hover:text-red-400 shrink-0">
                    <XIcon />
                  </button>
                </div>
                {expandedId === entry.id && (
                  <div className="border-t border-neutral-700 p-2 space-y-2">
                    <XyzRow label="Position" value={entry.transform.position}
                      onChange={pos => onMeshTransformChange(entry.id, { ...entry.transform, position: pos })} />
                    <XyzRow label="Rotation °" value={entry.transform.rotation}
                      onChange={rot => onMeshTransformChange(entry.id, { ...entry.transform, rotation: rot })} step={1} />
                    <NumInput label="Scale" value={entry.transform.scale}
                      onChange={s => onMeshTransformChange(entry.id, { ...entry.transform, scale: Math.max(0.0001, s) })}
                      step={0.1} width="w-full" min={0.0001} />
                    <div className="pt-1 border-t border-neutral-700">
                      <button onClick={() => onCaptureIblFromMesh(entry.id)}
                        className="w-full text-[10px] bg-neutral-700 hover:bg-neutral-600 text-neutral-200 rounded px-2 py-1 transition-colors"
                        title="Capture 360 IBL from mesh center and add to IBL list">
                        Capture IBL from mesh
                      </button>
                    </div>
                  </div>
                )}
              </div>
            ))}
          </>
        )}

        {/* ── Lights tab ── */}
        {tab === "lights" && (
          <>
            {lightEntries.length === 0 && (
              <p className="text-[10px] text-neutral-600 text-center py-2">No lights yet</p>
            )}
            {lightEntries.map(entry => (
              <div key={entry.id} className={`rounded border ${entry.id === selectedId ? "border-indigo-500" : "border-neutral-700"}`}>
                <div className="flex items-center gap-1.5 p-1.5">
                  <button onClick={() => onLightChange(entry.id, { visible: !entry.visible })} className="text-neutral-500 hover:text-white shrink-0">
                    {entry.visible ? <EyeOnIcon /> : <EyeOffIcon />}
                  </button>
                  <button onClick={() => onSelectLight(entry.id)} className="flex-1 text-left text-[10px] text-neutral-200 truncate hover:text-white">
                    {entry.name} <span className="text-neutral-500">{entry.type}</span>
                  </button>
                  <button onClick={() => setExpandedId(expandedId === entry.id ? null : entry.id)} className="text-neutral-500 hover:text-white shrink-0">
                    <ChevronIcon open={expandedId === entry.id} />
                  </button>
                  <button onClick={() => onRemoveLight(entry.id)} className="text-neutral-500 hover:text-red-400 shrink-0">
                    <XIcon />
                  </button>
                </div>
                {expandedId === entry.id && (
                  <div className="border-t border-neutral-700 p-2 space-y-2">
                    <div className="flex items-center gap-2">
                      <span className="text-[9px] text-neutral-500 w-12">Color</span>
                      <input type="color" value={entry.color}
                        onChange={e => onLightChange(entry.id, { color: e.target.value })}
                        className="nodrag nopan w-8 h-6 cursor-pointer rounded bg-transparent border border-neutral-700" />
                    </div>
                    <label className="flex items-center gap-2">
                      <span className="text-[9px] text-neutral-500 shrink-0 w-12">Intensity</span>
                      <input type="range" min={0} max={100} step={0.5}
                        value={entry.intensity}
                        onChange={e => onLightChange(entry.id, { intensity: parseFloat(e.target.value) })}
                        className="nodrag nopan flex-1 accent-yellow-500" />
                      <span className="text-[9px] text-neutral-400 w-8">{entry.intensity.toFixed(1)}</span>
                    </label>
                    <XyzRow label="Position" value={entry.position}
                      onChange={pos => onLightChange(entry.id, { position: pos })} />

                    {entry.type === "spot" && (
                      <>
                        <div className="flex gap-1">
                          <button
                            onClick={() => onSelectLight(entry.id)}
                            className={`flex-1 text-[9px] py-1 rounded transition-colors ${selectedId === entry.id && selectedSpotTargetId !== entry.id ? "bg-indigo-600 text-white" : "bg-neutral-700 text-neutral-300 hover:bg-neutral-600"}`}
                          >
                            Move Light
                          </button>
                          <button
                            onClick={() => onSelectSpotTarget(entry.id)}
                            className={`flex-1 text-[9px] py-1 rounded transition-colors ${selectedSpotTargetId === entry.id ? "bg-amber-600 text-white" : "bg-neutral-700 text-neutral-300 hover:bg-neutral-600"}`}
                          >
                            Move Target
                          </button>
                        </div>
                        <label className="flex items-center gap-2 cursor-pointer">
                          <input type="checkbox" checked={entry.lockTarget}
                            onChange={e => onLightChange(entry.id, { lockTarget: e.target.checked })}
                            className="nodrag nopan accent-indigo-500" />
                          <span className="text-[9px] text-neutral-400">Move light + target together</span>
                        </label>
                        <XyzRow label="Target" value={entry.targetPosition}
                          onChange={t => onLightChange(entry.id, { targetPosition: t })} />
                        <label className="flex items-center gap-2">
                          <span className="text-[9px] text-neutral-500 shrink-0 w-12">Angle°</span>
                          <input type="range" min={1} max={89} step={1}
                            value={Math.round((entry.angle * 180) / Math.PI)}
                            onChange={e => onLightChange(entry.id, { angle: (parseInt(e.target.value) * Math.PI) / 180 })}
                            className="nodrag nopan flex-1 accent-yellow-500" />
                          <span className="text-[9px] text-neutral-400 w-6">{Math.round((entry.angle * 180) / Math.PI)}°</span>
                        </label>
                        <label className="flex items-center gap-2">
                          <span className="text-[9px] text-neutral-500 shrink-0 w-12">Penumbra</span>
                          <input type="range" min={0} max={1} step={0.05}
                            value={entry.penumbra}
                            onChange={e => onLightChange(entry.id, { penumbra: parseFloat(e.target.value) })}
                            className="nodrag nopan flex-1 accent-yellow-500" />
                          <span className="text-[9px] text-neutral-400 w-8">{entry.penumbra.toFixed(2)}</span>
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

        {/* ── IBL tab ── */}
        {tab === "ibl" && (
          <>
            {iblEntries.length === 0 && (
              <p className="text-[10px] text-neutral-600 text-center py-4">No IBLs yet.<br />Capture from mesh or camera.</p>
            )}
            {iblEntries.map(entry => (
              <div key={entry.id} className="rounded border border-neutral-700">
                <div className="flex items-center gap-1.5 p-1.5">
                  <button onClick={() => onIblChange(entry.id, { visible: !entry.visible })} className="text-neutral-500 hover:text-white shrink-0">
                    {entry.visible ? <EyeOnIcon /> : <EyeOffIcon />}
                  </button>
                  <span className="flex-1 text-[10px] text-neutral-200 truncate">{entry.name}</span>
                  <button onClick={() => setExpandedId(expandedId === entry.id ? null : entry.id)} className="text-neutral-500 hover:text-white shrink-0">
                    <ChevronIcon open={expandedId === entry.id} />
                  </button>
                  <button onClick={() => onRemoveIbl(entry.id)} className="text-neutral-500 hover:text-red-400 shrink-0">
                    <XIcon />
                  </button>
                </div>
                {expandedId === entry.id && (
                  <div className="border-t border-neutral-700 p-2 space-y-2">
                    <XyzRow label="Position" value={entry.position}
                      onChange={pos => onIblChange(entry.id, { position: pos })} />
                    <label className="flex items-center gap-2">
                      <span className="text-[9px] text-neutral-500 shrink-0 w-10">Radius</span>
                      <input type="range" min={0} max={50} step={0.5}
                        value={entry.radius}
                        onChange={e => onIblChange(entry.id, { radius: parseFloat(e.target.value) })}
                        className="nodrag nopan flex-1 accent-teal-500" />
                      <span className="text-[9px] text-neutral-400 w-8">{entry.radius === 0 ? "∞" : entry.radius.toFixed(1)}</span>
                    </label>
                    {entry.radius > 0 && (
                      <label className="flex items-center gap-2">
                        <span className="text-[9px] text-neutral-500 shrink-0 w-10">Ramp</span>
                        <input type="range" min={0} max={1} step={0.05}
                          value={entry.ramp}
                          onChange={e => onIblChange(entry.id, { ramp: parseFloat(e.target.value) })}
                          className="nodrag nopan flex-1 accent-teal-500" />
                        <span className="text-[9px] text-neutral-400 w-8">{entry.ramp.toFixed(2)}</span>
                      </label>
                    )}
                    <label className="flex items-center gap-2">
                      <span className="text-[9px] text-neutral-500 shrink-0 w-10">Intensity</span>
                      <input type="range" min={0} max={5} step={0.05}
                        value={entry.intensity}
                        onChange={e => onIblChange(entry.id, { intensity: parseFloat(e.target.value) })}
                        className="nodrag nopan flex-1 accent-teal-500" />
                      <span className="text-[9px] text-neutral-400 w-8">{entry.intensity.toFixed(2)}</span>
                    </label>

                    {/* Color grading — single sliders, negative-capable */}
                    <div className="pt-1 border-t border-neutral-700 space-y-2">
                      <span className="text-[9px] text-neutral-500 uppercase block">Color Grade (HDR)</span>
                      <SliderRow label="Lift" value={entry.lift} onChange={v => onIblChange(entry.id, { lift: v })} min={-2} max={2} step={0.01} />
                      <SliderRow label="Gain" value={entry.gain} onChange={v => onIblChange(entry.id, { gain: v })} min={-2} max={10} step={0.05} />
                      <SliderRow label="Gamma" value={entry.gamma} onChange={v => onIblChange(entry.id, { gamma: v })} min={0.1} max={5} step={0.05} />
                    </div>
                  </div>
                )}
              </div>
            ))}
          </>
        )}
      </div>

      {/* Footer */}
      {tab === "meshes" && (
        <button onClick={onAddMesh}
          className="w-full text-[10px] bg-neutral-700 hover:bg-neutral-600 text-neutral-200 rounded px-2 py-1.5 transition-colors">
          + Add Mesh (.glb / .obj)
        </button>
      )}
      {tab === "lights" && (
        <div className="flex gap-1">
          <button onClick={() => onAddLight("point")} className="flex-1 text-[10px] bg-neutral-700 hover:bg-neutral-600 text-neutral-200 rounded px-1 py-1.5 transition-colors">Point</button>
          <button onClick={() => onAddLight("spot")} className="flex-1 text-[10px] bg-neutral-700 hover:bg-neutral-600 text-neutral-200 rounded px-1 py-1.5 transition-colors">Spot</button>
          <button onClick={() => onAddLight("rect")} className="flex-1 text-[10px] bg-neutral-700 hover:bg-neutral-600 text-neutral-200 rounded px-1 py-1.5 transition-colors">Rect</button>
        </div>
      )}
      {tab === "ibl" && (
        <button onClick={onCaptureIblAtCamera}
          className="w-full text-[10px] bg-teal-800 hover:bg-teal-700 text-neutral-200 rounded px-2 py-1.5 transition-colors"
          title="Capture 360 IBL from current camera position">
          + Capture IBL at Camera
        </button>
      )}
    </div>
  );
}
