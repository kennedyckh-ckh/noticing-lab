// The structured shapes the AI layer produces and the screens render/edit.
// Observations and interpretations are kept in separate lists on purpose, and every item
// cites the public ids of the entries it came from (for example G1-P1-02).

export type AiKind = "group_summary" | "cross_group" | "salient_points";

export interface GroupSummaryContent {
  observations: Array<{ text: string; source_ids: string[]; timestamp?: string }>;
  interpretations: Array<{ text: string; source_ids: string[] }>;
  disagreements: Array<{ topic: string; positions: Array<{ position: string; source_ids: string[] }> }>;
  open_questions: Array<{ text: string; source_ids: string[] }>;
  caveats: string[];
  facilitator_note?: string;
}

export interface CrossGroupContent {
  common_ground: Array<{ text: string; groups: string[]; source_ids: string[] }>;
  differences: Array<{ topic: string; positions: Array<{ group: string; position: string; source_ids: string[] }> }>;
  unique_noticings: Array<{ group: string; text: string; source_ids: string[] }>;
  caveats: string[];
  facilitator_note?: string;
}

export interface SalientContent {
  points: Array<{
    title: string;
    why_salient: string;
    criteria_matched: string[];
    basis: "observation" | "interpretation" | "disagreement" | "question";
    source_ids: string[];
    discussion_prompt: string;
  }>;
  caveats: string[];
  facilitator_note?: string;
}

export type AiContent = GroupSummaryContent | CrossGroupContent | SalientContent;
