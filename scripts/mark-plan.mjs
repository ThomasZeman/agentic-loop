#!/usr/bin/env node
/**
 * Sets one plan's status in plans/.state.json by hand:
 *
 *   node scripts/mark-plan.mjs <plan-file.md> <completed|wont-do> "<reason>"
 *
 * The runner owns that file the rest of the time. Editing it in an editor is the
 * alternative and a bad one: it is written with a BOM, which JSON.parse rejects
 * outright, so a hand-edit tends to end in a corrupted file the next run cannot read.
 *
 * `wont-do` is for a plan that was deliberately abandoned - the queue must stop
 * offering it, but recording it as `completed` would be a lie that outlives the
 * decision. Anyone reading the state later would see a plan claiming to have shipped
 * with no commit on the base branch to show for it.
 */
import {existsSync, readFileSync, writeFileSync} from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import {fileURLToPath} from 'node:url';

/** The statuses a human sets. `needs-review` and `skipped` are the runner's to write. */
export const MARKABLE_STATUSES = ['completed', 'wont-do'];

const BOM = '﻿';

/**
 * Returns a copy of `state` with one plan's status set.
 *
 * A `wont-do` plan loses its commit and branch: it is marked precisely because that
 * work is not on the base branch, and often because the branch has been deleted, so
 * keeping either would leave a reference that resolves to nothing.
 */
export function markPlanStatus(state, planName, status, reason, now) {
    if (!MARKABLE_STATUSES.includes(status)) {
        throw new Error(`unknown status '${status}' - expected one of: ${MARKABLE_STATUSES.join(', ')}`);
    }
    const existing = state[planName] ?? {};
    const entry = {...existing, status, finishedAt: now, problems: [`${status}: ${reason}`]};
    if (status === 'wont-do') {
        entry.commit = null;
        entry.branch = null;
    }
    else if (entry.commit === undefined) {
        entry.commit = null;
    }
    return {...state, [planName]: entry};
}

function readState(statePath) {
    if (!existsSync(statePath)) return {};
    const raw = readFileSync(statePath, 'utf8');
    const withoutBom = raw.startsWith(BOM) ? raw.slice(BOM.length) : raw;
    if (!withoutBom.trim()) return {};
    return JSON.parse(withoutBom);
}

function writeState(statePath, state) {
    // Set-Content -Encoding UTF8 in PowerShell 5.1 writes a BOM, so the runner's own
    // writes carry one. Match it rather than leave the file flipping encoding.
    writeFileSync(statePath, BOM + JSON.stringify(state, null, 4) + '\n', 'utf8');
}

function main() {
    const [planName, status, reason] = process.argv.slice(2);
    if (!planName || !status) {
        console.error('usage: node mark-plan.mjs <plan-file.md> <completed|wont-do> "<reason>"');
        process.exit(2);
    }
    const statePath = path.join(process.cwd(), 'plans', '.state.json');
    let next;
    try {
        next = markPlanStatus(readState(statePath), planName, status, reason ?? 'set by hand', new Date().toISOString());
    } catch (error) {
        console.error(error.message);
        process.exit(3);
    }
    writeState(statePath, next);
    console.log(`${planName} -> ${status}`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))) {
    main();
}
