# Command Access and Permissions

## Defaults
- By default, commands are usable by everyone.
- Administrator users can always use commands regardless of role whitelist.
- `/fwa mail send` defaults to FWA leader-role + Administrator when no explicit whitelist is set.

## Default Administrator-Only Targets
- `/tracked-clan add`, `/tracked-clan remove`
- `/permission add`, `/permission remove`
- `/sheet link`, `/sheet unlink`, `/sheet show`, `/sheet refresh`
- `/kick-list build`, `/kick-list add`, `/kick-list remove`, `/kick-list show`, `/kick-list clear`
- `/sync time post`
- `/notify war`

## Role Whitelisting
- Use `/permission add` to whitelist roles per command target.
- Use `/permission remove` to remove role access.
- Use `/permission list` to inspect current policy.

Examples:
- Lock `/sync` to role `@RoleX`:
  - `/permission add command:sync role:@RoleX`
- Fine-grained `/sync ...` targets:
  - `sync:time:post`
  - `sync:post:status`
  - Example: `/permission add command:sync:time:post role:@RoleX`
  - Example: `/permission add command:sync:post:status role:@RoleX`
- Lock `/fwa` to role `@RoleX`:
  - `/permission add command:fwa role:@RoleX`
- Lock only `/fwa mail send` to role `@RoleX`:
  - `/permission add command:fwa:mail:send role:@RoleX`
- Lock `/recruitment` to role `@RoleX`:
  - `/permission add command:recruitment role:@RoleX`
- Lock `/notify` to role `@RoleX`:
  - `/permission add command:notify role:@RoleX`

## Notes
- `/fwa match-type` is Administrator-only by default.
- The `/fwa match` single-clan `Send Mail` button uses the same permission policy as `/fwa mail send`.
