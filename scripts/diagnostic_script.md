TASK
Use the ISSUE BLOCK below as the only starting input. It may contain a few sentences, bullets, stack traces, logs, or mixed notes about a regression or bug.

Work in the current repository and complete a full diagnostic cycle:
- discover the real execution path
- localize the failure
- identify the root cause
- implement the smallest safe fix
- verify the result with the best available checks

ISSUE BLOCK
<<< paste your bug report / logs / symptoms here >>>

RULES
- Do not assume the issue description is fully accurate.
- Do not jump straight to code changes.
- Prefer evidence from code paths, tests, logs, and runtime behavior over guesswork.
- Make reasonable assumptions and keep moving unless blocked by missing external access or genuinely ambiguous risk.
- Avoid large refactors, unrelated cleanup, or speculative improvements.
- If temporary instrumentation is needed, keep it targeted and remove it unless it provides lasting value.

REQUIRED WORKFLOW

1. Triage
- Restate the reported problem precisely.
- Extract likely affected entrypoints, components, and failure modes from the issue block.
- Note any assumptions.

2. System Mapping
- Trace the end-to-end execution path from the user-facing entrypoint to the final output or side effect.
- For each stage, identify the responsible file and function.
- Present a compact flow map.

3. Failure Localization
- Find the exact stage where behavior diverges from expectation.
- Add targeted logging, tests, or reproduction steps if needed.
- State the evidence for the failing stage.

4. Root Cause
- Explain the underlying defect, why it causes the observed symptom, and when it is triggered.
- Distinguish the symptom from the actual root cause.

5. Fix Plan
- Describe the minimal changes required before editing files.
- Explain why this is the smallest safe fix.

6. Implementation
- Apply the minimal code changes needed.
- Preserve existing architecture, conventions, and behavior outside the defect scope.
- Add or update a focused regression test if the repo already has a relevant test pattern.

7. Verification
- Run the most relevant checks available (targeted tests, repro path, build, lint, typecheck, etc.).
- Confirm the expected behavior after the fix.
- If any check cannot be run, say exactly what was not verified.

OUTPUT FORMAT
Return results in this order:
1. Issue summary
2. Execution path
3. Failure point
4. Root cause
5. Fix implemented
6. Verification
7. Residual risks or follow-ups

SUCCESS CRITERIA
- The real failure point is identified with evidence.
- The fix is minimal, scoped, and directly tied to the root cause.
- Verification is performed or gaps are explicitly called out.
- No unrelated refactors or cleanup-only edits are included.
