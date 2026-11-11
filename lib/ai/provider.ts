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
  provider: "anthropic" | "gemini" | "simulated" | string;
  model: string;
  simulated: boolean;
}

export type AiProvider = (req: AiRequest) => Promise<AiResult>;

// Preserved from your original file.
// For Claude, set AI_MODEL to a model available to your account.
export const DEFAULT_MODEL = "claude-opus-5-5";

/**
 * Claude provider.
 * Requires ANTHROPIC_API_KEY.
 */
export function createAnthropicProvider(
  client: Pick<Anthropic, "messages">,
  model = process.env.AI_MODEL || DEFAULT_MODEL,
): AiProvider {
  const effort =
    (process.env.AI_EFFORT as
      | "low"
      | "medium"
      | "high"
      | "xhigh"
      | "max"
      | undefined) || "high";

  return async (req) => {
    let msg: Anthropic.Message;

    try {
      msg = await client.messages.create({
        model,
        max_tokens: 16000,
        system: SYSTEM_PROMPT,
        messages: [
          {
            role: "user",
            content: buildUserMessage(
              req.kind,
              req.entries,
              req.criteria,
            ),
          },
        ],
        output_config: {
          effort,
          format: {
            type: "json_schema",
            schema: SCHEMAS[req.kind],
          },
        },
      });
    } catch (e) {
      if (e instanceof Anthropic.RateLimitError) {
        throw new HttpError(
          503,
          "The AI service is busy. Please try again in a minute.",
          "AI_BUSY",
        );
      }

      if (e instanceof Anthropic.AuthenticationError) {
        throw new HttpError(
          502,
          "The AI service rejected the server's API key. Ask the administrator to check ANTHROPIC_API_KEY.",
          "AI_AUTH",
        );
      }

      if (e instanceof Anthropic.APIConnectionError) {
        throw new HttpError(
          502,
          "Could not reach the AI service. Please try again.",
          "AI_UNREACHABLE",
        );
      }

      if (e instanceof Anthropic.APIError) {
        throw new HttpError(
          502,
          `The AI service returned an error (${e.status ?? "unknown"}). Nothing was saved.`,
          "AI_ERROR",
        );
      }

      throw e;
    }

    if (msg.stop_reason === "refusal") {
      throw new HttpError(
        422,
        "The AI service declined to analyse this material. Nothing was saved. You can write the summary yourself, or try different entries.",
        "AI_REFUSED",
      );
    }

    if (msg.stop_reason === "max_tokens") {
      throw new HttpError(
        502,
        "The AI response was cut off before it finished, so it was discarded. Try fewer entries or a single part.",
        "AI_TRUNCATED",
      );
    }

    const text = msg.content
      .flatMap((block) =>
        block.type === "text" ? [block.text] : [],
      )
      .join("");

    let raw: unknown;

    try {
      raw = JSON.parse(text);
    } catch {
      throw new HttpError(
        502,
        "The AI response was not valid JSON, so it was discarded. Please try again.",
        "AI_BAD_OUTPUT",
      );
    }

    return {
      raw,
      provider: "anthropic",
      model,
      simulated: false,
    };
  };
}

interface GeminiResponse {
  promptFeedback?: {
    blockReason?: string;
  };
  candidates?: Array<{
    finishReason?: string;
    content?: {
      parts?: Array<{
        text?: string;
        thought?: boolean;
      }>;
    };
  }>;
}

/**
 * Gemini provider using the REST API.
 * Requires GEMINI_API_KEY and AI_MODEL.
 */
