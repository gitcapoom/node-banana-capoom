import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { NextRequest } from "next/server";

// Use vi.hoisted to define mocks that work with hoisted vi.mock
const { mockGenerateContent, MockGoogleGenAI, mockGoogleGenAIInstance } = vi.hoisted(() => {
  const mockGenerateContent = vi.fn();
  const mockGoogleGenAIInstance = {
    models: {
      generateContent: mockGenerateContent,
    },
  };
  // Use a class to properly support `new` keyword
  class MockGoogleGenAI {
    apiKey: string;
    models = mockGoogleGenAIInstance.models;

    constructor(config: { apiKey: string }) {
      this.apiKey = config.apiKey;
      // Track calls to constructor
      MockGoogleGenAI.lastCalledWith = config;
      MockGoogleGenAI.callCount++;
    }

    static lastCalledWith: { apiKey: string } | null = null;
    static callCount = 0;
    static reset() {
      MockGoogleGenAI.lastCalledWith = null;
      MockGoogleGenAI.callCount = 0;
    }
  }
  return { mockGenerateContent, MockGoogleGenAI, mockGoogleGenAIInstance };
});

vi.mock("@google/genai", () => ({
  GoogleGenAI: MockGoogleGenAI,
}));

// Image helpers are mocked so the many-image DECISION can be observed without
// running sharp on real pixels. compressImage passes through; capLongEdge
// records the max edge it was asked for.
const { mockCapLongEdge } = vi.hoisted(() => ({ mockCapLongEdge: vi.fn() }));
vi.mock("@/app/api/generate/utils/imageCompression", () => ({
  compressImage: vi.fn(async (s: string) => s),
  capLongEdge: mockCapLongEdge.mockImplementation(async (s: string) => s),
}));

