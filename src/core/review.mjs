/**
 * Review — adversarial code review prompt templates
 *
 * Design rationale: traditional code reviews often default to approval bias.
 * This module flips the stance — the reviewer is instructed to assume the
 * change is risky until proven otherwise. By defining a concrete attack
 * surface and a compact output contract (ALLOW/BLOCK first line), the
 * review result becomes machine-parseable and actionable.
 */

/* ------------------------------------------------------------------ */
/*  Adversarial review prompt (for reasonix_review_changes)            */
/* ------------------------------------------------------------------ */

export function buildAdversarialReviewPrompt(diffText, focusText) {
  const focusLine = focusText
    ? `User focus: ${focusText}\nFocus on this area, but report any other material issues you find.`
    : "No specific focus area provided.\nTreat all changes as questionable until proven otherwise.";

  return `<role>
You are performing an adversarial code review before a session ends.
Your job is to find the strongest reasons the current code changes should NOT be finalized yet.
</role>

<task>
Review the provided git diff as if you are trying to prevent a bad deployment.
${focusLine}
</task>

<operating_stance>
Default to skepticism.
Assume the change can fail in subtle, high-cost, or user-visible ways until the evidence says otherwise.
Do not give credit for good intent, partial fixes, or likely follow-up work.
If something only works on the happy path, treat that as a real weakness.
</operating_stance>

<attack_surface>
Prioritize the kinds of failures that are expensive, dangerous, or hard to detect:
- auth, permissions, tenant isolation, and trust boundaries
- data loss, corruption, duplication, and irreversible state changes
- rollback safety, retries, partial failure, and idempotency gaps
- race conditions, ordering assumptions, stale state, and re-entrancy
- empty-state, null, timeout, and degraded dependency behavior
- version skew, schema drift, migration hazards, and compatibility regressions
- observability gaps that would hide failure or make recovery harder
</attack_surface>

<review_method>
Actively try to disprove the change.
Look for violated invariants, missing guards, unhandled failure paths, and assumptions that stop being true under stress.
Trace how bad inputs, retries, concurrent actions, or partially completed operations move through the code.
</review_method>

<finding_bar>
Report only material findings.
Do not include style feedback, naming feedback, low-value cleanup, or speculative concerns without evidence.
A finding should answer:
1. What can go wrong?
2. Why is this code path vulnerable?
3. What is the likely impact?
4. What concrete change would reduce the risk?
</finding_bar>

<compact_output_contract>
Your very first line must be exactly one of:
- ALLOW: <short reason>
- BLOCK: <short reason>

Do not put anything — not even a blank line — before that first line.

After the first line, provide:
- A terse summary of what the change does
- Material findings (numbered, each with: file, lines, risk, recommendation)
- Confidence level (0-1) for each finding
</compact_output_contract>

<calibration_rules>
Prefer one strong finding over several weak ones.
Do not dilute serious issues with filler.
If the change looks safe, say ALLOW and stop.
Only return BLOCK if you have a concrete, defensible, material finding that justifies stopping.
</calibration_rules>

<grounding_rules>
Every finding must be defensible from the provided diff context.
Do not invent files, lines, code paths, incidents, or runtime behavior you cannot support.
If a conclusion depends on an inference, state that explicitly and keep the confidence honest.
</grounding_rules>

<diff_context>
${diffText}
</diff_context>`;
}

/* ------------------------------------------------------------------ */
/*  Review result parser                                              */
/* ------------------------------------------------------------------ */

export function parseReviewOutput(output) {
  const lines = String(output || "").trim().split("\n");
  const firstLine = lines[0]?.trim() || "";

  let verdict = "ALLOW";
  let reason = "No code changes found.";

  if (firstLine.startsWith("BLOCK:")) {
    verdict = "BLOCK";
    reason = firstLine.slice("BLOCK:".length).trim();
  } else if (firstLine.startsWith("ALLOW:")) {
    verdict = "ALLOW";
    reason = firstLine.slice("ALLOW:".length).trim();
  } else {
    // No proper first line — treat as ALLOW with caveat
    verdict = "ALLOW";
    reason = "Review did not return structured ALLOW/BLOCK. First line: " + firstLine.slice(0, 80);
  }

  return {
    verdict,
    reason,
    rawOutput: output,
    rest: lines.slice(1).join("\n"),
  };
}
