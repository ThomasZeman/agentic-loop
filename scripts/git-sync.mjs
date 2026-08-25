// Where a branch stands against its remote, and what that permits.
//
// The plan runner used never to contact origin: it fast-forwarded each verified plan onto the
// branch it started on and stopped there, so every plan it had ever shipped sat on one machine's
// local `main`. It now treats origin as the real base branch, and this is the rule it reads the
// situation by.
//
// Only two moves are ever offered, and both preserve history exactly: fast-forward the local
// branch onto the remote one, or push the local branch to the remote. There is deliberately no
// third. A merge commit would put a tree on the base branch that was never tested as a whole,
// and a force-push would delete somebody else's work - so when the two sides have both moved,
// the answer is that neither move applies and a human has to look at it.
//
// Nothing here runs git. `git-sync-cli.mjs` does the measuring; this decides what the numbers
// mean, so the decision can be tested without a repository.

function commits(count) {
  return count === 1 ? '1 commit' : `${count} commits`
}

/**
 * What to do about a branch that is `ahead` commits past its upstream and `behind` commits short
 * of it.
 *
 * `actions` is a subset of ['fast-forward', 'push'], in that order, and is empty whenever the
 * situation is one no action can improve. `reason` is what a human is shown, so it always names
 * the counts it was decided from.
 *
 * @param {{ hasUpstream: boolean, ahead?: number, behind?: number }} standing
 * @returns {{ state: string, actions: string[], reason: string }}
 */
export function syncDecision({ hasUpstream, ahead = 0, behind = 0 }) {
  if (!hasUpstream) {
    return {
      state: 'no-upstream',
      actions: [],
      reason: 'the branch tracks no remote branch, so there is nothing to sync it with',
    }
  }
  if (ahead > 0 && behind > 0) {
    return {
      state: 'diverged',
      actions: [],
      reason: `the branch has ${commits(ahead)} the remote does not, and the remote has ${commits(behind)} the branch does not`,
    }
  }
  if (behind > 0) {
    return {
      state: 'behind',
      actions: ['fast-forward'],
      reason: `the remote has ${commits(behind)} the branch does not`,
    }
  }
  if (ahead > 0) {
    return {
      state: 'ahead',
      actions: ['push'],
      reason: `the branch has ${commits(ahead)} the remote does not`,
    }
  }
  return { state: 'in-sync', actions: [], reason: 'the branch and its remote are the same commit' }
}
