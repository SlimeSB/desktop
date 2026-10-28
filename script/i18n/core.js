const crypto = require('crypto')
const fs = require('fs')
const ts = require('typescript')

const inlineTags = new Set([
  'LinkButton',
  'Em',
  'Strong',
  'Ref',
  'Code',
  'kbd',
  'b',
  'i',
  'em',
  'strong',
  'code',
  'a',
  'span',
  's',
  'u',
  'small',
  'sup',
  'sub',
])

const textAttributes = new Set([
  'label',
  'title',
  'placeholder',
  'arialabel',
  'arialivemessage',
  'okbuttontext',
  'cancelbuttontext',
  'actiontitle',
  'description',
  'heading',
  'caption',
  'buttontext',
  'messagetext',
  'emptystatetext',
  'linkbuttondescription',
])

const textProperties = new Set([
  'label',
  'title',
  'placeholder',
  'ariaLabel',
  'ariaLiveMessage',
  'okButtonText',
  'actionTitle',
  'description',
  'relativeText',
  'absoluteText',
])

const cssLike = /^[a-z][a-z0-9-]*$/
const technical = /^[a-z]+:\/\/|^\/|^[A-Z]:\\|%[sd]|\$\{/
const hasLetter = /[A-Za-z]/

function slugifyFile(relativePath) {
  return relativePath
    .replace(/\\/g, '/')
    .replace(/^app\/src\//, '')
    .replace(/\.(tsx?|jsx?)$/, '')
    .split('/')
    .map(part =>
      part
        .replace(/([a-z0-9])([A-Z])/g, '$1-$2')
        .toLowerCase()
        .replace(/[^a-z0-9-]+/g, '-')
        .replace(/^-+|-+$/g, '')
    )
    .filter(Boolean)
    .join('.')
}

function hashText(text) {
  return crypto.createHash('sha1').update(text).digest('hex').slice(0, 8)
}

function normalizeText(raw) {
  return raw.replace(/\s+/g, ' ').trim()
}

function isTranslatable(text) {
  if (!text) {
    return false
  }
  if (!hasLetter.test(text)) {
    return false
  }
  return !(cssLike.test(text) || technical.test(text))
}

function scriptKind(fileName) {
  return fileName.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS
}

function isSpaceExpression(node) {
  return (
    ts.isJsxExpression(node) &&
    node.expression !== undefined &&
    (ts.isStringLiteral(node.expression) ||
      ts.isNoSubstitutionTemplateLiteral(node.expression)) &&
    node.expression.text.trim() === ''
  )
}

function isInlineChild(node, sourceFile) {
  if (ts.isJsxText(node) || ts.isJsxExpression(node)) {
    return true
  }
  if (ts.isJsxElement(node)) {
    return inlineTags.has(node.openingElement.tagName.getText(sourceFile))
  }
  if (ts.isJsxSelfClosingElement(node)) {
    return inlineTags.has(node.tagName.getText(sourceFile))
  }
  return false
}

function groupText(children, sourceFile) {
  const placeholders = []
  let message = ''
  let hasText = false
  let pendingSpace = false

  for (const child of children) {
    if (ts.isJsxText(child)) {
      const raw = child.getText(sourceFile)
      const text = normalizeText(raw)
      if (text) {
        const needsSpace =
          pendingSpace || (message.length > 0 && !/^[.,!?;:)]/.test(text))
        message += needsSpace && !message.endsWith(' ') ? ` ${text}` : text
        hasText = true
      }
      pendingSpace = /\s$/.test(raw)
      continue
    }
    if (isSpaceExpression(child)) {
      pendingSpace = message.length > 0
      continue
    }
    if (pendingSpace && message.length > 0 && !message.endsWith(' ')) {
      message += ' '
    }
    message += `{${placeholders.length}}`
    placeholders.push(child)
    pendingSpace = false
  }

  return { message: message.trim(), placeholders, hasText }
}

function renderGroup(site, message, source, sites, translations) {
  const pattern = /\{(\d+)\}/g
  const parts = []
  let last = 0
  let match

  while ((match = pattern.exec(message)) !== null) {
    const literal = message.slice(last, match.index)
    if (literal.trim()) {
      parts.push(`{${JSON.stringify(literal)}}`)
    }
    const child = site.placeholders[Number(match[1])]
    if (child !== undefined) {
      parts.push(renderRange(child.getStart(), child.getEnd(), source, sites, translations))
    }
    last = pattern.lastIndex
  }

  const tail = message.slice(last)
  if (tail.trim()) {
    parts.push(`{${JSON.stringify(tail)}}`)
  }

  return parts.join('')
}

function directlyNested(sites, start, end) {
  const inside = sites.filter(
    site =>
      site.start >= start &&
      site.end <= end &&
      !(site.start === start && site.end === end)
  )
  return inside
    .filter(
      site =>
        !inside.some(
          other =>
            other !== site &&
            site.start >= other.start &&
            site.end <= other.end &&
            !(other.start === site.start && other.end === site.end)
        )
    )
    .sort((a, b) => a.start - b.start)
}

function renderRange(start, end, source, sites, translations) {
  const inner = directlyNested(sites, start, end)
  let out = ''
  let pos = start

  for (const site of inner) {
    out += source.slice(pos, site.start)
    const replacement = renderSite(site, source, sites, translations)
    out +=
      replacement === null
        ? renderRange(site.start, site.end, source, sites, translations)
        : replacement
    pos = site.end
  }

  return out + source.slice(pos, end)
}

function renderSite(site, source, sites, translations) {
  const translated = translations[site.key]

  if (site.kind === 'group') {
    if (translated !== undefined && translated !== site.text) {
      return renderGroup(site, translated, source, sites, translations)
    }
    return null
  }

  if (site.kind === 'template') {
    if (translated !== undefined && translated !== site.text) {
      return renderTemplate(site, translated)
    }
    return null
  }

  if (translated === undefined || translated === site.text) {
    return null
  }

  const quote = source[site.start] === "'" ? "'" : '"'
  const escaped = translated
    .replace(/\\/g, '\\\\')
    .replace(/\r?\n/g, '\\n')
    .split(quote)
    .join(`\\${quote}`)
  return `${quote}${escaped}${quote}`
}

function collectLocaleSites(sourceFile) {
  const sites = []
  const visit = node => {
    if (
      ts.isStringLiteral(node) &&
      (node.text === 'en-US' || node.text === 'en-us')
    ) {
      sites.push({
        kind: 'attribute',
        start: node.getStart(),
        end: node.getEnd(),
        text: node.text,
        placeholders: [],
        localeLiteral: true,
      })
    }
    ts.forEachChild(node, visit)
  }
  visit(sourceFile)
  return sites
}

function transform(source, fileName, options = {}) {
  source = source.replace(/\r\n/g, '\n')
  const sourceFile = ts.createSourceFile(
    fileName,
    source,
    ts.ScriptTarget.Latest,
    true,
    scriptKind(fileName)
  )

  const translations = options.translations ?? {}
  const sites = collectSites(sourceFile)
  const localeSites =
    options.locale !== undefined ? collectLocaleSites(sourceFile) : []

  if (sites.length === 0 && localeSites.length === 0) {
    return { code: source, entries: [] }
  }

  const entries = assignKeys(sites, options.relativePath ?? fileName)
  let code = source

  for (const site of localeSites.slice().sort((a, b) => b.start - a.start)) {
    code =
      code.slice(0, site.start) +
      JSON.stringify(options.locale) +
      code.slice(site.end)
  }

  if (sites.length === 0) {
    return { code, entries }
  }

  const shifted = ts.createSourceFile(
    fileName,
    code,
    ts.ScriptTarget.Latest,
    true,
    scriptKind(fileName)
  )
  const shiftedSites = collectSites(shifted)
  assignKeys(shiftedSites, options.relativePath ?? fileName)

  return {
    code: renderRange(0, code.length, code, shiftedSites, translations),
    entries,
  }
}

const textVariables = new Set([
  'title',
  'label',
  'placeholder',
  'description',
  'message',
  'tooltip',
  'heading',
  'caption',
  'text',
  'name',
  'summary',
  'ariaLabel',
  'action',
])

function attributeNameOf(node, sourceFile) {
  return node.name.getText(sourceFile).toLowerCase()
}

const textCallees = new Set([
  'renderMenuBackedAction',
  'renderCallToAction',
  'showContextualMenu',
  'getMenuItemInfo',
  'postError',
  'setError',
  'addBanner',
  'showPopup',
  'openDialog',
  'showDialog',
  'renderDescription',
  'renderButtonGroupButton',
])

const technicalPropertyNames = new Set([
  'kind',
  'type',
  'role',
  'mode',
  'status',
  'code',
  'event',
  'variant',
  'style',
  'size',
  'shape',
  'direction',
  'align',
  'symbol',
  'icon',
  'display',
  'layout',
  'theme',
  'channel',
  'platform',
  'state',
  'operation',
  'action',
  'id',
  'key',
  'path',
  'uri',
  'url',
  'href',
  'src',
  'endpoint',
  'method',
  'format',
  'extension',
  'language',
  'encoding',
  'signal',
])

function looksTechnical(text) {
  if (typeof text !== 'string' || text.length < 2) {
    return true
  }
  if (/^[a-z][a-zA-Z0-9]*$/.test(text)) {
    return true
  }
  if (/^[A-Z][A-Z0-9_]+$/.test(text)) {
    return true
  }
  if (/^[a-z0-9.-]+\.[a-z]{2,}$/.test(text)) {
    return true
  }
  return false
}

function isTextPosition(node, sourceFile) {
  if (typeof node.text === 'string' && looksTechnical(node.text)) {
    let owner = node.parent
    while (
      owner !== undefined &&
      (ts.isConditionalExpression(owner) || ts.isParenthesizedExpression(owner))
    ) {
      owner = owner.parent
    }
    const isFileWord =
      /^files?$/.test(node.text) &&
      owner !== undefined &&
      ts.isVariableDeclaration(owner) &&
      /File$/.test(owner.name.getText(sourceFile))

    if (!isFileWord) {
      return false
    }
  }

  let cur = node.parent
  let nested = 0

  while (cur !== undefined) {
    if (
      ts.isConditionalExpression(cur) ||
      ts.isParenthesizedExpression(cur) ||
      ts.isBinaryExpression(cur)
    ) {
      if (
        ts.isBinaryExpression(cur) &&
        cur.operatorToken.kind === ts.SyntaxKind.PlusEqualsToken &&
        ts.isIdentifier(cur.left)
      ) {
        const target = cur.left.text
        const named =
          textVariables.has(target) ||
          /Label$|Text$|Message$|Title$|Description$|Placeholder$/.test(target)
        const words = (node.text ?? '').match(/[A-Za-z]{2,}/g) ?? []
        if (named && words.length >= 3) {
          return true
        }
      }
      nested++
      cur = cur.parent
      continue
    }
    if (nested > 0 && ts.isPropertyAssignment(cur)) {
      return textProperties.has(cur.name.getText(sourceFile))
    }
    if (ts.isCallExpression(cur)) {
      const callee = cur.expression.getText(sourceFile)
      const name = callee.split('.').pop() ?? ''
      return textCallees.has(name)
    }
    if (ts.isJsxExpression(cur)) {
      const parent = cur.parent
      if (ts.isJsxElement(parent) || ts.isJsxFragment(parent)) {
        return true
      }
      if (ts.isJsxAttribute(parent)) {
        return textAttributes.has(attributeNameOf(parent, sourceFile))
      }
      return false
    }
    if (ts.isJsxAttribute(cur)) {
      return textAttributes.has(attributeNameOf(cur, sourceFile))
    }
    if (ts.isPropertyAssignment(cur)) {
      return textProperties.has(cur.name.getText(sourceFile))
    }
    if (ts.isVariableDeclaration(cur) && ts.isIdentifier(cur.name)) {
      if (textVariables.has(cur.name.text)) {
        return true
      }
      return /Label$|Name$|Text$|Message$|Title$|Description$|Placeholder$|Verb$|File$|^openIn/.test(
        cur.name.text
      )
    }
    if (ts.isReturnStatement(cur)) {
      return true
    }
    return false
  }

  return false
}

function templateMessage(node) {
  let message = node.head.text
  const spans = []
  for (const span of node.templateSpans) {
    message += `{${spans.length}}`
    spans.push(span.expression)
    message += span.literal.text
  }
  return { message: message.replace(/\s+/g, ' ').trim(), spans }
}

function renderTemplate(site, translated) {
  const pattern = /\{(\d+)\}/g
  let out = '`'
  let last = 0
  let match

  while ((match = pattern.exec(translated)) !== null) {
    out += translated
      .slice(last, match.index)
      .replace(/\\/g, '\\\\')
      .replace(/`/g, '\\`')
      .replace(/\r?\n/g, '\\n')
    const expression = site.spans[Number(match[1])]
    if (expression !== undefined) {
      out += '${' + expression.getText() + '}'
    }
    last = pattern.lastIndex
  }

  out += translated
    .slice(last)
    .replace(/\\/g, '\\\\')
    .replace(/`/g, '\\`')
    .replace(/\r?\n/g, '\\n')

  return out + '`'
}

function looksLikeCode(message) {
  const bare = message.replace(/\{\d+\}/g, ' ').trim()
  if (/\/[^\s]|[^\s]\//.test(message)) {
    return true
  }
  if (/\{\d+\}-|-\{\d+\}/.test(message)) {
    return true
  }
  if (/<[a-z/]/i.test(message)) {
    return true
  }
  const words = bare.match(/[A-Za-z][A-Za-z0-9-]*/g) ?? []
  if (words.length === 0) {
    return true
  }
  return words.some(word => /^[a-z0-9]+-[a-z0-9-]+$/.test(word))
}

function isStringContext(node, sourceFile) {
  let cur = node.parent
  while (
    cur !== undefined &&
    (ts.isConditionalExpression(cur) || ts.isParenthesizedExpression(cur))
  ) {
    cur = cur.parent
  }
  if (cur === undefined) {
    return false
  }
  if (ts.isVariableDeclaration(cur) && ts.isIdentifier(cur.name)) {
    return /Label$|Text$|Name$|Title$|Description$|Message$|Placeholder$|^openIn/.test(
      cur.name.text
    )
  }
  return (
    ts.isPropertyAssignment(cur) &&
    /^(label|title|description|placeholder)$/i.test(
      cur.name.getText(sourceFile)
    )
  )
}

function isFileWord(node, sourceFile) {
  if (!/^files?$/i.test(node.text)) {
    return false
  }
  let owner = node.parent
  while (
    owner !== undefined &&
    (ts.isConditionalExpression(owner) || ts.isParenthesizedExpression(owner))
  ) {
    owner = owner.parent
  }
  return (
    owner !== undefined &&
    ts.isVariableDeclaration(owner) &&
    /File$/.test(owner.name.getText(sourceFile))
  )
}

function hasProse(text) {
  if (looksLikeCode(text)) {
    return false
  }
  const words = text.replace(/\{\d+\}/g, '').match(/[A-Za-z]{2,}/g) ?? []
  if (words.length >= 2) {
    return true
  }
  const placeholders = (text.match(/\{\d+\}/g) ?? []).length
  if (words.length >= 1 && placeholders >= 2) {
    return true
  }
  return words.length === 1 && placeholders >= 1 && /^[A-Z]/.test(text.trim())
}

function collectSites(sourceFile) {
  const sites = []

  const visit = node => {
    if (ts.isJsxElement(node) || ts.isJsxFragment(node)) {
      let run = []

      const flush = () => {
        if (run.length > 0) {
          const { message, placeholders, hasText } = groupText(run, sourceFile)
          if (hasText && isTranslatable(message)) {
            sites.push({
              kind: 'group',
              start: run[0].getStart(),
              end: run[run.length - 1].getEnd(),
              text: message,
              placeholders,
            })
          }
        }
        run = []
      }

      for (const child of node.children) {
        if (isInlineChild(child, sourceFile)) {
          run.push(child)
        } else {
          flush()
        }
      }
      flush()
    }

    if (
      ts.isTemplateExpression(node) &&
      isTextPosition(node, sourceFile) &&
      hasProse(templateMessage(node).message)
    ) {
      const { message, spans } = templateMessage(node)
      if (isTranslatable(message)) {
        sites.push({
          kind: 'template',
          start: node.getStart(),
          end: node.getEnd(),
          text: message,
          placeholders: spans,
          spans,
        })
      }
    }

    if (
      (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) &&
      (isTranslatable(node.text) || isFileWord(node, sourceFile)) &&
      isTextPosition(node, sourceFile)
    ) {
      sites.push({
        kind: 'attribute',
        start: node.getStart(),
        end: node.getEnd(),
        text: node.text,
        placeholders: [],
      })
    }

    ts.forEachChild(node, visit)
  }

  visit(sourceFile)
  return sites
}

function assignKeys(sites, relativePath) {
  const slug = slugifyFile(relativePath)
  const used = new Map()

  for (const site of sites) {
    const base = `${slug}.${hashText(site.text)}`
    const count = (used.get(base) ?? 0) + 1
    used.set(base, count)
    site.key = count === 1 ? base : `${base}~${count}`
  }

  return sites.map(site => ({ key: site.key, text: site.text }))
}

function readTranslations(file) {
  if (!fs.existsSync(file)) {
    return {}
  }
  return JSON.parse(fs.readFileSync(file, 'utf8'))
}

module.exports = {
  transform,
  slugifyFile,
  hashText,
  normalizeText,
  isTranslatable,
  readTranslations,
}
