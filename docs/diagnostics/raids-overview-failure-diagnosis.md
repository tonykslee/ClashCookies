# `/raids overview` failure diagnosis

## Confirmed by code and controlled tests

- Raid-history failures are kept separate from genuinely empty histories. An all-failed source returns a retryable user response, while partial failures remain visible in the overview diagnostics.
- CoC request deadlines are owned by the shared queue and begin when a task is dispatched for HTTP execution. Queue wait, including 429 backoff, does not consume the network deadline. An in-flight timeout aborts the request through its `AbortSignal` before the queue dispatches more work.
- Raid-history diagnostics use the shared telemetry error taxonomy, preserving HTTP 401, 403, and 429 codes as distinct from timeout, invalid-response, and unknown failures.
- Raid overview metadata requests remain serial at the shared dispatcher boundary. Request counts and elapsed durations are logged; the overview does not bypass queue pacing.

## Not confirmed in production

The production root cause is not proven by this change. The available investigation did not include application container logs or a production reproduction, so upstream API failure, queue delay, and deployment-specific behavior remain hypotheses until production telemetry identifies the failing category and timing. This change adds diagnostics to make that distinction observable without changing raid-intel persistence or ownership.
