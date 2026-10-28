const fs = require('fs')
const path = require('path')
const { transform } = require('./core')

const repoRoot = path.resolve(__dirname, '..', '..')
const srcRoot = path.join(repoRoot, 'app', 'src')
const localeFile = path.join(repoRoot, 'app', 'locales', 'en.json')
const sourceExtensions = new Set(['.ts', '.tsx'])

function walk(dir, files = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name.startsWith('.')) {
      continue
    }
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) {
      walk(full, files)
    } else if (sourceExtensions.has(path.extname(entry.name))) {
      files.push(full)
    }
  }
  return files
}

function main() {
  const files = walk(srcRoot).sort()
  const messages = {}
  const owners = new Map()
  const stats = []

  for (const file of files) {
    const relativePath = path.relative(repoRoot, file).replace(/\\/g, '/')
    const source = fs.readFileSync(file, 'utf8')
    const { entries } = transform(source, file, { relativePath })

    if (entries.length === 0) {
      continue
    }

    for (const entry of entries) {
      const existing = owners.get(entry.key)
      if (existing !== undefined) {
        throw new Error(
          `duplicate key ${entry.key} in ${relativePath} and ${existing}`
        )
      }
      owners.set(entry.key, relativePath)
      messages[entry.key] = entry.text
    }

    stats.push({ file: relativePath, count: entries.length })
  }

  const sorted = Object.fromEntries(
    Object.keys(messages)
      .sort()
      .map(key => [key, messages[key]])
  )

  fs.mkdirSync(path.dirname(localeFile), { recursive: true })
  fs.writeFileSync(localeFile, `${JSON.stringify(sorted, null, 2)}\n`)

  stats.sort((a, b) => b.count - a.count)
  console.log(`files with messages: ${stats.length}`)
  console.log(`total messages: ${Object.keys(sorted).length}`)
  console.log(`locale written: ${path.relative(repoRoot, localeFile)}`)
}

main()
