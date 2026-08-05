import type {
  FilePayload,
  MutationResult,
  StatusReport,
  TreeEntry,
  Workspace,
  Worktree,
} from '../shared/types.ts'

async function getJson<T>(url: string): Promise<T> {
  const response = await fetch(url)
  const data = (await response.json()) as T & { error?: string }
  if (data && typeof data === 'object' && 'error' in data && data.error) throw new Error(data.error)
  return data
}

async function post(route: string, payload: Record<string, unknown>): Promise<MutationResult> {
  const response = await fetch(route, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload),
  })
  return (await response.json()) as MutationResult
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

  tree: (repo: string, dir: string): Promise<TreeEntry[]> => getJson(`/api/tree?${repoQuery(repo, { path: dir })}`),

  file: (repo: string, file: string): Promise<FilePayload> => getJson(`/api/file?${repoQuery(repo, { path: file })}`),

  diff: (repo: string, file: string, staged: boolean, untracked: boolean): Promise<string> =>
    fetch(
      `/api/diff?${repoQuery(repo, { path: file, staged: staged ? '1' : '0', untracked: untracked ? '1' : '0' })}`
    ).then(response => response.text()),

  wsTree: (dir: string): Promise<TreeEntry[]> => getJson(`/api/ws/tree?path=${encodeURIComponent(dir)}`),

  wsFile: (file: string): Promise<FilePayload> => getJson(`/api/ws/file?path=${encodeURIComponent(file)}`),

  worktrees: (repo: string): Promise<Worktree[]> => getJson(`/api/worktrees?${repoQuery(repo)}`),

  stage: (repo: string, paths: string[]) => post('/api/stage', { repo, paths }),
  unstage: (repo: string, paths: string[]) => post('/api/unstage', { repo, paths }),
  discard: (repo: string, paths: string[]) => post('/api/discard', { repo, paths }),
  commit: (repo: string, message: string) => post('/api/commit', { repo, message }),

  focus: (repo: string) => post('/api/focus', { repo }),
  prefs: (repo: string, patch: { hidden?: boolean; order?: number }) => post('/api/prefs', { repo, ...patch }),
  reorder: (ids: string[]) => post('/api/reorder', { ids }),
  addRepo: (repoPath: string) => post('/api/repos/add', { path: repoPath }),
  removeRepo: (repo: string) => post('/api/repos/remove', { repo }),
}
