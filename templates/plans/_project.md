# <Project name> — rules for every plan

<!--
This file is appended to the runner's standing instructions (the spine) as the "Project
section". It binds exactly as much as the spine, and wins where the two seem to conflict.
Say only what the spine cannot know: this repo's docs, its exact commands, its harnesses,
what is off limits. Delete any heading that does not apply. Keep it short - every plan reads it.
-->

## Read first

- <`CLAUDE.md`, a contributing guide, a code-standards checklist — whatever governs diffs here>
- <the design notes convention, if it differs from "a sibling .md with the same base name">

## Conventions

- <test file naming and location, e.g. `kebab-case.test.ts`, co-located; never `*.spec.*`>
- <file and folder naming>
- <anything the repo's linters do not already enforce>

## Gates — run these before you commit

From the affected package directory:

```
npm run test -- --findRelatedTests <changed-files...>   # fast feedback first
npm run test                                            # then the full suite
<type-check command, if the runner's quality ratchet is on>
<lint command, if the runner's quality ratchet is on>
```

## Browser check

<How the visual harness is run, where its images land, and how baselines are re-recorded
when styling changes on purpose. Or: "This project has no visual harness — verify
user-visible work in the live app when the trailer says it is up, otherwise mark
Browser: n/a and say why.">

## Driving the live app

<How to open and drive the app the runner keeps running — which URL, which throwaway
identity or profile to use, what never to do to a human's own browser. Delete this heading
if `devServers` is empty in runner.json.>

## Showcase

<How to stage screenshots for the people who asked for the change, if the project has a demo
hook. Delete this heading otherwise; the spine then expects "Demo: n/a".>

## Off limits

- <directories that must never be written to, external systems that must never be touched>

## Gitignored, runner-owned

- <any staging directory the showcase mechanism uses, beyond `plans/logs/` and `plans/.state.json`>
