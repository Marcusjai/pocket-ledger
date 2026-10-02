# Pocket Ledger v1.2.0 API (read protocol 2)

Single-user ledger. POST JSON to the Apps Script `/exec` URL; follow redirects. No cookie auth. Token in the request body. GET returns public service metadata only. Error objects are application errors; **check `ok`, not only HTTP status**.

## Create

Nested or flat payloads are accepted. Shortcuts can build the flat form using ordinary JSON fields.

```json
{
  "token": "YOUR_PRIVATE_TOKEN",
  "action": "create",
  "id": "one-persisted-uuid-per-payment",
  "timestamp": "2026-09-19T12:00:00+08:00",
  "source": "ApplePay",
  "amount": "48.00",
  "currency": "HKD",
  "merchant": "McDonald's HK",
  "account": "daily-visa",
  "note": ""
}
```

Response: `{ "ok": true, "status": "inserted", "transaction": { ... } }`, or `status: "duplicate"` and the existing canonical record. The canonical ID can differ from the submitted ID when exact-event deduplication finds an existing Wallet event.

`source`: `Cash`, `ApplePay`, `Octopus`, `FPS`. `amount`: positive numeric value / ungrouped decimal string, maximum 2 decimal places, at most HK$9,999,999.99. Currency defaults to HKD; other currencies are rejected. `timestamp`: ISO 8601 with timezone, mandatory for non-cash, including retries. Cash expenses can default to server receipt time, but always send the recorded event time for meaningful offline accounting. `id`: 8–128 ASCII letters, digits, `_ . : -`. Merchant at most 160 characters; note 500; card alias 64. Do not send card numbers. Direct `create` means the caller has already chosen to record an expense; notification-based eligibility is enforced by `fps` instead.

Optional category: `Dining`, `Transport`, `Groceries`, `Shopping`, `Bills`, `Entertainment`, `Health`, `Other`, `Uncategorized`. Omit / use `Auto` to apply rules. Unknown merchants go to Uncategorized + needsReview=true. Explicit Other is considered reviewed.

Internally: integer `amountCents`, UTC ISO timestamp, Hong Kong day/month grouping. Category does not affect amounts or identity.

Ordinary expenses use `kind: "expense"`; omission is accepted for existing Shortcuts and v1 records. Their original fingerprint format is unchanged.

## Reimburse a linked expense

Flat or nested payloads are accepted. Use **`action: "reimburse"`**; `create` deliberately refuses reimbursement records. An older backend rejects the new action instead of recording a positive expense.

```json
{
  "token": "YOUR_PRIVATE_TOKEN",
  "action": "reimburse",
  "id": "one-persisted-uuid-per-repayment",
  "expenseId": "original-expense-id",
  "timestamp": "2026-10-02T12:00:00+08:00",
  "source": "BankTransfer",
  "amount": "63.00",
  "currency": "HKD",
  "payer": "Alex",
  "note": "My friend's share of dinner"
}
```

- `kind` is set to `reimbursement` by this action. Supplying any other explicit kind is rejected.
- `expenseId` must identify an existing HKD expense in this ledger. Create/sync the expense first. A reimbursement cannot link to another reimbursement.
- Receipt `source`: **BankTransfer, FPS, PayMe, Cash**. These extra methods are receipt sources only; the expense source list above is unchanged.
- `amount` is **positive**, using the same precision/limit as an expense. `timestamp` is the actual receipt time with timezone and is required, including for cash repayments. `payer` is optional text up to 160 characters; `note` is optional up to 500.
- Multiple/partial repayments are allowed. Their combined amount cannot exceed the original expense. The server checks the current balance under the same script lock used for insertion. Duplicate retries are recognized before checking the remaining balance.
- Category and merchant come from the original expense. A repayment does not create another unknown-merchant review item. Categorize the original expense; linked repayments follow it.
- Success has the same `ok`, `status` and `transaction` shape as `create`. The returned record includes `kind`, `expenseId`, `payer` and a positive `amountCents`.
- Repayments reduce totals on their **receipt date**, not the date of the original expense. Gross spending minus repayments equals net spending; HK day, month and category totals use that same rule. Receipt-only months/categories can be negative.

Preserve the payload/ID/timestamp for retries. Never guess which expense an incoming bank message belongs to or classify all credits as repayments.

## Duplicate policy

