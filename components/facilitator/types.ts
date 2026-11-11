export interface PartInfo {
  status: "locked" | "not_started" | "draft" | "submitted";
  entry_count: number;
  contributors: number;
  last_activity: string | null;
  submitted_at: string | null;
  submitted_by: string | null;
}

export interface Progress {
  active: number;
  submitted: number;
  missing: Array<{ id: string; code: string; name: string }>;
  override_active: boolean;
  ready: boolean;
}

export interface Dash {
  session: { id: string; title: string; join_code: string; part2_unlocked_at: string | null; sharing_enabled: boolean };
  groups: Array<{
    id: string;
    code: string;
    name: string;
    active: boolean;
    authorised_count: number;
    members: Array<{ id: string; name: string }>;
    shared_count: number;
    part1: PartInfo;
    part2: PartInfo;
  }>;
  progress: { part1: Progress; part2: Progress };
  overrides: Array<{ id: string; part: number; reason: string; created_at: string; missing_group_ids: string[] }>;
}

export interface Detail {
  session: {
    id: string;
    title: string;
    description: string;
    video_title: string;
    video_url: string;
    join_code: string;
    sharing_enabled: boolean;
    salient_criteria: string;
    part2_unlocked_at: string | null;
  };
  groups: Array<{
    id: string;
    code: string;
    name: string;
    active: boolean;
    people: Array<{ user_id: string; name: string; email: string; joined: boolean; selected: boolean }>;
  }>;
  guiding_questions: Array<{ id: string; position: number; text: string }>;
}
