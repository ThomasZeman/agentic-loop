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
 *
 * Marking a plan `completed` also deletes the branches that were attempts at it - the
 * local `plan/<name>` and `plan/<name>-N`, and the copies the runner pushed to the remote
 * when they failed - because `completed` means that work is on the base branch in some
 * form and the branches are superseded. `--keep-branches` leaves them; `--remote <name>`
 * names the remote (default `origin`); `--prefix <p>` / `--no-prefix` match the runner's
 * -BranchPrefix. A `wont-do` plan's branch is left alone: it may be the only copy.
 */
import {execFileSync} from 'node:child_process';
import {existsSync, readFileSync, writeFileSync} from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import {fileURLToPath} from 'node:url';
import {parseArgs} from 'node:util';

import {attemptBranches, planBranchName} from './plan-branch.mjs';

/** The statuses a human sets. `needs-review` and `skipped` are the runner's to write. */
export const MARKABLE_STATUSES = ['completed', 'wont-do'];

const BOM = '﻿';

/**
 * The plan's file name, as `.state.json` keys it - never a path or a branch.
 *
 * `plans/.state.json` once grew a key `plan/728-....md` from a hand that passed the branch
 * name here; the entry was accepted, the real one stayed `needs-review`, and the queue would
 * have re-run a plan that had shipped. So anything with a directory separator is refused.
 */
export function assertPlanFileName(name) {
    if (typeof name !== 'string' || !/^[^\\/]+\.md$/.test(name)) {
        throw new Error(`'${name}' is not a plan file name - pass the file's own name, like 142-a-thing.md, not a path or a branch`);
    }
    return name;
}

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

function git(args) {
    return execFileSync('git', args, {encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe']});
}

function branchNames(args) {
    return git(args).split(/\r?\n/).map(line => line.trim()).filter(Boolean);
}

/**
 * Deletes every attempt branch of a completed plan, locally and on the remote, saying which.
 * -D locally: a retry's earlier attempts are not on the base branch, so -d would refuse them,
 * and `completed` is the human's word that their work has landed in another form.
 */
function deleteAttemptBranches(planName, {prefix, remote}) {
    const desired = planBranchName(planName, prefix === undefined ? {} : {prefix});
    for (const branch of attemptBranches(desired, branchNames(['branch', '--format=%(refname:short)']))) {
        try {
            git(['branch', '-D', branch]);
            console.log(`deleted ${branch}`);
        } catch (error) {
            console.error(`could not delete ${branch}: ${firstLine(error)}`);
        }
    }
    if (!remote) return;
    const remoteNames = branchNames(['branch', '-r', '--format=%(refname:short)'])
        .filter(name => name.startsWith(`${remote}/`))
        .map(name => name.slice(remote.length + 1));
    for (const branch of attemptBranches(desired, remoteNames)) {
        try {
            git(['push', remote, '--delete', branch]);
            console.log(`deleted ${remote}/${branch}`);
        } catch (error) {
            console.error(`could not delete ${remote}/${branch}: ${firstLine(error)}`);
        }
    }
}

function firstLine(error) {
    return String(error.stderr ?? error.message).split(/\r?\n/).find(line => line.trim()) ?? '';
}

function main() {
    const {values, positionals} = parseArgs({
        args: process.argv.slice(2),
        allowPositionals: true,
        options: {
            'keep-branches': {type: 'boolean', default: false},
            remote: {type: 'string', default: 'origin'},
            prefix: {type: 'string'},
            'no-prefix': {type: 'boolean', default: false},
        },
    });
    const [planName, status, reason] = positionals;
    if (!planName || !status) {
        console.error('usage: node mark-plan.mjs <plan-file.md> <completed|wont-do> "<reason>" [--keep-branches] [--remote origin] [--prefix plan/ | --no-prefix]');
        process.exit(2);
    }
    const statePath = path.join(process.cwd(), 'plans', '.state.json');
    let next;
    try {
        assertPlanFileName(planName);
        next = markPlanStatus(readState(statePath), planName, status, reason ?? 'set by hand', new Date().toISOString());
    } catch (error) {
        console.error(error.message);
        process.exit(3);
    }
    writeState(statePath, next);
    console.log(`${planName} -> ${status}`);
    if (status === 'completed' && !values['keep-branches']) {
        deleteAttemptBranches(planName, {prefix: values['no-prefix'] ? '' : values.prefix, remote: values.remote});
    }
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))) {
    main();
}
