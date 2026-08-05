// Unified-diff parsing: just enough structure to render gutters and hunks.

export type DiffRowKind = 'add' | 'del' | 'ctx' | 'hunk' | 'meta'

export type DiffRow = {
  kind: DiffRowKind
  text: string
  oldLine: number | null
  newLine: number | null
}

const HUNK = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/

export function parseDiff(raw: string): DiffRow[] {
  const rows: DiffRow[] = []
  let oldLine = 0
  let newLine = 0

  for (const line of raw.split('\n')) {
    if (line.startsWith('diff --git') || line.startsWith('index ') || line.startsWith('--- ') || line.startsWith('+++ ')) {
      continue
    }
    if (line.startsWith('new file') || line.startsWith('deleted file') || line.startsWith('rename ') || line.startsWith('similarity ')) {
      rows.push({ kind: 'meta', text: line, oldLine: null, newLine: null })
      continue
    }
    const hunk = HUNK.exec(line)
    if (hunk) {
      oldLine = Number(hunk[1])
      newLine = Number(hunk[2])
      rows.push({ kind: 'hunk', text: line, oldLine: null, newLine: null })
      continue
    }
    if (line.startsWith('+')) rows.push({ kind: 'add', text: line.slice(1), oldLine: null, newLine: newLine++ })
    else if (line.startsWith('-')) rows.push({ kind: 'del', text: line.slice(1), oldLine: oldLine++, newLine: null })
    else if (line.startsWith('\\')) rows.push({ kind: 'meta', text: line.slice(2), oldLine: null, newLine: null })
    else if (line.startsWith(' ')) rows.push({ kind: 'ctx', text: line.slice(1), oldLine: oldLine++, newLine: newLine++ })
  }

  // A trailing empty context row is an artifact of the final newline.
  const last = rows[rows.length - 1]
  if (last && last.kind === 'ctx' && last.text === '') rows.pop()
  return rows
}

export function countChanges(rows: DiffRow[]): { added: number; removed: number } {
  let added = 0
  let removed = 0
  for (const row of rows) {
    if (row.kind === 'add') added++
    else if (row.kind === 'del') removed++
  }
  return { added, removed }
}
