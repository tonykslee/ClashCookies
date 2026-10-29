# `/layout` post interaction and image-rendering diagnosis

Status: diagnostic only. No production or source behavior was changed by this investigation.

## Executive summary

The repository at `HEAD` is the #1931 revert merge, `8fcb7c153e37a1837366837d116f7e78dfc37d44`. In the TypeScript source, successful Info and Layout Link actions use `interaction.update()`, so they update the canonical public message in place. The only intentional ephemeral path in the current source is `replyLayoutPostError()` for invalid, stale, out-of-scope, or failed interactions.

Production evidence subsequently confirmed that the obsolete PR #1929 compiled implementation was present before redeployment. On the production droplet, the command `docker exec clashcookies-app sh -lc 'grep -n "Layout panel custom ID exceeds" dist/services/LayoutPostService.js || true'` returned `92: throw new Error("Layout panel custom ID exceeds Discord's length limit.");`. Production then emitted `event=interaction_failed ... action=link ... error=Layout panel custom ID exceeds Discord's length limit.` for `legacy-layout-5fe3458a21330780d51c6fc599c91fa8`, and was redeployed successfully. After redeployment, the unwanted ephemeral interaction behavior disappeared. The same obsolete implementation remains as a stale local `dist` artifact, which is consistent with the production finding.

The image analysis remains a source-level hypothesis only. Native images are initially published as an uploaded file referenced by `attachment://filename`. On a later interaction, if `message.attachments.first()` is empty but the existing embed image is exposed as a Discord CDN HTTPS URL, `resolveLayoutPostImageSource()` returns that CDN URL. `interaction.update()` would then retain the native attachment while rebuilding the embed against the CDN URL. This could make the same image render both as an embed image and as an ordinary attachment preview, but the original image observations occurred while production was running the obsolete #1929 code. Whether duplication persists under the corrected deployment is unverified.

## 1. Repository and runtime identity

- `git rev-parse HEAD` is `8fcb7c153e37a1837366837d116f7e78dfc37d44`, the #1931 merge.
- Git history contains #1927 (`1fb4051e`, native-image preservation), #1929 (`0e59ff6e`, ephemeral panels), and #1931 (`0639542c`, restore in-place interactions).
- Current source `src/services/LayoutPostService.ts:319-350` uses `interaction.update()` for Info and Layout Link.
- Local `dist/services/LayoutPostService.js:334-350` uses `interaction.reply(buildLayoutPostPanelPayload(...))`, which is the old #1929 behavior; it also contains panel-only code absent from current source.
- `dist/services/LayoutPostService.js` is ignored/untracked and has a local timestamp of 2026-10-29 09:35:29, earlier than the current merge commit at 10:07:16.
- `src/ClashCookies.ts:25-45` emits `[startup:build] git_sha=... build_sha=...`. `package.json` makes `npm start` rebuild before `start:runtime`; `ops/deploy/container-start.sh` invokes `npm run start`.

Confirmed production facts: the pre-redeployment production artifact contained the obsolete #1929 panel code; the custom-ID length error came from that old panel implementation; redeployment removed the observed ephemeral behavior. The current source restores in-place Info and Link.

Still-unverified runtime facts: whether native-image duplication persists after the corrected deployment, the corrected deployment's exact startup SHA/container digest, the number of active bot sessions after redeployment, and the live Discord message JSON before and after the corrected-deployment clicks. No post-redeployment image metadata was provided.

## 2. Info-button execution paths

### Current source path

`src/listeners/interactionCreate.ts:1003-1008` routes any recognized `layout:` button custom ID to `handleLayoutButtonInteraction()`. `src/services/LayoutPostService.ts:280-316` then:

1. Parses the custom ID.
2. Loads the `LayoutRecord` by ID.
3. Validates guild, channel, and canonical message provenance.
4. Validates the confirmation episode token when the action is `confirm`.

For a valid Info click, `src/services/LayoutPostService.ts:318-343` resolves image metadata, reads the durable alert policy, optionally resolves the typed `layout-alerts` channel, then calls `interaction.update()` with the public Info payload. This is a successful in-place update, not an ephemeral response.

### Every current source path that can appear ephemeral

