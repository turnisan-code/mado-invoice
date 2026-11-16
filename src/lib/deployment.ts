// Where this build runs, and whether it may write to Bookamat. Only production books: a Vercel
// preview uses production's database and the Bookamat key stored there, so a click on a preview
// would book for real (the owner's rule: a preview never writes). A local server books only with
// BOOKAMAT_ALLOW_WRITES=1. Read per call, so tests and the runtime see the current environment.

export type DeploymentEnv = 'production' | 'preview' | 'development' | 'local'
type Env = Record<string, string | undefined>

export function deploymentEnv(env: Env = process.env): DeploymentEnv {
  const v = env.VERCEL_ENV
  return v === 'production' || v === 'preview' || v === 'development' ? v : 'local'
}

export function bookamatWritesAllowed(env: Env = process.env): boolean {
  const where = deploymentEnv(env)
  return where === 'production' || (where === 'local' && env.BOOKAMAT_ALLOW_WRITES === '1')
}

// The short commit a Vercel build was made from (null locally).
export function deploymentCommit(env: Env = process.env): string | null {
  return env.VERCEL_GIT_COMMIT_SHA?.slice(0, 7) || null
}
