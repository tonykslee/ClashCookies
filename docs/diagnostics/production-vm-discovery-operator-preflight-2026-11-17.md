# Production VM discovery operator preflight — 2026-11-17

> **ARCHIVED / SUPERSEDED (owner decision Nov 19, 2026):** This document records historical investigation of the now-withdrawn replacement deployment architecture. Do not run its collector, installation, Gate 1 commands, or proposed broker. The existing `~/deploy-prod.sh` workflow remains the deployment path; see rollback PR #2086 and `docs/deployment.md`.

**Status:** documentation and review only. No production VM, SSH session, checkout, Docker daemon, database, credential, backup unit, staging resource, or discovery invocation was accessed by this change.

This preflight is the operator procedure for the already merged, read-only discovery tooling from [PR #2027](https://github.com/tonykslee/ClashCookies/pull/2027). It is deliberately separate from release authorization. The operator must stop if any prerequisite requires installing a tool, changing permissions or ownership, creating an unapproved VM directory, reading a secret, running a wrapper, or changing a production resource.

## November 17 approved archive delivery — completed (operator/Codex-reported PASS)

- **Result and provenance:** Following the separate, explicit owner approval for transfer, extraction and verification, Codex reported **PASS — delivery completed during the task**, not previously present. These are fresh Codex-reported workstation/remote checks conveyed by the operator, **not independently reproduced by GitHub or ChatGPT**. Remote authentication used the existing `clash-vm` alias as `tilo` (UID/GID `1000:1000`); archive transfer used exclusive creation and did not overwrite a destination.
- **Pinned source:** commit `1cb81528ea34dd25f51613557d6f6030fddd0b3a`. Local archive `C:\Users\tonyk\clashcookies-production-vm-discovery-1cb81528.tar`; remote archive `/home/tilo/.clashcookies-discovery/clashcookies-production-vm-discovery-1cb81528.tar`. Both SHA-256: `8138275d0f18451ea02955357c3f2e7c22c729175c575033aae64bff7dc81015`.
- **Exact six TAR members:** three ordinary directory entries (`ops/`, `ops/deploy/`, `ops/deploy/discovery/`) and exactly three regular files: `ops/deploy/direct-docker-adapter.js`, `ops/deploy/discovery/production-vm-discovery.sh`, and `ops/deploy/discovery/runtime-contract-validator.js`. Codex reported no duplicate, absolute, traversal, symlink, hard-link, special or unexpected members.
- **Exact extracted regular files:** `ops/deploy/discovery/production-vm-discovery.sh`: SHA-256 `bb56d8e4ff9cd8d7d2652ef6fb3fbc6dd07e98ca3b0d65252c8a7a2ec9626da9`, 35,191 bytes, owner `1000:1000`, mode `0664`; `ops/deploy/discovery/runtime-contract-validator.js`: SHA-256 `e2fbc31275003aa631aa16b984e6d2a8eaabef57646b377b82e02d27a20e27d6`, 1,589 bytes, owner `1000:1000`, mode `0664`; `ops/deploy/direct-docker-adapter.js`: SHA-256 `379490aa007ecf6d036d5ef95e6b5ed07c5d4fdf726904bbd152ee1486032666`, 49,084 bytes, owner `1000:1000`, mode `0664`.
- **Isolation and metadata:** `/home/tilo/.clashcookies-discovery` and extraction root `/home/tilo/.clashcookies-discovery/production-vm-discovery-1cb81528` were reported canonical, real nonsymlink directories, owner `1000:1000`, mode `0700`. The private parent contains only the approved TAR and extraction root; the root contains exactly three ordinary directories (owner `1000:1000`, mode `0775`) and the three files, with no links or special entries. The enclosing private `0700` directories provide the stated access boundary; `0775` internal directory modes must not be confused with root permissions.
- **Change scope:** Only the approved remote TAR and the three extracted directories/files were created. Codex reported no other VM modifications or overwrite. The local repository was unchanged apart from the **pre-existing** untracked `powershell` file; local `origin/dev` was reported at `e4247885` while GitHub `dev` had advanced to `f9e4224` (do not imply they were synchronized).
- **Next separate gates:** Delivery PASS is **not** discovery collector execution or evidence validation. Private workstation-side stdout-only capture setup requires its own approval; one bounded collector invocation requires another approval. Neither has occurred. No helper/validator invocation, deployment wrapper, Docker, DB, secrets, backup, migration, timer, staging or release action occurred. Preserve the safeguards in sections 3–9, including independently identifying protected paths before any collector execution; release PR #1983 remains out of scope.

## November 17 local preparation checkpoint (operator/Codex-reported)

- **PASS — local archive preparation and offline verification:** The operator created `%USERPROFILE%\clashcookies-production-vm-discovery-1cb81528.tar` from pinned commit `1cb81528ea34dd25f51613557d6f6030fddd0b3a`. Codex subsequently reported exactly three regular files with the pinned SHA-256 hashes in section 1, plus only the normal TAR directory entries `ops/`, `ops/deploy/` and `ops/deploy/discovery/`. No symlinks, unexpected files, or other entry types were reported.
- **Archive provenance:** Codex reported archive SHA-256 `8138275d0f18451ea02955357c3f2e7c22c729175c575033aae64bff7dc81015` unchanged across verification. This is **operator/Codex-reported local evidence**, not independently inspected by ChatGPT or verified on the VM. Existing untracked `powershell` was preserved; no SSH, VM, Docker, production, transfer, or script execution occurred in this milestone.
- **Approved next narrow phase:** The user approved **read-only VM delivery preparation checks** to identify a suitable isolated private destination, verify operator identity and existing access/permissions, and return findings. This does **not** authorize transferring the archive, creating any VM directory, changing ownership/mode, installing tools, configuring capture, running the collector, or accessing secret contents. The permission is restricted to non-mutating prerequisites needed to select the destination. If Codex cannot establish access without new credentials or privilege escalation, stop and report `UNKNOWN/BLOCKED`; do not fall back to repeated ad hoc operator commands unless genuinely necessary.
- **Separate authorization gates unchanged:** Actual delivery (including any specifically named directory creation), protected workstation-side stdout-only evidence capture, and one bounded discovery invocation each still require distinct explicit approval. A verified local archive is not live runtime, wrapper, lock, database, backup, or release evidence. The script caveats in section 9 and release PR #1983's block remain unchanged.
- **Workflow:** [PR #2034](https://github.com/tonykslee/ClashCookies/pull/2034) merged the Codex-first autonomous execution preference into `docs/ai-development-workflow.md`; use one focused Codex task for eligible checks without treating autonomy as production authorization.

## November 17 SSH recovery and isolated directory authorization checkpoint (operator/Codex-reported)

- **SSH authentication recovered (PASS for new connections):** Windows CMD and Codex initially observed `Permission denied (publickey)` using the existing `clash-vm` alias. The configured Windows identity `C:\Projects\droplet_clashcookies` had a public fingerprint matching an existing `tilo` authorized key. A direct interactive SSH command prompted for the private key passphrase and returned `tilo`; the failed batch-mode attempts had no usable agent. The operator enabled the existing Windows OpenSSH `ssh-agent` service for manual startup, started it, and loaded the existing passphrase-protected identity. A subsequent `ssh -o BatchMode=yes -o ConnectTimeout=10 clash-vm "whoami"` returned `tilo`. Codex subsequently reported its own authenticated SSH access as PASS. **No private key contents or passphrase are recorded.** Agent readiness is session/environment-dependent and must be rechecked in future sessions; do not assume a live connection.
- **VM identity and delivery tooling (Codex-reported PASS):** Existing operator `tilo`, UID/GID `1000/1000`, groups `tilo`, `sudo`, `users`, `docker`. GNU `tar` 1.35, `sha256sum` 9.4, `stat`, `readlink` and `find` were available. Existence of these privileges or tools is **not authorization** to use privileged functionality.
- **Initial destination checks (BLOCKED):** The `/operator-approved` example paths did not exist; `/home/tilo` was owner `tilo:tilo`, mode `0755`, so it was not itself private. `/home/tilo/apps` was mode `0775`; `/home/tilo/apps/clashcookies-prod` is explicitly excluded. No existing suitable isolated private parent or complete destination was verified. The pinned archive remained unchanged, SHA-256 `8138275d0f18451ea02955357c3f2e7c22c729175c575033aae64bff7dc81015`; the local untracked `powershell` was preserved.
- **Explicitly approved next action — directory creation/verification only:** The owner approved creation of exactly `/home/tilo/.clashcookies-discovery` and `/home/tilo/.clashcookies-discovery/production-vm-discovery-1cb81528`, each intended owner `tilo` and mode `0700`, subject to checking existing path objects, canonical paths, symlinks, and parent safety first. If either object already exists unexpectedly or a prerequisite fails, stop without overwriting, changing permissions, or improvising a path. **Execution of the directory-creation task has not yet been reported or verified at this checkpoint; do not mark these paths as existing.**
- **Authorization gates:** No archive transfer or extraction, evidence capture setup, collector invocation, privilege escalation, production/staging modification, deployment, migration, backup/timer activation, or `dev`-to-`main` promotion is approved. After Codex reports directory creation and verifies mode, owner, path and emptiness, obtain separate explicit delivery authorization naming concrete permitted writes. Capture and collection each remain separately gated. No new code or release PR action is implied.

## November 17 isolated staging directory creation — verified operator/Codex report

- **PASS — narrowly authorized directory creation completed:** Codex reported authenticated `tilo` identity, UID/GID `1000:1000`. It verified `/home/tilo` is the canonical nonsymlinked real directory, owner `1000:1000`, mode `0755`.
- **Exactly two approved directories created:** `/home/tilo/.clashcookies-discovery` and `/home/tilo/.clashcookies-discovery/production-vm-discovery-1cb81528`. Codex reported each as a real directory, exact canonical path, no symlink, owner `1000:1000`, mode `0700`, with existing `tilo` read/traverse permission. The private parent contains only the approved child; the staging child is empty. These are **Codex-reported live VM observations**, not an independent ChatGPT host inspection.
- **Scope preserved:** No archive transfer or extraction, collector/script invocation, privilege escalation or unrelated production modification was reported. The local pinned archive and existing untracked `powershell` file remain unchanged. Do not claim discovery execution or readiness for production release.
- **Next gate — requires separate explicit owner approval:** Delivery of the existing pinned archive to a concretely specified location within the new private staging area and extraction of exactly its three pinned regular files, with no overwrite, followed by read-only inventory and SHA-256 checks. The previous directory-creation authorization **did not authorize archive transfer or extraction**. Before proposing the exact permitted writes, review the operator preflight's transfer and staging rules. Private stdout capture and one bounded collector invocation remain **distinct later authorizations**; no deployment, migration, backup/timer activation, staging modification, or `dev` to `main` promotion is authorized.

## November 17 evidence-encryption preparation — synthetic feasibility PASS, live capture still gated

- **Existing capability:** The Windows workstation has FiloSottile `age` and `age-keygen` version `1.3.2` installed. `rage` was not installed. The backup design uses `age` with public recipients on the VM and private identities off-host; do not reuse the production backup recipients or private identities for discovery evidence. A dedicated evidence recipient and independently managed recovery identity are required.
- **Synthetic stream result:** A disposable local age identity was generated under a temporary directory, used only for testing, and removed. Fixed synthetic SSH stdout containing NUL and CRLF bytes was encrypted and decrypted byte-for-byte; the plaintext and recovered SHA-256 were both `ab6ec652b9b779d8ce69e32652f33a27bc24f7e9b60b7ec6fbb04bc7e0eea5c9`. SSH stderr remained separate. Source nonzero exit, encryption failure, truncated ciphertext and empty output were detected. No plaintext evidence file was created.
- **No-overwrite finding:** Direct `age -o <existing-file>` overwrote a synthetic existing file and is not an acceptable capture sink. The safe design passed separately: open the final ciphertext path with Windows `CreateNew`/Node `wx`, then stream `age` stdout into that already-exclusive handle. The disposable ciphertext decrypted byte-for-byte and the existing sentinel remained unchanged.
- **Proposed storage:** Use an age ciphertext file under `%USERPROFILE%\clashcookies-production-evidence-20261117`, for example `production-vm-discovery-20261117T<UTC>-1cb81528.ndjson.age`, with separate `.stderr` and `.provenance.json` sidecars. The original JSONL plaintext must never be written to the VM, repository, chat, shared storage or an unencrypted temporary file. Codex created and verified this directory as canonical, non-reparse, empty, outside the detected OneDrive path, with inherited ACLs containing no broad-principal rules and full control for the current token. EFS was disabled; ciphertext-only storage avoids making whole-drive BitLocker a prerequisite.
- **Capture boundary:** A future wrapper must open the ciphertext and stderr paths exclusively, run the existing SSH client with no TTY and separate stdout/stderr, feed only stdout to `age`, require both SSH and age success, reject empty/truncated/malformed JSONL, calculate ciphertext SHA-256, and preserve incomplete artifacts without treating them as evidence. Offline validation should decrypt through a local pipe into a schema validator without creating a plaintext file.
- **Identity and custody gate:** Exactly one dedicated age v1.3.2 identity was generated. Its public recipient is `age15gwzpsek379vh09r9qylc2td3rzglls9hctum063p8qkqmxhagqqmtee3g`. The primary copy is protected with current-user Windows DPAPI; the stored blob contains no plaintext `AGE-SECRET-KEY` marker. Existing primary and emergency backup identities were not opened or modified, and the private identity was not transmitted to the VM, repository or chat.
- **Recovery validation:** A separate passphrase-encrypted recovery copy was created in the approved OneDrive directory using OpenSSL AES-256-CBC with PBKDF2 (`200000` iterations) and a salt. The Bitwarden-held passphrase was entered only through a masked local prompt and was not passed in arguments or environment variables. Recovery from that copy succeeded without consulting the DPAPI primary copy. Recovery ciphertext SHA-256 is `58a16cce1e788350035a19e0456b2f2af7820505d9f3f354224bee5ca785d42c`.
- **Synthetic validation:** The recovered identity encrypted and decrypted a fixed NUL/CRLF payload byte-for-byte. Plaintext SHA-256 is `0d20eafaebb45b0eed1df16ca2da213124fd5f0b0ce611f8fa6a1b29459070ec`; synthetic age ciphertext SHA-256 is `a9e94829faefe7bd5b0c83fe7b1da21872c418aea390ff27f47c0c7eed4e6aff`. Invalid-passphrase, corrupted-ciphertext, truncated-ciphertext and pre-existing-destination rejection tests all passed.
- **Cloud-copy verification:** The operator verified the exact approved object in the signed-in OneDrive web account and downloaded a separate copy to the restricted local verification directory. Codex observed exactly one regular, non-reparse 96-byte file there and independently calculated SHA-256 `58a16cce1e788350035a19e0456b2f2af7820505d9f3f354224bee5ca785d42c`, matching the trusted local value. The cloud account/session observation is operator-verified; the downloaded bytes and all cryptographic checks are Codex-verified.
- **Independent cloud recovery:** Using only the downloaded cloud copy and a masked local Bitwarden passphrase prompt, Codex recovered the identity in memory without consulting the DPAPI primary copy. The recovered recipient matched `age15gwzpsek379vh09r9qylc2td3rzglls9hctum063p8qkqmxhagqqmtee3g`. A synthetic NUL/CRLF age payload decrypted byte-for-byte; plaintext SHA-256 was `cbc5de59c844a49b6b917c4e20a73deeb4221fe0740bf81339ea574cdeb9c60e`, and synthetic ciphertext SHA-256 was `f122a7a15e6e4319b62f085517b01556cdb2611fbff3e5a3a9b9ed29a20379b7`. Wrong-passphrase, corrupted-ciphertext and truncated-ciphertext rejection all passed.
- **Synchronization boundary:** Cloud existence, filename and size are operator-verified through the signed-in OneDrive web session; the downloaded bytes, hash and recovery are independently verified by Codex. This clears the cloud-copy recovery check, but does not clear authenticated-integrity hardening.
- **Status at earlier AES-CBC checkpoint (superseded by November 17 age verification below):** Workstation identity custody and the legacy cloud-copy recovery were verified, while authenticated-integrity hardening remained open. No collector, runtime helper, production resource or evidence capture was executed.
- **Recovery integrity follow-up (OPEN):** The recovery file's OpenSSL AES-256-CBC/PBKDF2 encryption is not authenticated encryption: failed corruption/truncation tests do not prove arbitrary modification detection. The preferred future design is a separately approved age v1.3.2 passphrase-wrapped recovery object, validated with synthetic material through a protected Windows input path and exclusive no-overwrite handling; an encrypt-then-MAC design with distinct keys is the fallback. Do not replace, re-encrypt, delete or overwrite the current recovery object without explicit migration approval. The recorded SHA-256 is useful for comparing copies only when compared with an independently trusted expected value, not as a standalone authenticity guarantee.
- **Age hardening design (PROPOSED):** The installed age v1.3.2 documentation states that `-p` requests a passphrase interactively from the terminal, passphrase-encrypted identity files are accepted by `-i`, and age files are binary and non-malleable. The proposed new filename is `ClashCookies-Discovery-Evidence-20261117.identity.age`; it must be created exclusively beside the unchanged `.identity.enc` object, then independently downloaded, hashed and recovered before any retirement decision.
- **Disposable age validation:** A disposable in-memory age identity and synthetic payload passed byte-exact encryption/decryption, altered-ciphertext rejection, truncated-ciphertext rejection, and no-persistent-identity-file checks. SHA-256 values were `eaf3649ef6389760826be6942764d3d65b8b6f78f1ea73b060b5dad9983d81c8` for plaintext and `00d27ea25c8e40290eb69178dc2fedffcf884698baf839bdc31a792ccee0179b` for ciphertext. Exclusive `CreateNew` rejected an existing sentinel without changing it; malformed-recipient encryption failed closed with exit 1 and no ciphertext.
- **Native passphrase blocker:** `age -p` v1.3.2 has no passphrase-file/stdin option in its installed help. A redirected-stdin synthetic attempt did not complete within the safety timeout, so Codex did not inject or log a passphrase. The one precise alternative is an operator-run visible Windows CMD age prompt with the passphrase typed locally, or a separately reviewed wrapper using the age library with a protected Windows callback; neither is authorized or implemented here.
- **Next verification sequence:** The cloud-copy existence/hash/recovery sequence is complete. The remaining open item is an explicitly approved migration using the protected age prompt alternative above, followed by cloud download/hash/recovery verification. Do not upload the private identity or passphrase anywhere else or put cloud evidence in Git/chat. Collector execution and protected stdout capture still require their respective explicit authorization.


## November 17 authenticated age recovery migration — operator-reported PASS

- **Implemented (operator-reported):** After separate authorization, the operator launched the locally prepared migration from a visible Windows CMD session. A new, distinct passphrase-protected age v1.3.2 recovery object `ClashCookies-Discovery-Evidence-20261117.identity.age` was created exclusively without overwriting the legacy `.identity.enc` recovery object. New ciphertext SHA-256: `5a050ccea53f37a7ba8c579ba4c58816b8966e01dde4ad4a9f6e07c7550daa6a`. Original `.identity.enc` SHA-256 remained `58a16cce1e788350035a19e0456b2f2af7820505d9f3f354224bee5ca785d42c`; retain both until separately approved retirement.
- **Independent local verification (operator script output):** The read-only verification script reported recovered recipient `age15gwzpsek379vh09r9qylc2td3rzglls9hctum063p8qkqmxhagqqmtee3g`, `RECOVERY_OUTPUT_VALIDATION=PASS`, `SYNTHETIC_RECOVERY=PASS`, `AGE_CHILD_PROCESS_ISOLATION=PASS`, `WRONG_PASSPHRASE_REJECTION=PASS`, and `NONEMPTY_WRONG_PASSPHRASE_ASSERTED=PASS`. The synthetic plaintext SHA-256 was `58fa10c86ae34548d5cc20eb7eb04e9fa14db47839d61ae19ab6f4c04054b175`. Earlier repeated `WRONG_PASSPHRASE_ACCEPTED` results were due to the operator supplying the correct Bitwarden passphrase at the deliberately incorrect test prompt; this was resolved by using the fixed nonempty sentinel. No new identity was generated.
- **Independent cloud-copy verification (operator script output):** Following download of the new `.identity.age` from the approved OneDrive account to a separate local verification path, the checker reported `CLOUD_COPY_SHA256=5a050ccea53f37a7ba8c579ba4c58816b8966e01dde4ad4a9f6e07c7550daa6a`, `CLOUD_COPY_INTEGRITY=PASS`, `PERMANENT_OBJECTS_WRITE_MODE=NONE`, successful recovery of the same recipient, synthetic recovery PASS, wrong-passphrase rejection PASS (child exit 1) and final `STATUS=CLOUD_COPY_VERIFICATION_PASS`. These are operator-provided terminal results, not an independent GitHub or ChatGPT inspection of workstation/cloud files.
- **Remaining gates:** Authenticated age recovery and cloud-copy recovery are now reported PASS; retain the original AES-CBC object as rollback. The protected production wrapper, locks, executor, credential-source metadata and append-only release record must still be independently identified before proposing a collector call. Protected evidence capture and one bounded production discovery collector invocation require separate explicit authorization. No live collector execution, production evidence capture, deployment, migration, timer activation, or release promotion is authorized by this documentation update.

## 1. Pinned delivery source

Use the exact PR #2027 merge commit, not an arbitrary working tree or a later mutable branch checkout:

```text
source commit: 1cb81528ea34dd25f51613557d6f6030fddd0b3a
target branch at review: dev
latest reviewed dev documentation base: e4247885a0061bb78a63add59e8deafc0db7f430
delivery shape: ops/deploy/discovery/
```

The following are the only files to deliver. Their SHA-256 values are over the exact Git blob bytes at that commit; preserve the relative paths and LF content.

| Relative path | SHA-256 |
| --- | --- |
| `ops/deploy/discovery/production-vm-discovery.sh` | `bb56d8e4ff9cd8d7d2652ef6fb3fbc6dd07e98ca3b0d65252c8a7a2ec9626da9` |
| `ops/deploy/discovery/runtime-contract-validator.js` | `e2fbc31275003aa631aa16b984e6d2a8eaabef57646b377b82e02d27a20e27d6` |
| `ops/deploy/direct-docker-adapter.js` | `379490aa007ecf6d036d5ef95e6b5ed07c5d4fdf726904bbd152ee1486032666` |

The Node helper imports the adapter through `../direct-docker-adapter.js`; delivering only the two discovery-directory files is incomplete. Do not deliver tests, the operator guide, a whole repository checkout, credentials, `.env` files, or a deployment wrapper.

## 2. Smallest safe delivery method

### Local Windows CMD — prepare and verify the three-file archive

Use a private local staging location outside the repository. The following command is preparation only; it does not contact the VM or execute discovery. It intentionally uses literal paths and the pre-existing `%USERPROFILE%` value, so it has no same-line dependency on variables set earlier. Stop if the archive already exists rather than overwriting it.

```cmd
if exist "%USERPROFILE%\clashcookies-production-vm-discovery-1cb81528.tar" (echo STOP: archive already exists&&exit /b 1) else (git -C "C:\Projects\ClashCookies" cat-file -e "1cb81528ea34dd25f51613557d6f6030fddd0b3a^{commit}"&&git -C "C:\Projects\ClashCookies" archive --format=tar --output="%USERPROFILE%\clashcookies-production-vm-discovery-1cb81528.tar" "1cb81528ea34dd25f51613557d6f6030fddd0b3a" ops/deploy/discovery/production-vm-discovery.sh ops/deploy/discovery/runtime-contract-validator.js ops/deploy/direct-docker-adapter.js&&tar -tf "%USERPROFILE%\clashcookies-production-vm-discovery-1cb81528.tar")
```

The archive listing must contain exactly the three pinned paths and no symlinks. Verify the extracted files or an equivalent approved transfer copy with `certutil -hashfile <file> SHA256` against the table above. Preserve the archive and its source-commit/hash record as delivery provenance; do not edit files to change line endings.

Transfer the archive only through the operator's approved private channel. Do not put it in the production checkout, a public share, chat, an unencrypted temporary upload, or a directory readable by the bot runtime.

### Remote Linux — select an isolated operator location

The VM destination is intentionally not prescribed. The operator must identify an existing private parent outside `/home/tilo/apps/clashcookies-prod`, or obtain separate authorization for the one-time creation of a fresh child directory beneath that parent. Temporary VM directory creation is not implied by this document.

Before any delivery write, replace the placeholder with the operator-approved location and verify it is not the production checkout, is not a symlink, and is readable/searchable by the operator:

```bash
DISCOVERY_ROOT=/operator-approved/private/path/production-vm-discovery-1cb81528; test -d "$DISCOVERY_ROOT" && test ! -L "$DISCOVERY_ROOT" && test -r "$DISCOVERY_ROOT" && test -x "$DISCOVERY_ROOT" && test "$DISCOVERY_ROOT" != /home/tilo/apps/clashcookies-prod && printf '%s\n' 'isolated discovery root is usable'
```

If a fresh child directory must be created, the delivery authorization must name the exact path and permit only that directory creation. Use a new empty directory, extract the archive there, and do not overwrite existing files. The operator must not use `sudo`, `chmod`, `chown`, `rm`, `mv`, or cleanup as part of delivery. A failed or ambiguous delivery is `BLOCKED`; preserve the archive and do not improvise another location.

After the approved transfer, extract only the archive into that new empty directory. This is the only remote delivery write; it is not the discovery invocation:

```bash
ARCHIVE=/operator-approved/private/incoming/clashcookies-production-vm-discovery-1cb81528.tar; DISCOVERY_ROOT=/operator-approved/private/path/production-vm-discovery-1cb81528; test -f "$ARCHIVE" && test -d "$DISCOVERY_ROOT" && tar --extract --file="$ARCHIVE" --directory="$DISCOVERY_ROOT" --no-same-owner --no-same-permissions --keep-old-files
```

If `tar` reports an existing file, a path traversal/symlink, or any other extraction error, stop. Do not remove or replace the conflicting object.

After the approved transfer and extraction, run this remote read-only verification from the isolated directory. It must report the three files and the exact hashes; any mismatch, extra file, symlink, or missing parent directory is a stop condition.

```bash
DISCOVERY_ROOT=/operator-approved/private/path/production-vm-discovery-1cb81528; test "$(find "$DISCOVERY_ROOT" -type f -print | wc -l)" = 3 && test "$(find "$DISCOVERY_ROOT" -type l -print | wc -l)" = 0 && test ! -L "$DISCOVERY_ROOT/ops/deploy/discovery/production-vm-discovery.sh" && test ! -L "$DISCOVERY_ROOT/ops/deploy/discovery/runtime-contract-validator.js" && test ! -L "$DISCOVERY_ROOT/ops/deploy/direct-docker-adapter.js" && sha256sum "$DISCOVERY_ROOT/ops/deploy/discovery/production-vm-discovery.sh" "$DISCOVERY_ROOT/ops/deploy/discovery/runtime-contract-validator.js" "$DISCOVERY_ROOT/ops/deploy/direct-docker-adapter.js"
```

The `find` count is valid only when `DISCOVERY_ROOT` is a newly created empty staging directory. If the approved location contains anything else, do not delete or clean it; classify delivery `BLOCKED` and obtain a new approved location. The hash verification proves file content, not that the directory is trusted or that the files are executable. The collector is invoked explicitly with `bash` and the Node helper with `node`, so no `chmod` is required.

## 3. Operator prerequisites

Run these as read-only checks after delivery authorization and before any collector authorization. Do not install missing tools, add the operator to a group, start Docker, source a new environment file, or change permissions. A missing command, denied Docker socket, unreadable checkout, or inaccessible evidence destination is `UNKNOWN`/`BLOCKED`, not a reason to use `sudo`.

### Identity, shell, and Node

The collector uses Bash features including `coproc`, `mapfile`, `read -N`, `[[ ]]`, arrays, and lowercase expansion. Require Bash 4 or newer; the reviewed/tested Linux target should use the existing system Bash 5.x. The helper uses CommonJS, `node:` built-ins, optional chaining, `String.matchAll`, and `Array.prototype.at`; use the existing tested Node 20 LTS or a compatible Node at least 16.6. Do not install or switch runtimes for this check.

```bash
DISCOVERY_ROOT=/operator-approved/private/path/production-vm-discovery-1cb81528; id -u; id -g; id -un; id -G; bash --version; node --version; bash -n "$DISCOVERY_ROOT/ops/deploy/discovery/production-vm-discovery.sh"; node --check "$DISCOVERY_ROOT/ops/deploy/discovery/runtime-contract-validator.js"; node --check "$DISCOVERY_ROOT/ops/deploy/direct-docker-adapter.js"
```

Record the UID, GID, username, group IDs, Bash version, and Node version in the private operator record. Do not paste a full login environment or shell configuration into the evidence bundle.

### Required command availability

The collector's external command allowlist is: `awk`, `curl`, `date`, `df`, `docker`, `git`, `id`, `node`, `ps`, `psql`, `sha256sum`, `stat`, `systemctl`, and GNU `timeout`. `bash` is the interpreter. `printf`, `command`, `kill`, `mapfile`, `coproc`, `read`, `wait`, and `test` are shell built-ins. `psql` is needed only when an already configured operator selection is intentionally available; the other commands are required by the normal path.

```bash
for command_name in awk curl date df docker git id node ps psql sha256sum stat systemctl timeout; do command -v "$command_name" >/dev/null 2>&1 || printf 'MISSING %s\n' "$command_name"; done
```

The script requires GNU-style `stat -c`, GNU `timeout` with `--kill-after`, Docker CLI access to the existing daemon, systemd `systemctl`, and a Linux `/proc`/cgroup view compatible with the fixed `ps` command. Do not substitute a different command or wrapper.

### Read-only visibility and permissions

Verify Docker visibility without `sudo` and without `docker exec`, Compose configuration rendering, logs, environment inspection, or full inspect output:

```bash
docker version --format '{{.Server.Version}}'; docker container ls --filter status=running --format '{{.ID}}|{{.Names}}'
```

Verify that the operator can traverse/read the isolated delivery root and the existing checkout. The supplied checkout path `/home/tilo/apps/clashcookies-prod` and legacy wrapper path `/home/tilo/deploy-prod.sh` are operator-reported context and still require live identity verification; they do not confirm any protected lock, credential, executor, or release-record path.

```bash
DISCOVERY_ROOT=/operator-approved/private/path/production-vm-discovery-1cb81528; DISCOVERY_APP_DIR=/home/tilo/apps/clashcookies-prod; test -r "$DISCOVERY_ROOT/ops/deploy/discovery/production-vm-discovery.sh" && test -r "$DISCOVERY_ROOT/ops/deploy/discovery/runtime-contract-validator.js" && test -r "$DISCOVERY_ROOT/ops/deploy/direct-docker-adapter.js" && test -d "$DISCOVERY_APP_DIR" && test -r "$DISCOVERY_APP_DIR" && test -x "$DISCOVERY_APP_DIR"
```

Verify checkout identity without fetching, checking out, refreshing, or modifying it:

```bash
DISCOVERY_APP_DIR=/home/tilo/apps/clashcookies-prod; git -C "$DISCOVERY_APP_DIR" rev-parse --show-toplevel; git -C "$DISCOVERY_APP_DIR" rev-parse --verify HEAD; GIT_OPTIONAL_LOCKS=0 git -C "$DISCOVERY_APP_DIR" status --porcelain=v1 -uall --branch
```

The output must be reviewed against the separately supplied production identity. Existing tracked changes, unexpected branch/HEAD, or inability to establish the checkout identity is a stop condition. Preserve all untracked files; do not clean them.

### Evidence destination

Choose a private, encrypted destination outside the VM, outside the repository, and outside ordinary chat or shared-drive history. The destination must be writable by the operator and restricted to the operator/review group under the applicable retention policy. Verify the local Windows ACL before collection; do not put the JSON Lines file on the VM.

```cmd
if not exist "%USERPROFILE%\clashcookies-production-evidence-20261117" mkdir "%USERPROFILE%\clashcookies-production-evidence-20261117"&&icacls "%USERPROFILE%\clashcookies-production-evidence-20261117"
```

If the ACL is broader than the approved evidence policy, stop. Do not loosen or repair it as part of discovery; use an already approved destination. Use the concrete stdout-only capture method in section 5; the final original stdout must land in this private destination without being edited.

## 4. Independently identify protected resource paths

The following locations are **UNKNOWN until independently established**. The paths shown in older examples, including `/run/lock/clashcookies-prod-deploy.lock`, `/run/lock/clashcookies-prod-migration.lock`, `/home/tilo/deploy-assets/REVIEWED-HELPER.sh`, `/etc/clashcookies/production-db.env`, and `/var/lib/clashcookies/release-record.ndjson`, are not confirmed VM configuration and must not be copied into the invocation merely because they appear plausible.

Identify each path from an approved deployment inventory, the exact live wrapper's reviewed control flow, or the corresponding reviewed service/runner configuration. Do not execute the wrapper, read credential contents, dump environments, print process arguments, search the whole filesystem, or make a new path to satisfy the collector.

1. **Legacy deployment wrapper:** independently confirm the exact existing wrapper that the deployment operator uses, then set `DISCOVERY_WRAPPER_PATH` to that regular file. The collector's marker scan is only a redacted heuristic; a `wrapper_control_flow` `PASS` is not proof that the wrapper participates in the repository lock contract.
2. **Shared release lock and parent:** from a controlled review of the wrapper and [the lock contract](../../ops/deploy/deployment-lock.md), identify the one host-level lock directory and its parent. Verify metadata for both without creating, acquiring, deleting, or repairing the lock. The lock path must remain `UNKNOWN` if the wrapper does not reveal a canonical path.
3. **Migration runner lock:** identify the distinct inner lock from the reviewed migration-runner configuration. It must not equal the release lock and must not be inferred from a filename. Do not acquire it.
4. **Protected deployment executor:** identify the exact immutable helper invoked by the reviewed deployment path. Verify only regular-file metadata and, if the operator's approved record has one, the expected SHA-256. Never execute it or print its contents.
5. **Protected database credential source:** identify the existing source used by the reviewed migration runner without reading it. Verify only path, regular-file type, owner, group, and mode. Do not `cat`, `source`, `grep`, or export its value. A production `.env` with permissive mode is not an acceptable credential boundary.
6. **Append-only release record:** identify the exact existing record target and parent from the reviewed deployment path. Verify metadata only; do not create, append, truncate, rotate, or test-write it. Existence and mode do not prove append-only protection or release readiness.

For every unconfirmed location, omit the corresponding variable only after noting that the current merged script has a non-empty default for `DISCOVERY_LOCK_PATH`. Because that default is an unverified guess, the operator must not rely on omission for the shared lock: either provide an independently confirmed path or stop and classify the protected-lock gate `UNKNOWN/BLOCKED`. Unknown locations must remain unknown in the review record.

## 5. Exact bounded invocation — proposed, not executed

This is the only proposed collector invocation. It is intentionally one bounded call and must not be run by Codex or as part of this documentation task. The operator may execute it only after the separate authorization gate in section 8 is approved.

### Capture method — existing approved SSH client

This section applies only to the later discovery collector and retained JSONL evidence. It does not govern the fixed Gate 1 prerequisite probe, whose bounded summaries may be reviewed transiently in a protected operator terminal after its separate SSH authorization. Do not route the prerequisite probe through this capture method, create a ciphertext destination for it, or treat terminal review as retained provenance.

Use the operator's existing approved noninteractive SSH client/session in **remote-command mode**, with its stdout-capture feature configured before execution to write the remote command's stdout byte-for-byte to the already approved local evidence file outside the VM. The operator must supply the existing host, identity, and local destination; this document intentionally invents none of them. Do not open an interactive shell, use a terminal transcript, copy/paste output, or redirect stdout to a VM path.

Configure the client in this order:

1. Select the operator's existing approved production host and identity from its already authorized configuration; do not type or disclose credentials here.
2. Select `remote command`/noninteractive execution and configure **stdout only** capture to the restricted local evidence file. Keep SSH diagnostics/stderr separate and do not merge them into the evidence file.
3. Confirm the local file is outside the VM, private under the approved ACL, and either absent or protected by the client's no-overwrite policy. Capture authorization is separate from discovery execution authorization.
4. Paste the single remote command below as the remote command. Do not add `tee`, `sudo`, an interactive shell, a wrapper, or any other command.
5. After the client reports remote command completion, close the capture without editing the file and preserve the original artifact and provenance record.

If the client cannot guarantee stdout-only capture, cannot write the local file, adds banners/prompts to the captured stream, or disconnects before a complete JSON Lines stream is received, stop and classify capture `INCOMPLETE`/`BLOCKED`. That is a capture failure, not a valid collector `UNKNOWN` result. A valid `UNKNOWN` is a complete schema-valid record emitted by the collector for one bounded probe.

Before approval, replace only values independently verified by the operator. Do not use shell expansion to discover paths, do not source credentials, and do not set `DISCOVERY_PG_SERVICE` or any `PG*` value unless an existing least-privilege selection has already been approved. Keep the fixed limits exactly as shown.

```bash
DISCOVERY_MAX_OUTPUT_BYTES=131072 DISCOVERY_MAX_COMMAND_SECONDS=5 DISCOVERY_MAX_CONTAINERS=64 DISCOVERY_APP_DIR=/home/tilo/apps/clashcookies-prod DISCOVERY_WRAPPER_PATH=/home/tilo/deploy-prod.sh DISCOVERY_LOCK_PATH=/operator-verified/shared-release-lock DISCOVERY_MIGRATION_LOCK_PATH=/operator-verified/migration-runner-lock DISCOVERY_EXECUTOR_PATH=/operator-verified/immutable-executor DISCOVERY_CREDENTIAL_PATH=/operator-verified/protected-db-credential DISCOVERY_RELEASE_RECORD_PATH=/operator-verified/append-only-release-record bash /operator-approved/private/path/production-vm-discovery-1cb81528/ops/deploy/discovery/production-vm-discovery.sh
```

The `/home/tilo/...` values are the supplied operator context, not a substitute for the checkout/wrapper identity checks. Every `/operator-verified/...` and `/operator-approved/...` value is a placeholder and must be replaced or the invocation must not proceed. If any path, command, permission, Docker identity, or evidence destination is unresolved, stop before this command.

The invocation must not be wrapped with `sudo`, `tee` to a VM file, `bash -c` string concatenation, `env` dumps, `docker exec`, `docker compose`, the legacy wrapper, a backup service, a timer, a migration runner, or any cleanup command. A normal collector completion with `UNKNOWN` records is not a successful release preflight.

## 6. Evidence validation and secure handling

The collector emits one JSON object per line. The original stdout is the evidence artifact; do not edit it in place. Preserve its source commit, the three file hashes, transfer time, operator identity record, collector start time, capture method, and SHA-256 of the original file in a separate provenance record. The script's `observed_at` is the collection start timestamp, not an independently measured timestamp for every probe.

Validate offline on the private Windows workstation. The validator must reject blank lines, malformed JSON, duplicate or missing required fields, an unexpected schema, statuses outside `PASS`/`FAIL`/`UNKNOWN`, unbounded detail, or any record other than the collector's documented shape. It should print only counts and validation status, never the records themselves.

```cmd
node -e "const fs=require('fs'),p=process.argv[1],a=fs.readFileSync(p,'utf8').split(/\r?\n/);if(a[a.length-1]==='')a.pop();if(!a.length)throw Error('empty evidence');let n=0;for(const line of a){if(!line.trim())throw Error('blank line');const r=JSON.parse(line),k=Object.keys(r).sort().join(',');if(k!=='detail,evidence,observed_at,provenance,schema,status'||r.schema!=='clashcookies.production-vm-discovery.v1'||!r.evidence||!['PASS','FAIL','UNKNOWN'].includes(r.status)||!/^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}Z$/.test(r.observed_at)||r.provenance!=='live-vm-read-only'||typeof r.detail!=='string'||r.detail.length>4096)throw Error('schema/status/detail violation');n++}console.log('VALID JSONL records='+n)" "%USERPROFILE%\clashcookies-production-evidence-20261117\production-vm-discovery.ndjson"
```

Perform a human redaction review before sharing any derivative. Confirm that the original and derivative contain no passwords, database URLs, tokens, private keys, environment values, process arguments, full Docker labels/inspect data, private monitoring URLs, credential paths that policy treats as sensitive, or wrapper/configuration source. The collector is designed not to emit these, but validation is still required.

If stdout is truncated, interrupted, contains malformed records, or fails schema validation, keep the original in a restricted quarantine location, mark the bundle `INCOMPLETE` or `MALFORMED`, and do not repair, concatenate, or hand-edit it. Do not rerun ad hoc; a rerun requires a new authorization and a new provenance record. A sanitized derivative must reference the original artifact hash and must never replace it.

Transfer only the redacted derivative and its provenance through an approved encrypted channel. Retain the original and derivative for the approved retention period with access logging; expire them only under that policy. Never upload raw evidence to a public issue, chat, paste service, or repository.

## 7. Post-collection review and classifications

Review each record against the current `dev` versions of the workflow, architecture and priority documents, observability/deployment contracts, backup roadmap, Phase 1 diagnostic, Phase 2A diagnostic, and [the discovery guide](../../ops/deploy/discovery/production-vm-discovery.md). Record the following separately:

- `PASS`: only the bounded probe described by that record succeeded. It is not a release PASS, a singleton proof, a lock-cooperation proof, an immutable-file proof, an append-only proof, a backup-recovery proof, or authorization.
- `UNKNOWN`: the command was unavailable/denied/timed out, a path was absent or unconfigured, output was malformed, a prerequisite was not independently established, or the result cannot distinguish safe from unsafe state.
- `FAIL`: the probe observed a contradictory or unsafe condition, such as a non-200 health response, a tracked checkout change, a non-canonical runtime candidate, a symlinked protected path, an enabled backup timer, or an uncorrelated potential runtime process.
- `BLOCKED`: an authorization, identity, ownership, recovery, staging, or release gate is not closed. `BLOCKED` is an operator/reviewer decision and must not be converted to `PASS` because the collector completed.

The review checklist must explicitly cover:

1. Source commit and all three file hashes match; relative structure is intact; no production checkout was modified.
2. Operator UID/GID/groups, Bash/Node compatibility, command availability, Docker visibility, and file traverse/read permissions are recorded.
3. Checkout HEAD, branch/detached state, tracked cleanliness, and untracked-file inventory are reviewed without cleaning anything.
4. Wrapper identity and redacted control-flow findings are reviewed against the lock contract; marker counts are not treated as live cooperation.
5. Shared lock, parent, migration lock, executor, credential source, and release-record paths are independently identified or remain `UNKNOWN`.
6. Runtime identity has exactly one canonical candidate and complete PID/cgroup correlation; any ambiguity remains `UNKNOWN`/`BLOCKED`.
7. Database identity, if queried, is the intended production identity and read-only; migration count is descriptive only. No database contents, grants, migrations, or writes were accessed.
8. Fresh `/livez` and `/healthz`, disk/inode headroom, monitoring, backup service/timer state, staging residuals, and any failures are reviewed.
9. Backup freshness, off-host retrieval/restore, recovery-key custody, monitoring, staging waiver, migration recovery, final release diff, and release approval remain separate gates.
10. The evidence bundle is sanitized, provenance-preserving, retained securely, and not treated as permission to deploy.

## 8. Separate authorization gate

Three decisions are required and must be recorded separately for delivery and retained collector evidence:

1. **Delivery authorization:** permission to transfer exactly the three pinned files and, if necessary, create one named isolated operator staging directory outside the production checkout. This does not authorize discovery execution.
2. **Evidence capture authorization:** permission to configure the existing approved SSH client's stdout-only remote-command capture to the approved local destination. This does not authorize the remote command or any production access beyond the separately approved execution.
3. **Discovery execution authorization:** explicit approval for one bounded invocation using the verified paths, operator account, existing read-only Docker visibility, optional existing read-only PostgreSQL selection, and approved private evidence destination. It does not authorize deployment, migration, backup/timer activation, wrapper execution, permission changes, staging cleanup, or release promotion.

The fixed Gate 1 prerequisite probe is a separate terminal-only action. Its one-command SSH authorization does not authorize retained evidence capture, and the retained-evidence authorization does not authorize the collector unless separately granted.

If any of the three authorizations is absent, if a prerequisite is unresolved, or if any stop condition occurs, stop with `UNKNOWN`/`BLOCKED` and return the review record. Do not merge a future code change, enable `PHASE1_EXECUTION_ENABLED`, merge release PR #1983, or promote `dev` to `main` as part of this preflight.

## 9. Script review findings — documented separately from this docs change

The merged scripts were reviewed as-is. No code changes are included in this documentation task.

- **Heuristic wrapper PASS:** `wrapper_control_flow` can report `PASS` from marker counts and line ordering, including markers in comments or non-executed branches. The guide warns that this is not proof, but the status is still easy to misread. Treat it as metadata/`UNKNOWN` for release decisions and require controlled review of the exact wrapper.
- **Unverified lock default:** `DISCOVERY_LOCK_PATH` has a non-empty default even though the live shared lock location is not confirmed. Never omit this variable and assume the default is authoritative; an independently identified path is required. A future code fix should make an unknown lock explicitly empty/`UNKNOWN` rather than probing a guessed path.
- **Backup service classification:** a service state that is not `active` is currently emitted as `PASS`, including a possible `failed` state. Record the raw bounded state for review and never treat this as backup readiness. A future code fix should distinguish `inactive/success`, `failed`, `not-found`, and command failure.
- **Backup timer classification:** `systemctl is-enabled` output/exit handling can treat a missing or otherwise ambiguous unit as a safe `PASS`, and it does not by itself prove that the timer is inactive. Require separate active-state review; a future code fix should distinguish `disabled`, `not-found`, `static`, and active state.
- **PostgreSQL address label:** the emitted `server_address_class=loopback_or_local` label is too broad for every non-empty address because the address is intentionally not emitted. Treat the database record as identity evidence requiring review, not as proof of local/loopback placement.
- **Path inspection race:** shell path checks and wrapper read/hash operations are not one atomic descriptor-based inspection. Treat a concurrent path replacement or a changing wrapper as `UNKNOWN`; do not use the collector as proof of immutable path ownership.
- **Runtime scope:** the adapter fail-closes on multiple plausible candidates and uncorrelated `node`/`nodejs`/`npm`/`yarn` processes, but process-name matching cannot prove that no differently named independent runtime exists. Preserve the separate singleton gate.

These findings are genuine follow-up review items, not silent code changes. They do not authorize bypassing the collector or weakening its disabled mutation boundary.

## November 17 protected production VM path verification — BLOCKED (operator/Codex-reported)

- **Access and identity:** Existing `clash-vm` batch authentication succeeded as `tilo`, UID/GID `1000:1000`, groups `tilo`, `sudo`, `users`, `docker`. No key, passphrase, SSH configuration, privilege escalation, Docker command, database query, or production helper execution was used.
- **Live wrapper:** `/home/tilo/deploy-prod.sh` resolved to the same canonical regular file, owner `1001:1001`, mode `0755`, size `7,348` bytes, SHA-256 `ae5af2b09ca329553a55da633d0c3699f97d3559ecc65197dbf9d7cf91aeb507`; `bash -n` passed. The wrapper is readable/traversable by `tilo` through its existing path components. Its bounded static review found no `DEPLOY_LOCK_PATH`, `DEPLOY_LOCK_FILE`, `flock`, atomic lock-directory, `owner.json`, migration-aware, migration-lock, executor, credential-source or release-record implementation markers. It references `docker-compose` directly and uses Git/health checks; it does not establish participation in the canonical shared-lock contract.
- **Tooling and checkout:** `docker-compose` was not found in the current noninteractive SSH `PATH`; no attempt was made to invoke it. The production checkout `/home/tilo/apps/clashcookies-prod` is canonical, owner `1000:1000`, mode `0775`, on `main` at `0d2a49bbc33fe42bfbac56a2583e7d114b71cfad`, and contains pre-existing untracked files. The reviewed discovery, migration-aware, migration-runner and deployment-lock files are absent from that checkout's `ops/deploy` path; only `container-start.sh` and `ensure-yarn-deps.sh` were present there.
- **Referenced helper metadata:** `/home/tilo/deploy-observability.sh` is canonical, owner `1001:1001`, mode `0755`, size `247` bytes; `/home/tilo/deploy-assets/clashcookies/container-start.sh` and `ensure-yarn-deps.sh` are canonical, owner `1000:1000`, mode `0755`, sizes `86` and `1,129` bytes. None is an identified immutable deployment executor for the live wrapper.
- **Protected-resource classification:**
  - **Production wrapper — PASS for identity/metadata; FAIL for canonical lock-contract participation.**
  - **Shared deployment lock and parent — UNKNOWN/BLOCKED.** The wrapper exposes no authoritative lock path or acquisition/release contract. Historical `/run/lock/clashcookies-prod-deploy.lock` and its migration counterpart were absent; `/run/lock` itself is root-owned mode `1777`.
  - **Separate migration-runner lock — UNKNOWN/BLOCKED.** No live migration-aware runner or authoritative lock path was present; the historical candidate was absent.
  - **Protected executor/helper — UNKNOWN/BLOCKED.** No immutable helper path is selected by the wrapper; the direct `docker-compose` command was unavailable in the inspected noninteractive environment.
  - **Database credential source — UNKNOWN, with an unsafe candidate.** The wrapper contains bounded `.env` references, but its exact credential role cannot be established without reviewing potentially secret-bearing control flow. `/home/tilo/apps/clashcookies-prod/.env` is canonical regular file `1000:1000`, mode `0664`, size `1,727` bytes; if it is the credential source, it fails the required private credential boundary. Its contents were not read, hashed, or exported.
  - **Append-only release record and parent — UNKNOWN/BLOCKED.** No live release-record path was exposed; historical `/var/lib/clashcookies/release-record.ndjson` was absent. No record was created, appended, or test-written.
- **Overall result:** **BLOCKED** for protected-path readiness. The live wrapper's absence of the shared-lock contract is a verified discrepancy, while the exact migration lock, executor, credential source and release record remain unresolved. This does not authorize wrapper replacement, path repair, collector execution, evidence capture, Docker/DB inspection, deployment, migration, backup, timer activation or release promotion.
- **Scope:** Only bounded metadata, syntax, path, identity and checkout-state checks were performed. No production files were changed; no lock was acquired or touched; no secret contents, process arguments, Docker state, database state or collector output were accessed. The local untracked `powershell` file was preserved.


## November 19 repaired prerequisite-probe handoff — no new execution

The owner made **one separately approved** noninteractive SSH attempt to run the fixed terminal-only prerequisite packet on 2026-11-19. It returned malformed duplicate identity, file-hash and candidate metadata lines because of Windows CMD/Bash quoting; the archive probe also used a filename that did not match the documented delivered archive. The malformed output is **INVALID**, not accepted as trusted Gate 1 evidence. The owner's one-shot authorization was consumed; no repeat SSH invocation is implied by a repository update. No collector, Docker, PostgreSQL, wrapper execution, retained capture, credential read, provisioning, migration, backup or deployment is reported for that attempt.

[PR #2082](https://github.com/tonykslee/ClashCookies/pull/2082) subsequently repaired the *unexecuted replacement packet* and its CMD transport (CMD doubled quotes, proper Bash variable quoting, exact archive path). Reviewed PR head `cc7f861231d0f3633786ecf0a790d2784612b85f` merged to `dev` at `650ba69f0fc007d976c1c4eef88ff11d0f10ba84`; Ubuntu CI [44601591863](https://github.com/tonykslee/ClashCookies/actions/runs/44601591863) passed lint/test/build. Synthetic full-packet Bash/validator coverage and native Windows CMD fake-`ssh.cmd` transport tests were added; Codex reported **2 local Windows tests PASS**, with focused totals 57 passed/3 skipped. Windows-specific tests do **not** execute in the Ubuntu CI job, and a batch fake-SSH handoff is not a live OpenSSH transport guarantee. Structural `VALID` under synthetic provenance does not establish any VM fact.

**Next gate, not yet authorized:** owner may separately authorize **one** protected-terminal-only execution of the **repaired** command in the current `dev` installation-readiness packet after fresh Gate B SSH identity/host-key/agent checks. Windows policy blocked Codex from opening the isolated protected CMD terminal; a normal Codex command runner retains output, so real execution must not use that runner. No SSH retry, transcript, redirection, stdout capture, evidence file, or collector is authorized by this merge. Review only fixed-field terminal classifications, stop on malformed/nonzero output, and keep any absent historical candidate distinct from an unknown canonical resource. The evidence-root's two pre-existing files are preserved. The later retained collector/evidence-custody gates are unchanged, and draft release PR #1983 remains NO-GO.

## November 19 repaired prerequisite-probe live invocation — owner-reported

After the preceding no-execution checkpoint, the owner reported one successful-looking protected-terminal Gate B remote check and one **first** invocation of the unchanged repaired Gate C SSH command. Gate B showed account `tilo`, UID/GID `1000:1000`, four complete groups and read/traverse `PASS`. The repaired probe displayed the expected ordered fixed records without visible `STOP`; all four pinned archive/adapter/collector/validator SHA-256 values matched the repository allowlist. Wrapper syntax, checkout identity and bounded untracked count remained consistent with prior operator evidence. The historical lock, executor, credential and release-record *candidate* paths were reported absent; no canonical resource location was established. The existing `.env` candidate remains mode `0664` and is not a verified protected credential source.

**Evidence boundary:** this is an operator-shared terminal observation, not a retained, provenance-verified ciphertext bundle. SSH exit status was not independently attested, the local validator was not applied to live captured evidence, and the approved host-key binding was not independently reviewed by ChatGPT. The output was pasted to chat despite the transient/no-chat rule; do not duplicate it in Git or use it as approved retained evidence. The one-shot Gate C authorization is consumed. No further SSH, retries, collector, capture, provisioning or release operations are approved. Installation and PR #1983 remain blocked; see the installation-readiness diagnostic for the bounded classification.
