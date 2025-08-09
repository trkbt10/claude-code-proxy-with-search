import { serve } from "@hono/node-server";
import app from "./src/index";

// Load environment variables
const port = parseInt(process.env.PORT || "8082", 10);

console.log(`🚀 Server starting on http://localhost:${port}`);
console.log(`📝 Endpoints:`);
console.log(`   - GET  /health`);
console.log(`   - POST /v1/messages`);
console.log(`   - POST /v1/messages/count_tokens`);
console.log(`   - GET  /test-connection`);

serve({
  fetch: app.fetch,
  port,
});