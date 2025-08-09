import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import app from "./index";
import type { MessageCreateParams } from "@anthropic-ai/sdk/resources/messages";

describe("/v1/messages endpoint", () => {
  describe("Non-streaming mode", () => {
    it("should handle a simple message request", async () => {
      const request: MessageCreateParams = {
        model: "claude-3-5-sonnet-20241022",
        messages: [
          {
            role: "user",
            content: "What's 2+2? Answer in one word.",
          },
        ],
        max_tokens: 100,
      };

      const response = await app.request("/v1/messages", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify(request),
      });

      expect(response.status).toBe(200);
      
      const data = await response.json();
      expect(data).toHaveProperty("id");
      expect(data).toHaveProperty("type", "message");
      expect(data).toHaveProperty("role", "assistant");
      expect(data).toHaveProperty("content");
      expect(Array.isArray(data.content)).toBe(true);
      expect(data.content.length).toBeGreaterThan(0);
    });

    it("should handle conversation context with multiple messages", async () => {
      const request: MessageCreateParams = {
        model: "claude-3-5-sonnet-20241022",
        messages: [
          {
            role: "user",
            content: "Remember the number 42.",
          },
          {
            role: "assistant",
            content: "I'll remember the number 42.",
          },
          {
            role: "user",
            content: "What number did I ask you to remember?",
          },
        ],
        max_tokens: 100,
      };

      const response = await app.request("/v1/messages", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-conversation-id": "test-conversation-1",
        },
        body: JSON.stringify(request),
      });

      expect(response.status).toBe(200);
      const data = await response.json();
      expect(data).toHaveProperty("content");
    });
  });

  describe("Streaming mode", () => {
    it("should handle a streaming request", async () => {
      const request: MessageCreateParams = {
        model: "claude-3-5-sonnet-20241022",
        messages: [
          {
            role: "user",
            content: "Count from 1 to 3.",
          },
        ],
        max_tokens: 100,
      };

      const response = await app.request("/v1/messages", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-stainless-helper-method": "stream",
        },
        body: JSON.stringify(request),
      });

      expect(response.status).toBe(200);
      expect(response.headers.get("content-type")).toContain("text/event-stream");

      const reader = response.body?.getReader();
      expect(reader).toBeDefined();

      if (!reader) return;

      const decoder = new TextDecoder();
      const events: string[] = [];

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        const chunk = decoder.decode(value, { stream: true });
        const lines = chunk.split("\n");
        
        for (const line of lines) {
          if (line.startsWith("event:")) {
            const eventType = line.substring(6).trim();
            events.push(eventType);
          }
        }
      }

      // Check that we received expected SSE events
      expect(events).toContain("message_start");
      expect(events).toContain("content_block_start");
      expect(events).toContain("message_stop");
      expect(events.length).toBeGreaterThan(3);
    });

    it("should handle streaming with conversation context", async () => {
      const request: MessageCreateParams = {
        model: "claude-3-5-sonnet-20241022",
        messages: [
          {
            role: "user",
            content: "Hi, what's your name?",
          },
        ],
        max_tokens: 50,
      };

      const response = await app.request("/v1/messages", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-stainless-helper-method": "stream",
          "x-conversation-id": "test-conversation-2",
        },
        body: JSON.stringify(request),
      });

      expect(response.status).toBe(200);
      
      // Consume the stream
      const reader = response.body?.getReader();
      if (reader) {
        while (true) {
          const { done } = await reader.read();
          if (done) break;
        }
      }
    });
  });

  describe("Error handling", () => {
    it("should handle invalid request gracefully", async () => {
      const invalidRequest = {
        model: "claude-3-5-sonnet-20241022",
        // Missing required "messages" field
      };

      const response = await app.request("/v1/messages", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify(invalidRequest),
      });

      // The actual status code depends on OpenAI API's validation
      expect(response.status).toBeGreaterThanOrEqual(400);
    });
  });
});

describe("/health endpoint", () => {
  it("should return health status", async () => {
    const response = await app.request("/health");
    
    expect(response.status).toBe(200);
    const data = await response.json();
    expect(data).toHaveProperty("status", "ok");
    expect(data).toHaveProperty("timestamp");
  });
});

describe("/v1/messages/count_tokens endpoint", () => {
  it("should count tokens for a message", async () => {
    const request: MessageCreateParams = {
      model: "claude-3-5-sonnet-20241022",
      messages: [
        {
          role: "user",
          content: "Hello, how are you?",
        },
      ],
      max_tokens: 100,
    };

    const response = await app.request("/v1/messages/count_tokens", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify(request),
    });

    expect(response.status).toBe(200);
    const data = await response.json();
    expect(data).toHaveProperty("input_tokens");
    expect(typeof data.input_tokens).toBe("number");
    expect(data.input_tokens).toBeGreaterThan(0);
  });
});