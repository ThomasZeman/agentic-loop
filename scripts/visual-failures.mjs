#!/usr/bin/env node
/**
 * Reads a Playwright JSON report and prints the set of tests that genuinely failed:
 *
 *   { "failures": ["DPR-1 | dom-qr-dialog.test.ts | dom qr dialog lobby default", ...],
 *     "stats": {...}, "notes": [...] }
 *
 * Used by scripts/run-plans.ps1 to enforce a ratchet on the visual suite. The suite
 * carries a standing set of pre-existing reds, so a pass/fail-on-exit-code gate fails
 * every frontend plan regardless of its own diff. What a plan must not do is add a
 * *new* red - which is a question about identity, not about a count.
 *
 * Deliberately a set and not a count. A count ratchets itself into a corner: one lucky
 * run recording a low number holds every later run to a total the suite cannot hit
 * while any of its reds are order-dependent, and no message tells you which test moved.
 *
 * Playwright has already resolved each test to expected/unexpected/flaky/skipped by the
 * time it writes the report, so a test that failed and then passed on retry arrives as
 * `flaky` and is not counted here. That is the point of the retries in the visual
 * playwright.config.ts: real reds stay red, order-dependent ones stop moving the set.
 */
import {existsSync, readFileSync} from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import {fileURLToPath} from 'node:url';

/** Where playwright.config.ts's json reporter writes, relative to the package directory. */
export const VISUAL_REPORT_RELATIVE_PATH = path.join('test-results', 'visual-report.json');

const FAILED_STATUS = 'unexpected';

function toPosix(file) {
    return String(file ?? '').replace(/\\/g, '/');
}

function testId(projectName, file, titlePath) {
    return `${projectName} | ${toPosix(file)} | ${titlePath.join(' > ')}`;
}

function collectSuite(suite, ancestorTitles, found) {
    // The outermost suite of a file is titled with the file itself; only describe()
    // blocks below it add anything a reader needs to tell two tests apart.
    for (const spec of suite.specs ?? []) {
        for (const test of spec.tests ?? []) {
            if (test.status !== FAILED_STATUS) continue;
            found.push(testId(test.projectName, spec.file ?? suite.file, [...ancestorTitles, spec.title]));
        }
    }
    for (const child of suite.suites ?? []) {
        collectSuite(child, [...ancestorTitles, child.title], found);
    }
}

/**
 * The ids of every test the report records as failed, sorted so two runs diff line
 * for line. Flaky, skipped and passed tests are all absent.
 */
export function failingTestIds(report) {
    const found = [];
    for (const suite of report?.suites ?? []) collectSuite(suite, [], found);
    return found.sort();
}

/**
 * Compares this run's failures against the accepted set.
 *
 * `newFailures` is what fails the plan. `fixed` are baseline entries that now pass and
 * are banked immediately, so a later plan cannot re-break them - that is the ratchet.
 * A new failure never joins the baseline: excusing it here would mean the next plan
 * inherits it, which is exactly the drift this gate exists to stop.
 */
export function ratchetVisualBaseline(baseline, currentFailures) {
    const current = [...new Set(currentFailures)].sort();
    if (baseline === null || baseline === undefined) {
        return {firstSighting: true, newFailures: [], fixed: [], nextBaseline: current};
    }
    const known = new Set(baseline);
    const nowFailing = new Set(current);
    return {
        firstSighting: false,
        newFailures: current.filter((id) => !known.has(id)),
        fixed: [...known].filter((id) => !nowFailing.has(id)).sort(),
        nextBaseline: [...known].filter((id) => nowFailing.has(id)).sort(),
    };
}

function main() {
    const pkgDir = process.argv[2];
    if (!pkgDir || !existsSync(pkgDir)) {
        console.error('usage: node visual-failures.mjs <package-dir> [report-relative-path]');
        process.exit(2);
    }
    // The report location is playwright.config.ts's business and so the target project's;
    // the runner passes its configured `gates.visual.report` here. The default stays what
    // it always was.
    const reportPath = path.join(pkgDir, process.argv[3] ?? VISUAL_REPORT_RELATIVE_PATH);
    if (!existsSync(reportPath)) {
        console.error(`no playwright json report at ${reportPath} - did the suite run?`);
        process.exit(3);
    }
    let report;
    try {
        report = JSON.parse(readFileSync(reportPath, 'utf8'));
    } catch (error) {
        console.error(`unparseable playwright json report at ${reportPath}: ${error.message}`);
        process.exit(4);
    }
    const notes = [];
    // Playwright records a suite-level crash (a spec that would not even load) in
    // `errors`, and such a spec contributes no failing test id. Surfacing it keeps a
    // broken suite from reading as "no new failures".
    for (const error of report.errors ?? []) {
        notes.push(`report-level error: ${String(error.message ?? error).split('\n')[0].slice(0, 200)}`);
    }
    console.log(JSON.stringify({
        failures: failingTestIds(report),
        stats: report.stats ?? {},
        notes,
    }));
}

// Only run the CLI when invoked directly, so the test file can import the pure parts.
// fileURLToPath rather than URL.pathname: the latter yields "/C:/..." on Windows.
if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))) {
    main();
}
