#!/usr/bin/env node
/**
 * governance-guard — PreToolUse hook for the Edit and Write tools.
 *
 * Two small rules:
 *
 *   1. DENY  an agent writing outside its permitted scope (AGENT_WRITE_SCOPE).
 *            Needed because `memory: project` auto-enables Read/Write/Edit for
 *            engineering-lead, so its `tools:` list cannot make it read-only.
 *
 *   2. ASK   any edit to a governance file (PROTECTED). Governance Change
 *            Control (CLAUDE.md, Mandatory Gate #6) forbids applying such a
 *            change without explicit human approval of that specific change; the
 *            prompt makes an unapproved edit visible. It is NOT the approval
 *            record — that still has to be captured per CLAUDE.md.
 *
 * Limits (see docs/enforcement.md):
 *   - Covers Edit/Write only. `sed -i`, redirects or scripts run through Bash /
 *     PowerShell can still modify these files; real protection for that is
 *     branch protection + CODEOWNERS review on the pull request.
 *   - `ask` needs a human to answer. Observed on Claude Code 2.1.280: in headless
 *     (`claude -p`) runs the edit was refused, not allowed, in both default and
 *     bypassPermissions modes; interactive prompting is per the Claude Code docs and
 *     was not exercised. Deny (rule 1) does not depend on a prompt.
 *   - Any failure of this hook other than exit 2 fails open.
 */
import { readFileSync } from 'node:fs';
import { isAbsolute, relative, resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';

// Paths relative to the project root. A trailing "/" means "everything below".
export const PROTECTED = [
  'CLAUDE.md', // also matched in subdirectories
  '.claude/rules/',
  '.claude/agents/',
  '.claude/skills/',
  '.claude/hooks/',
  '.claude/settings.json',
  '.claude/settings.local.json',
];

// agent_type (the agent's `name`) -> path prefixes it may write. Absent = no extra limit.
export const AGENT_WRITE_SCOPE = {
  'engineering-lead': ['.claude/agent-memory/engineering-lead/'],
};

/** Project-relative path with forward slashes and original case, or null if outside the project. */
function relativePath(file, projectDir) {
  const rel = relative(projectDir, resolve(projectDir, file));
  if (rel === '' || rel.startsWith('..') || isAbsolute(rel)) return null;
  return rel.split(sep).join('/');
}

// case-insensitive: Windows and macOS file systems are, and a case variant must not slip past
const isProtected = (rel) => {
  const key = rel.toLowerCase();
  return PROTECTED.some((p) => {
    const q = p.toLowerCase();
    if (q.endsWith('/')) return key.startsWith(q);
    return key === q || (q === 'claude.md' && key.endsWith('/claude.md'));
  });
};

/** Returns null (allow) or {action: 'deny'|'ask', message}. */
export function evaluate({ file, agentType, projectDir }) {
  const rel = relativePath(file, projectDir);
  const scope = agentType && AGENT_WRITE_SCOPE[agentType];
  if (scope && !(rel && scope.some((prefix) => rel.toLowerCase().startsWith(prefix.toLowerCase())))) {
    return {
      action: 'deny',
      message:
        `BLOCKED by governance-guard: agent \`${agentType}\` may only write under ${scope.join(', ')}.\n` +
        'Why: this agent coordinates and must not modify the project; its memory directory is the only write access it needs (.claude/agents/engineering-lead.md, Tool Scope).\n' +
        'Instead: return the change you want in your output and let the main session or fullstack-engineer make it.',
    };
  }
  if (rel && isProtected(rel)) {
    return {
      action: 'ask',
      message:
        `governance-guard: \`${rel}\` is a governance file (CLAUDE.md, .claude/rules|agents|skills|hooks, .claude settings). ` +
        'Changing it requires explicit human approval of this specific change (CLAUDE.md Governance Change Control, Mandatory Gate #6). ' +
        'Approve only if you have asked for this exact change.',
    };
  }
  return null;
}

function main() {
  let input;
  try {
    input = JSON.parse(readFileSync(0, 'utf8'));
  } catch (err) {
    process.stderr.write(`governance-guard: could not parse hook input (${err.message}); blocking to stay safe. The hook contract may have changed — see .claude/hooks/governance-guard.mjs.\n`);
    process.exitCode = 2;
    return;
  }
  const file = input?.tool_input?.file_path ?? input?.tool_input?.notebook_path;
  if (typeof file !== 'string') return;
  const decision = evaluate({
    file,
    agentType: input.agent_type,
    projectDir: process.env.CLAUDE_PROJECT_DIR || input.cwd || process.cwd(),
  });
  if (!decision) return;
  if (decision.action === 'deny') {
    process.stderr.write(`${decision.message}\n`);
    process.exitCode = 2;
    return;
  }
  process.stdout.write(JSON.stringify({
    hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'ask', permissionDecisionReason: decision.message },
  }));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
