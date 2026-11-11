/**
 * Facilitator accounts cannot be self-registered (that would be a privilege escalation),
 * so they are created here by whoever operates the server.
 *   npx tsx scripts/create-facilitator.ts you@school.org "Your Name" 'a-long-password'
 */
import { getDb } from "../lib/db";
import { checkPasswordStrength, createUser, normaliseEmail } from "../lib/auth";

const [emailArg, name, password] = process.argv.slice(2);
if (!emailArg || !name || !password) {
  console.error('Usage: npx tsx scripts/create-facilitator.ts email "Name" password');
  process.exit(1);
}
getDb();
createUser({ email: normaliseEmail(emailArg), name, password: checkPasswordStrength(password), role: "facilitator" });
console.log(`Facilitator created: ${emailArg}`);
