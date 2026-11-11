# Command Access and Permissions

## Defaults
- By default, commands are usable by everyone.
- Administrator users can always use commands regardless of role whitelist.
- `/fwa compliance` defaults to FWA leader-role + Administrator when no explicit whitelist is set.
- `/fwa police` defaults to FWA leader-role + Administrator when no explicit whitelist is set.
- `/fwa weight-link`, `/fwa weight-health`, and `/fwa weight-alert` default to FWA leader-role + Administrator when no explicit whitelist is set.
- `/sync retrospective` defaults to FWA leader-role + Administrator when no explicit whitelist is set.
- `/repwork` defaults to FWA leader-role + Administrator when no explicit whitelist is set.
- `/defer` defaults to FWA leader-role + Administrator when no explicit whitelist is set.
- `/unlinked` defaults to FWA leader-role + Administrator when no explicit whitelist is set.
- `/autorole refresh` defaults to FWA leader-role + Administrator when no explicit whitelist is set.
- `/link create` self-links are public; selecting another Discord user uses the same FWA leader-role + Administrator override policy when no explicit whitelist is set.
- `/cwl members` and `/cwl rotations show` are public by default; `/cwl rotations create`, `/cwl rotations import`, and `/cwl rotations export` default to Administrator.
- `/layout` is an Administrator-only creation/presentation mutation; its canonical post buttons remain public under their existing scope rules.
- `/roster ping` has the independent `roster:ping` target. With no ping-specific policy, it inherits the existing `roster:manage` policy; additive grants preserve inherited manager access, while an existing legacy ping whitelist remains an explicit override. Administrators retain access, and the roster report button plus final confirmation use the same rechecked policy.

## Default Administrator-Only Targets
- `/clan configure`, `/clan cwl-tags`, `/clan remove`
- `/reminders`, `/reminders create`, `/reminders list`, `/reminders edit`
- `/permission add`, `/permission remove`
- `/sheet link`, `/sheet unlink`, `/sheet show`, `/sheet refresh`
- `/kick-list build`, `/kick-list add`, `/kick-list remove`, `/kick-list show`, `/kick-list clear`
- `/sync time post`
- `/bot-logs`
- `/notify war`
- `/autorole`, `/autorole config`, `/autorole rules`, `/autorole exclusions`, `/autorole refresh user`, `/autorole refresh role`
- `/cwl rotations create`
- `/cwl rotations import`
- `/cwl rotations export`
- `/roster ping` (inherits `roster:manage` unless an explicit `roster:ping` policy is configured)

## Role Whitelisting
- Use `/permission add` to add roles to a command target without replacing its built-in default or existing added roles. Repeating the same add is a no-op.
- Use `/permission remove` as the inverse: it removes only the selected role, records an explicit role/default exclusion when needed, and never revokes Discord Administrator bypass.
- Use `/permission list` to inspect effective defaults, added roles, exclusions, legacy restrictive policies, and the Administrator bypass.

Examples:
- Add `@RoleX` access to `/sync`:
  - `/permission add command:sync role:@RoleX`
- Add `@RoleX` access to `/say` without restricting its public default:
  - `/permission add command:say role:@RoleX`
- Add `@RoleX` access to `/bot-logs` while preserving its Administrator default:
  - `/permission add command:bot-logs role:@RoleX`
- Fine-grained `/sync ...` targets:
  - `sync:time:post`
  - `sync:post:status`
  - `sync:retrospective`
  - Example: `/permission add command:sync:time:post role:@RoleX`
  - Example: `/permission add command:sync:post:status role:@RoleX`
  - Example: `/permission add command:sync:retrospective role:@RoleX`
- Add `@RoleX` access to `/fwa`:
  - `/permission add command:fwa role:@RoleX`
- Add `@RoleX` access to `/fwa compliance`:
  - `/permission add command:fwa:compliance role:@RoleX`
- Add role `@RoleX` access to `/fwa police`:
  - `/permission add command:fwa:police role:@RoleX`
  - Covers `/fwa police configure|show|show-default|show-all|set|set-default|reset|reset-default|send`.
- Add role `@RoleX` access to `/fwa weight-health`:
  - `/permission add command:fwa:weight-health role:@RoleX`
- Add role `@RoleX` access to `/repwork`:
  - `/permission add command:repwork role:@RoleX`
- Add role `@RoleX` access to `/defer`:
  - `/permission add command:defer role:@RoleX`
- Add role `@RoleX` access to `/unlinked`:
  - `/permission add command:unlinked role:@RoleX`
- Add role `@RoleX` access to `/remaining cwl`:
  - `/permission add command:remaining:cwl role:@RoleX`
- Add role `@RoleX` access to `/cwl rotations create`:
  - `/permission add command:cwl:rotations:create role:@RoleX`
- Add role `@RoleX` access to `/recruitment`:
  - `/permission add command:recruitment role:@RoleX`
- Add role `@RoleX` access to `/notify`:
  - `/permission add command:notify role:@RoleX`
- Add `@RosterPing` access to roster pings:
  - `/permission add command:roster:ping role:@RosterPing`
- Inspect the effective ping policy:
  - `/permission list command:roster:ping`

## Notes
- `/fwa match-type` is Administrator-only by default.
- The `/fwa match` single-clan `Send Mail` button and its `Confirm WIN`/`Confirm LOSE` outcome controls use the same FWA leader-role + Administrator permission policy as the mail-send flow.
- Autorole role application requires Discord **Manage Roles** plus bot role hierarchy above every managed role.
- Autorole nickname application requires Discord **Manage Nicknames** plus bot role hierarchy above the target member's highest role.