1. Same ID + same immutable financial fingerprint → duplicate. Changed financial facts with the same ID → `ID_CONFLICT`.
2. Non-cash exact match of `[source, timestamp, cents, currency, normalized merchant, account alias]` → duplicate even if IDs differ.
3. Separate cash IDs are never collapsed by the fingerprint, so two actual HK$35 cash purchases survive.
4. Different sources/cards/timestamps remain separate. No fuzzy time window. Set only one automation per card; persist original payload before network I/O. Note/category changes require the category API where applicable, not replaying creates.

For repayments the immutable fingerprint is `["reimbursement", expenseId, source, receipt timestamp, cents, currency, normalized payer, account alias]`. The linked expense and payer distinguish repayment events. Same-ID changed facts are rejected. Exact non-cash fingerprints with different IDs return the existing canonical record; distinct cash IDs are retained. Note and derived category are not part of the identity. Only changing a category is supported; create/reimburse retries are not an editing interface.

## List

`{"token":"…","action":"list","protocolVersion":2}` → `{"ok":true,"protocolVersion":2,"transactions":[…],"rules":[…],"serverTime":"…"}`. This is a complete snapshot, not a silently truncated page. It supports up to 10,000 records (expenses and repayments combined). Each request reads the current Sheet under a script lock. The browser merges returned records and preserves unsent local changes. Deleted remote rows do not delete local records.

For compatibility, old `list` requests without `protocolVersion: 2` work until the ledger contains its first repayment. After that they return `UPGRADE_REQUIRED`, preventing old clients from counting repayments as expenses. Existing expense-creation Shortcuts continue working. Protocol 2 snapshots also include `fpsRecipients` (an array; older clients may ignore it). Public GET metadata reports `version: 2`, `release: "1.2.0"`, and `capabilities: ["reimbursements", "fps-notifications"]`, without exposing transaction data.

## Categorize / remember a merchant

```json
{"token":"…","action":"categorize","id":"original-payment-id","operationId":"new-persisted-operation-uuid","version":1,"category":"Dining","remember":true}
```

Requires current `version`; returns incremented record. Replaying the same last operation is idempotent. `VERSION_CONFLICT` includes the current transaction and requires user resolution. Remembered rules are exact normalized merchant matches, applied to future inserts; they do not bulk-reclassify history. Source merchant text stays available for review.

Backup restore also uses `{"token":"…","action":"rule","merchantKey":"normalized shop","category":"Dining"}` to idempotently upsert a standalone rule, even if no matching historical transaction exists. A rule must have a nonempty normalized key. Rule changes are last-write-wins, while transaction category edits use explicit version checks.

## Browser transport and storage

The PWA sends `Content-Type: text/plain;charset=utf-8`, JSON body, `credentials: omit`, CORS mode, and follows the ContentService redirect. No custom headers / preflight, no JSONP, no `no-cors` false-success workaround. Live Google deployment permissions/CORS still need smoke testing. Timeout is 30 seconds. Errors retain the outbox.

IndexedDB read-modify-write transactions serialize local edits. Database `pocket-ledger-v1` upgrades in place from version 1 to 2, retaining the `state` object store and queued records; old version-1 writers cannot reopen it. Close old tabs during the update. A 60-second lease prevents concurrent sync from multiple tabs; each request refreshes it, uses a 30-second timeout and checks its owner before starting. A queue entry is normally removed only after a valid success response. A create response canonicalizes IDs, rebases queued category changes, and remaps linked repayment IDs/fingerprints and queued payloads. Server snapshots preserve pending edits.

Category conflicts require an explicit choice in Settings. If a repayment gets a definitive `OVER_REIMBURSEMENT`, `EXPENSE_NOT_FOUND` or `INVALID_EXPENSE` response, Settings permits removing only that rejected local entry. These errors occur before insertion; network/timeouts/ambiguous server errors do not permit this removal. A rejected repayment remains marked pending and is included in provisional local totals until resolved. The server snapshot is refreshed where possible so another device's repayments become visible.

JSON backup schema 2 contains `kind`, `expenseId` and `payer`, excludes token/endpoint, and accepts both schema 1 and 2 on restore. Restore is an atomic merge, inserts original expenses before repayments regardless of array order, and remaps canonical IDs. Invalid records or rules abort the import. v1 apps deliberately cannot import schema-2 backups. Successfully recorded amounts/links are immutable in this release; no deletion or reversal is provided.

