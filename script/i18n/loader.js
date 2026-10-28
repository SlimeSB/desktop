const path = require('path')
const { transform, readTranslations } = require('./core')

const repoRoot = path.resolve(__dirname, '..', '..')
const localeFile = path.join(repoRoot, 'app', 'locales', 'zh-CN.json')
const active = process.env.DESKTOP_LOCALE === 'zh-CN'
const pluralFile = 'app/src/ui/lib/plural.ts'

let translations = null

module.exports = function i18nLoader(source) {
  this.cacheable(true)

  if (!active) {
    return source
  }

  const relativePath = path
    .relative(repoRoot, this.resourcePath)
    .replace(/\\/g, '/')

  if (relativePath === pluralFile) {
    return source.replace(
      /return count === 1 \? '' : 's'/,
      "return ''"
    )
  }

  if (translations === null) {
    translations = readTranslations(localeFile)
  }
  const { code } = transform(source, this.resourcePath, {
    relativePath,
    translations,
    locale: 'zh-CN',
  })

  return code
}
