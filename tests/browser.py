"""Browser regression checks for the clearly labelled, self-contained demo.

Prerequisites: pip install playwright; playwright install chromium
Run npm run build first, then: python tests/browser.py
CHROME_BIN may select an existing Chromium installation.
No local server and no outbound network requests are needed for this suite.
"""
import json
import os
from pathlib import Path
from playwright.sync_api import sync_playwright, expect

ROOT = Path(__file__).resolve().parents[1]
OUTPUT = ROOT / 'test-results'
OUTPUT.mkdir(exist_ok=True)
SOURCE = (ROOT / 'dist/cloudlane-preview.html').read_text()
checks = []


def checked(label, condition=True):
    assert condition, label
    checks.append(label)


with sync_playwright() as p:
    options = {'headless': True, 'args': ['--no-sandbox']}
    if os.environ.get('CHROME_BIN'):
        options['executable_path'] = os.environ['CHROME_BIN']
    browser = p.chromium.launch(**options)
    page = browser.new_page(viewport={'width': 1600, 'height': 1180}, device_scale_factor=1)
    errors, requests = [], []
    page.on('pageerror', lambda e: errors.append(str(e)))
    page.on('request', lambda req: requests.append(req.url))

    def reset():
        # set_content retains module bindings, so use a fresh document for each reset.
        page.goto('about:blank')
        page.set_content(SOURCE)
        expect(page.locator('.record-card')).to_have_count(6)
        page.wait_for_timeout(300)

    def close():
        page.keyboard.press('Escape')
        expect(page.locator('[role="dialog"]')).to_have_count(0)

    def navigation(key):
        page.locator(f'[data-action="navigate"][data-id="{key}"]').click()

    reset()
    checked('desktop has six sample cards, and no horizontal overflow', page.evaluate('document.documentElement.scrollWidth <= innerWidth'))
    domain_lefts = page.locator('.record-card .domain-map').evaluate_all('(xs) => xs.map(x => Math.round(x.getBoundingClientRect().left))')
    status_lefts = page.locator('.record-card .record-status').evaluate_all('(xs) => xs.map(x => Math.round(x.getBoundingClientRect().left))')
    checked('desktop cards share aligned domain and status columns', max(domain_lefts) - min(domain_lefts) <= 1 and max(status_lefts) - min(status_lefts) <= 1)
    ssl_pending_card = page.locator('.record-card').filter(has=page.locator('[data-action="detail"][data-id="demo-route-1"]'))
    expect(ssl_pending_card.locator('.badge.blue').first).to_contain_text('配置就绪')
    expect(ssl_pending_card.locator('.ssl-line')).to_contain_text('pending_validation')
    checked('SSL pending is visible but does not make the route unready')
    page.screenshot(path=str(OUTPUT / 'desktop.png'), full_page=True)
    page.locator('#route-search').fill('one-mcp')
    expect(page.locator('.record-card')).to_have_count(1)
    checked('search filters records without losing keyboard focus', page.locator('#route-search').evaluate('(x) => document.activeElement === x'))
    page.locator('#route-search').fill('')
    page.locator('[data-action="tab"][data-id="attention"]').click()
    expect(page.locator('.record-card')).to_have_count(1)
    checked('attention filter excludes informational SSL pending and still includes drift')
    page.locator('[data-action="tab"][data-id="all"]').click()
    page.locator('#profile-filter').select_option('demo-profile-2')
    expect(page.locator('.record-card')).to_have_count(2)
    checked('profile filter separates multiple tunnels/accounts')
    page.locator('#profile-filter').select_option('')

    page.locator('[data-action="detail"][data-id="demo-route-4"]').first.click()
    expect(page.locator('.diagnostics')).to_be_visible()
    expect(page.locator('.modal .notice.amber')).to_contain_text('橙云')
    checked('diagnostics exposes drift without claiming origin reachability')
    page.wait_for_timeout(350)
    page.screenshot(path=str(OUTPUT / 'diagnostics.png'))
    checked('background is inert while dialog is open', page.locator('.app-shell').evaluate('(x) => x.inert'))
    close()

    page.locator('[data-action="new-route"]').click()
    page.locator('input[name="slug"]').fill('notes-test')
    expect(page.locator('input[name="publicHostname"]')).to_have_value('notes-test.b.example')
    expect(page.locator('input[name="originHostname"]')).to_have_value('notes-test.a.example')
    page.locator('input[name="name"]').fill('Notes Test')
    page.locator('input[name="service"]').fill('http://localhost:5230')
    page.wait_for_timeout(300)
    page.screenshot(path=str(OUTPUT / 'create.png'))
    page.locator('button[type="submit"]').click()
    expect(page.locator('#modal-title')).to_contain_text('检查变更')
    expect(page.locator('.plan-step')).to_have_count(5)
    checked('new route creates a plan first, not a route', page.locator('.record-card').count() == 6)
    expect(page.locator('input[name="confirmHostname"]')).to_have_count(0)
    checked('normal cloud changes use one acknowledgement instead of typed hostname confirmation')
    page.locator('input[name="acknowledge"]').check()
    page.locator('.plan-step details').first.locator('summary').click()
    page.wait_for_timeout(300)
    page.screenshot(path=str(OUTPUT / 'plan.png'))
    page.locator('button[type="submit"]').click()
    expect(page.locator('#modal-title')).to_have_text('Notes Test')
    expect(page.locator('.modal .notice').first).to_contain_text('演示任务已完成')
    checked('confirmed simulation has journal details and no live cloud claims')
    close()
    expect(page.locator('.record-card')).to_have_count(7)

    new_id = page.locator('.record-title').filter(has_text='Notes Test').get_attribute('data-id')
    page.locator(f'[data-action="edit-route"][data-id="{new_id}"]').click()
    checked('editing locks public hostname', page.locator('input[name="publicHostname"]').get_attribute('readonly') is not None)
    page.locator('input[name="name"]').fill('<img src=x onerror="window.pwned=1">')
    page.locator('input[name="service"]').fill('http://localhost:5231')
    page.locator('button[type="submit"]').click()
    expect(page.locator('#modal-title')).to_contain_text('检查变更')
    page.locator('input[name="acknowledge"]').check()
    expect(page.locator('input[name="confirmHostname"]')).to_have_count(0)
    page.locator('button[type="submit"]').click()
    expect(page.locator('#modal-title')).to_contain_text('<img')
    close()
    checked('record names and job titles are HTML-escaped', page.evaluate('window.pwned === undefined') and page.locator('img').count() == 0)

    page.locator('.head-actions [data-action="import"]').click()
    page.locator('[data-action="scan-import"]').click()
    expect(page.locator('.candidate')).to_have_count(1)
    page.locator('button[type="submit"]').click()
    expect(page.locator('[role="dialog"]')).to_have_count(0)
    expect(page.locator('.record-card')).to_have_count(8)
    checked('scan, select, and read-only import interaction works')

    navigation('profiles')
    expect(page.locator('.resource-card')).to_have_count(2)
    page.locator('[data-action="edit-profile"]').first.click()
    expect(page.locator('select[name="sourceZoneId"]')).to_have_value('1' * 32)
    checked('profile edit loads catalogs and locks referenced tunnel', page.locator('select[name="tunnelId"]').is_disabled())
    close()
    page.locator('[data-action="edit-edge"]').first.click()
    expect(page.locator('.modal .notice.amber')).to_contain_text('引用')
    page.locator('input[name="target"]').fill('new-preferred.example.net')
    page.locator('button[type="submit"]').click()
    expect(page.locator('#modal-title')).to_contain_text('检查变更')
    checked('shared edge edit requires its own impact preview')
    close()

    navigation('credentials')
    page.locator('[data-action="new-credential"]').click()
    page.locator('input[name="label"]').fill('QA credential')
    page.locator('input[name="accountId"]').fill('c' * 32)
    page.locator('input[name="token"]').fill('QA-secret-never-echo')
    page.locator('button[type="submit"]').click()
    expect(page.locator('.resource-card')).to_have_count(3)
    checked('credential saved without token appearing in rendered page', 'QA-secret-never-echo' not in page.content())
    navigation('tunnels')
    page.locator('[data-action="refresh-catalogs"]').click()
    expect(page.locator('.resource-card')).to_have_count(2)
    checked('tunnel catalog supports multiple accounts')
    expect(page.locator('#app')).to_have_attribute('aria-busy', 'false')
    navigation('jobs')
    page.locator('[data-action="job"]').first.click()
    expect(page.locator('.modal .plan-step')).not_to_have_count(0)
    close()
    checked('job history drilldown works')
    navigation('activity')
    expect(page.locator('.activity-row')).not_to_have_count(0)
    navigation('help')
    expect(page.locator('.guide-card')).to_have_count(6)
    checked('activity and in-app guide have real content')

    navigation('routes')
    page.locator('[data-action="detail"][data-id="demo-route-0"]').first.click()
    page.locator('[data-action="delete-cloud"]').click()
    expect(page.locator('#modal-title')).to_contain_text('删除云端资源')
    expect(page.locator('input[name="confirmHostname"]')).to_have_count(1)
    page.locator('input[name="acknowledge"]').check()
    page.locator('input[name="confirmHostname"]').fill('one-mcp.b.example')
    page.locator('button[type="submit"]').click()
    expect(page.locator('.modal .notice').first).to_contain_text('演示任务已完成')
    close()
    expect(page.locator('.record-card')).to_have_count(7)  # 8 before delete, 1 destructive delete
    checked('destructive cloud deletion has its own preview and typed safety confirmation')

    # Mobile: actual DOM layout and interactions, not just a resized desktop PNG.
    page.set_viewport_size({'width': 390, 'height': 844})
    reset()
    checked('390px viewport has no horizontal page overflow', page.evaluate('document.documentElement.scrollWidth <= innerWidth'))
    page.screenshot(path=str(OUTPUT / 'mobile.png'), full_page=True)
    page.locator('[data-action="menu"]').last.click()
    expect(page.locator('.app-shell')).to_have_class('app-shell menu-open')
    navigation('profiles')
    checked('mobile navigation opens and closes', 'menu-open' not in page.locator('.app-shell').get_attribute('class'))
    page.locator('[data-action="new-profile"]').click()
    expect(page.locator('select[name="sourceCredentialId"]')).to_have_value('demo-credential-1')
    page.wait_for_timeout(400)
    checked('mobile form does not overflow viewport', page.evaluate('document.querySelector(".modal").getBoundingClientRect().right <= innerWidth'))
    close()
    page.locator('[data-action="menu"]').last.click()
    navigation('routes')
    page.locator('[data-action="new-route"]').click()
    page.wait_for_timeout(300)
    page.locator('button[type="submit"]').focus()
    page.keyboard.press('Tab')
    checked('dialog keyboard focus stays inside modal', page.evaluate('document.activeElement.closest("[role=dialog]") !== null'))
    close()
    checked('no browser JavaScript errors', not errors)
    checked('offline preview makes no external requests', not requests)
    browser.close()

report = {'suite': 'offline-browser-regression', 'checks': len(checks), 'passed': checks, 'errors': errors, 'requests': requests}
(OUTPUT / 'browser-report.json').write_text(json.dumps(report, ensure_ascii=False, indent=2))
print(json.dumps(report, ensure_ascii=False, indent=2))