// Mock logger to avoid console noise during tests
vi.mock("@/utils/logger", () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

import { POST } from "../route";

// Store original env and fetch
const originalEnv = { ...process.env };
const originalFetch = global.fetch;

// Mock fetch for OpenAI API
const mockFetch = vi.fn();

// Helper to create mock NextRequest for POST
function createMockPostRequest(
  body: unknown,
  headers?: Record<string, string>
): NextRequest {
  return {
    json: vi.fn().mockResolvedValue(body),
    headers: new Headers(headers),
  } as unknown as NextRequest;
}

describe("/api/llm route", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    MockGoogleGenAI.reset();
    // Reset env to original
    process.env = { ...originalEnv };
  });

  afterEach(() => {
    process.env = originalEnv;
    global.fetch = originalFetch;
  });

  describe("Google provider", () => {
    it("should generate text successfully with Google/Gemini", async () => {
      process.env.GEMINI_API_KEY = "test-gemini-key";

      mockGenerateContent.mockResolvedValueOnce({
        text: "Generated response from Gemini",
      });

      const request = createMockPostRequest({
        prompt: "Test prompt",
        provider: "google",
        model: "gemini-2.5-flash",
        temperature: 0.7,
        maxTokens: 1024,
      });

      const response = await POST(request);
      const data = await response.json();

      expect(response.status).toBe(200);
      expect(data.success).toBe(true);
      expect(data.text).toBe("Generated response from Gemini");
      expect(mockGenerateContent).toHaveBeenCalledWith({
        model: "gemini-2.5-flash",
        contents: [{ role: "user", parts: [{ text: "Test prompt" }] }],
        config: {
          temperature: 0.7,
          maxOutputTokens: 1024,
        },
      });
    });

    it("should handle multimodal input (images + prompt)", async () => {
      process.env.GEMINI_API_KEY = "test-gemini-key";

      mockGenerateContent.mockResolvedValueOnce({
        text: "Description of the image",
      });

      const request = createMockPostRequest({
        prompt: "Describe this image",
        images: ["data:image/png;base64,iVBORw0KGgo="],
        provider: "google",
        model: "gemini-2.5-flash",
        temperature: 0.7,
        maxTokens: 1024,
      });

      const response = await POST(request);
      const data = await response.json();

      expect(response.status).toBe(200);
      expect(data.success).toBe(true);
      expect(data.text).toBe("Description of the image");

      // Verify multimodal content structure
      expect(mockGenerateContent).toHaveBeenCalledWith({
        model: "gemini-2.5-flash",
        contents: [
          {
            role: "user",
            parts: [
              {
                inlineData: {
                  mimeType: "image/png",
                  data: "iVBORw0KGgo=",
                },
              },
              { text: "Describe this image" },
            ],
          },
        ],
        config: {
          temperature: 0.7,
          maxOutputTokens: 1024,
        },
      });
    });

    it("should reject missing prompt", async () => {
      process.env.GEMINI_API_KEY = "test-gemini-key";

      const request = createMockPostRequest({
        provider: "google",
        model: "gemini-2.5-flash",
      });

      const response = await POST(request);
      const data = await response.json();

      expect(response.status).toBe(400);
      expect(data.success).toBe(false);
      expect(data.error).toBe("Prompt or messages are required");
    });

    it("should reject missing API key (no env var, no header)", async () => {
      delete process.env.GEMINI_API_KEY;

      const request = createMockPostRequest({
        prompt: "Test prompt",
        provider: "google",
        model: "gemini-2.5-flash",
      });

      const response = await POST(request);
      const data = await response.json();

      expect(response.status).toBe(500);
      expect(data.success).toBe(false);
      expect(data.error).toContain("GEMINI_API_KEY not configured");
    });

    it("should use X-Gemini-API-Key header over env var", async () => {
      process.env.GEMINI_API_KEY = "env-gemini-key";

      mockGenerateContent.mockResolvedValueOnce({
        text: "Response with header key",
      });

      const request = createMockPostRequest(
        {
          prompt: "Test prompt",
          provider: "google",
          model: "gemini-2.5-flash",
        },
        { "X-Gemini-API-Key": "header-gemini-key" }
      );

      const response = await POST(request);
      const data = await response.json();

      expect(response.status).toBe(200);
      expect(data.success).toBe(true);

      // Verify GoogleGenAI was called with header key (takes precedence)
      expect(MockGoogleGenAI.lastCalledWith).toEqual({ apiKey: "header-gemini-key" });
    });

    it("should return 429 on rate limit errors", async () => {
      process.env.GEMINI_API_KEY = "test-gemini-key";

      mockGenerateContent.mockRejectedValueOnce(
        new Error("429 Resource exhausted")
      );

      const request = createMockPostRequest({
        prompt: "Test prompt",
        provider: "google",
        model: "gemini-2.5-flash",
      });

      const response = await POST(request);
      const data = await response.json();

      expect(response.status).toBe(429);
      expect(data.success).toBe(false);
      expect(data.error).toBe("Rate limit reached. Please wait and try again.");
    });

    it("should return 500 on API errors", async () => {
      process.env.GEMINI_API_KEY = "test-gemini-key";

      mockGenerateContent.mockRejectedValueOnce(
        new Error("Internal server error")
      );

      const request = createMockPostRequest({
        prompt: "Test prompt",
        provider: "google",
        model: "gemini-2.5-flash",
      });

      const response = await POST(request);
      const data = await response.json();

      expect(response.status).toBe(500);
      expect(data.success).toBe(false);
      expect(data.error).toBe("Internal server error");
    });

    it("should handle no text in Google AI response", async () => {
      process.env.GEMINI_API_KEY = "test-gemini-key";

      mockGenerateContent.mockResolvedValueOnce({
        text: null,
      });

      const request = createMockPostRequest({
        prompt: "Test prompt",
        provider: "google",
        model: "gemini-2.5-flash",
      });

      const response = await POST(request);
      const data = await response.json();

      expect(response.status).toBe(500);
      expect(data.success).toBe(false);
      expect(data.error).toBe("No text in Google AI response");
    });

    it("should filter out image without data URL prefix", async () => {
      process.env.GEMINI_API_KEY = "test-gemini-key";

      mockGenerateContent.mockResolvedValueOnce({
        text: "Image description",
      });

      const request = createMockPostRequest({
        prompt: "Describe this",
        images: ["iVBORw0KGgoAAAANSUhEUgAAAAUA"], // raw base64, no prefix
        provider: "google",
        model: "gemini-2.5-flash",
      });

      const response = await POST(request);
      const data = await response.json();

      expect(response.status).toBe(200);
      expect(data.success).toBe(true);

      // Raw base64 without a data URL prefix fails the image-URL validity
      // check, so the request goes through as text-only.
      expect(mockGenerateContent).toHaveBeenCalledWith({
        model: "gemini-2.5-flash",
        contents: [{ role: "user", parts: [{ text: "Describe this" }] }],
        config: {
          temperature: 0.7,
          maxOutputTokens: 4096,
        },
      });
    });
  });

  describe("OpenAI provider", () => {
    beforeEach(() => {
      global.fetch = mockFetch;
    });

    it("omits temperature for a model that does not accept one", async () => {
      // The reasoning models reject any explicit temperature but the default:
      // "Unsupported value: 'temperature' does not support 0.7 with this model.
      // Only the default (1) value is supported."
      //
      // The node already hides the control for these — allowedParameterNames'
      // family rule for /^o\d/ excludes it — but the route used to substitute a
      // 0.7 default anyway, so the request carried a value the user could not
      // see or change, and every call failed.
      process.env.OPENAI_API_KEY = "test-openai-key";

      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ choices: [{ message: { content: "ok" } }] }),
      });

      const request = createMockPostRequest({
        prompt: "Test prompt",
        provider: "openai",
        model: "o3",
        // Explicitly supplied, and must STILL be dropped: the model's own
        // schema is the authority, not the caller.
        temperature: 0.7,
        maxTokens: 1024,
      });

      const response = await POST(request);
      expect(response.status).toBe(200);

      const body = JSON.parse((mockFetch.mock.calls[0][1] as { body: string }).body);
      expect("temperature" in body).toBe(false);
      // The rest of the request is unaffected.
      expect(body.model).toBe("o3");
      expect(body.max_completion_tokens).toBe(1024);
    });

    it("still sends temperature for a model that accepts one", async () => {
      // The other half of the guard: the fix must not strip temperature from
      // the models that were working.
      process.env.OPENAI_API_KEY = "test-openai-key";

      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ choices: [{ message: { content: "ok" } }] }),
      });

      const request = createMockPostRequest({
        prompt: "Test prompt",
        provider: "openai",
        model: "gpt-4.1-mini",
        temperature: 0.3,
        maxTokens: 1024,
      });

      await POST(request);
      const body = JSON.parse((mockFetch.mock.calls[0][1] as { body: string }).body);
      expect(body.temperature).toBe(0.3);
    });

    it("should generate text successfully with OpenAI", async () => {
      process.env.OPENAI_API_KEY = "test-openai-key";

      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () =>
          Promise.resolve({
            choices: [{ message: { content: "OpenAI response text" } }],
          }),
      });

      const request = createMockPostRequest({
        prompt: "Test prompt",
        provider: "openai",
        model: "gpt-4.1-mini",
        temperature: 0.7,
        maxTokens: 1024,
      });

      const response = await POST(request);
      const data = await response.json();

      expect(response.status).toBe(200);
      expect(data.success).toBe(true);
      expect(data.text).toBe("OpenAI response text");

      // Verify fetch was called with correct parameters
      expect(mockFetch).toHaveBeenCalledWith(
        "https://api.openai.com/v1/chat/completions",
        expect.objectContaining({
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: "Bearer test-openai-key",
          },
          body: JSON.stringify({
            model: "gpt-4.1-mini",
            messages: [{ role: "user", content: "Test prompt" }],
            temperature: 0.7,
            max_completion_tokens: 1024,
          }),
        })
      );
    });

    it("should handle vision input (images + prompt)", async () => {
      process.env.OPENAI_API_KEY = "test-openai-key";

      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () =>
          Promise.resolve({
            choices: [{ message: { content: "Image description from OpenAI" } }],
          }),
      });

      const request = createMockPostRequest({
        prompt: "Describe this image",
        images: ["data:image/png;base64,iVBORw0KGgo="],
        provider: "openai",
        model: "gpt-4.1-mini",
        temperature: 0.7,
        maxTokens: 1024,
      });

      const response = await POST(request);
      const data = await response.json();

      expect(response.status).toBe(200);
      expect(data.success).toBe(true);
      expect(data.text).toBe("Image description from OpenAI");

      // Verify fetch was called with vision content structure
      expect(mockFetch).toHaveBeenCalledWith(
        "https://api.openai.com/v1/chat/completions",
        expect.objectContaining({
          method: "POST",
          body: JSON.stringify({
            model: "gpt-4.1-mini",
            messages: [
              {
                role: "user",
                content: [
                  { type: "text", text: "Describe this image" },
                  { type: "image_url", image_url: { url: "data:image/png;base64,iVBORw0KGgo=", detail: "high" } },
                ],
              },
            ],
            temperature: 0.7,
            max_completion_tokens: 1024,
          }),
        })
      );
    });

    it("should reject unknown provider", async () => {
      const request = createMockPostRequest({
        prompt: "Test prompt",
        provider: "unknown-provider",
        model: "some-model",
      });

      const response = await POST(request);
      const data = await response.json();

      expect(response.status).toBe(400);
      expect(data.success).toBe(false);
      expect(data.error).toBe("Unknown provider: unknown-provider");
    });

    it("should reject missing OpenAI API key", async () => {
      delete process.env.OPENAI_API_KEY;

      const request = createMockPostRequest({
        prompt: "Test prompt",
        provider: "openai",
        model: "gpt-4.1-mini",
      });

      const response = await POST(request);
      const data = await response.json();

      expect(response.status).toBe(500);
      expect(data.success).toBe(false);
      expect(data.error).toContain("OPENAI_API_KEY not configured");
    });

    it("should use X-OpenAI-API-Key header over env var", async () => {
      process.env.OPENAI_API_KEY = "env-openai-key";

      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () =>
          Promise.resolve({
            choices: [{ message: { content: "Response with header key" } }],
          }),
      });

      const request = createMockPostRequest(
        {
          prompt: "Test prompt",
          provider: "openai",
          model: "gpt-4.1-mini",
        },
        { "X-OpenAI-API-Key": "header-openai-key" }
      );

      const response = await POST(request);
      const data = await response.json();

      expect(response.status).toBe(200);
      expect(data.success).toBe(true);

      // Verify fetch was called with header key (takes precedence)
      expect(mockFetch).toHaveBeenCalledWith(
        "https://api.openai.com/v1/chat/completions",
        expect.objectContaining({
          headers: {
            "Content-Type": "application/json",
            Authorization: "Bearer header-openai-key",
          },
        })
      );
    });

    it("should return 429 on rate limit errors", async () => {
      process.env.OPENAI_API_KEY = "test-openai-key";

      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 429,
        json: () =>
          Promise.resolve({
            error: { message: "429 Rate limit exceeded" },
          }),
      });

      const request = createMockPostRequest({
        prompt: "Test prompt",
        provider: "openai",
        model: "gpt-4.1-mini",
      });

      const response = await POST(request);
      const data = await response.json();

      expect(response.status).toBe(429);
      expect(data.success).toBe(false);
      expect(data.error).toBe("Rate limit reached. Please wait and try again.");
    });

    it("should handle OpenAI API error responses", async () => {
      process.env.OPENAI_API_KEY = "test-openai-key";

      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 401,
        json: () =>
          Promise.resolve({
            error: { message: "Invalid API key" },
          }),
      });

      const request = createMockPostRequest({
        prompt: "Test prompt",
        provider: "openai",
        model: "gpt-4.1-mini",
      });

      const response = await POST(request);
      const data = await response.json();

      expect(response.status).toBe(500);
      expect(data.success).toBe(false);
      expect(data.error).toBe("Invalid API key");
    });

    it("should handle OpenAI API error without message", async () => {
      process.env.OPENAI_API_KEY = "test-openai-key";

      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 500,
        json: () => Promise.resolve({}),
      });

      const request = createMockPostRequest({
        prompt: "Test prompt",
        provider: "openai",
        model: "gpt-4.1-mini",
      });

      const response = await POST(request);
      const data = await response.json();

      expect(response.status).toBe(500);
      expect(data.success).toBe(false);
      expect(data.error).toBe("OpenAI API error: 500");
    });

    it("should handle no text in OpenAI response", async () => {
      process.env.OPENAI_API_KEY = "test-openai-key";

      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () =>
          Promise.resolve({
            choices: [{ message: { content: null } }],
          }),
      });

      const request = createMockPostRequest({
        prompt: "Test prompt",
        provider: "openai",
        model: "gpt-4.1-mini",
      });

      const response = await POST(request);
      const data = await response.json();

      expect(response.status).toBe(500);
      expect(data.success).toBe(false);
      expect(data.error).toBe("No text in OpenAI response");
    });
  });

  describe("Anthropic provider", () => {
    beforeEach(() => {
      global.fetch = mockFetch;
    });

    it("should generate text successfully with Anthropic", async () => {
      process.env.ANTHROPIC_API_KEY = "test-anthropic-key";

      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () =>
          Promise.resolve({
            content: [{ type: "text", text: "Anthropic response text" }],
          }),
      });

      const request = createMockPostRequest({
        prompt: "Test prompt",
        provider: "anthropic",
        model: "claude-sonnet-4.5",
        temperature: 0.7,
        maxTokens: 1024,
      });

      const response = await POST(request);
      const data = await response.json();

      expect(response.status).toBe(200);
      expect(data.success).toBe(true);
      expect(data.text).toBe("Anthropic response text");

      // Verify fetch was called with correct parameters
      expect(mockFetch).toHaveBeenCalledWith(
        "https://api.anthropic.com/v1/messages",
        expect.objectContaining({
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "x-api-key": "test-anthropic-key",
            "anthropic-version": "2023-06-01",
          },
          body: JSON.stringify({
            model: "claude-sonnet-4-5-20250929",
            messages: [{ role: "user", content: "Test prompt" }],
            temperature: 0.7,
            max_tokens: 1024,
          }),
        })
      );
    });

    it("should handle multimodal input with Anthropic content block structure", async () => {
      process.env.ANTHROPIC_API_KEY = "test-anthropic-key";

      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () =>
          Promise.resolve({
            content: [{ type: "text", text: "Image description from Claude" }],
          }),
      });

      const request = createMockPostRequest({
        prompt: "Describe this image",
        images: ["data:image/png;base64,iVBORw0KGgo="],
        provider: "anthropic",
        model: "claude-sonnet-4.5",
        temperature: 0.7,
        maxTokens: 1024,
      });

      const response = await POST(request);
      const data = await response.json();

      expect(response.status).toBe(200);
      expect(data.success).toBe(true);
      expect(data.text).toBe("Image description from Claude");

      // Verify Anthropic content block structure
      expect(mockFetch).toHaveBeenCalledWith(
        "https://api.anthropic.com/v1/messages",
        expect.objectContaining({
          body: JSON.stringify({
            model: "claude-sonnet-4-5-20250929",
            messages: [
              {
                role: "user",
                content: [
                  {
                    type: "image",
                    source: { type: "base64", media_type: "image/png", data: "iVBORw0KGgo=" },
                  },
                  { type: "text", text: "Describe this image" },
                ],
              },
            ],
            temperature: 0.7,
            max_tokens: 1024,
          }),
        })
      );
    });

    it("should use adaptive thinking + effort on current Claude models (no budget_tokens)", async () => {
      process.env.ANTHROPIC_API_KEY = "test-anthropic-key";

      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () =>
          Promise.resolve({
            content: [
              { type: "thinking", thinking: "" },
              { type: "text", text: "Thought about it" },
            ],
          }),
      });

      const request = createMockPostRequest({
        prompt: "Hard question",
        provider: "anthropic",
        model: "claude-opus-4-6",
        temperature: 0.7,
        maxTokens: 1024,
        reasoning: "high",
      });

      const response = await POST(request);
      const data = await response.json();

      expect(response.status).toBe(200);
      expect(data.text).toBe("Thought about it");
      // Adaptive shape: thinking {type: adaptive} + output_config.effort,
      // temperature omitted, max_tokens bumped for thinking headroom.
      expect(mockFetch).toHaveBeenCalledWith(
        "https://api.anthropic.com/v1/messages",
        expect.objectContaining({
          body: JSON.stringify({
            model: "claude-opus-4-6",
            messages: [{ role: "user", content: "Hard question" }],
            max_tokens: 17408,
            thinking: { type: "adaptive" },
            output_config: { effort: "high" },
          }),
        })
      );
    });

    it("should keep budget_tokens thinking on pre-adaptive Claude models", async () => {
      process.env.ANTHROPIC_API_KEY = "test-anthropic-key";

      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () =>
          Promise.resolve({ content: [{ type: "text", text: "ok" }] }),
      });

      const request = createMockPostRequest({
        prompt: "Question",
        provider: "anthropic",
        model: "claude-sonnet-4.5",
        temperature: 0.7,
        maxTokens: 1024,
        reasoning: "medium",
      });

      await POST(request);

      expect(mockFetch).toHaveBeenCalledWith(
        "https://api.anthropic.com/v1/messages",
        expect.objectContaining({
          body: JSON.stringify({
            model: "claude-sonnet-4-5-20250929",
            messages: [{ role: "user", content: "Question" }],
            max_tokens: 9216,
            thinking: { type: "enabled", budget_tokens: 8192 },
          }),
        })
      );
    });

    it("should omit temperature for 5-tier Claude models even with reasoning off", async () => {
      process.env.ANTHROPIC_API_KEY = "test-anthropic-key";

      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () =>
          Promise.resolve({ content: [{ type: "text", text: "ok" }] }),
      });

      const request = createMockPostRequest({
        prompt: "Question",
        provider: "anthropic",
        model: "claude-sonnet-5",
        temperature: 0.7,
        maxTokens: 1024,
        reasoning: "off",
      });

      await POST(request);

      expect(mockFetch).toHaveBeenCalledWith(
        "https://api.anthropic.com/v1/messages",
        expect.objectContaining({
          body: JSON.stringify({
            model: "claude-sonnet-5",
            messages: [{ role: "user", content: "Question" }],
            max_tokens: 1024,
          }),
        })
      );
    });

    it("should reject missing Anthropic API key", async () => {
      delete process.env.ANTHROPIC_API_KEY;

      const request = createMockPostRequest({
        prompt: "Test prompt",
        provider: "anthropic",
        model: "claude-sonnet-4.5",
      });

      const response = await POST(request);
      const data = await response.json();

      expect(response.status).toBe(500);
      expect(data.success).toBe(false);
      expect(data.error).toContain("ANTHROPIC_API_KEY not configured");
    });

    it("should use X-Anthropic-API-Key header over env var", async () => {
      process.env.ANTHROPIC_API_KEY = "env-anthropic-key";

      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () =>
          Promise.resolve({
            content: [{ type: "text", text: "Response with header key" }],
          }),
      });

      const request = createMockPostRequest(
        {
          prompt: "Test prompt",
          provider: "anthropic",
          model: "claude-sonnet-4.5",
        },
        { "X-Anthropic-API-Key": "header-anthropic-key" }
      );

      const response = await POST(request);
      const data = await response.json();

      expect(response.status).toBe(200);
      expect(data.success).toBe(true);

      // Verify fetch was called with header key (takes precedence)
      expect(mockFetch).toHaveBeenCalledWith(
        "https://api.anthropic.com/v1/messages",
        expect.objectContaining({
          headers: {
            "Content-Type": "application/json",
            "x-api-key": "header-anthropic-key",
            "anthropic-version": "2023-06-01",
          },
        })
      );
    });

    it("should return 429 on rate limit errors", async () => {
      process.env.ANTHROPIC_API_KEY = "test-anthropic-key";

      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 429,
        json: () =>
          Promise.resolve({
            error: { message: "429 Rate limit exceeded" },
          }),
      });

      const request = createMockPostRequest({
        prompt: "Test prompt",
        provider: "anthropic",
        model: "claude-sonnet-4.5",
      });

      const response = await POST(request);
      const data = await response.json();

      expect(response.status).toBe(429);
      expect(data.success).toBe(false);
      expect(data.error).toBe("Rate limit reached. Please wait and try again.");
    });

    it("should handle Anthropic API error responses", async () => {
      process.env.ANTHROPIC_API_KEY = "test-anthropic-key";

      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 401,
        json: () =>
          Promise.resolve({
            error: { message: "Invalid API key" },
          }),
      });

      const request = createMockPostRequest({
        prompt: "Test prompt",
        provider: "anthropic",
        model: "claude-sonnet-4.5",
      });

      const response = await POST(request);
      const data = await response.json();

      expect(response.status).toBe(500);
      expect(data.success).toBe(false);
      expect(data.error).toBe("Invalid API key");
    });

    it("should handle no text in Anthropic response", async () => {
      process.env.ANTHROPIC_API_KEY = "test-anthropic-key";

      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () =>
          Promise.resolve({
            content: [],
          }),
      });

      const request = createMockPostRequest({
        prompt: "Test prompt",
        provider: "anthropic",
        model: "claude-sonnet-4.5",
      });

      const response = await POST(request);
      const data = await response.json();

      expect(response.status).toBe(500);
      expect(data.success).toBe(false);
      expect(data.error).toBe("No text in Anthropic response");
    });

    it("should filter out image without data URL prefix", async () => {
      process.env.ANTHROPIC_API_KEY = "test-anthropic-key";

      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () =>
          Promise.resolve({
            content: [{ type: "text", text: "Image description" }],
          }),
      });

      const request = createMockPostRequest({
        prompt: "Describe this",
        images: ["iVBORw0KGgoAAAANSUhEUgAAAAUA"],
        provider: "anthropic",
        model: "claude-sonnet-4.5",
      });

      const response = await POST(request);
      const data = await response.json();

      expect(response.status).toBe(200);
      expect(data.success).toBe(true);

      // Raw base64 without a data URL prefix fails the image-URL validity
      // check, so the request goes through as a plain-text message.
      expect(mockFetch).toHaveBeenCalledWith(
        "https://api.anthropic.com/v1/messages",
        expect.objectContaining({
          body: JSON.stringify({
            model: "claude-sonnet-4-5-20250929",
            messages: [{ role: "user", content: "Describe this" }],
            temperature: 0.7,
            max_tokens: 4096,
          }),
        })
      );
    });
  });

  describe("Video input", () => {
    beforeEach(() => {
      global.fetch = mockFetch;
    });

    it("should send video as a Gemini inlineData part before the text", async () => {
      process.env.GEMINI_API_KEY = "test-gemini-key";
      mockGenerateContent.mockResolvedValueOnce({ text: "A clip of a cat" });

      const request = createMockPostRequest({
        prompt: "Describe this video",
        videos: ["data:video/mp4;base64,AAAAFGZ0eXA="],
        provider: "google",
        model: "gemini-2.5-flash",
      });

      const response = await POST(request);
      const data = await response.json();

      expect(response.status).toBe(200);
      expect(data.text).toBe("A clip of a cat");
      const callArg = mockGenerateContent.mock.calls[0][0];
      expect(callArg.contents[0].parts[0]).toEqual({
        inlineData: { mimeType: "video/mp4", data: "AAAAFGZ0eXA=" },
      });
      expect(callArg.contents[0].parts[callArg.contents[0].parts.length - 1]).toEqual({
        text: "Describe this video",
      });
    });

    it("should reject video input for non-Gemini providers with a clear error", async () => {
      process.env.ANTHROPIC_API_KEY = "test-anthropic-key";

      const request = createMockPostRequest({
        prompt: "Describe this video",
        videos: ["data:video/mp4;base64,AAAAFGZ0eXA="],
        provider: "anthropic",
        model: "claude-sonnet-4.5",
      });

      const response = await POST(request);
      const data = await response.json();

      expect(response.status).toBe(400);
      expect(data.success).toBe(false);
      expect(data.error).toContain("Google Gemini");
      expect(mockFetch).not.toHaveBeenCalled();
    });

    it("should strip non-video values wired to the video handle", async () => {
      process.env.GEMINI_API_KEY = "test-gemini-key";
      mockGenerateContent.mockResolvedValueOnce({ text: "ok" });

      const request = createMockPostRequest({
        prompt: "Hello",
        videos: ["not a video at all", "blob:http://localhost/x"],
        provider: "google",
        model: "gemini-2.5-flash",
      });

      const response = await POST(request);
      expect(response.status).toBe(200);
      const callArg = mockGenerateContent.mock.calls[0][0];
      expect(callArg.contents[0].parts).toEqual([{ text: "Hello" }]);
    });
  });
});

