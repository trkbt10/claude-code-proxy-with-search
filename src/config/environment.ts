export function checkEnvironmentVariables() {
  if (!process.env.OPENAI_API_KEY) {
    throw new Error("OPENAI_API_KEY environment variable is required");
  }

  if (!process.env.OPENAI_MODEL) {
    console.warn(
      "OPENAI_MODEL environment variable is not set, using default gpt-4.1"
    );
  }
}