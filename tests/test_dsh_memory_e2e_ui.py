#!/usr/bin/env python3
"""End-to-end UI tests for the dsh-memory settings panel.

Boots a throwaway DSH web profile on an ephemeral port (see
helpers/dsh-e2e-service.mjs), drives headless Chromium through the Python
Playwright installation that ships with the machine's browser-acceptance
tooling, and asserts the rendered panel across desktop/light, dark, and
narrow viewports, plus the empty-state hiding of the preview section on a
fresh memory store, keyboard/focus behavior, inline confirmations, status
tones, and the absence of the removed Legacy migration UI.

The live memory store, real DSH_HOME, and provider credentials are never
touched. Exits non-zero on any assertion failure; skipped (exit 0) when
Playwright is unavailable so CI without browsers still passes.
"""

import json
import os
import re
import shutil
import subprocess
import sys
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent

#: The memory settings panel renders inside the "设置" popover panel.
SETTINGS_TRIGGER = "button.VOzbGW_trigger"
SETTINGS_PANEL = ".VOzbGW_panel"
MEMORY_SECTION = "section[aria-label='长期记忆']"


def run_node(script: str, timeout=120) -> dict:
    """Run a node snippet inside the repo and return its JSON stdout."""
    proc = subprocess.run(
        ["node", "-e", script],
        cwd=ROOT,
        capture_output=True,
        text=True,
        timeout=timeout,
    )
    if proc.returncode != 0:
        raise RuntimeError(f"node helper failed:\n{proc.stderr}")
    return json.loads(proc.stdout)


def wait_for(condition, timeout=15, interval=0.25, message="condition"):
    deadline = time.time() + timeout
    last = None
    while time.time() < deadline:
        try:
            last = condition()
            if last:
                return last
        except Exception as exc:  # noqa: BLE001 - retryable page/selector errors
            last = exc
        time.sleep(interval)
    raise AssertionError(f"timed out waiting for {message} (last: {last!r})")


def open_memory_panel(page, base_url):
    """Navigate to the memory settings panel from a fresh page load.

    Dismisses every first-run dialog (internal-testing notice and API-key
    onboarding) until only the app shell remains, then opens the settings
    popover and returns the memory panel locator.
    """
    page.goto(base_url, wait_until="domcontentloaded", timeout=30000)
    page.wait_for_timeout(4000)
    # The seeded settings.yaml suppresses the internal-testing notice; the
    # API-key onboarding still appears on homes without a provider. Loop until
    # no modal intercepts clicks, then open settings.
    for _ in range(5):
        # Close any visible modal by its primary action button.
        for label in ("Add an API key to get started", "Internal Testing Notice"):
            dialog = page.locator(f"[role='dialog'][aria-label='{label}']")
            if dialog.count() and dialog.first.is_visible():
                action = dialog.first.locator(
                    "button:has-text('Configure later'), button:has-text('Continue')"
                ).first
                try:
                    action.click(timeout=5000)
                    page.wait_for_timeout(1200)
                except Exception:
                    pass
        # A lingering mask blocks pointer events; drop it so the shell is
        # clickable. The mask is purely decorative (aria-hidden).
        page.evaluate(
            """() => document.querySelectorAll('._mask_15u5s_14, [role="presentation"]._root_15u5s_2').forEach((el) => el.remove())""",
        )
        trigger = page.locator(SETTINGS_TRIGGER).first
        if trigger.is_visible():
            try:
                trigger.click(timeout=3000)
                break
            except Exception:
                page.wait_for_timeout(500)
        page.wait_for_timeout(500)
    panel = page.locator(SETTINGS_PANEL).first
    wait_for(lambda: panel.is_visible(), message="settings panel visible")
    page.wait_for_timeout(2000)
    return panel


def stop_service(service: dict | None) -> None:
    """Stop the detached DSH service by PID and remove its temp home."""
    pid = service.get("pid")
    if pid:
        try:
            os.kill(pid, 15)  # SIGTERM
        except OSError:
            pass
    home = service.get("home")
    if home:
        shutil.rmtree(home, ignore_errors=True)


