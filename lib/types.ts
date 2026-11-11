export type Role = "participant" | "facilitator";

export interface User {
  id: string;
  email: string;
  name: string;
  role: Role;
  must_change_password: number;
}

export interface PdSession {
  id: string;
  facilitator_id: string;
  title: string;
  description: string;
  video_title: string;
  video_url: string;
  join_code: string;
  sharing_enabled: number;
  salient_criteria: string;
  part2_unlocked_at: string | null;
  part2_unlocked_by: string | null;
  created_at: string;
}

export interface Group {
  id: string;
  session_id: string;
  code: string;
  name: string;
  active: number;
  created_at: string;
}

export interface EntryRow {
  id: string;
  session_id: string;
  group_id: string;
  part: 1 | 2;
  seq: number;
  public_id: string;
  author_id: string;
  observation: string;
  timestamp_sec: number | null;
  evidence: string;
  interpretation: string;
  question: string;
  guiding_question_id: string | null;
  version: number;
  created_at: string;
  updated_at: string;
  deleted_at: string | null;
}

export const STAGE_LABELS: Record<number, string> = {
  1: "Part 1 - Initial noticing",
  2: "Part 2 - Guided noticing",
};
