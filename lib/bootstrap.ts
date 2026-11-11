import { getDb } from "./db";
import { checkPasswordStrength, createUser, normaliseEmail } from "./auth";

/**
 * First-run setup for hosts without a shell. If BOOTSTRAP_FACILITATOR_EMAIL / _NAME / _PASSWORD are set
 * and no facilitator exists yet, create one that must change its password at first sign-in.
 * Never overwrites or resets an existing account. Remove the variables afterwards.
 */
export function bootstrapFacilitator(env: NodeJS.ProcessEnv = process.env): "created" | "skipped" | "invalid" {
  const { BOOTSTRAP_FACILITATOR_EMAIL: email, BOOTSTRAP_FACILITATOR_NAME: name, BOOTSTRAP_FACILITATOR_PASSWORD: password } = env;
  if (!email || !name || !password) return "skipped";
  const db = getDb();
  const existing = db.prepare("SELECT COUNT(*) AS n FROM users WHERE role = 'facilitator'").get() as { n: number };
  if (existing.n > 0) return "skipped";
  try {
    createUser({ email: normaliseEmail(email), name: name.trim().slice(0, 120) || "Facilitator", password: checkPasswordStrength(password), role: "facilitator", mustChange: true });
  } catch (e) {
    console.error("BOOTSTRAP_FACILITATOR_* ignored:", e instanceof Error ? e.message : e);
    return "invalid";
  }
  console.log(`Created first facilitator ${email.trim().toLowerCase()} (must change password at first sign-in).`);
  return "created";
}