describe("Anthropic many-image requests", () => {
  // Anthropic caps EVERY image in a request at 2000px per side once the request
  // carries more than 20 image blocks — and the count explicitly includes images
  // from earlier turns that get resent. Because the API is stateless, a chat
  // that resends its transcript crosses that line on its own after a few turns,
  // and images that worked on turn one start being rejected.
  // https://platform.claude.com/docs/en/build-with-claude/vision — Request limits
  const img = "data:image/png;base64,iVBORw0KGgo=";

  function turnsWith(count: number) {
    // Spread across turns, the way a real conversation accumulates them.
    return Array.from({ length: count }, (_, i) => ({
      role: "user" as const,
      text: `turn ${i}`,
      images: [img],
    }));
  }

  beforeEach(() => {
    mockCapLongEdge.mockClear();
    global.fetch = mockFetch;
    process.env.ANTHROPIC_API_KEY = "test-anthropic-key";
    mockFetch.mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ content: [{ type: "text", text: "ok" }] }),
    });
  });

  it("caps every image once the request exceeds 20 of them", async () => {
    const request = createMockPostRequest({
      messages: turnsWith(21),
      provider: "anthropic",
      model: "claude-sonnet-4-5-20250929",
      maxTokens: 1024,
    });

    await POST(request);

    expect(mockCapLongEdge).toHaveBeenCalledTimes(21);
    // Every call, not just the ones past the threshold — the limit applies to
    // the whole request retroactively.
    for (const call of mockCapLongEdge.mock.calls) {
      expect(call[1]).toBe(2000);
    }
  });

  it("leaves images alone at or below the threshold", async () => {
    const request = createMockPostRequest({
      messages: turnsWith(20),
      provider: "anthropic",
      model: "claude-sonnet-4-5-20250929",
      maxTokens: 1024,
    });

    await POST(request);

    // Resizing 20 images that the API would have accepted costs quality and
    // time for nothing.
    expect(mockCapLongEdge).not.toHaveBeenCalled();
  });
});