| Path | Source evidence | Result |
|---|---|---|
| Malformed/obsolete layout ID | `LayoutPostService.ts:281-284` | `replyLayoutPostError()` |
| Missing record or guild/channel/message scope mismatch | `LayoutPostService.ts:288-295` and `438-443` | `replyLayoutPostError()` after `scope_rejected` log |
| Legacy confirmation without an episode token | `LayoutPostService.ts:299-306` | Ephemeral error |
| Stale confirmation token | `LayoutPostService.ts:308-315` | Ephemeral error |
| Alert policy database/settings lookup throws | `LayoutPostService.ts:320-333`, inside the outer `try` | Falls into the generic error handler |
| Typed `layout-alerts` lookup throws | `LayoutPostService.ts:323-333`; `BotLogChannelService.ts:212-223` | Falls into the generic error handler |
| `interaction.update()` rejects before Discord marks the interaction responded/deferred | `LayoutPostService.ts:334-341`, then `374-381` | The generic error handler may send an ephemeral error |
| `interaction.update()` rejects after the interaction is already acknowledged | `LayoutPostService.ts:631-640` | `replyLayoutPostError()` returns without sending a second response; the user sees a timeout/error rather than a successful ephemeral Info panel |

`LayoutAlertConfigService.getPolicy()` itself returns either a row or `null` (`LayoutAlertConfigService.ts:162-164`). Missing policy is not an error. `BotLogChannelService.getChannelIdForType()` returns `null` for missing or malformed settings (`BotLogChannelService.ts:212-223`), and the Info renderer shows “not configured” rather than making Info ephemeral.

### Old code, stale deployment, or duplicate listener possibilities

- Confirmed: the old #1929 source explicitly used `interaction.reply(buildLayoutPostPanelPayload(...))` for Info and Link, and the production artifact contained that implementation. The observed `Layout panel custom ID exceeds Discord's length limit` error came from that old panel code when Layout Link was clicked.
- Confirmed: production was redeployed and the unwanted ephemeral behavior disappeared afterward.
- `src/listeners/interactionCreate.ts:253-254` and `601-607` use a per-`Client` `WeakSet` to prevent registering this listener twice in one process. That does not prevent two separate bot processes or old and new deployments from receiving the same interaction.
- Two live instances would race to acknowledge one interaction. That can produce one successful response and one failed/expired response, but there is no evidence that this remained true after redeployment.
- A stale component on a moved, replaced, or non-canonical message reaches the scope check and intentionally receives an ephemeral error. It cannot produce a successful public Info update from current source.

### Info conclusion

Confirmed: the obsolete compiled #1929 implementation was present in production before redeployment; its panel custom-ID construction produced the observed length error; and redeployment resolved the observed ephemeral behavior. Confirmed from repository: current source has no successful ephemeral Info path and restores public in-place Info/Link updates. The corrected deployment's current image behavior is a separate, open question.

## 3. Native image publication and interaction trace

### Initial `/layout post ... image:<attachment>`

`src/commands/Layout.ts:144-148` reads the attachment. Validation occurs at `Layout.ts:184-191`, and `Layout.ts:210-215` passes it to `LayoutPostPublicationService.publish()`.

For a native upload, `LayoutPostPublicationService.publish()`:

- downloads and sanitizes the Discord attachment (`LayoutPostPublicationService.ts:420-445`);
- treats the rendered record as `imageUrl: null` (`:110-114`);
- builds the collapsed embed with `attachment://<sanitized filename>` and uploads one `files[0]` (`:150-158`, `:734-736`);
- binds the message as canonical, then persists native ownership only after successful publication (`:160-198`, `:382-418`).

For an existing canonical post, `publish()` edits that same message (`:114-147`). A native replacement supplies the new file and `attachments: []` in `buildEditPayload()` (`:738-747`), which intentionally removes old attachments. That is a replacement operation, not a repost of the canonical message.

### Interaction update

`getCurrentMessageImageSource()` calls `resolveLayoutPostImageSource()` (`LayoutPostService.ts:536-550`). The resolver has this precedence:

1. `message.attachments.first()` → attachment name and CDN URL, kind `attachment_collection`.
2. Existing embed image URL beginning `attachment://` → decoded attachment name, kind `embedded_attachment`.
3. Existing embed image URL beginning `http(s)://` → URL, kind `embedded_url`.
4. No usable metadata → `none` or `metadata_unavailable`.

