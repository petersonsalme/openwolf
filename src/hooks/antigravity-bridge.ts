/**
 * OpenWolf <-> Antigravity CLI Bridge
 * Translates Antigravity CLI hook events to OpenWolf hook scripts and back.
 */

import * as cp from "node:child_process";
import * as path from "node:path";
import * as fs from "node:fs";
import { fileURLToPath } from "node:url";

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(SCRIPT_DIR, "..", "..");
const WOLF_HOOKS = SCRIPT_DIR;

// Tool name mapping: Antigravity -> OpenWolf
const TOOL_NAME_MAP: Record<string, string> = {
  view_file: "Read",
  write_to_file: "Write",
  replace_file_content: "Edit",
  run_command: "Bash",
};

function getCachePath(conversationId: string): string {
  const safeId = (conversationId || "default").replace(/[^a-zA-Z0-9_-]/g, "_");
  return path.join("/tmp", `openwolf-ag-last-tool-${safeId}.json`);
}

function translateArgs(toolName: string, args: Record<string, any> = {}): Record<string, any> {
  switch (toolName) {
    case "view_file":
      return {
        file_path: args.AbsolutePath || args.file_path || "",
        offset: args.StartLine !== undefined ? args.StartLine : undefined,
        limit: args.EndLine !== undefined ? args.EndLine : undefined,
      };
    case "write_to_file":
      return {
        file_path: args.TargetFile || args.file_path || "",
        content: args.CodeContent || args.content || "",
      };
    case "replace_file_content":
      return {
        file_path: args.TargetFile || args.file_path || "",
        old_string: args.TargetContent || args.old_string || "",
        new_string: args.ReplacementContent || args.new_string || "",
      };
    case "run_command":
      return {
        command: args.CommandLine || args.command || "",
      };
    default:
      return args;
  }
}

function readAllStdin(): Promise<string> {
  return new Promise((resolve) => {
    let settled = false;
    const chunks: Buffer[] = [];
    const done = (val: string) => {
      if (!settled) {
        settled = true;
        clearTimeout(timer);
        resolve(val);
      }
    };
    const timer = setTimeout(() => {
      done(chunks.length > 0 ? Buffer.concat(chunks).toString("utf-8") : "");
    }, 1000);
    timer.unref();

    process.stdin.on("data", (chunk: Buffer) => chunks.push(chunk));
    process.stdin.on("end", () => {
      done(Buffer.concat(chunks).toString("utf-8"));
    });
    process.stdin.on("error", () => {
      done(Buffer.concat(chunks).toString("utf-8"));
    });
  });
}

function runWolfHook(scriptName: string, stdinPayload: unknown, workspaceRoot: string): Promise<string> {
  return new Promise((resolve) => {
    const scriptPath = path.join(WOLF_HOOKS, scriptName);
    if (!fs.existsSync(scriptPath)) {
      resolve("");
      return;
    }

    let settled = false;
    const done = (val: string) => {
      if (!settled) {
        settled = true;
        clearTimeout(timer);
        resolve(val);
      }
    };

    const child = cp.spawn("node", [scriptPath], {
      env: {
        ...process.env,
        OPENWOLF_PROJECT_ROOT: workspaceRoot,
        ANTIGRAVITY: "1",
      },
      stdio: ["pipe", "pipe", "pipe"],
    });

    let stdout = "";
    child.stdout.on("data", (d: Buffer) => (stdout += d.toString()));
    child.on("close", () => done(stdout));
    child.on("error", () => done(""));

    const timer = setTimeout(() => {
      try {
        child.kill();
      } catch {}
      done(stdout);
    }, 2000);
    timer.unref();

    try {
      child.stdin.end(JSON.stringify(stdinPayload));
    } catch {
      done("");
    }
  });
}