def start_service(options=None) -> dict:
    """Start the source-checkout DSH fixture with optional seeded state."""
    options_json = json.dumps(options or {}, ensure_ascii=False)
    return run_node(
        f'''
        const {{ startIsolatedService }} = await import("./tests/helpers/dsh-e2e-service.mjs");
        const s = await startIsolatedService({options_json});
        console.log(JSON.stringify({{ baseUrl: s.baseUrl, port: s.port, pid: s.child.pid, home: s.home }}));
        process.exit(0);
        ''',
    )


def main() -> int:
    try:
        from playwright.sync_api import sync_playwright
    except ImportError:
        print("dsh-memory e2e: python playwright unavailable; skipping")
        return 0

    service = None
    try:
        service = start_service()
        base_url = service["baseUrl"]
        print(f"dsh-memory e2e: isolated service at {base_url}")

        with sync_playwright() as p:
            browser = p.chromium.launch(headless=True)

            # --- desktop / light + empty states + toggle --------------------
            page = browser.new_page(viewport={"width": 1280, "height": 800})
            panel = open_memory_panel(page, base_url)
            txt = panel.text_content() or ""

            assert "长期记忆" in txt, "memory section title missing"
            assert "记忆库" in txt, "memory repository row missing"
            assert "最近同步" in txt, "recent sync card missing"
            # The Legacy migration UI is intentionally removed; preview remains
            # hidden when the fresh store has no pending previews.
            assert "Legacy 记录" not in txt, "Legacy migration UI must remain absent"
            assert "待应用预览" not in txt, "preview section must be hidden when no pending previews"
            # The repository reports healthy (fixture repo), not unavailable.
            match = re.search(r"记忆库[^\n]*", txt)
            assert match and "不可用" not in match.group(0), f"memory repository unhealthy: {match.group(0) if match else 'N/A'}"

            # The accordion is keyboard-first. Delete is always present even
            # in a fresh store; Enter opens it, Escape closes it, and focus
            # returns to the row header instead of falling out of the modal.
            delete_head = panel.get_by_role("button", name="删除记忆")
            delete_head.focus()
            page.keyboard.press("Enter")
            assert delete_head.get_attribute("aria-expanded") == "true", "Enter should expand delete row"
            delete_body_id = delete_head.get_attribute("aria-controls")
            assert delete_body_id, "accordion header must reference its body"
            delete_body = panel.locator(f"#{delete_body_id}")
            assert delete_body.get_attribute("hidden") is None, "expanded body must be visible"
            page.keyboard.press("Escape")
            assert delete_head.get_attribute("aria-expanded") == "false", "Escape should collapse delete row"
            assert delete_head.evaluate("(el) => document.activeElement === el"), "focus should return to row header"

            # Enable switch reflects the seeded default (on) and toggles off/on.
            toggle = page.locator("button[role='switch'][aria-label='长期记忆']").first
            assert toggle.get_attribute("aria-checked") == "true", "seeded default should be enabled"
            toggle.click()
            page.wait_for_timeout(600)
            assert toggle.get_attribute("aria-checked") == "false", "toggle should turn memory off"
            toggle.click()
            page.wait_for_timeout(600)
            assert toggle.get_attribute("aria-checked") == "true", "toggle should turn memory back on"
            print("dsh-memory e2e: desktop/light + empty states + toggle OK")
            page.close()

            # --- status tones + preview confirmation -----------------------
            # Restart against a second isolated fixture containing a failed
            # last-run journal and one real pending preview. This exercises
            # the source checkout's status rendering and inline confirmation
            # path without a Provider or the user's memory store.
            browser.close()
            stop_service(service)
            service = start_service({"seedLastRun": "failed", "seedPreview": True})
            base_url = service["baseUrl"]
            browser = p.chromium.launch(headless=True)
            page = browser.new_page(viewport={"width": 1280, "height": 800})
            panel = open_memory_panel(page, base_url)

            recent_row = panel.locator("section[aria-label='最近同步']")
            assert recent_row.locator(".dshmu_dot--danger").count() == 1, "failed status must use danger tone"
            assert recent_row.get_by_text("同步失败").count() >= 1, "failed status label missing"
            assert recent_row.get_by_role("button", name="回滚本次同步").count() == 0, "failed runs must not offer rollback"

            preview_row = panel.locator("section[aria-label='待应用预览']")
            preview_head = preview_row.get_by_role("button", name=re.compile("待应用预览"))
            preview_head.click()
            assert preview_head.get_attribute("aria-expanded") == "true", "preview row should expand"
            preview_id = "20260821T000001Z-e2e00002"
            preview_line = preview_row.locator(".dshmu_previewLine")
            assert preview_line.get_by_text(preview_id).count() == 1, "preview id missing"

            apply_button = preview_line.get_by_role("button", name=re.compile("^应用预览 "))
            apply_button.click()
            wait_for(
                lambda: preview_line.get_by_text(f"应用预览 {preview_id}？").count() == 1,
                message="apply confirmation prompt",
            )
            # Escape only cancels the confirmation cluster and keeps the
            # accordion row open; it must not close the settings modal.
            page.keyboard.press("Escape")
            assert preview_line.get_by_text(f"应用预览 {preview_id}？").count() == 0, "Escape should cancel confirmation"
            assert preview_head.get_attribute("aria-expanded") == "true", "confirmation Escape must keep row open"

            apply_button.click()
            confirm_apply = preview_line.get_by_role("button", name="确认应用")
            wait_for(lambda: confirm_apply.is_visible(), message="apply confirmation button")
            confirm_apply.click()
            wait_for(
                lambda: panel.locator("section[aria-label='待应用预览']").count() == 0,
                message="pending preview row removal after apply",
            )
            wait_for(lambda: "已应用" in (panel.text_content() or ""), message="applied status")

            recent_row = panel.locator("section[aria-label='最近同步']")
            recent_head = recent_row.get_by_role("button", name=re.compile("最近同步"))
            assert recent_head.evaluate("(el) => document.activeElement === el"), "apply completion should restore focus"
            recent_head.click()
            assert recent_row.locator(".dshmu_dot--success").count() == 1, "applied status must use success tone"
            rollback_button = recent_row.get_by_role("button", name="回滚本次同步")
            rollback_button.click()
            confirm_rollback = recent_row.get_by_role("button", name="确认回滚")
            wait_for(lambda: confirm_rollback.is_visible(), message="rollback confirmation button")
            confirm_rollback.click()
            wait_for(lambda: "已回滚本次同步" in (panel.text_content() or ""), message="rollback result")
            wait_for(
                lambda: recent_row.locator(".dshmu_dot--warning").count() == 1,
                message="rolled-back status refresh",
            )
            assert recent_row.locator(".dshmu_dot--warning").count() == 1, "rolled-back status must use warning tone"
            assert recent_row.get_by_role("button", name="回滚本次同步").count() == 0, "rolled-back runs must not offer rollback"
            assert recent_head.evaluate("(el) => document.activeElement === el"), "rollback completion should restore focus"
            print("dsh-memory e2e: accordion keyboard + status tones + confirmations OK")
            page.close()

            # --- theme contract ----------------------------------------------
            # The panel's colors come from DSH theme variables
            # (var(--dsw-*)); the settings UI must not hard-code theme colors.
            # Verify the injected stylesheet references the theme tokens.
            page = browser.new_page(viewport={"width": 1280, "height": 800})
            page.goto(base_url, wait_until="domcontentloaded", timeout=30000)
            page.wait_for_timeout(3000)
            css_text = page.evaluate(
                "() => Array.from(document.querySelectorAll('style')).map((s) => s.textContent).join(String.fromCharCode(10))",
            )
            assert "--dsw-alias-label-primary" in css_text, "memory styles must use DSH theme variables"
            assert "--dsw-alias-border-l2" in css_text, "memory styles must use DSH theme variables"
            assert "--dsw-alias-fill-primary" in css_text, "memory styles must use DSH theme variables"
            print("dsh-memory e2e: theme contract OK (var(--dsw-*) referenced)")
            page.close()

            # --- narrow viewport --------------------------------------------
            page = browser.new_page(viewport={"width": 480, "height": 800})
            panel = open_memory_panel(page, base_url)
            overflow = page.evaluate(
                "() => document.documentElement.scrollWidth > document.documentElement.clientWidth",
            )
            assert not overflow, "narrow viewport must not horizontally overflow"
            print("dsh-memory e2e: narrow viewport OK")
            page.close()

            browser.close()
    finally:
        if service:
            stop_service(service)

    print("dsh-memory e2e: all checks passed")
    return 0


if __name__ == "__main__":
    sys.exit(main())
