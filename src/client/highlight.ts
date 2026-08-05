// A deliberately small syntax highlighter: one pass, one regex per language
// family. It is not a parser — it is good enough to read code, and it costs
// nothing to ship.

const HTML_ESCAPES: Record<string, string> = { '&': '&amp;', '<': '&lt;', '>': '&gt;' }

export const escapeHtml = (text: string): string => text.replace(/[&<>]/g, char => HTML_ESCAPES[char]!)

type Family = 'clike' | 'hash' | 'markup' | 'json' | 'markdown' | 'plain'

const BY_EXTENSION: Record<string, Family> = {
  js: 'clike', mjs: 'clike', cjs: 'clike', jsx: 'clike', ts: 'clike', tsx: 'clike', mts: 'clike',
  go: 'clike', rs: 'clike', java: 'clike', kt: 'clike', swift: 'clike', scala: 'clike', dart: 'clike',
  c: 'clike', h: 'clike', cpp: 'clike', hpp: 'clike', cc: 'clike', cs: 'clike', php: 'clike',
  css: 'clike', scss: 'clike', less: 'clike', sql: 'clike', zig: 'clike',
  py: 'hash', rb: 'hash', sh: 'hash', bash: 'hash', zsh: 'hash', fish: 'hash', pl: 'hash',
  yml: 'hash', yaml: 'hash', toml: 'hash', ini: 'hash', conf: 'hash', env: 'hash', r: 'hash',
  html: 'markup', htm: 'markup', xml: 'markup', svg: 'markup', vue: 'markup',
  json: 'json', jsonc: 'json',
  md: 'markdown', markdown: 'markdown',
}

const BY_FILENAME: Record<string, Family> = {
  dockerfile: 'hash',
  makefile: 'hash',
  '.gitignore': 'hash',
  '.env': 'hash',
}

export function languageOf(filePath: string): Family {
  const base = filePath.split('/').pop()?.toLowerCase() ?? ''
  if (BY_FILENAME[base]) return BY_FILENAME[base]!
  const ext = base.includes('.') ? base.split('.').pop()! : ''
  return BY_EXTENSION[ext] ?? 'plain'
}

const CLIKE_KEYWORDS =
  'as|async|await|break|case|catch|class|const|constructor|continue|declare|default|defer|delete|do|' +
  'else|enum|export|extends|extern|false|final|finally|fn|for|from|func|function|go|if|impl|implements|' +
  'import|in|instanceof|interface|let|loop|match|mod|module|mut|namespace|new|nil|null|of|package|private|' +
  'protected|public|pub|readonly|return|satisfies|self|static|struct|super|switch|this|throw|throws|trait|' +
  'true|try|type|typeof|undefined|union|unsafe|use|var|void|where|while|with|yield'

const HASH_KEYWORDS =
  'and|as|assert|async|await|break|case|class|continue|def|del|do|elif|else|elsif|end|esac|except|export|' +
  'False|fi|finally|for|from|function|global|if|import|in|is|lambda|local|module|new|nil|None|nonlocal|not|' +
  'or|pass|raise|require|return|self|source|then|True|try|unless|until|while|with|yield'

const STRINGS = String.raw`"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|\`(?:\\.|[^\`\\])*\``
const NUMBER = String.raw`\b(?:0[xXbBoO][0-9a-fA-F_]+|\d[\d_]*(?:\.\d+)?(?:[eE][+-]?\d+)?)\b`

type Rule = [className: string, pattern: string]

const RULES: Record<Exclude<Family, 'plain'>, Rule[]> = {
  clike: [
    ['c', String.raw`//[^\n]*|/\*[\s\S]*?\*/`],
    ['s', STRINGS],
    ['n', NUMBER],
    ['k', String.raw`\b(?:${CLIKE_KEYWORDS})\b`],
    ['f', String.raw`\b[A-Za-z_$][\w$]*(?=\s*\()`],
    ['t', String.raw`\b[A-Z][A-Za-z0-9_]*\b|@[A-Za-z_][\w.]*|#[A-Za-z_][\w]*`],
  ],
  hash: [
    ['c', String.raw`#[^\n]*`],
    ['s', String.raw`"""[\s\S]*?"""|'''[\s\S]*?'''|${STRINGS}`],
    ['n', NUMBER],
    ['k', String.raw`\b(?:${HASH_KEYWORDS})\b`],
    ['f', String.raw`\b[A-Za-z_][\w]*(?=\s*\()`],
    ['t', String.raw`\$\{?[A-Za-z_][\w]*\}?|@[A-Za-z_][\w.]*`],
  ],
  markup: [
    ['c', String.raw`<!--[\s\S]*?-->`],
    ['s', STRINGS],
    ['k', String.raw`</?[A-Za-z][\w:.-]*|/?>`],
    ['t', String.raw`\b[A-Za-z_:][\w:.-]*(?==)`],
  ],
  json: [
    ['t', String.raw`"(?:\\.|[^"\\])*"(?=\s*:)`],
    ['s', String.raw`"(?:\\.|[^"\\])*"`],
    ['n', NUMBER],
    ['k', String.raw`\b(?:true|false|null)\b`],
  ],
  markdown: [
    ['c', String.raw`^\s{0,3}#{1,6}[^\n]*`],
    ['s', String.raw`\`\`\`[\s\S]*?\`\`\`|\`[^\`\n]+\``],
    ['k', String.raw`\*\*[^*\n]+\*\*|__[^_\n]+__|^\s*(?:[-*+]|\d+\.)\s`],
    ['t', String.raw`\[[^\]\n]*\]\([^)\n]*\)`],
  ],
}

const compiled = new Map<Family, RegExp>()

function patternFor(family: Exclude<Family, 'plain'>): RegExp {
  let regex = compiled.get(family)
  if (!regex) {
    regex = new RegExp(RULES[family].map(([, pattern]) => `(${pattern})`).join('|'), 'gm')
    compiled.set(family, regex)
  }
  regex.lastIndex = 0
  return regex
}

/** Returns escaped HTML with `<span class="tok-*">` wrappers. */
export function highlight(code: string, family: Family): string {
  if (family === 'plain') return escapeHtml(code)
  const rules = RULES[family]
  const regex = patternFor(family)
  let out = ''
  let last = 0

  for (let match = regex.exec(code); match; match = regex.exec(code)) {
    // Rule patterns use non-capturing groups only, so group i+1 maps to rule i.
    const ruleIndex = rules.findIndex((_, i) => match![i + 1] !== undefined)
    if (ruleIndex === -1) continue
    out += escapeHtml(code.slice(last, match.index))
    out += `<span class="tok-${rules[ruleIndex]![0]}">${escapeHtml(match[0])}</span>`
    last = match.index + match[0].length
    if (match[0].length === 0) regex.lastIndex++
  }
  return out + escapeHtml(code.slice(last))
}
