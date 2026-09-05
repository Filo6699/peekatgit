import type { MutationResult } from '../shared/types.ts'
import { hooks, state } from './state.ts'

/** One Git operation per repository, with errors kept beside the affected checkout. */
export async function operate(repo: string, label: string, run: () => Promise<MutationResult>, success?: () => void): Promise<void> {
  if (state.busy.has(repo)) return
  state.busy.set(repo, label)
  delete state.errors[repo]
  hooks.paint()
  try {
    const result = await run()
    if (!result.ok) throw new Error(result.error)
    success?.()
  } catch (error) {
    state.errors[repo] = (error as Error).message ?? String(error)
    state.collapsed.delete(repo)
  } finally {
    state.busy.delete(repo)
    await hooks.refresh([repo])
  }
}
