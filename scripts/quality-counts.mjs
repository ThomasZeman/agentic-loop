#!/usr/bin/env node
/**
 * Measures a package directory's static-quality counters and prints them as JSON:
 *
 *   { "tsc": <error count | null>, "lint": <problem count | null>, "notes": [...] }
 *
 * `null` means "not measurable here" (no tsconfig / no eslint config / tool failure),
 * which callers must treat as "no comparison possible", never as zero.
 *
 * Used by scripts/run-plans.ps1 after every plan to enforce a ratchet: neither count
 * may rise compared to the recorded baseline in plans/.quality-baseline.json.
 * Invoke tools via their JS entry points with the current node binary - never through
 * npx/npm.cmd - so the output stays parseable and Windows shell quirks stay out of it.
 */
import {spawnSync} from 'node:child_process';
import {existsSync} from 'node:fs';
import path from 'node:path';
import process from 'node:process';

const TOOL_TIMEOUT_MS = 10 * 60 * 1000;
const MAX_BUFFER = 64 * 1024 * 1024;

function findUp(startDir, relative) {
    let dir = path.resolve(startDir);
    for (;;) {
        const candidate = path.join(dir, relative);
        if (existsSync(candidate)) return candidate;
        const parent = path.dirname(dir);
        if (parent === dir) return null;
        dir = parent;
    }
}

function runNode(scriptPath, args, cwd) {
    return spawnSync(process.execPath, [scriptPath, ...args], {
        cwd,
        encoding: 'utf8',
        timeout: TOOL_TIMEOUT_MS,
        maxBuffer: MAX_BUFFER,
    });
}

function countTscErrors(pkgDir, notes) {
    if (!existsSync(path.join(pkgDir, 'tsconfig.json'))) {
        notes.push('tsc: no tsconfig.json, skipped');
        return null;
    }
    const tscJs = findUp(pkgDir, path.join('node_modules', 'typescript', 'lib', 'tsc.js'));
    if (tscJs === null) {
        notes.push('tsc: typescript not resolvable, skipped');
        return null;
    }
    const run = runNode(tscJs, ['-p', 'tsconfig.json', '--noEmit'], pkgDir);
    if (run.error) {
        notes.push(`tsc: failed to run (${run.error.message})`);
        return null;
    }
    const matches = `${run.stdout}\n${run.stderr}`.match(/error TS\d+/g);
    return matches === null ? 0 : matches.length;
}

function hasEslintConfig(pkgDir) {
    return ['eslint.config.mjs', 'eslint.config.js', 'eslint.config.cjs']
        .some((name) => existsSync(path.join(pkgDir, name)));
}

function countLintProblems(pkgDir, notes) {
    if (!hasEslintConfig(pkgDir) || !existsSync(path.join(pkgDir, 'src'))) {
        notes.push('lint: no flat eslint config or no src/, skipped');
        return null;
    }
    const eslintJs = findUp(pkgDir, path.join('node_modules', 'eslint', 'bin', 'eslint.js'));
    if (eslintJs === null) {
        notes.push('lint: eslint not resolvable, skipped');
        return null;
    }
    const run = runNode(eslintJs, ['src', '--format', 'json'], pkgDir);
    if (run.error) {
        notes.push(`lint: failed to run (${run.error.message})`);
        return null;
    }
    try {
        const results = JSON.parse(run.stdout);
        return results.reduce((sum, file) => sum + file.errorCount + file.warningCount, 0);
    } catch {
        notes.push(`lint: unparseable eslint output (exit ${run.status}): ${run.stderr.slice(0, 300)}`);
        return null;
    }
}

const pkgDir = process.argv[2];
if (!pkgDir || !existsSync(pkgDir)) {
    console.error('usage: node quality-counts.mjs <package-dir>');
    process.exit(2);
}

const notes = [];
const counts = {
    tsc: countTscErrors(pkgDir, notes),
    lint: countLintProblems(pkgDir, notes),
    notes,
};
console.log(JSON.stringify(counts));
