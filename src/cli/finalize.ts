import type { Command } from "commander";
import { findProjectRoot } from "../scanner/project-root.js";

// Harnesses without a true, automatic SessionEnd event: their Stop-equivalent
// fires per turn, so the ledger flush and the "Session end" memory.md line
// that SessionEnd normally writes never happen on their own. See docs/hooks.md.
const NO_AUTO_SESSION_END_AGENTS = ["antigravity"];

export function addFinalizeCommand(program: Command): void {
  program
    .command("finalize")
    .description("Manually close a session for a harness with no automatic SessionEnd hook (e.g. Antigravity)")
    .requiredOption("--agent <agent>", `Agent to finalize (${NO_AUTO_SESSION_END_AGENTS.join(", ")})`)
    .option("--session <id>", "Session id to finalize; defaults to the legacy single-session state file")
    .action(async (opts: { agent: string; session?: string }) => {
      if (!NO_AUTO_SESSION_END_AGENTS.includes(opts.agent)) {
        throw new Error(`Unknown finalize agent: ${opts.agent}. Only agents without an automatic SessionEnd hook need this command.`);
      }
      process.env.OPENWOLF_PROJECT_ROOT = findProjectRoot();
      const { finalizeSession } = await import("../hooks/session-end.js");
      const result = await finalizeSession({ session_id: opts.session });
      console.log(JSON.stringify(result, null, 2));
    });
}
