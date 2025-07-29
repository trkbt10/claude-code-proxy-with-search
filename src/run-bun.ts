// run-bun.ts
import app from ".";

const port = parseInt(process.env.PORT || "8082");

console.log(`Starting Claude to OpenAI Responses API Proxy on port ${port}`);
console.log("Endpoints:");
console.log("  POST /v1/messages - Claude Messages API");
console.log("  POST /v1/messages/count_tokens - Token counting");
console.log("  GET  /health - Health check");
console.log("  GET  /test-connection - Test OpenAI connection");

export default {
  port,
  fetch: app.fetch,
};
