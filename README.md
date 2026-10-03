# 袋住記 · Pocket Ledger v1.2.0

Personal HKD expense tracker with offline browser storage, Google Sheet synchronisation, Octopus/Wallet Shortcuts and linked friend repayments.

The FPS update reads supported outgoing Hang Seng transfer notifications. Recipients explicitly enabled in **設定 → FPS 自動記帳收款人** record automatically; other transfers ask before becoming expenses. Categorising a recipient alone does not enable automatic recording. No recipients are enabled by default.

Follow the [FPS update and iPhone Shortcut guide](docs/FPS.md), keeping the same Google Sheet, private token and `/exec` deployment. Replace all three files under **backend/** in the existing Apps Script project and deploy a new version before using the FPS actions. The static website uses the files at this repository root. The local database remains at version 2.

See the [API contract](docs/API.md) for `fps`, `fpsConfirm`, recipient settings and duplicate handling. Do not put private connection credentials in this public repository.

Validation: 70 core checks, 24 Chromium browser flows and two integrations upgrading actual v1.0.0/v1.1.0 bundles passed. Physical iPhone notifications, Safari and live Google permissions still need the genuine-payment check in the guide. No signed iOS Shortcut is supplied.