Backend columns A:L remain ID, Timestamp, Source, Amount, Currency, Merchant, Category, Note, NeedsReview, Version, UpdatedAt, RecordJSON. New display columns M:O are Kind, ExpenseID, Payer; they are appended to standard v1 sheets without rewriting old transaction rows. Nonempty unrelated M:O headings are refused instead of overwritten. RecordJSON is authoritative and stores positive cents; **Sheet Amount and CSV Amount are signed** (negative for repayments) so summing them produces net spending. CSV adds Kind, ExpenseID, Payer and exports amounts as numeric values. Untrusted text cells/CSV fields escape spreadsheet formulas. Repayment display categories are refreshed when the original category changes; the list/totals also derive them from the original record. Script lock spans read/dedupe/write/flush. Cross-row/category/rule writes are not database transactions; retrying the same category operation repairs partial rule or linked-category writes.

## Errors and constraints

`UNAUTHORIZED`, `NOT_CONFIGURED`, `INVALID_JSON`, `INVALID_INPUT`, `INVALID_AMOUNT`, `INVALID_TIMESTAMP`, `INVALID_SOURCE`, `UNSUPPORTED_CURRENCY`, `INVALID_CATEGORY`, `INVALID_ID`, `ID_CONFLICT`, `NOT_FOUND`, `VERSION_CONFLICT`, `SCHEMA_MISMATCH`, `CAPACITY`, `BUSY`, `SERVER_ERROR`, `INVALID_KIND`, `INVALID_ACTION`, `INVALID_EXPENSE`, `EXPENSE_NOT_FOUND`, `OVER_REIMBURSEMENT`, `UPGRADE_REQUIRED`.

Linked friend repayments are supported. Merchant refunds, wages/other income, general transfers between accounts and FX conversion are not. There is no institution connection, native Wallet read access, guaranteed background sync or OCR. Octopus use depends on the device's event support; manual source selection is the fallback. Both backend and frontend can operate with free services subject to their quotas and policies. Auth uses one bearer secret for a single personal ledger, not multi-user access controls.

## FPS notification actions (v1.2.0)

`fps` takes authenticated flat fields `title`, `body`, `notificationTimestamp`. Notification Date must be a zoned ISO 8601 timestamp with time, reused on retry. Supported Hang Seng outgoing messages are parsed on the server; grouped monetary values are normalised here, while `create` retains its ungrouped amount validation.

Responses have `ok: true` and one of `inserted`, `duplicate`, `needs_confirmation` or `ignored`. `needs_confirmation` includes `preview` (`id`, `amount`, `currency`, `recipient`, `label`, `timestamp`) and a human-readable `prompt`; no expense is saved. `fpsConfirm` accepts the same notification fields and records the particular transfer as an expense after the caller obtains the user's choice. Alternatively `fps` accepts boolean `confirmedExpense: true`; a string is rejected. Neither form automatically enables future transfers.

Authenticated `fpsRecipient` upserts `{recipient, match: "exact" | "domain", label, category, enabled: boolean}`. All recipients start unapproved; `enabled` must be explicit. Exact matches preserve punctuation and masked characters, ignoring only case, NFKC variants and repeated whitespace. Domain rules match the entire email domain. Exact rules take precedence over domain rules, including disabled exceptions. An enabled recipient determines the expense label/category; unknown confirmed transfers use Uncategorized and need review. Merchant category rules never approve eligibility. Stored recipient settings are returned by `list` and use a separate `FPSRecipients` Sheet (Key, Recipient, Match, Label, Category, Enabled, RecipientJSON).

The bank's stated transaction time is interpreted as Hong Kong time. ID is `fps-` plus the SHA-256 of the canonical message and notification timestamp. A digest-derived account alias separates legitimate otherwise identical transfers within one bank-reported minute, while retrying the same notification returns the original expense even after recipient settings change. The full raw SMS is not saved in transaction rows: notes retain the masked recipient only. A newly delivered duplicate with a different notification date may need manual review; the SMS contains no unique bank reference.

See [FPS.md](FPS.md) for update and iPhone steps. Public metadata does not reveal recipient settings or financial records. Direct `create` remains available for deliberate manual FPS expense entry; it is not a notification eligibility check.
