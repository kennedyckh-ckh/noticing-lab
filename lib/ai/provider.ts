import Anthropic from "@anthropic-ai/sdk";
import { HttpError } from "../util";
import type { AiKind } from "./types";
import type { EntrySnap } from "./entries";
import { SCHEMAS, SYSTEM_PROMPT, buildUserMessage } from "./prompt";
import { simulate } from "./simulated";

export interface AiRequest {
  kind: AiKind;
  entries: EntrySnap[];
  criteria: string;
}
export interface AiResult {
  raw: unknown;
  provider: "anthropic" | "simulated" | string;
  model: string;
  simulated: boolean;
}
export type AiProvider = (req: AiRequest) => Promise<AiResult>;

export const DEFAULT_MODEL = "claude-opus-5-5";

/** Real model through the official Anthropic SDK. Needs ANTHROPIC_API_KEY; NOT connected in this build's demo. */
export function createAnthropicProvider(client: Pick<Anthropic, "messages">, model = process.env.AI_MODEL || DEFAULT_MODEL): AiProvider {
  const effort = (process.env.AI_EFFORT as "low" | "medium" | "high" | "xhigh" | "max" | undefined) || "high";
  return async (req) => {
    let msg: Anthropic.Message;
    try {
      msg = await client.messages.create({
        model,
        max_tokens: 16000,
        system: SYSTEM_PROMPT,
        messages: [{ role: "user", content: buildUserMessage(req.kind, req.entries, req.criteria) }],
        output_config: { effort, format: { type: "json_schema", schema: SCHEMAS[req.kind] } },
      });
    } catch (e) {
      if (e instanceof Anthropic.RateLimitError) throw new HttpError(503, "The AI service is busy. Please try again in a minute.", "AI_BUSY");
      if (e instanceof Anthropic.AuthenticationError) throw new HttpError(502, "The AI service rejected the server's API key. Ask the administrator to check ANTHROPIC_API_KEY.", "AI_AUTH");
      if (e instanceof Anthropic.APIConnectionError) throw new HttpError(502, "Could not reach the AI service. Please try again.", "AI_UNREACHABLE");
      if (e instanceof Anthropic.APIError) throw new HttpError(502, `The AI service returned an error (${e.status ?? "unknown"}). Nothing was saved.`, "AI_ERROR");
      throw e;
    }
    if (msg.stop_reason === "refusal") {
      throw new HttpError(422, "The AI service declined to analyse this material. Nothing was saved. You can write the summary yourself, or try different entries.", "AI_REFUSED");
    }
    if (msg.stop_reason === "max_tokens") {
      throw new HttpError(502, "The AI response was cut off before it finished, so it was discarded. Try fewer entries or a single part.", "AI_TRUNCATED");
    }
    const out = msg.content.flatMap((b) => (b.type === "text" ? [b.text] : [])).join("");
    let raw: unknown;
    try {
      raw = JSON.parse(out);
    } catch {
      throw new HttpError(502, "The AI response was not valid JSON, so it was discarded. Please try again.", "AI_BAD_OUTPUT");
    }
    return { raw, provider: "anthropic", model, simulated: false };
  };
}

export const simulatedProvider: AiProvider = async (req) => ({
  raw: simulate(req.kind, req.entries, req.criteria),
  provider: "simulated",
  model: "rule-based-simulator",
  simulated: true,
});

let override: AiProvider | null = null;
/** Tests inject a fake provider here. */
export function setProviderForTests(p: AiProvider | null): void {
  override = p;
}

export function providerInfo(): { name: string; simulated: boolean; model: string; reason: string } {
  const wantReal = (process.env.AI_PROVIDER || (process.env.ANTHROPIC_API_KEY ? "anthropic" : "simulated")) === "anthropic";
  if (wantReal && process.env.ANTHROPIC_API_KEY) return { name: "anthropic", simulated: false, model: process.env.AI_MODEL || DEFAULT_MODEL, reason: "Real model through the Anthropic API." };
  return {
    name: "simulated",
    simulated: true,
    model: "rule-based-simulator",
    reason: wantReal ? "AI_PROVIDER=anthropic but ANTHROPIC_API_KEY is not set, so the simulator is used." : "No ANTHROPIC_API_KEY is set. Outputs come from a rule-based simulator, not a language model.",
  };
}

export function getProvider(): AiProvider {
  if (override) return override;
  const info = providerInfo();
  if (info.simulated) return simulatedProvider;
  return createAnthropicProvider(new Anthropic({ timeout: 120_000, maxRetries: 2 }));
}
