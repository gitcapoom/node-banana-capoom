import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import { MediaResolutionBadge } from "@/components/nodes/MediaResolutionBadge";

const mockGetMediaDimensions = vi.fn();
vi.mock("@/utils/nodeDimensions", () => ({
  getMediaDimensions: (url: string) => mockGetMediaDimensions(url),
}));

describe("MediaResolutionBadge", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetMediaDimensions.mockResolvedValue(null);
  });

  it("prefers stored dimensions over measuring — a reloaded node only has a thumb", async () => {
    render(
      <MediaResolutionBadge
        media="data:image/jpeg;base64,THUMB"
        storedDims={{ width: 3840, height: 2160 }}
      />
    );

    expect(await screen.findByText("3840 × 2160")).toBeTruthy();
    // Measuring the thumbnail would have reported the wrong number.
    expect(mockGetMediaDimensions).not.toHaveBeenCalled();
  });

  it("measures the media when no dimensions were stored", async () => {
    mockGetMediaDimensions.mockResolvedValue({ width: 1920, height: 1080 });

    render(<MediaResolutionBadge media="data:image/png;base64,FULL" />);

    expect(await screen.findByText("1920 × 1080")).toBeTruthy();
  });

  it("stays silent when the media is a thumbnail and nothing was stored", async () => {
    // Measuring would report the THUMBNAIL's size as the image's resolution.
    mockGetMediaDimensions.mockResolvedValue({ width: 256, height: 144 });

    const { container } = render(
      <MediaResolutionBadge media="data:image/jpeg;base64,THUMB" mediaIsThumb />
    );

    await waitFor(() => expect(mockGetMediaDimensions).toHaveBeenCalled());
    expect(container.textContent).toBe("");
  });

  it("reports a thumbnail's SOURCE size when it was recorded", async () => {
    render(
      <MediaResolutionBadge
        media="data:image/jpeg;base64,THUMB"
        mediaIsThumb
        storedDims={{ width: 2048, height: 1152 }}
      />
    );

    expect(await screen.findByText("2048 × 1152")).toBeTruthy();
  });

  it("renders nothing without media", () => {
    const { container } = render(<MediaResolutionBadge media={null} />);
    expect(container.firstChild).toBeNull();
  });
});
