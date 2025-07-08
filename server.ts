// server.ts
import { serve } from "@hono/node-server";
import app from "./index.js";

const port = parseInt("8082") || 8082; // Default port if not set in environment

console.log(`Starting Claude to OpenAI Responses API Proxy on port ${port}`);

serve(
  {
    fetch: app.fetch,
    port,
  },
  (info) => {
    console.log(`Server is running on http://localhost:${info.port}`);
    console.log("Endpoints:");
    console.log("  POST /v1/messages - Claude Messages API");
    console.log("  POST /v1/messages/count_tokens - Token counting");
    console.log("  GET  /health - Health check");
    console.log("  GET  /test-connection - Test OpenAI connection");
  }
);
