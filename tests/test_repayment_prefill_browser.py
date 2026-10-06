"""Local-only Chromium integration tests; see docs/testing.md for setup and limits.

Run: python -m unittest discover -s tests -p 'test_*_browser.py' -v
No third-party website, real ledger, credentials, or backend is used. Each test
gets a fresh ephemeral context/IndexedDB. All non-loopback page requests abort.
"""
from contextlib import contextmanager
from functools import partial
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
import os
import shutil
import subprocess
import tempfile
import threading
import unittest
from urllib.parse import quote, urlparse

from playwright.sync_api import sync_playwright, expect

ROOT = Path(__file__).resolve().parents[1]
ARTIFACTS = Path(os.environ.get("BROWSER_TEST_ARTIFACTS", "/tmp/pocket-ledger-browser-tests"))
EXPENSE_ID = "synthetic-expense-0001"
BASELINE_REF = os.environ.get("BASELINE_REF", "e6bd6ae3b4883fed94fa9e67c2d108ccd718bdd2")


class Handler(SimpleHTTPRequestHandler):
    def log_message(self, *_):
        pass

    def end_headers(self):
        # In addition to request interception, prohibit unexpected remote reads
        # from either a page or a service worker in this synthetic test origin.
        self.send_header("Content-Security-Policy", "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; worker-src 'self'")
        self.send_header("Cache-Control", "no-store")
        super().end_headers()


@contextmanager
def server(directory):
    httpd = ThreadingHTTPServer(("127.0.0.1", 0), partial(Handler, directory=str(directory)))
    worker = threading.Thread(target=httpd.serve_forever, daemon=True)
    worker.start()
    try:
        yield f"http://127.0.0.1:{httpd.server_port}"
    finally:
        httpd.shutdown()
        httpd.server_close()
        worker.join()


class RepaymentPrefillBrowserTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.server = server(ROOT)
        cls.origin = cls.server.__enter__()
        cls.playwright = sync_playwright().start()
        cls.browser = cls.playwright.chromium.launch(
            executable_path=os.environ.get("CHROMIUM_PATH", "/usr/bin/chromium"),
            headless=True,
            args=["--no-sandbox", "--disable-background-networking"],
        )
        ARTIFACTS.mkdir(parents=True, exist_ok=True)

    @classmethod
    def tearDownClass(cls):
        cls.browser.close()
        cls.playwright.stop()
        cls.server.__exit__(None, None, None)

    def setUp(self):
        self.context = self.browser.new_context(viewport={"width": 390, "height": 844}, service_workers="block")
        self.external_requests = []
        self.context.route("**/*", self.restrict_request)
        self.page = self.context.new_page()
        self.page.set_default_timeout(5000)
        self.errors = []
        self.page.on("pageerror", lambda error: self.errors.append(str(error)))

    def tearDown(self):
        self.context.close()
        self.assertEqual([], self.external_requests, "Unexpected external request attempted")
        self.assertEqual([], self.errors, "Uncaught browser JavaScript error")

    def restrict_request(self, route):
        if urlparse(route.request.url).hostname != "127.0.0.1":
            self.external_requests.append(route.request.url)
            route.abort()
        else:
            route.continue_()

    def open(self, fragment="dashboard"):
        self.page.goto(self.origin + "/#" + fragment)
        self.page.wait_for_function("document.querySelector('#status').textContent.includes('本機模式')")

    def navigate(self, fragment):
        self.page.evaluate("fragment => { location.hash = fragment; }", fragment)
        if fragment.startswith("reimburse?"):
            expect(self.page).to_have_url(self.origin + "/#reimburse")
        else:
            expect(self.page).to_have_url(self.origin + "/#" + fragment)
        # URL is replaced during route; ensure pending hashchange has run.
        self.page.wait_for_function("!document.querySelector('#' + (location.hash === '#reimburse' ? 'add' : location.hash.slice(1))).hidden")

    def ledger(self):
        return self.page.evaluate("LedgerStore.read()")

    def seed_expense(self, amount="200.00"):
        self.page.evaluate("""async ({id, amount}) => {
            await LedgerStore.mutate(s => LedgerStore.add(s, {
                id, amount, source: 'Cash', category: 'Dining',
                merchant: 'Synthetic test only', note: 'Never real data',
                timestamp: new Date().toISOString()
            }));
            await refresh();
        }""", {"id": EXPENSE_ID, "amount": amount})

    def assert_blank_draft(self):
        for field in ["expense", "amount", "payer", "note", "time"]:
            expect(self.page.locator("#reimbursement-" + field)).to_have_value("")
        expect(self.page.locator("#reimbursement-source")).to_have_value("BankTransfer")

    def test_initial_encoded_hkd_link_prefills_only_amount(self):
        self.open("reimburse?amount=" + quote("HK$ 1,234.50", safe=""))
        expect(self.page).to_have_url(self.origin + "/#reimburse")
        expect(self.page.locator("#reimbursement-form")).to_be_visible()
        expect(self.page.locator("#entry-form")).to_be_hidden()
        expect(self.page.locator("#reimbursement-amount")).to_have_value("1234.50")
        expect(self.page.locator("#reimbursement-expense")).to_have_value("")
        expect(self.page.locator("#save-reimbursement")).to_be_disabled()
        expect(self.page.locator("#repayment-link-actions")).to_be_hidden()
        self.assertEqual([], self.ledger()["transactions"])
        self.assertEqual([], self.ledger()["outbox"])
        self.assertNotIn("amount=", self.page.url)
        self.page.screenshot(path=str(ARTIFACTS / "phone-prefill.png"), full_page=True)

    def test_already_open_link_and_expense_draft_are_independent(self):
        self.open("add")
        self.page.locator("#amount").fill("77.70")
        self.page.locator("#note").fill("Synthetic unsaved expense")
        self.navigate("reimburse?amount=63")
        expect(self.page.locator("#reimbursement-amount")).to_have_value("63.00")
        self.page.locator("#mode-expense").click()
        expect(self.page.locator("#amount")).to_have_value("77.70")
        expect(self.page.locator("#note")).to_have_value("Synthetic unsaved expense")
        self.assertEqual([], self.ledger()["transactions"])

    def test_blank_and_invalid_payloads_have_manual_handoff_without_write(self):
        # Every case gets a fresh document; no previous invalid notice/draft can
        # make a later assertion pass accidentally.
        invalid = ["", " ", "USD 63", "$63", "-63", "0", "1.234", "1e2", "12,34.50", "10000000", "<img src=x onerror=alert(1)>"]
        fragments = ["reimburse?amount=" + quote(v, safe="") for v in invalid]
        fragments += ["reimburse?amount=63&amount=64", "reimburse?amount=63&token=synthetic", "reimburse?amount=%", "reimburse?Amount=63", "reimburse?", "reimburse?amount=" + "1" * 300]
        for fragment in fragments:
            with self.subTest(fragment=fragment):
                self.open(fragment)
                expect(self.page).to_have_url(self.origin + "/#reimburse")
                self.assert_blank_draft()
                expect(self.page.locator("#repayment-link-notice")).to_be_visible()
                expect(self.page.locator("#repayment-link-message")).to_contain_text("格式未能確認")
                expect(self.page.locator("#repayment-link-actions")).to_be_hidden()
                self.assertEqual([], self.ledger()["transactions"])
                self.assertEqual([], self.ledger()["outbox"])

    def test_plain_repayment_route_still_works(self):
        self.open("reimburse")
        self.assert_blank_draft()
        expect(self.page.locator("#repayment-link-notice")).to_be_hidden()
        expect(self.page.locator("#reimbursement-form")).to_be_visible()

    def test_manual_select_and_save_writes_exactly_one_valid_repayment(self):
        self.open("dashboard")
        self.seed_expense()
        before = self.ledger()
        self.navigate("reimburse?amount=63.25")
        self.assertEqual(before, self.ledger(), "A link must never change ledger or outbox")
        expect(self.page.locator("#save-reimbursement")).to_be_disabled()
        self.page.locator("#reimbursement-expense").select_option(EXPENSE_ID)
        self.page.locator("#reimbursement-payer").fill("Synthetic friend")
        expect(self.page.locator("#save-reimbursement")).to_be_enabled()
        self.assertEqual(before, self.ledger(), "Selecting an expense must not save")
        self.page.locator("#save-reimbursement").click()
        expect(self.page).to_have_url(self.origin + "/#dashboard")
        after = self.ledger()
        self.assertEqual(2, len(after["transactions"]))
        repayment = [r for r in after["transactions"] if r["kind"] == "reimbursement"][0]
        self.assertEqual((EXPENSE_ID, 6325, "Synthetic friend"), (repayment["expenseId"], repayment["amountCents"], repayment["payer"]))
        self.assertEqual(1, len([o for o in after["outbox"] if o["action"] == "reimburse"]))
        self.navigate("reimburse?amount=12")
        expect(self.page.locator("#reimbursement-amount")).to_have_value("12.00")
        expect(self.page.locator("#repayment-link-actions")).to_be_hidden()

    def test_oversize_repayment_remains_unsaved_and_user_edit_can_fix_it(self):
        self.open()
        self.seed_expense("100.00")
        before = self.ledger()
        self.navigate("reimburse?amount=100.01")
        self.page.locator("#reimbursement-expense").select_option(EXPENSE_ID)
        self.page.locator("#save-reimbursement").click()
        expect(self.page.locator("#toast")).to_contain_text("累計還款不可超過原支出")
        expect(self.page.locator("#reimbursement-amount")).to_have_value("100.01")
        self.assertEqual(before, self.ledger())
        self.page.locator("#reimbursement-amount").fill("99.99")
        self.page.locator("#save-reimbursement").click()
        expect(self.page).to_have_url(self.origin + "/#dashboard")
        self.assertEqual(9999, [r for r in self.ledger()["transactions"] if r["kind"] == "reimbursement"][0]["amountCents"])

    def test_existing_full_draft_keep_or_explicitly_discard_all_fields(self):
        self.open("reimburse")
        self.seed_expense()
        values = {"expense": EXPENSE_ID, "amount": "51.50", "payer": "Synthetic Alex", "note": "Synthetic draft", "time": "2026-10-06T12:34", "source": "PayMe"}
        self.page.locator("#reimbursement-form details").evaluate("el => el.open = true")
        for field, value in values.items():
            locator = self.page.locator("#reimbursement-" + field)
            locator.select_option(value) if field in ("expense", "source") else locator.fill(value)
        before = self.ledger()
        self.navigate("reimburse?amount=64")
        expect(self.page.locator("#repayment-link-actions")).to_be_visible()
        for field, value in values.items():
            expect(self.page.locator("#reimbursement-" + field)).to_have_value(value)
        self.page.screenshot(path=str(ARTIFACTS / "phone-conflict.png"), full_page=True)
        self.page.locator("#keep-repayment-draft").click()
        expect(self.page.locator("#repayment-link-notice")).to_be_hidden()
        for field, value in values.items():
            expect(self.page.locator("#reimbursement-" + field)).to_have_value(value)
        self.navigate("reimburse?amount=64")
        self.page.locator("#replace-repayment-draft").click()
        expect(self.page.locator("#reimbursement-amount")).to_have_value("64.00")
        for field in ["expense", "payer", "note", "time"]:
            expect(self.page.locator("#reimbursement-" + field)).to_have_value("")
        expect(self.page.locator("#reimbursement-source")).to_have_value("BankTransfer")
        expect(self.page.locator("#save-reimbursement")).to_be_disabled()
        expect(self.page.locator("#repayment-link-actions")).to_be_hidden()
        self.assertEqual(before, self.ledger())

    def test_each_individual_draft_field_blocks_silent_overwrite(self):
        for field, value in [("expense", EXPENSE_ID), ("amount", "2"), ("payer", "Synthetic"), ("note", "Synthetic"), ("time", "2026-10-06T12:34"), ("source", "FPS")]:
            with self.subTest(field=field):
                self.open("reimburse")
                if field == "expense" and not self.ledger()["transactions"]:
                    self.seed_expense()
                self.page.locator("#reimbursement-form details").evaluate("el => el.open = true")
                locator = self.page.locator("#reimbursement-" + field)
                locator.select_option(value) if field in ("expense", "source") else locator.fill(value)
                self.navigate("reimburse?amount=63")
                expect(self.page.locator("#repayment-link-actions")).to_be_visible()
                expect(locator).to_have_value(value)

    def test_typed_then_cleared_draft_is_still_protected(self):
        self.open("reimburse")
        self.page.locator("#reimbursement-payer").fill("Synthetic")
        self.page.locator("#reimbursement-payer").fill("")
        self.navigate("reimburse?amount=63")
        self.assert_blank_draft()
        expect(self.page.locator("#repayment-link-actions")).to_be_visible()
        self.page.locator("#replace-repayment-draft").click()
        expect(self.page.locator("#reimbursement-amount")).to_have_value("63.00")
        self.page.locator("#reimbursement-amount").fill("")
        expect(self.page.locator("#repayment-link-notice")).to_be_hidden()
        self.navigate("reimburse?amount=64")
        expect(self.page.locator("#reimbursement-amount")).to_have_value("")
        expect(self.page.locator("#repayment-link-actions")).to_be_visible()

    def test_repeated_link_and_newer_link_use_latest_pending_amount(self):
        self.open("reimburse?amount=63")
        self.navigate("reimburse?amount=63")
        expect(self.page.locator("#repayment-link-actions")).to_be_visible()
        expect(self.page.locator("#reimbursement-amount")).to_have_value("63.00")
        self.navigate("reimburse?amount=64")
        expect(self.page.locator("#repayment-link-message")).to_contain_text("64.00")
        self.page.locator("#reimbursement-note").fill("Edits while deciding remain protected")
        self.page.locator("#replace-repayment-draft").click()
        expect(self.page.locator("#reimbursement-amount")).to_have_value("64.00")
        expect(self.page.locator("#reimbursement-note")).to_have_value("")
        self.assertEqual([], self.ledger()["transactions"])

    def test_navigation_and_invalid_link_clear_stale_pending_conflict(self):
        self.open("reimburse?amount=63")
        self.navigate("reimburse?amount=64")
        self.page.locator("nav [data-view=settings]").click()
        self.page.locator("nav [data-view=add]").click()
        expect(self.page.locator("#reimbursement-amount")).to_have_value("63.00")
        expect(self.page.locator("#repayment-link-notice")).to_be_hidden()
        self.page.locator("#replace-repayment-draft").evaluate("el => el.click()")
        expect(self.page.locator("#reimbursement-amount")).to_have_value("63.00")
        self.navigate("reimburse?amount=65")
        self.navigate("reimburse?amount=USD63")
        expect(self.page.locator("#repayment-link-actions")).to_be_hidden()
        self.page.locator("#replace-repayment-draft").evaluate("el => el.click()")
        expect(self.page.locator("#reimbursement-amount")).to_have_value("63.00")
        self.page.locator("#mode-expense").click()
        self.page.locator("#mode-reimbursement").click()
        expect(self.page.locator("#repayment-link-notice")).to_be_hidden()

    def test_browser_back_forward_never_replays_consumed_amount(self):
        self.open("dashboard")
        self.navigate("reimburse?amount=63")
        self.page.locator("#reimbursement-amount").fill("62.00")
        self.navigate("settings")
        self.page.go_back()
        expect(self.page).to_have_url(self.origin + "/#reimburse")
        expect(self.page.locator("#reimbursement-amount")).to_have_value("62.00")
        expect(self.page.locator("#repayment-link-notice")).to_be_hidden()
        self.page.go_back()
        expect(self.page).to_have_url(self.origin + "/#dashboard")
        self.page.go_forward()
        expect(self.page).to_have_url(self.origin + "/#reimburse")
        expect(self.page.locator("#reimbursement-amount")).to_have_value("62.00")
        expect(self.page.locator("#repayment-link-actions")).to_be_hidden()
        self.page.go_forward()
        expect(self.page).to_have_url(self.origin + "/#settings")
        self.assertEqual([], self.ledger()["transactions"])

    def test_delayed_storage_initialization_uses_latest_navigation(self):
        self.context.add_init_script("""(() => {
            const realOpen = indexedDB.open.bind(indexedDB);
            indexedDB.open = (...args) => {
                const wrapper = {};
                window.releaseTestStorage = () => {
                    const request = realOpen(...args);
                    for (const event of ['success', 'error', 'upgradeneeded', 'blocked']) {
                        request.addEventListener(event, e => {
                            Object.defineProperties(wrapper, {
                                result: {get: () => request.result, configurable: true},
                                error: {get: () => request.error, configurable: true}
                            });
                            wrapper['on' + event]?.(e);
                        });
                    }
                };
                return wrapper;
            };
        })();""")
        self.page.goto(self.origin + "/#reimburse?amount=63")
        self.page.wait_for_function("typeof releaseTestStorage === 'function'")
        self.page.evaluate("location.hash = 'reimburse?amount=64'")
        self.page.evaluate("releaseTestStorage()")
        expect(self.page).to_have_url(self.origin + "/#reimburse")
        expect(self.page.locator("#reimbursement-amount")).to_have_value("64.00")
        self.assertEqual([], self.ledger()["transactions"])

    def pause_next_mutation(self, fail=False):
        self.page.evaluate("""fail => {
            const mutate = LedgerStore.mutate;
            LedgerStore.mutate = async fn => {
                LedgerStore.mutate = mutate;
                await new Promise(resolve => { window.releaseTestSave = resolve; });
                if (fail) throw new Error('Synthetic write failure');
                return mutate(fn);
            };
        }""", fail)

    def start_paused_save(self, fail=False):
        self.open()
        self.seed_expense()
        self.navigate("reimburse?amount=63")
        self.page.locator("#reimbursement-expense").select_option(EXPENSE_ID)
        self.pause_next_mutation(fail)
        self.page.locator("#save-reimbursement").click()
        self.page.wait_for_function("typeof releaseTestSave === 'function'")

    def test_new_link_while_saving_survives_as_new_unsaved_draft(self):
        self.start_paused_save()
        self.navigate("reimburse?amount=64")
        self.navigate("reimburse?amount=65")
        self.page.evaluate("releaseTestSave()")
        expect(self.page.locator("#reimbursement-amount")).to_have_value("65.00")
        expect(self.page).to_have_url(self.origin + "/#reimburse")
        expect(self.page.locator("#reimbursement-expense")).to_have_value("")
        expect(self.page.locator("#save-reimbursement")).to_be_disabled()
        repayments = [r for r in self.ledger()["transactions"] if r["kind"] == "reimbursement"]
        self.assertEqual([6300], [r["amountCents"] for r in repayments])

    def test_navigation_while_saving_is_not_replaced_by_old_save_redirect(self):
        self.start_paused_save()
        self.navigate("reimburse?amount=64")
        self.navigate("settings")
        self.page.evaluate("releaseTestSave()")
        self.page.wait_for_function("LedgerStore.read().then(s => s.transactions.length === 2)")
        expect(self.page).to_have_url(self.origin + "/#settings")
        expect(self.page.locator("#settings")).to_be_visible()
        self.page.locator("nav [data-view=add]").click()
        expect(self.page.locator("#repayment-link-actions")).to_be_hidden()
        self.page.locator("#replace-repayment-draft").evaluate("el => el.click()")
        expect(self.page.locator("#reimbursement-amount")).not_to_have_value("64.00")

    def test_failed_save_preserves_existing_draft_and_pending_link_choice(self):
        self.start_paused_save(fail=True)
        self.navigate("reimburse?amount=64")
        self.page.evaluate("releaseTestSave()")
        expect(self.page.locator("#toast")).to_contain_text("Synthetic write failure")
        expect(self.page.locator("#reimbursement-amount")).to_have_value("63.00")
        expect(self.page.locator("#reimbursement-expense")).to_have_value(EXPENSE_ID)
        expect(self.page.locator("#repayment-link-actions")).to_be_visible()
        self.assertEqual(1, len(self.ledger()["transactions"]))
        self.page.locator("#replace-repayment-draft").click()
        expect(self.page.locator("#reimbursement-amount")).to_have_value("64.00")
        expect(self.page.locator("#reimbursement-expense")).to_have_value("")

    def test_storage_failure_is_visible_and_never_saves(self):
        self.context.add_init_script("indexedDB.open = () => { throw new Error('Synthetic storage unavailable'); }")
        self.page.goto(self.origin + "/#reimburse?amount=63")
        expect(self.page.locator("#status")).to_contain_text("無法開啟本機資料庫")
        expect(self.page.locator("#toast")).to_contain_text("Synthetic storage unavailable")
        expect(self.page.locator("#reimbursement-amount")).to_have_value("")
        # Startup failure currently leaves the handoff in the fragment; this
        # observation is reported separately, rather than implying a saved entry.

    def test_narrow_phone_layout_has_no_horizontal_overflow(self):
        self.page.set_viewport_size({"width": 320, "height": 640})
        self.open("reimburse?amount=9999999.99")
        self.navigate("reimburse?amount=1234.50")
        self.assertLessEqual(self.page.evaluate("document.documentElement.scrollWidth"), 320)
        for selector in ["#keep-repayment-draft", "#replace-repayment-draft", "#reimbursement-amount"]:
            box = self.page.locator(selector).bounding_box()
            self.assertGreaterEqual(box["x"], 0)
            self.assertLessEqual(box["x"] + box["width"], 320)
        self.page.screenshot(path=str(ARTIFACTS / "phone-320-conflict.png"), full_page=True)

    def test_service_worker_upgrade_preserves_old_shell_until_reopen(self):
        # Build an actual baseline shell, then swap only the served fixture to
        # the new files. No app source or real browser profile is modified.
        self.context.close()
        self.context = self.browser.new_context(service_workers="allow")
        self.context.route("**/*", self.restrict_request)
        with tempfile.TemporaryDirectory(prefix="ledger-shell-upgrade-") as directory:
            root = Path(directory)
            files = ["index.html", "styles.css", "engine.js", "store.js", "app.js", "sw.js", "manifest.webmanifest", "icons/icon.svg", "icons/icon-192.png", "icons/icon-512.png"]
            for file in files:
                target = root / file
                target.parent.mkdir(parents=True, exist_ok=True)
                target.write_bytes(subprocess.check_output(["git", "show", BASELINE_REF + ":" + file], cwd=ROOT))
            with server(root) as origin:
                self.page = self.context.new_page()
                self.page.on("pageerror", lambda error: self.errors.append(str(error)))
                self.page.goto(origin + "/#settings")
                self.page.evaluate("navigator.serviceWorker.ready")
                self.page.wait_for_function("navigator.serviceWorker.controller !== null")
                self.assertFalse(self.page.evaluate("'RepaymentLink' in window"))
                old_cache = self.page.evaluate("caches.keys()")
                for file in files + ["repayment-link.js"]:
                    shutil.copyfile(ROOT / file, root / file)
                self.page.evaluate("navigator.serviceWorker.getRegistration().then(r => r.update())")
                self.page.wait_for_function("navigator.serviceWorker.getRegistration().then(r => !!r.waiting)")
                self.assertTrue(set(old_cache).issubset(self.page.evaluate("caches.keys()")))
                self.page.reload()
                self.assertFalse(self.page.evaluate("'RepaymentLink' in window"), "Waiting worker must not mix new JS into old shell")
                self.page.close()
                self.page = self.context.new_page()
                self.page.on("pageerror", lambda error: self.errors.append(str(error)))
                self.page.goto(origin + "/#reimburse?amount=74.25")
                self.page.wait_for_function("typeof RepaymentLink !== 'undefined'")
                expect(self.page.locator("#reimbursement-amount")).to_have_value("74.25")
                self.page.wait_for_function("caches.keys().then(keys => keys.length === 1)")
                self.assertNotEqual(old_cache, self.page.evaluate("caches.keys()"))
                self.context.set_offline(True)
                self.page.reload()
                expect(self.page.locator("#status")).to_contain_text("離線模式")
                self.page.evaluate("location.hash = 'reimburse?amount=75.25'")
                expect(self.page.locator("#reimbursement-amount")).to_have_value("75.25")
                self.assertEqual([], self.ledger()["transactions"])

    def test_service_worker_cached_shell_and_new_script_work_offline(self):
        self.context.close()
        self.context = self.browser.new_context(viewport={"width": 390, "height": 844}, service_workers="allow")
        self.context.route("**/*", self.restrict_request)
        self.page = self.context.new_page()
        self.page.on("pageerror", lambda error: self.errors.append(str(error)))
        self.open("reimburse?amount=63")
        self.page.evaluate("navigator.serviceWorker.ready")
        self.page.wait_for_function("navigator.serviceWorker.controller !== null")
        cached = self.page.evaluate("""async () => {
            const result = {};
            for (const key of await caches.keys()) result[key] = (await (await caches.open(key)).keys()).map(r => new URL(r.url).pathname + new URL(r.url).search);
            return result;
        }""")
        self.assertEqual(1, len(cached))
        paths = next(iter(cached.values()))
        self.assertTrue(any(path.startswith("/repayment-link.js?v=") for path in paths))
        self.assertTrue(any(path.startswith("/app.js?v=") for path in paths))
        self.context.set_offline(True)
        self.page.reload()
        expect(self.page.locator("#status")).to_contain_text("離線模式")
        self.navigate("reimburse?amount=84.25")
        expect(self.page.locator("#reimbursement-amount")).to_have_value("84.25")
        self.assertEqual([], self.ledger()["transactions"])
        self.assertNotIn("amount=", self.page.url)
        self.page.screenshot(path=str(ARTIFACTS / "phone-offline-prefill.png"), full_page=True)


if __name__ == "__main__":
    unittest.main()
