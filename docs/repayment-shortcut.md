# Prefill the repayment amount from an iPhone notification

This changes only **HASEnotice → received-transfer menu → Record repayment** in the existing Shortcut. It opens Pocket Ledger with the received HKD amount filled in. You still choose **原本嘅支出**, check the amount, and tap **儲存還款** yourself. Opening the link creates no repayment.

## Deploy and refresh the app first

Do not switch the Shortcut to amount links until the app update is deployed. In Pocket Ledger settings, check for **Pocket Ledger v1.2.1 · 還款金額預填**.

If an older offline copy appears, open the app while online and let its update download. When settings says a new version is downloaded, close **all** Pocket Ledger browser tabs and its Home Screen app, then reopen it. Verify the version again. Do not clear website data to refresh it: that could remove local, unsynced records.

With a blank repayment form and no unsaved work, test this synthetic link in the browser that the Shortcut opens:

```text
https://marcusjai.github.io/pocket-ledger/#reimburse?amount=12.34
```

It must show **記朋友還款**, fill **已收到金額 · HKD** with `12.34`, leave the original expense for you to select, and create no record. Leave without saving. The app removes the amount parameter after reading it. If this fails, keep the old bare `#reimburse` link until the deployed app and cache are updated.

If you already have an unsaved repayment, the app keeps it and asks whether to **保留現有還款** or **放棄現有內容，用新金額**. Only choose the latter when you intend to discard that draft. A manual fallback link imports nothing; it does not erase an existing draft.

## Change the Record repayment branch

Keep a private backup of your Shortcut before editing. Do not publish an exported Shortcut containing credentials. Keep the other menu choices and transaction branches as they are.

Use the **Notification Body** input already used by the `received a transfer` check. Select that original notification-body variable explicitly; do not use the notification title, the previous action's number, or text copied from the screen.

1. Replace the branch's old URL/open actions with **Match Text** on that Notification Body. Paste the expression below, including `(?i)`, without surrounding slashes.

```regex
(?i)^Hang Seng: You['’]ve received a transfer of (?:HKD|HK\$)[ \t]*((?:[1-9][0-9]{0,6}|[1-9][0-9]{0,2},[0-9]{3}|[1-9],[0-9]{3},[0-9]{3})(?:\.[0-9]{1,2})?|0\.(?:0[1-9]|[1-9][0-9]?))(?=[ \t]+from\b)(?![\s\S]*(?:\breceived a transfer\b|(?<![A-Za-z0-9_])(?:HKD|HK\$)))
```

2. Add **Count**, set to **Items**, using the Match Text result.
3. Add **If** the count **is 1**.
4. Inside that If, add **Get Group from Matched Text**. Select **Group 1** from the original Match Text result. This returns only the number, for example `1,234.50`. Do not pass the whole matched text.
5. Add **URL Encode** in **Encode** mode, with only Group 1 as its input. Keep it as text; do not convert it with Get Numbers from Input or round it.
6. Add **URL**. Type the following prefix, then insert the **URL Encoded Text** magic-variable token immediately after `=`:

```text
https://marcusjai.github.io/pocket-ledger/#reimburse?amount=
```

7. In **Otherwise**, add a **URL** action containing the existing manual-entry link:

```text
https://marcusjai.github.io/pocket-ledger/#reimburse
```

8. After **End If**, add **Open URLs**, taking **If Result** as its input. Ensure this branch does not continue into an expense-submission action.

The URL Encoded Text must be a blue variable token, not its name typed as ordinary text. Encode only the amount, once. For example, `1,234.50` becomes `1%2C234.50`; do not encode the whole URL. Apple documents [inserting magic variables](https://support.apple.com/en-sg/guide/shortcuts/apdd02c2780c/ios), [passing the selected branch through If Result](https://support.apple.com/guide/shortcuts/use-if-actions-apd83dcd1b51/ios), and [building a URL then opening it](https://support.apple.com/guide/shortcuts/use-another-apps-url-scheme-apd68802640c/ios).

## What this extracts

The pattern follows the wording visible in the supplied HASEnotice screenshot. This example uses invented data:

```text
Hang Seng: You've received a transfer of HKD1,234.50 from EXAMPLE to your account XXX-XXX on 2026-01-01.
```

It extracts `1,234.50`, specifically after the received-transfer phrase and before `from`. It also accepts `HK$`, a straight or curly apostrophe, whole amounts, and one or two decimal places. It rejects zero, negatives, values above `9,999,999.99`, broken comma grouping, extra decimal places, scientific notation, unsupported currency labels, and multiple received-transfer phrases or HKD/HK$ labels. Leading-zero formats and changed bank wording also fall back to manual entry.

The exact-one-match check must stay. Never pick the first number or first match when the notification is ambiguous. A balance, account number, date, outgoing transfer, or other notification must not supply the repayment amount. Unexpected formatting should open the bare repayment form so you can enter the amount yourself.

## Check on the iPhone before using real notifications

In a separate temporary test Shortcut, use a **Text** action with the synthetic example above as the input to the same Match Text/If/URL actions. Do not run synthetic text through the existing expense or backend-submission branches.

Start each test in a fresh, blank form so a retained draft is not mistaken for a newly imported amount. Do not discard real unsaved work for a test.

- The valid example must open the form with `1234.50`; do not save the test
- Change the amount to `HKD123.456`, `HKD12,34.50`, `HKD-12`, `HKD1e3`, `HKD0`, or `USD12.34`: each must open the manual form with no imported amount
- Add another `HKD20.00` or a second `received a transfer` phrase: use the manual form
- Confirm the real branch still asks you to choose **Record repayment**, then choose the original expense and tap **儲存還款** only when the details are correct

The regex and URL contract have automated synthetic tests. Execution of these actions on the user's iPhone still needs the check above; a screenshot confirms the wording, not the installed automation or its variable wiring.

## Privacy and limits

The Shortcut passes only the extracted number. Never add the sender, account details, full notification, backend URL, authentication token, or other secret to the link. Do not add **Get Contents of URL**, a backend POST, or automatic saving to this repayment branch.

The amount is in the URL fragment after `#`, rather than a server query. The app removes the amount parameter once it reads it, but browser history, browser sync, screenshots, extensions, or copied links may capture the original URL. Do not treat a fragment as secret storage.

This is amount prefilling only. It does not identify the original expense or detect duplicate repayments. Reopening the same notification does not prove it has not already been recorded; check before saving again.

## Short version

After the deployed app shows v1.2.1, edit only **Record repayment**: Match Text on Notification Body with the pattern above → Count Items → If exactly 1 → Get Group 1 → URL Encode that number → URL with `#reimburse?amount=` plus the encoded token. Otherwise use the old bare `#reimburse` URL. After End If, Open URLs using If Result. Test without saving, then select the original expense and save manually for real repayments.
