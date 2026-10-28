const fs = require('fs')
const path = require('path')

const repoRoot = path.resolve(__dirname, '..', '..')
const enFile = path.join(repoRoot, 'app', 'locales', 'en.json')
const zhFile = path.join(repoRoot, 'app', 'locales', 'zh-CN.json')

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'))
}

function isPlaceholderOnly(text) {
  return text.replace(/\{\d+\}|&nbsp;|\s/g, '') === ''
}

function main() {
  const en = readJson(enFile)
  const zh = readJson(zhFile)

  const enKeys = Object.keys(en)
  const missing = enKeys.filter(key => zh[key] === undefined)
  const stale = Object.keys(zh).filter(key => en[key] === undefined)
  const same = enKeys.filter(key => zh[key] !== undefined && zh[key] === en[key])
  const forbidden = same.filter(key => !isPlaceholderOnly(en[key]))

  console.log(`total: ${enKeys.length}`)
  console.log(`translated: ${enKeys.length - missing.length}`)
  console.log(`missing: ${missing.length}`)
  console.log(`stale: ${stale.length}`)
  console.log(`kept as-is: ${same.length}`)

  if (process.argv.includes('--verbose')) {
    for (const key of same) {
      console.log(`  as-is ${key} => ${JSON.stringify(en[key])}`)
    }
  }

  for (const key of missing.slice(0, 20)) {
    console.log(`  missing ${key} => ${JSON.stringify(en[key])}`)
  }
  for (const key of stale.slice(0, 20)) {
    console.log(`  stale ${key}`)
  }

  if (process.argv.includes('--strict')) {
    if (missing.length > 0 || stale.length > 0) {
      process.exitCode = 1
    }
    for (const key of forbidden) {
      console.log(`  unexpected as-is ${key} => ${JSON.stringify(en[key])}`)
    }
  }
}

main()
