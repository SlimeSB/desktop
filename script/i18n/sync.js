const fs = require('fs')
const path = require('path')
const { execFileSync } = require('child_process')

const repoRoot = path.resolve(__dirname, '..', '..')
const enFile = path.join(repoRoot, 'app', 'locales', 'en.json')
const zhFile = path.join(repoRoot, 'app', 'locales', 'zh-CN.json')
const pendingFile = path.join(repoRoot, 'app', 'locales', 'pending.json')
const relativeEn = 'app/locales/en.json'

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'))
}

function writeJson(file, value) {
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`)
}

function readBaseline(ref) {
  try {
    const out = execFileSync('git', ['show', `${ref}:${relativeEn}`], {
      cwd: repoRoot,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    })
    return JSON.parse(out)
  } catch {
    return {}
  }
}

function placeholders(text) {
  return (text.match(/\{\d+\}/g) ?? []).sort().join(',')
}

function main() {
  const args = process.argv.slice(2)
  const refFlag = args.indexOf('--base')
  const ref = refFlag === -1 ? 'HEAD' : args[refFlag + 1]

  const en = readJson(enFile)
  const zh = readJson(zhFile)
  const base = readBaseline(ref)

  const reuse = new Map()
  const conflicts = new Map()
  for (const [key, text] of Object.entries(base)) {
    const translated = zh[key]
    if (translated === undefined) {
      continue
    }
    if (placeholders(translated) !== placeholders(text)) {
      continue
    }
    if (!reuse.has(text)) {
      reuse.set(text, new Set())
    }
    reuse.get(text).add(translated)
  }

  const removed = Object.keys(zh).filter(key => en[key] === undefined)
  const reused = []
  const pending = {}
  const conflicted = []

  for (const [key, text] of Object.entries(en)) {
    if (zh[key] !== undefined) {
      continue
    }
    const candidates = reuse.get(text)
    if (candidates === undefined) {
      pending[key] = text
    } else if (candidates.size === 1) {
      zh[key] = [...candidates][0]
      reused.push(key)
    } else {
      pending[key] = text
      conflicted.push([key, text, [...candidates]])
    }
  }

  for (const key of removed) {
    delete zh[key]
  }

  const sorted = {}
  for (const key of Object.keys(en).sort()) {
    if (zh[key] !== undefined) {
      sorted[key] = zh[key]
    }
  }
  const serialized = `${JSON.stringify(sorted, null, 2)}\n`
  if (fs.readFileSync(zhFile, 'utf8').replace(/\r\n/g, '\n') !== serialized) {
    writeJson(zhFile, sorted)
  }

  const sortedPending = Object.fromEntries(
    Object.keys(pending)
      .sort()
      .map(key => [key, pending[key]])
  )
  if (Object.keys(sortedPending).length === 0) {
    if (fs.existsSync(pendingFile)) {
      fs.unlinkSync(pendingFile)
    }
  } else {
    writeJson(pendingFile, sortedPending)
  }

  const baseKeys = Object.keys(base).length
  console.log(`base ${ref}: ${baseKeys} keys`)
  console.log(`current: ${Object.keys(en).length} keys`)
  console.log(`removed: ${removed.length}`)
  console.log(`reused: ${reused.length}`)
  console.log(`needs translation: ${Object.keys(pending).length}`)
  if (conflicted.length > 0) {
    console.log(`ambiguous (same text, several old translations): ${conflicted.length}`)
    for (const [key, text, options] of conflicted.slice(0, 10)) {
      console.log(`  ${key} ${JSON.stringify(text)} -> ${options.join(' / ')}`)
    }
  }
  for (const [key, text] of Object.entries(sortedPending)) {
    console.log(`  ${key} => ${JSON.stringify(text)}`)
  }
}

main()
