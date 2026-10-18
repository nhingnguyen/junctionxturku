import { OllamaProvider } from "./ollama.js";
import type { LLMProvider } from "./types.js";

export function createProvider(): LLMProvider {
    const name = process.env.LLM_PROVIDER ?? "ollama";
    switch (name) {
        case "ollama":
            return new OllamaProvider();
        default:
            throw new Error(`Unsupported LLM_PROVIDER: ${name}`);
    }
}