async function main(): Promise<void> {
  const event = process.argv[2] || "unknown";
  const subtype = process.argv[3] || "read";

  const rawStdin = await readAllStdin();
  let agiPayload: Record<string, any> = {};
  if (rawStdin) {
    try {
      agiPayload = JSON.parse(rawStdin);
    } catch {}
  }

  const conversationId = agiPayload.conversationId || "default";
  const workspaceRoot = (agiPayload.workspacePaths && agiPayload.workspacePaths[0]) || PROJECT_ROOT;
  const tc = agiPayload.toolCall || {};
  const toolName = tc.name || "";
  const cacheFile = getCachePath(conversationId);

  if (event === "PreToolUse") {
    const wolfToolName = TOOL_NAME_MAP[toolName] || toolName;
    const toolInput = translateArgs(toolName, tc.args || {});

    try {
      fs.writeFileSync(
        cacheFile,
        JSON.stringify({
          toolName,
          wolfToolName,
          toolInput,
          stepIdx: agiPayload.stepIdx,
        })
      );
    } catch {}

    const wolfScript = subtype === "write" ? "pre-write.js" : subtype === "bash" ? "pre-bash.js" : "pre-read.js";
    const wolfInput = {
      session_id: conversationId,
      tool_name: wolfToolName,
      tool_input: toolInput,
    };

    const rawOutput = await runWolfHook(wolfScript, wolfInput, workspaceRoot);
    let outputObj: Record<string, any> = {};
    try {
      outputObj = JSON.parse(rawOutput);
    } catch {}

    const specific = outputObj.hookSpecificOutput || {};
    if (specific.permissionDecision === "block" || specific.permissionDecision === "deny") {
      process.stdout.write(
        JSON.stringify({
          decision: "deny",
          reason: specific.permissionDecisionReason || "Blocked by OpenWolf rule",
        })
      );
      process.exit(0);
    }

    if (specific.additionalContext) {
      process.stdout.write(
        JSON.stringify({
          decision: "allow",
          reason: specific.additionalContext,
        })
      );
      process.exit(0);
    }

    process.stdout.write(JSON.stringify({ decision: "allow" }));
    process.exit(0);
  }

  if (event === "PostToolUse") {
    let cached: any = null;
    try {
      if (fs.existsSync(cacheFile)) {
        cached = JSON.parse(fs.readFileSync(cacheFile, "utf-8"));
      }
    } catch {}

    if (cached && !agiPayload.error) {
      const wolfScript = subtype === "write" ? "post-write.js" : subtype === "bash" ? "post-bash.js" : "post-read.js";
      const wolfInput = {
        session_id: conversationId,
        tool_name: cached.wolfToolName,
        tool_input: cached.toolInput,
      };
      await runWolfHook(wolfScript, wolfInput, workspaceRoot);
    }

    process.stdout.write(JSON.stringify({}));
    process.exit(0);
  }

  if (event === "PreInvocation") {
    if (agiPayload.invocationNum === 1) {
      const wolfInput = {
        session_id: conversationId,
      };
      const rawOutput = await runWolfHook("session-start.js", wolfInput, workspaceRoot);
      let outputObj: Record<string, any> = {};
      try {
        outputObj = JSON.parse(rawOutput);
      } catch {}

      const specific = outputObj.hookSpecificOutput || {};
      if (specific.additionalContext) {
        process.stdout.write(
          JSON.stringify({
            injectSteps: [
              {
                ephemeralMessage: specific.additionalContext,
              },
            ],
          })
        );
        process.exit(0);
      }
    }

    process.stdout.write(JSON.stringify({ injectSteps: [] }));
    process.exit(0);
  }

  if (event === "Stop") {
    const wolfInput = {
      session_id: conversationId,
      transcript_path: agiPayload.transcriptPath,
    };
    await runWolfHook("stop.js", wolfInput, workspaceRoot);
    process.stdout.write(JSON.stringify({}));
    process.exit(0);
  }

  process.stdout.write(JSON.stringify({ decision: "allow" }));
  process.exit(0);
}

main().catch(() => {
  process.stdout.write(JSON.stringify({ decision: "allow" }));
  process.exit(0);
});