`resolveImageUrl()` (`LayoutPostService.ts:522-534`) prefers the durable external `LayoutRecord.imageUrl`, then `attachment://filename`, then an attachment/CDN URL. Info, Link, Close, and auto-collapse all rebuild the public embed and use `interaction.update()` or `message.edit()` (`LayoutPostService.ts:334-369`, `401-418`). These interaction payloads contain no `files` and no `attachments` array.

### Discord attachment semantics

The Discord API documents that a message's `attachments` field contains files not referenced in embeds or components, and that uploaded files can be referenced inside an embed using `attachment://filename` ([Message Object](https://docs.discord.com/developers/resources/message#attachment-object), [Uploading Files](https://docs.discord.com/developers/reference#uploading-files)). On message edits, omitting `attachments` retains existing files; supplying `attachments: []` removes them. Discord also documents that a CDN URL may be used in an embed image and that attachment CDN URLs are signed ([Editing Message Attachments](https://docs.discord.com/developers/reference#uploading-files)). discord.js exposes the same rule: omitted edit attachments are kept ([MessageEditOptions](https://discord.js.org/docs/packages/discord.js/main/MessageEditOptions%3AInterface), [InteractionUpdateOptions](https://discord.js.org/docs/packages/discord.js/main/InteractionUpdateOptions%3AInterface)).

Therefore, the current interaction update does not create a second upload. It retains the original attachment and changes only the embed/components payload.

### Image duplication diagnosis

The #1927 fallback is the code-level defect most consistent with the report:

