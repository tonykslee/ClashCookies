# Command Access and Permissions

## Defaults
- By default, commands are usable by everyone.
- Administrator users can always use commands regardless of role whitelist.
- `/fwa mail send` defaults to FWA leader-role + Administrator when no explicit whitelist is set.
- `/fwa compliance` defaults to FWA leader-role + Administrator when no explicit whitelist is set.
- `/fwa police` defaults to FWA leader-role + Administrator when no explicit whitelist is set.
- `/fwa weight-age`, `/fwa weight-link`, `/fwa weight-health`, and `/fwa weight-cookie` default to FWA leader-role + Administrator when no explicit whitelist is set.
- `/defer` defaults to FWA leader-role + Administrator when no explicit whitelist is set.
- `/unlinked` defaults to FWA leader-role + Administrator when no explicit whitelist is set.
- `/link create` self-links are public; selecting another Discord user uses the same FWA leader-role + Administrator override policy when no explicit whitelist is set.
- `/cwl members` and `/cwl rotations show` are public by default; `/cwl rotations create`, `/cwl rotations import`, and `/cwl rotations export` default to Administrator.
- `/layout` is public by default; runtime `edit` (and optional `img-url` edit flow) still requires Administrator.

## Default Administrator-Only Targets
- `/tracked-clan configure`, `/tracked-clan cwl-tags`, `/tracked-clan remove`
- `/reminders`, `/reminders create`, `/reminders list`, `/reminders edit`
- `/permission add`, `/permission remove`
- `/sheet link`, `/sheet unlink`, `/sheet show`, `/sheet refresh`
- `/kick-list build`, `/kick-list add`, `/kick-list remove`, `/kick-list show`, `/kick-list clear`
- `/sync time post`
- `/bot-logs`
- `/notify war`
- `/cwl rotations create`
- `/cwl rotations import`
- `/cwl rotations export`

## Role Whitelisting
- Use `/permission add` to whitelist roles per command target.
- Use `/permission remove` to remove role access.
- Use `/permission list` to inspect current policy.

Examples:
- Lock `/sync` to role `@RoleX`:
  - `/permission add command:sync role:@RoleX`
- Lock `/say` to role `@RoleX`:
  - `/permission add command:say role:@RoleX`
- Lock `/bot-logs` to role `@RoleX`:
  - `/permission add command:bot-logs role:@RoleX`
- Fine-grained `/sync ...` targets:
  - `sync:time:post`
  - `sync:post:status`
  - Example: `/permission add command:sync:time:post role:@RoleX`
  - Example: `/permission add command:sync:post:status role:@RoleX`
- Lock `/fwa` to role `@RoleX`:
  - `/permission add command:fwa role:@RoleX`
- Lock only `/fwa mail send` to role `@RoleX`:
  - `/permission add command:fwa:mail:send role:@RoleX`
- Lock only `/fwa compliance` to role `@RoleX`:
  - `/permission add command:fwa:compliance role:@RoleX`
- Lock only `/fwa police` to role `@RoleX`:
  - `/permission add command:fwa:police role:@RoleX`
  - Covers `/fwa police configure|show|show-default|show-all|set|set-default|reset|reset-default|send`.
- Lock only `/fwa weight-health` to role `@RoleX`:
  - `/permission add command:fwa:weight-health role:@RoleX`
- Lock only `/fwa weight-cookie` to role `@RoleX`:
  - `/permission add command:fwa:weight-cookie role:@RoleX`
- Lock only `/defer` to role `@RoleX`:
  - `/permission add command:defer role:@RoleX`
- Lock only `/unlinked` to role `@RoleX`:
  - `/permission add command:unlinked role:@RoleX`
- Lock only `/remaining cwl` to role `@RoleX`:
  - `/permission add command:remaining:cwl role:@RoleX`
- Lock only `/cwl rotations create` to role `@RoleX`:
  - `/permission add command:cwl:rotations:create role:@RoleX`
- Lock `/recruitment` to role `@RoleX`:
  - `/permission add command:recruitment role:@RoleX`
- Lock `/notify` to role `@RoleX`:
  - `/permission add command:notify role:@RoleX`

## Notes
- `/fwa match-type` is Administrator-only by default.
- The `/fwa match` single-clan `Send Mail` button uses the same permission policy as `/fwa mail send`.
