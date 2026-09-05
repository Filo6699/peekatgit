import type {
  MutationResult,
  RepoGraph,
  StatusReport,
  SyncOutcome,
  Workspace,
  Worktree,
} from '../shared/types.ts'

async function getJson<T>(url: string): Promise<T> {
  const response = await fetch(url)
  const data = (await response.json()) as T & { error?: string }
  if (data && typeof data === 'object' && 'error' in data && data.error) throw new Error(data.error)
  return data
}

async function post<T = MutationResult>(route: string, payload: Record<string, unknown>): Promise<T> {
  const response = await fetch(route, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload),
  })
  return (await response.json()) as T
}

const repoQuery = (repo: string, extra: Record<string, string> = {}): string =>
  new URLSearchParams({ repo, ...extra }).toString()

export const api = {
  workspace: (): Promise<Workspace> => getJson('/api/workspace'),

  status: (repos: string[]): Promise<Record<string, StatusReport>> => {
    if (!repos.length) return Promise.resolve({})
    const query = repos.map(id => `repo=${encodeURIComponent(id)}`).join('&')
    return getJson(`/api/status?${query}`)
  },

  graph: (repos: string[], limit: number): Promise<RepoGraph[]> => {
    if (!repos.length) return Promise.resolve([])
    const query = repos.map(id => `repo=${encodeURIComponent(id)}`).join('&')
    return getJson(`/api/graph?${query}&limit=${limit}`)
  },



  diff: (repo: string, file: string, staged: boolean, untracked: boolean): Promise<string> =>
    fetch(
      `/api/diff?${repoQuery(repo, { path: file, staged: staged ? '1' : '0', untracked: untracked ? '1' : '0' })}`
    ).then(response => response.text()),



  worktrees: (repo: string): Promise<Worktree[]> => getJson(`/api/worktrees?${repoQuery(repo)}`),

  stage: (repo: string, paths: string[]) => post('/api/stage', { repo, paths }),
  unstage: (repo: string, paths: string[]) => post('/api/unstage', { repo, paths }),
  discard: (repo: string, paths: string[]) => post('/api/discard', { repo, paths }),
  commit: (repo: string, message: string) => post('/api/commit', { repo, message }),

  sync: (repo: string) => post<SyncOutcome>('/api/sync', { repo }),

  focus: (repo: string) => post('/api/focus', { repo }),
  prefs: (repo: string, patch: { hidden?: boolean; order?: number }) => post('/api/prefs', { repo, ...patch }),
  reorder: (ids: string[]) => post('/api/reorder', { ids }),
  addRepo: (repoPath: string) => post('/api/repos/add', { path: repoPath }),
  removeRepo: (repo: string) => post('/api/repos/remove', { repo }),
}