1. The initial message is created with `attachment://base.png`, which correctly associates the native file with the embed.
2. Discord may expose the attachment as absent from `message.attachments` because it is referenced by the embed, while exposing the embed image as a CDN HTTPS URL. The current client does not request `GatewayIntentBits.MessageContent` (`src/ClashCookies.ts:47-54`), but this is not evidence of missing metadata for this case: Discord exempts content in messages sent by the app—including these bot-authored canonical messages—from the Message Content restriction ([Gateway Message Content Intent](https://docs.discord.com/developers/events/gateway#message-content-intent)). Do not enable the privileged intent without separate evidence that the corrected production interaction payload is missing needed fields.
3. The #1927 resolver classifies the CDN URL as `embedded_url`, and `resolveImageUrl()` rebuilds the embed with that CDN URL instead of `attachment://base.png`.
4. The interaction edit omits `attachments`, so the native file is retained. The embed now points at the same bytes through HTTPS while the retained file is no longer referenced by the embed. Discord can consequently render the embed image and the ordinary attachment preview.
5. On a subsequent Close click, if Discord now exposes the retained file through `attachments.first()`, the resolver takes the first branch and rebuilds the embed with `attachment://base.png` again. That explains why Close can restore the normal appearance without deleting the file.

This is a source-level hypothesis, not a confirmed production root cause. The original duplication observations were made while production was running obsolete code, so they do not prove that the reverted implementation has the same problem. The required live evidence after the corrected deployment is the pre-click and post-click tuple:

`attachments.first().name`, `attachments.first().url`, `embeds[*].image.url`, attachment count, attachment content type, and the actual PATCH payload/response.

Other findings:

- The ordinary attachment is not created by `interaction.update()`; no `files` field is sent there.
- The code does not verify that the first message attachment is an image in the interaction resolver. A message with multiple attachments could select the wrong first file; this is a separate edge case.
- External HTTPS image URLs are durable `LayoutRecord.imageUrl` values and win over the message fallback, so this native-attachment duplication path does not apply to ordinary external image URLs.
- The two-minute timer captures the image source used at expansion time (`LayoutPostService.ts:393-418`). If expansion captured the CDN fallback, automatic collapse repeats that source; it does not independently repair the presentation.

## 4. Payload-level evidence and tests

The focused suite passed without source changes:

```text
3 test files passed
70 tests passed
```

Relevant proof boundaries:

| State | Payload evidence from current code/tests | What it proves |
|---|---|---|
| Initial external image | One embed image with the persisted HTTPS URL; no upload file | External URL rendering path is deterministic |
| Initial native image | One uploaded file and `attachment://filename` embed reference | Publication intends one native image and one embed reference |
| Info/Link/Close/auto-collapse | Rebuilt embed; no `files`; no explicit `attachments` array | Interaction path does not upload a second file and relies on Discord retaining the attachment |
| Attachment collection fallback | Uses `attachment://filename` | Safe when a filename is available |
| Embedded attachment fallback | Uses decoded `attachment://filename` | Safe for that metadata shape |
| Embedded HTTPS fallback | Uses the HTTPS URL | This is the suspected native-image regression when the HTTPS URL is a Discord attachment CDN URL |

`tests/layoutPost.service.test.ts` covers all four actions, fallback kinds, timer collapse, scope mismatch, stale confirmation, and alert-policy rendering. `tests/layoutPost.publication.test.ts` covers native upload, native replacement, native ownership, and preservation during publication edits. The tests assert embed JSON and mock calls; they do not prove Discord client rendering, the live attachment collection contents, the live API PATCH body, or whether an image is shown outside the embed.

## 5. Minimal reproduction and required live capture

1. Against the corrected production deployment, publish or update an existing canonical record with `/layout post link:<existing link> image:<native image>`.
2. Exercise Link, Info, Close, and the two-minute automatic collapse.
3. Repeat with an external HTTPS image URL.
4. If native duplication persists, capture the message JSON before and after each action, including `attachments`, `embeds`, attachment filename, URL, content type, and message flags.
5. If native duplication persists, capture whether the embed image URL changed from `attachment://filename` to a Discord CDN HTTPS URL and the exact `interaction.update()`/`message.edit()` payload.
6. Correlate the click time with `[startup:build]`, `[layout-post] event=image_source_fallback`, `event=image_source_unresolved`, `event=interaction_failed`, and `event=auto_collapse_failed` logs.

For Info, also record whether the response was `UPDATE_MESSAGE` or an ephemeral `CHANNEL_MESSAGE_WITH_SOURCE`, the corrected deployed SHA, and whether more than one process was connected with the bot token.

## 6. Smallest viable follow-up fixes

### Successful Info appears ephemeral

If startup logs show a SHA before #1931, or the deployed artifact contains `buildLayoutPostPanelPayload`, the smallest fix is operational: rebuild the image/artifact from `8fcb7c153e37a1837366837d116f7e78dfc37d44` or a later approved commit, restart every old bot instance, and verify one startup line per active process. No code change is needed for the intended current-source path.

Current-source error replies should remain ephemeral. If a valid Info click is found to enter the error path, fix the underlying lookup/update failure rather than converting the error to a public update.

### Native image duplication

No implementation fix is currently justified. First retest the corrected deployment. If duplication persists, confirm the live metadata and only then evaluate a localized image-source change. A possible fix would be preserving/recovering `attachment://filename` for a verified Discord attachment CDN URL while keeping arbitrary external HTTPS URLs as `embedded_url`, but this remains conditional and must not be implemented from the pre-redeployment observations alone.

If the corrected production interaction payload is unexpectedly missing needed fields, investigate the bot-authored-message exception and the existing resolver/fetch path first. Do not recommend enabling `MessageContent` without additional production evidence.

## 7. Risks and regressions

- Treating every HTTPS URL as a native attachment would break legitimate external image URLs and signed-URL refresh behavior.
- Reconstructing `attachment://` from an arbitrary filename can bind the embed to the wrong attachment if a message has multiple files; use canonical-message/channel evidence and image metadata.
- Explicitly sending `attachments: []` during interaction updates would remove the native image and violate native-image support.
- Fetching the message before every interaction adds latency and another Discord failure path; it must preserve the three-second interaction response budget.
- Enabling `MessageContent` is a privileged-intent and deployment configuration change; it is not justified solely by a local stale artifact.
- Changing Info/Link back to ephemeral panels would violate the canonical public-message and in-place interaction requirements and is out of scope.

## 8. Exact follow-up PR scope

1. No source implementation PR for image rendering should be opened until corrected-production retesting confirms that duplication persists.
2. If it persists, keep the public canonical message and current `interaction.update()` flow unchanged.
3. Then modify only the confirmed native-image source-resolution path, preserving arbitrary external HTTPS URLs.
4. Add focused tests only in that follow-up PR for the confirmed behavior; this diagnostic update does not modify tests.
5. Add bounded diagnostic logging only if needed to capture source kind, attachment count, filename presence, and message ID—without logging raw image URLs or bytes.
6. Verify against a live Discord message and record the before/after payloads.
7. Keep deployment repair, privileged-intent decisions, persistence, schema, canonical ownership, alerts, confirmation, reposting, and unrelated interaction behavior out of scope unless new evidence requires a separately approved change.

No persistence, schema, canonical ownership, alert policy, confirmation, repost, or unrelated interaction behavior should change.

