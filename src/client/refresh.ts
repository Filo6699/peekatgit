/** Merge bursts and serialize refreshes so an older response cannot replace newer state. */
export function refreshQueue(run: (repos?: string[]) => Promise<void>) {
  let active: Promise<void> | null = null
  let full = false
  let queued = false
  const pending = new Set<string>()
  return function refresh(repos?: string[]): Promise<void> {
    queued = true
    if (repos === undefined) full = true
    else for (const repo of repos) pending.add(repo)
    if (!active) {
      active = Promise.resolve().then(async () => {
        try {
          while (queued) {
            const batch = full ? undefined : [...pending]
            queued = full = false
            pending.clear()
            await run(batch)
          }
        } finally {
          active = null
        }
      })
    }
    return active
  }
}
