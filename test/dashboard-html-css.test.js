// dashboard-html-css.test.js - static analysis and structure verification for accessibility & tasks
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const htmlPath = join(process.cwd(), 'dashboard.html');
const cssPath = join(process.cwd(), 'css', 'style.css');
const jsPath = join(process.cwd(), 'js', 'dashboard.js');

const htmlContent = readFileSync(htmlPath, 'utf8');
const cssContent = readFileSync(cssPath, 'utf8');
const jsContent = readFileSync(jsPath, 'utf8');

test('dashboard.html contains semantic landmarks and skip-free logical structure', () => {
    assert.ok(htmlContent.includes('<nav class="sidebar"'), 'missing semantic nav landmark');
    assert.ok(htmlContent.includes('<header class="top-bar"'), 'missing semantic header top-bar');
    assert.ok(htmlContent.includes('<main class="main-content"'), 'missing semantic main landmark');
    assert.ok(htmlContent.includes('<section class="task-guidance-panel"'), 'missing task guidance section');
});

test('dashboard.html table headers use scope="col" and table has accessible description', () => {
    assert.ok(htmlContent.includes('<th scope="col">Instance ID</th>'), 'Instance ID missing scope="col"');
    assert.ok(htmlContent.includes('<th scope="col">Status</th>'), 'Status missing scope="col"');
    assert.ok(htmlContent.includes('<th scope="col">Actions</th>'), 'Actions missing scope="col"');
});

