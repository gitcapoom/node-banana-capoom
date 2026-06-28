import { describe, it, expect } from "vitest";
import * as THREE from "three";
import {
  interpolateScene,
  evaluateSceneAtFrame,
  serializePath,
  deserializePath,
  type SceneSnapshot,
  type CameraPath,
} from "../cameraAnimation";

const xform = (px: number, sx: number) => ({
  position: { x: px, y: 0, z: 0 },
  rotation: { x: 0, y: 0, z: 0 },
  scale: { x: sx, y: sx, z: sx },
});

const snapA: SceneSnapshot = {
  splatTransform: xform(0, 1),
  meshes: [{ id: "m1", transform: { position: { x: 0, y: 0, z: 0 }, rotation: { x: 0, y: 0, z: 0 }, scale: 1 }, visible: true }],
  lights: [{ id: "l1", type: "point", visible: true, color: "#000000", intensity: 0, position: { x: 0, y: 0, z: 0 } }],
  orbitTarget: [0, 0, 0],
};
const snapB: SceneSnapshot = {
  splatTransform: xform(10, 3),
  meshes: [{ id: "m1", transform: { position: { x: 4, y: 0, z: 0 }, rotation: { x: 0, y: 0, z: 0 }, scale: 5 }, visible: false }],
  lights: [{ id: "l1", type: "point", visible: true, color: "#ffffff", intensity: 10, position: { x: 2, y: 0, z: 0 } }],
  orbitTarget: [8, 0, 0],
};

describe("interpolateScene", () => {
  it("lerps numbers at the midpoint", () => {
    const m = interpolateScene(snapA, snapB, 0.5);
    expect((m.splatTransform as ReturnType<typeof xform>).position.x).toBeCloseTo(5);
    expect((m.splatTransform as ReturnType<typeof xform>).scale.x).toBeCloseTo(2);
    expect(m.orbitTarget?.[0]).toBeCloseTo(4);
    expect(m.meshes?.[0].transform).toMatchObject({ scale: 3 });
    expect((m.lights?.[0] as unknown as { intensity: number }).intensity).toBeCloseTo(5);
  });

  it("steps booleans — visibility holds the start value until the end", () => {
    expect(interpolateScene(snapA, snapB, 0.5).meshes?.[0].visible).toBe(true);
    expect(interpolateScene(snapA, snapB, 0.99).meshes?.[0].visible).toBe(true);
    expect(interpolateScene(snapA, snapB, 1).meshes?.[0].visible).toBe(false);
  });

  it("blends hex colors per channel", () => {
    const mid = interpolateScene(snapA, snapB, 0.5).lights?.[0] as unknown as { color: string };
    expect(mid.color.toLowerCase()).toBe("#808080");
  });

  it("matches entities by id, holding entities present in only one side", () => {
    const a: SceneSnapshot = { meshes: [{ id: "a", transform: { scale: 1 }, visible: true }] };
    const b: SceneSnapshot = { meshes: [{ id: "b", transform: { scale: 2 }, visible: true }] };
    const out = interpolateScene(a, b, 0.5).meshes!;
    expect(out.map((m) => m.id).sort()).toEqual(["a", "b"]);
  });
});

describe("evaluateSceneAtFrame", () => {
  const kf = (time: number, scene?: SceneSnapshot) => ({
    time,
    position: new THREE.Vector3(),
    quaternion: new THREE.Quaternion(),
    fov: 50,
    interpolation: "linear" as const,
    scene,
  });

  it("returns null when no keyframe carries scene data", () => {
    const path: CameraPath = { keyframes: [kf(0), kf(1)], durationFrames: 11, fps: 25 };
    expect(evaluateSceneAtFrame(path, 5)).toBeNull();
  });

  it("clamps at the ends and interpolates in the middle", () => {
    const path: CameraPath = { keyframes: [kf(0, snapA), kf(1, snapB)], durationFrames: 11, fps: 25 };
    expect((evaluateSceneAtFrame(path, 0)!.splatTransform as ReturnType<typeof xform>).position.x).toBeCloseTo(0);
    expect((evaluateSceneAtFrame(path, 10)!.splatTransform as ReturnType<typeof xform>).position.x).toBeCloseTo(10);
    expect((evaluateSceneAtFrame(path, 5)!.splatTransform as ReturnType<typeof xform>).position.x).toBeCloseTo(5);
  });
});

describe("serialize/deserialize round-trip", () => {
  it("preserves scene snapshots and reconstructs THREE vectors (incl. legacy object form)", () => {
    const path: CameraPath = {
      keyframes: [
        { time: 0, position: new THREE.Vector3(1, 2, 3), quaternion: new THREE.Quaternion(0, 0, 0, 1), fov: 50, scene: snapA },
      ],
      durationFrames: 11,
      fps: 25,
    };
    const round = deserializePath(JSON.parse(JSON.stringify(serializePath(path))));
    expect(round.keyframes[0].position).toBeInstanceOf(THREE.Vector3);
    expect(round.keyframes[0].position.x).toBe(1);
    expect(round.keyframes[0].scene?.splatTransform).toBeDefined();

    // Legacy form: position/quaternion stored as flattened {x,y,z} objects.
    const legacy = {
      keyframes: [{ time: 0, position: { x: 5, y: 6, z: 7 }, quaternion: { x: 0, y: 0, z: 0, w: 1 }, fov: 50 }],
      durationFrames: 11,
      fps: 25,
    };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const fromLegacy = deserializePath(legacy as any);
    expect(fromLegacy.keyframes[0].position).toBeInstanceOf(THREE.Vector3);
    expect(fromLegacy.keyframes[0].position.y).toBe(6);
  });
});
