# ClashCookies
A Clash of Clans bot that helps an active clan succeed.

Todo:
- link up player tag
- member list + th + activity
- clan war calling system

Invite Bot to your own server:
https://discord.com/oauth2/authorize?client_id=1131335782016237749&permissions=8&integration_type=0&scope=bot+applications.commands

User install (aka: add bot to your apps):
https://discord.com/oauth2/authorize?client_id=1131335782016237749&permissions=8&integration_type=1&scope=bot+applications.commands


https://www.fintechfutures.com/files/2018/12/Tough-cookie.jpg


Staging guild bot install:
https://discord.com/oauth2/authorize?client_id=1474193888146358393&permissions=8&integration_type=0&scope=bot+applications.commands

Staging user bot install:
https://discord.com/oauth2/authorize?client_id=1474193888146358393&permissions=8&integration_type=1&scope=bot+applications.commands

## Google Sheets setup

This bot can link to a Google Sheet and be re-linked later without code changes.

1. Create Google API credentials with Sheets API enabled.
2. Share your sheet with the account used by your auth flow (Viewer is enough).
3. Add one of these auth options:
   - OAuth:
     - `GOOGLE_OAUTH_CLIENT_ID`
     - `GOOGLE_OAUTH_CLIENT_SECRET`
     - `GOOGLE_OAUTH_REFRESH_TOKEN`
   - Service account:
     - `GOOGLE_SERVICE_ACCOUNT_JSON` (full JSON as one line)
     - `GOOGLE_SERVICE_ACCOUNT_JSON_BASE64` (base64 of full JSON)
     - `GOOGLE_SERVICE_ACCOUNT_EMAIL` + `GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY`

Commands:
- `/sheet link sheet_id_or_url:<id-or-url> [tab:<tab-name>]`
- `/sheet show`
- `/sheet preview [range:<A1-notation>]`
- `/sheet unlink`
- `/compo advice clan:<name>`
