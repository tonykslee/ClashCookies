# Command Access and Permissions

## Defaults
- By default, commands are usable by everyone.
- Administrator users can always use commands regardless of role whitelist.

## Default Administrator-Only Targets
- `/tracked-clan add`, `/tracked-clan remove`
- `/permission add`, `/permission remove`
- `/sheet link`, `/sheet unlink`, `/sheet show`, `/sheet refresh`
- `/kick-list build`, `/kick-list add`, `/kick-list remove`, `/kick-list show`, `/kick-list clear`
- `/post sync time`
- `/notify war`

## Role Whitelisting
- Use `/permission add` to whitelist roles per command target.
- Use `/permission remove` to remove role access.
- Use `/permission list` to inspect current policy.

Examples:
- Lock `/post` to role `@RoleX`:
  - `/permission add command:post role:@RoleX`
- Fine-grained `/post sync ...` targets:
  - `sync:time:post`
  - `sync:post:status`
- Lock `/fwa` to role `@RoleX`:
  - `/permission add command:fwa role:@RoleX`
- Lock `/recruitment` to role `@RoleX`:
  - `/permission add command:recruitment role:@RoleX`
- Lock `/notify` to role `@RoleX`:
  - `/permission add command:notify role:@RoleX`

## Notes
- `/fwa match-type` is Administrator-only by default.
