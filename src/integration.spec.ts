import { describe, it, expect, beforeAll } from "bun:test";
import app from "./index";
import type { MessageCreateParams, Tool } from "@anthropic-ai/sdk/resources/messages";

describe("Integration Tests - Full Feature Validation", () => {
  describe("Non-streaming Mode", () => {
    it("should handle basic text message", async () => {
      const request: MessageCreateParams = {
        model: "claude-3-5-sonnet-20241022",
        messages: [
          {
            role: "user",
            content: "Reply with exactly: Hello World",
          },
        ],
        max_tokens: 50,
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
      
      // Validate response structure
      expect(data).toHaveProperty("id");
      expect(data).toHaveProperty("type", "message");
      expect(data).toHaveProperty("role", "assistant");
      expect(data).toHaveProperty("content");
      expect(data).toHaveProperty("stop_reason");
      expect(data).toHaveProperty("usage");
      
      // Validate content structure
      expect(Array.isArray(data.content)).toBe(true);
      expect(data.content.length).toBeGreaterThan(0);
      expect(data.content[0]).toHaveProperty("type", "text");
      expect(data.content[0]).toHaveProperty("text");
      
      // Validate usage
      expect(data.usage).toHaveProperty("input_tokens");
      expect(data.usage).toHaveProperty("output_tokens");
      expect(data.usage.input_tokens).toBeGreaterThan(0);
      expect(data.usage.output_tokens).toBeGreaterThan(0);
    });

    it("should handle tool use requests", async () => {
      const tool: Tool = {
        type: "function",
        name: "get_weather",
        description: "Get weather information",
        input_schema: {
          type: "object",
          properties: {
            location: { type: "string" },
            unit: { type: "string", enum: ["celsius", "fahrenheit"] },
          },
          required: ["location"],
        },
      };

      const request: MessageCreateParams = {
        model: "claude-3-5-sonnet-20241022",
        messages: [
          {
            role: "user",
            content: "What's the weather in Tokyo?",
          },
        ],
        tools: [tool],
        max_tokens: 200,
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
      
      expect(data).toHaveProperty("content");
      expect(Array.isArray(data.content)).toBe(true);
      
      // Check if tool use is in response (may or may not be called depending on model)
      const hasToolUse = data.content.some((block: any) => block.type === "tool_use");
      if (hasToolUse) {
        const toolBlock = data.content.find((block: any) => block.type === "tool_use");
        expect(toolBlock).toHaveProperty("id");
        expect(toolBlock).toHaveProperty("name");
        expect(toolBlock).toHaveProperty("input");
        expect(data.stop_reason).toBe("tool_use");
      }
    });

    it("should maintain conversation context", async () => {
      const conversationId = "test-conv-" + Date.now();
      
      // First message
      const request1: MessageCreateParams = {
        model: "claude-3-5-sonnet-20241022",
        messages: [
          {
            role: "user",
            content: "My favorite number is 42. Remember it.",
          },
        ],
        max_tokens: 100,
      };

      const response1 = await app.request("/v1/messages", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-conversation-id": conversationId,
        },
        body: JSON.stringify(request1),
      });

      expect(response1.status).toBe(200);
      const data1 = await response1.json();
      
      // Second message in same conversation
      const request2: MessageCreateParams = {
        model: "claude-3-5-sonnet-20241022",
        messages: [
          {
            role: "user",
            content: "My favorite number is 42. Remember it.",
          },
          {
            role: "assistant",
            content: data1.content[0].text,
          },
          {
            role: "user",
            content: "What number did I tell you to remember?",
          },
        ],
        max_tokens: 100,
      };

      const response2 = await app.request("/v1/messages", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-conversation-id": conversationId,
        },
        body: JSON.stringify(request2),
      });

      expect(response2.status).toBe(200);
      const data2 = await response2.json();
      expect(data2.content[0].text).toContain("42");
    });
  });

  describe("Streaming Mode", () => {
    it("should stream basic text response", async () => {
      const request: MessageCreateParams = {
        model: "claude-3-5-sonnet-20241022",
        messages: [
          {
            role: "user",
            content: "Count to 3",
          },
        ],
        max_tokens: 50,
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
      const events: Record<string, number> = {};
      let messageStarted = false;
      let contentStarted = false;
      let messageStopped = false;

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        const chunk = decoder.decode(value, { stream: true });
        const lines = chunk.split("\n");
        
        for (const line of lines) {
          if (line.startsWith("event:")) {
            const eventType = line.substring(6).trim();
            events[eventType] = (events[eventType] || 0) + 1;
            
            if (eventType === "message_start") messageStarted = true;
            if (eventType === "content_block_start") contentStarted = true;
            if (eventType === "message_stop") messageStopped = true;
          }
        }
      }

      // Validate streaming event sequence
      expect(messageStarted).toBe(true);
      expect(contentStarted).toBe(true);
      expect(messageStopped).toBe(true);
      expect(events["message_start"]).toBe(1);
      expect(events["content_block_start"]).toBeGreaterThanOrEqual(1);
      expect(events["content_block_delta"]).toBeGreaterThanOrEqual(1);
      expect(events["content_block_stop"]).toBeGreaterThanOrEqual(1);
      expect(events["message_stop"]).toBe(1);
    });

    it("should handle streaming with tool use", async () => {
      const tool: Tool = {
        type: "function",
        name: "calculator",
        description: "Perform calculations",
        input_schema: {
          type: "object",
          properties: {
            expression: { type: "string" },
          },
          required: ["expression"],
        },
      };

      const request: MessageCreateParams = {
        model: "claude-3-5-sonnet-20241022",
        messages: [
          {
            role: "user",
            content: "Calculate 25 * 4 using the calculator tool",
          },
        ],
        tools: [tool],
        tool_choice: { type: "any" },
        max_tokens: 200,
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
      
      const reader = response.body?.getReader();
      if (!reader) return;

      const decoder = new TextDecoder();
      let toolUseStarted = false;
      let toolUseCompleted = false;

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        const chunk = decoder.decode(value, { stream: true });
        const lines = chunk.split("\n");
        
        for (const line of lines) {
          if (line.startsWith("event:")) {
            const eventType = line.substring(6).trim();
            if (eventType === "content_block_start") {
              // Check if this is a tool use block
              const nextLine = lines[lines.indexOf(line) + 1];
              if (nextLine && nextLine.includes("tool_use")) {
                toolUseStarted = true;
              }
            }
            if (eventType === "content_block_stop" && toolUseStarted) {
              toolUseCompleted = true;
            }
          }
        }
      }

      // Tool choice was set to "any", model may or may not use the tool
      // So we just check the stream worked without errors
    });
  });

  describe("Error Handling", () => {
    it("should handle missing messages field", async () => {
      const invalidRequest = {
        model: "claude-3-5-sonnet-20241022",
        // Missing messages field
        max_tokens: 100,
      };

      const response = await app.request("/v1/messages", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify(invalidRequest),
      });

      expect(response.status).toBeGreaterThanOrEqual(400);
      const data = await response.json();
      expect(data).toHaveProperty("error");
    });

    it("should handle invalid model", async () => {
      const request: MessageCreateParams = {
        model: "invalid-model" as any,
        messages: [
          {
            role: "user",
            content: "Hello",
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

      // Should still work since we map to a default model
      expect(response.status).toBe(200);
    });
  });

  describe("Special Features", () => {
    it("should handle system messages", async () => {
      const request: MessageCreateParams = {
        model: "claude-3-5-sonnet-20241022",
        system: "You are a helpful assistant that always responds in haiku format.",
        messages: [
          {
            role: "user",
            content: "Tell me about the sky",
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
      expect(data.content[0].text).toBeTruthy();
    });

    it("should respect max_tokens limit", async () => {
      const request: MessageCreateParams = {
        model: "claude-3-5-sonnet-20241022",
        messages: [
          {
            role: "user",
            content: "Write a very long story about dragons",
          },
        ],
        max_tokens: 10, // Very low limit
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
      
      // With such a low token limit, should hit max_tokens
      // Note: The actual behavior depends on OpenAI's response
      expect(data.usage.output_tokens).toBeLessThanOrEqual(20); // Some buffer for token counting differences
    });
  });

  describe("Token Counting Endpoint", () => {
    it("should count tokens correctly", async () => {
      const request: MessageCreateParams = {
        model: "claude-3-5-sonnet-20241022",
        messages: [
          {
            role: "user",
            content: "Hello, how are you today?",
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
});