export function createGeminiProvider(): AiProvider {
  return async (req) => {
    const key = process.env.GEMINI_API_KEY?.trim();
    const configuredModel = process.env.AI_MODEL?.trim();
    const model = configuredModel?.replace(/^models\//, "");

    if (!key || !model) {
      throw new HttpError(
        503,
        "Set GEMINI_API_KEY and AI_MODEL in Render's environment settings.",
        "AI_CONFIG",
      );
    }

    let response: Response;

    try {
      response = await fetch(
        `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "x-goog-api-key": key,
          },
          body: JSON.stringify({
            systemInstruction: {
              parts: [{ text: SYSTEM_PROMPT }],
            },
            contents: [
              {
                role: "user",
                parts: [
                  {
                    text: buildUserMessage(
                      req.kind,
                      req.entries,
                      req.criteria,
                    ),
                  },
                ],
              },
            ],
            generationConfig: {
              responseMimeType: "application/json",
              responseJsonSchema: SCHEMAS[req.kind],
              maxOutputTokens: 8192,
            },
          }),
          signal: AbortSignal.timeout(120_000),
        },
      );
    } catch {
      throw new HttpError(
        502,
        "Could not reach Gemini, or the request timed out. Please try again.",
        "AI_UNREACHABLE",
      );
    }

    if (!response.ok) {
      if (response.status === 429) {
        throw new HttpError(
          503,
          "Gemini's rate limit or quota was reached. Check your usage before retrying.",
          "AI_BUSY",
        );
      }

      if (
        response.status === 401 ||
        response.status === 403
      ) {
        throw new HttpError(
          502,
          "Gemini rejected the request. Check GEMINI_API_KEY and your account's API access.",
          "AI_AUTH",
        );
      }

      if (response.status === 404) {
        throw new HttpError(
          502,
          "The configured Gemini model or endpoint was not found. Check AI_MODEL and model availability.",
          "AI_MODEL",
        );
      }

      if (response.status === 400) {
        throw new HttpError(
          502,
          "Gemini rejected the request format. Check the selected model's support for structured JSON output and the schema. Nothing was saved.",
          "AI_REQUEST",
        );
      }

      throw new HttpError(
        502,
        `Gemini returned HTTP ${response.status}. Nothing was saved.`,
        "AI_ERROR",
      );
    }

    let data: GeminiResponse;

    try {
      data = (await response.json()) as GeminiResponse;
    } catch {
      throw new HttpError(
        502,
        "Gemini returned an unreadable response. Nothing was saved.",
        "AI_BAD_OUTPUT",
      );
    }

    if (data.promptFeedback?.blockReason) {
      throw new HttpError(
        422,
        "Gemini blocked this request. Nothing was saved. Review the submitted material before trying again.",
        "AI_REFUSED",
      );
    }

    const candidate = data.candidates?.[0];

    if (candidate?.finishReason === "MAX_TOKENS") {
      throw new HttpError(
        502,
        "The Gemini response was cut off. Nothing was saved. Try fewer entries or a single part.",
        "AI_TRUNCATED",
      );
    }

    if (!candidate || candidate.finishReason !== "STOP") {
      throw new HttpError(
        502,
        "Gemini did not return a complete response. Nothing was saved. Try fewer entries or review the submitted material.",
        "AI_INCOMPLETE",
      );
    }

    const text = (candidate.content?.parts ?? [])
      .filter((part) => !part.thought)
      .map((part) => part.text ?? "")
      .join("");

    let raw: unknown;

    try {
      raw = JSON.parse(text);
    } catch {
      throw new HttpError(
        502,
        "Gemini returned invalid JSON. Nothing was saved. Please try again.",
        "AI_BAD_OUTPUT",
      );
    }

    return {
      raw,
      provider: "gemini",
      model,
      simulated: false,
    };
  };
}

/**
 * Local rule-based demo provider.
 * Does not call an AI model.
 */
export const simulatedProvider: AiProvider = async (req) => ({
  raw: simulate(req.kind, req.entries, req.criteria),
  provider: "simulated",
  model: "rule-based-simulator",
  simulated: true,
});

let override: AiProvider | null = null;

/** Tests inject a fake provider here. */
export function setProviderForTests(
  provider: AiProvider | null,
): void {
  override = provider;
}

export function providerInfo(): {
  name: string;
  simulated: boolean;
  model: string;
  reason: string;
} {
  const selected = (
    process.env.AI_PROVIDER ||
    (process.env.ANTHROPIC_API_KEY
      ? "anthropic"
      : "simulated")
  )
    .trim()
    .toLowerCase();

  if (selected === "gemini") {
    const configured =
      !!process.env.GEMINI_API_KEY?.trim() &&
      !!process.env.AI_MODEL?.trim();

    return {
      name: "gemini",
      simulated: false,
      model: process.env.AI_MODEL?.trim() || "(not configured)",
      reason: configured
        ? "Gemini selected; requests use the Gemini API."
        : "Gemini selected, but GEMINI_API_KEY or AI_MODEL is missing. Generation will fail until configured.",
    };
  }

  if (
    selected === "anthropic" &&
    process.env.ANTHROPIC_API_KEY
  ) {
    return {
      name: "anthropic",
      simulated: false,
      model: process.env.AI_MODEL || DEFAULT_MODEL,
      reason: "Real model through the Anthropic API.",
    };
  }

  return {
    name: "simulated",
    simulated: true,
    model: "rule-based-simulator",
    reason:
      selected === "anthropic"
        ? "AI_PROVIDER=anthropic but ANTHROPIC_API_KEY is not set, so the simulator is used."
        : "Simulator selected, or no supported AI provider is configured. No language model is used.",
  };
}

export function getProvider(): AiProvider {
  if (override) return override;

  const info = providerInfo();

  if (info.name === "gemini") {
    return createGeminiProvider();
  }

  if (info.simulated) {
    return simulatedProvider;
  }

  return createAnthropicProvider(
    new Anthropic({
      timeout: 120_000,
      maxRetries: 2,
    }),
  );
}
