/**
 * Reading a user-picked camera.json file (client-side).
 *
 * SALACAK per-camera camera.json holds `{ camera_name, focal_length (mm),
 * aperture (mm), … }`. The image2GS node and Gaussian Splat Viewer node let the
 * user load one directly (file picker / drop) to seed Focal/Aperture (Lens/
 * Sensor) — no server round-trip, no project-structure assumptions.
 */

export interface CameraJsonValues {
  name: string | null;
  focal: number | null; // focal_length (mm)
  aperture: number | null; // aperture (mm)
}

/** Parse a picked camera.json File → its name/focal/aperture (nulls if absent/invalid). */
export function readCameraJsonFile(file: File): Promise<CameraJsonValues | null> {
  return new Promise((resolve) => {
    const r = new FileReader();
    r.onload = () => {
      try {
        const j = JSON.parse(r.result as string);
        resolve({
          name: typeof j.camera_name === "string" ? j.camera_name : null,
          focal: typeof j.focal_length === "number" ? j.focal_length : null,
          aperture: typeof j.aperture === "number" ? j.aperture : null,
        });
      } catch {
        resolve(null);
      }
    };
    r.onerror = () => resolve(null);
    r.readAsText(file);
  });
}