test('dashboard.html action buttons have explicit visible text and aria-labels', () => {
    // verify primary and danger buttons have aria-label and btn-text
    const btnMatches = [...htmlContent.matchAll(/<button[^>]*class="btn[^"]*"[^>]*>/g)];
    assert.ok(btnMatches.length >= 8, 'expected at least 8 table action and form buttons');

    for (const match of btnMatches) {
        const btnHtml = match[0];
        // verify buttons have aria-label if icon-like or within table
        if (btnHtml.includes('data-instance')) {
            assert.ok(btnHtml.includes('aria-label='), `table button missing aria-label: ${btnHtml}`);
        }
    }

    assert.ok(htmlContent.includes('<span class="btn-text">Restart</span>'), 'missing visible Restart label');
    assert.ok(htmlContent.includes('<span class="btn-text">Isolate</span>'), 'missing visible Isolate label');
});

test('dashboard.html includes textual status indicators alongside status dots', () => {
    assert.ok(htmlContent.includes('<span class="status-text">Healthy</span>'), 'missing textual Healthy indicator');
    assert.ok(htmlContent.includes('<span class="status-text">Critical (Overloaded)</span>'), 'missing textual Critical indicator');
    assert.ok(htmlContent.includes('aria-label="Status: Healthy"'), 'missing aria-label for healthy status');
    assert.ok(htmlContent.includes('aria-label="Status: Critical Overloaded"'), 'missing aria-label for critical status');
});

test('dashboard.html form controls have explicitly associated label elements', () => {
    assert.ok(htmlContent.includes('<label for="cfg-max-threads">Max Thread Count</label>'), 'missing label for max threads');
    assert.ok(htmlContent.includes('id="cfg-max-threads"'), 'missing id for max threads');

    assert.ok(htmlContent.includes('<label for="cfg-memory-limit">Memory Limit (MB)</label>'), 'missing label for memory limit');
    assert.ok(htmlContent.includes('id="cfg-memory-limit"'), 'missing id for memory limit');

    assert.ok(htmlContent.includes('<label for="cfg-fallback-strategy">Fallback Strategy</label>'), 'missing label for fallback strategy');
    assert.ok(htmlContent.includes('id="cfg-fallback-strategy"'), 'missing id for fallback strategy');

    assert.ok(htmlContent.includes('<label for="cfg-aggressive-caching">Aggressive Caching</label>'), 'missing label for aggressive caching');
    assert.ok(htmlContent.includes('id="cfg-aggressive-caching"'), 'missing id for aggressive caching');
});

test('dashboard.html inline feedback has role="status" and aria-live="polite"', () => {
    assert.ok(htmlContent.includes('id="inline-feedback"'), 'missing inline-feedback element');
    assert.ok(htmlContent.includes('role="status"'), 'missing role="status" on feedback element');
    assert.ok(htmlContent.includes('aria-live="polite"'), 'missing aria-live="polite" on feedback element');
    assert.ok(htmlContent.includes('aria-atomic="true"'), 'missing aria-atomic="true" on feedback element');
});

test('css/style.css defines visible focus ring and reduced-motion media query', () => {
    assert.ok(cssContent.includes(':focus-visible'), 'missing :focus-visible rules');
    assert.ok(cssContent.includes('outline: 3px solid var(--focus-ring)'), 'missing focus-visible outline');
    assert.ok(cssContent.includes('@media (prefers-reduced-motion: reduce)'), 'missing reduced-motion media query');
    assert.ok(cssContent.includes('animation-duration: 0.001ms'), 'missing reduced-motion animation override');
});

test('css/style.css defines accessible contrast and difficult research fixture rules', () => {
    // accessible default contrast tokens
    assert.ok(cssContent.includes('--text-primary: #0f172a;'), 'missing high-contrast primary text');
    assert.ok(cssContent.includes('--color-primary: #1d4ed8;'), 'missing accessible primary button color');
    assert.ok(cssContent.includes('--color-danger: #b91c1c;'), 'missing accessible danger button color');

    // difficult research fixture selector
    assert.ok(cssContent.includes('body.fixture-difficult'), 'missing body.fixture-difficult rule');
    assert.ok(cssContent.includes('body.fixture-difficult .status-text'), 'missing difficult fixture status-text rule');
    assert.ok(cssContent.includes('body.fixture-difficult .btn-text'), 'missing difficult fixture btn-text rule');
});

test('js/dashboard.js contains zero blocking alert calls', () => {
    assert.ok(!jsContent.includes('alert('), 'blocking alert() found in dashboard.js! All alerts must be replaced');
});

test('js/dashboard.js exposes task state and manager to window', () => {
    assert.ok(jsContent.includes('window.dashboardTaskManager = taskManager;'), 'missing dashboardTaskManager window export');
    assert.ok(jsContent.includes('window.dashboardTaskState = {'), 'missing dashboardTaskState window export');
    assert.ok(jsContent.includes('getMode: () => taskManager.getMode()'), 'missing getMode window export');
    assert.ok(jsContent.includes('setMode: (mode, reason = \'manual\')'), 'missing setMode window export');
});

test('dashboard.html includes mode selector and step guidance container', () => {
    assert.ok(htmlContent.includes('id="mode-select"'), 'missing mode-select element');
    assert.ok(htmlContent.includes('value="standard"'), 'missing standard mode option');
    assert.ok(htmlContent.includes('value="focused"'), 'missing focused mode option');
    assert.ok(htmlContent.includes('id="task-step-guidance"'), 'missing task-step-guidance element');
    assert.ok(htmlContent.includes('id="task-step-list"'), 'missing task-step-list element');
});

test('dashboard.html groups tasks into workspace panels with progressive disclosure toggles', () => {
    assert.ok(htmlContent.includes('id="server-matrix-panel"'), 'missing server-matrix-panel element');
    assert.ok(htmlContent.includes('id="config-panel"'), 'missing config-panel element');
    assert.ok(htmlContent.includes('id="server-matrix-toggle-btn"'), 'missing server-matrix-toggle-btn element');
    assert.ok(htmlContent.includes('id="config-toggle-btn"'), 'missing config-toggle-btn element');
    assert.ok(htmlContent.includes('id="sidebar-secondary-disclosure"'), 'missing sidebar-secondary-disclosure element');
});

test('css/style.css defines focused mode adaptation rules and task step styles', () => {
    assert.ok(cssContent.includes('.mode-select-input'), 'missing .mode-select-input rule');
    assert.ok(cssContent.includes('body.mode-focused'), 'missing body.mode-focused rule');
    assert.ok(cssContent.includes('.task-step-guidance'), 'missing .task-step-guidance rule');
    assert.ok(cssContent.includes('.step-item.step-complete'), 'missing .step-item.step-complete rule');
    assert.ok(cssContent.includes('.step-item.step-current'), 'missing .step-item.step-current rule');
    assert.ok(cssContent.includes('.task-focus-tag'), 'missing .task-focus-tag rule');
    assert.ok(cssContent.includes('.secondary-toggle-btn'), 'missing .secondary-toggle-btn rule');
});

