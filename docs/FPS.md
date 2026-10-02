# FPS automatic recording · v1.2.0

This update reuses your existing Wallet / Messages notification Shortcut. Recognised outgoing Hang Seng transfer alerts can become FPS expenses. Only recipients you explicitly enable record automatically. Other transfers show a choice; skipping creates no expense. Your Octopus and incoming friend-repayment branches stay in place.

## Update the backend and website first

1. In 袋住記 **設定 → 下載備份 JSON**, save a backup. Keep the same Google Sheet and Apps Script project.
2. Replace the contents of the existing Apps Script files with **backend/Engine.gs**, **backend/Api.gs** and **backend/Code.gs** from this release. These are complete files; do not append them to the old code. Keep your `API_TOKEN` and `SPREADSHEET_ID` Script Properties.
3. Save, then choose **Deploy → Manage deployments → pencil icon → Version: New version → Deploy**. Updating the existing deployment keeps your `/exec` address. Opening it in a browser must show `"release":"1.2.0"` and `fps-notifications` before the new FPS actions will work. See [Google's deployment instructions](https://developers.google.com/apps-script/concepts/deployments#edit_a_versioned_deployment).
4. Upload the contents of **dist/** to the same GitHub Pages root, or merge the prepared update on GitHub. Keep the `icons` folder. The web-only ZIP contains these files at its root; the full ZIP also contains the backend and instructions.
5. On your iPhone, close every 袋住記 Safari tab and the home-screen app. Reopen online and let the update download; close and reopen once if Settings says a new version is waiting. **設定** must show **Pocket Ledger v1.2.0 · FPS 與朋友還款**. Keep your browser data: the database remains at version 2, with no clearing required.

The backend adds a separate **FPSRecipients** sheet for eligibility settings. Existing Transactions and Rules rows are retained. No past bank messages or screenshot transactions are imported by this update.

## Confirm the utility recipients

In **設定 → FPS 自動記帳收款人**:

| Field | HK Electric example |
| --- | --- |
| 收款人 ID | `hkelectric.com` |
| 比對方式 | 電郵域名 |
| 顯示名稱 | `HK Electric` |
| 分類 | 帳單 |
| 確認此收款人…自動記帳 | Tick only after confirming this is the bill recipient you use |

Choose **儲存收款人**, then wait until the entry says **已同步 · 自動記支出**. The Shortcut checks the server's saved settings, so a local unsynchronised change is not yet active. Domain matching applies to the entire part after `@`; it does not match subdomains or longer suffixes.

For **WSD** and **Towngas**, copy the actual masked recipient following `account / Proxy ID` in each payment SMS. Use **完整 ID**, label it `WSD` or `Towngas`, choose **帳單**, enable it and save. Their names alone cannot identify a masked account number. Until a matching ID is supplied, these transfers keep prompting. Stars and Xs are literal characters, not wildcards. Do not add an investment account or your own account to the expense list.

To stop automatic entry for a recipient, tap **修改設定**, untick the confirmation box and save. Future matching messages will ask again; saved expenses stay intact. An exact ID exception takes priority over a domain rule.

## Add the FPS branch to the same Shortcut

The top notification trigger should include **Wallet or Messages**, with no global `Octopus` or `HK$` filter. Those filters belong inside the Octopus If; a global Octopus filter would block bank messages before any branch runs.

Keep this structure:

```text
When a notification arrives from Wallet or Messages
If Title contains Octopus AND Subtitle contains HK$
    Existing Octopus actions
Otherwise
    If Title contains HASEnotice AND Body contains received a transfer
        Existing friend-repayment menu → Open #reimburse
    Otherwise
        If Title contains HASEsecure AND Body contains You've transferred HKD
            FPS actions below
        End If
    End If
End If
```

Add the new **If** inside the currently empty **Otherwise of the HASEnotice If**, not inside its repayment menu. Set **All are true** with the two conditions above. Bank content comes from **Notification → Body**, not Subtitle.

### Inside the FPS If

1. Add **Format Date**. Select **Notification → Date** as the input. Choose **ISO 8601** and turn **Include ISO 8601 Time ON**. Rename this output `FPS notification date` if helpful. Use this same variable in both requests below. Do not use Current Date or your existing Octopus formatted dates here.
2. Add **Get Contents of URL**. Reuse your existing private `/exec` address. Set **Method: POST**, **Request Body: JSON**. Add these five fields:

| Key | Type | Value |
| --- | --- | --- |
| `action` | Text | `fps` |
| `token` | Text | Your existing private connection token |
| `title` | Text | **Notification → Title** variable |
| `body` | Text | **Notification → Body** variable |
| `notificationTimestamp` | Text | **FPS notification date** from step 1 |

Do not enter a guessed amount or merchant, `source: Octopus`, a random ID, or `action: create` here. The backend extracts the transfer details and checks expense eligibility.

3. Add **Get Dictionary Value**, key **`ok`**, from the FPS **Contents of URL**. If it is false, show `error.message` from that same response in **Show Alert**. This makes authentication/deployment errors visible. Network errors from Get Contents of URL must also be resolved; they do not mean the payment was recorded.
4. In the successful branch, get **`status`** from the FPS response. Add **If status is `needs_confirmation`**. Inside it, get **`prompt`** from the same response, then add **Choose from Menu** using that prompt, with **Record expense** and **Skip**.
5. Inside **Record expense**, duplicate the FPS **Get Contents of URL** action from step 2. Change only `action` from **`fps`** to **`fpsConfirm`**. Keep the same notification Title, Body, Date and private token. This confirms one expense without enabling all future payments to that recipient. Check the second response's `ok` and show an error if false.
6. Leave **Skip** empty. When status is `inserted` or `duplicate`, no menu or Quick Look is needed. `ignored` means the message did not match the supported bank transfer format, and nothing was saved.

If a new If initially selects **Contents of URL / If Result**, tap its input, choose **Clear Variable**, then select the correct Notification field or Dictionary Value. Make sure dictionary actions use the **FPS response**, not the older Octopus URL action or the confirmation response by accident. Nested fields such as `error.message` are supported by [Apple's Get Dictionary Value action](https://support.apple.com/guide/shortcuts/get-dictionary-value-action-apdf01294032/ios).

## Verify with a genuine future payment

Check one normal payment you intended to make. The SMS should cause one Sheet expense with source **FPS**, the amount without a thousands comma, category **Bills** for an enabled utility, and the bank's transaction time in Hong Kong. Open 袋住記 and sync to see it. If the recipient is unknown, choose Record expense only when it belongs in your spending; it starts in 待分類 unless you have assigned that recipient a category.

This parser recognises the shown Hang Seng `#HASEsecure` / `You've transferred HKD… to account / Proxy ID … on YYYY-MM-DD HH:mm` format. It does not auto-record incoming repayments, generic `You've paid` alerts, verification codes or other banks' different templates. If a utility sends a different template, retain the prompt/manual FPS fallback and add that format only after inspecting a real message.

The phone automation needs internet and permission to send requests. A choice or alert requires interaction and may require unlocking the phone. There is no SMS outbox or bank-account connection. On a lost response, retry the **same notification fields and notification date**: its stable SHA-256 ID prevents a second entry. A newly delivered duplicate SMS can have a new notification date; without a unique bank transaction reference it cannot always be distinguished from a genuinely separate transfer. Do not test by inventing a new date for a previous payment, or by replaying old expenses already entered manually.

Local browser/Sheet tests are included in **TEST-RESULTS.md**. Physical iPhone notification delivery and live Google permissions still require the real-device check above. No signed `.shortcut` file is supplied; the steps amend your existing phone automation.
