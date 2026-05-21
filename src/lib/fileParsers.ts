const decodeXml = (value: string) =>
  value
    .replaceAll('&amp;', '&')
    .replaceAll('&lt;', '<')
    .replaceAll('&gt;', '>')
    .replaceAll('&quot;', '"')
    .replaceAll('&#39;', "'")

const cleanupText = (value: string) =>
  value
    .replace(/\s+/g, ' ')
    .replaceAll(String.fromCharCode(0), ' ')
    .trim()

const supportedImageTypes = new Set(['png', 'jpg', 'jpeg', 'webp'])

export async function extractPdfText(file: File) {
  const pdfjs = await import('pdfjs-dist')
  const pdfWorker = await import('pdfjs-dist/build/pdf.worker.min.mjs?url')
  pdfjs.GlobalWorkerOptions.workerSrc = pdfWorker.default

  const data = new Uint8Array(await file.arrayBuffer())
  const pdf = await pdfjs.getDocument({ data }).promise
  const pageTexts: string[] = []

  for (let pageNumber = 1; pageNumber <= pdf.numPages; pageNumber += 1) {
    const page = await pdf.getPage(pageNumber)
    const content = await page.getTextContent()
    const text = cleanupText(content.items.map((item) => ('str' in item ? item.str : '')).join(' '))
    if (text) {
      pageTexts.push(text)
    }
  }

  return pageTexts.join('\n\n')
}

// Patterns that indicate PPTX navigation/structural text, not subject content
const pptxNavPattern =
  /^(\d{1,3}|[A-Z]{2,6}-\d{3,}|lesson\s*\d|topic\s*\d|module\s*\d|section\s*\d|unit\s*\d|slide\s*\d|chapter\s*\d|part\s*\d|lab\s*\d|objective\s*\d|\(continued.*\)|continued on|next slide|key demo|learning obj|review q|activity\s*\d|table of contents|copyright|\d+\s*[A-Z].{0,50}\.{3,}\s*\d+)/i

function isNavFragment(text: string): boolean {
  if (text.length < 4) return true
  if (pptxNavPattern.test(text.trim())) return true
  // Pure course codes: "XKO-005", "N10-008", "SY0-601" etc.
  if (/^[A-Z]{2,4}\d*[-+]\d{3,}[a-z]?\s*$/.test(text)) return true
  // Lines that are only numbers + short words (slide numbering artifacts)
  if (/^\d+(\s+\d+)*\s*$/.test(text)) return true
  return false
}

export async function extractPptxText(file: File) {
  const { default: JSZip } = await import('jszip')
  const zip = await JSZip.loadAsync(await file.arrayBuffer())
  const slideNames = Object.keys(zip.files)
    .filter((name) => /^ppt\/slides\/slide\d+\.xml$/.test(name))
    .sort((left, right) => {
      const leftIndex = Number.parseInt(left.match(/\d+/)?.[0] ?? '0', 10)
      const rightIndex = Number.parseInt(right.match(/\d+/)?.[0] ?? '0', 10)
      return leftIndex - rightIndex
    })

  const slideTexts = await Promise.all(
    slideNames.map(async (name) => {
      const xml = await zip.file(name)?.async('string')
      if (!xml) return ''

      // Extract all paragraph blocks (<a:p>...</a:p>) separately so each
      // text run stays in its natural paragraph boundary.
      const paragraphs: string[] = []
      for (const paraMatch of xml.matchAll(/<a:p>([\s\S]*?)<\/a:p>/g)) {
        const runs = Array.from(paraMatch[1].matchAll(/<a:t>(.*?)<\/a:t>/g))
          .map((m) => cleanupText(decodeXml(m[1])))
          .filter(Boolean)
        if (runs.length === 0) continue
        const paraText = runs.join(' ')
        // Drop navigation / structural fragments
        if (isNavFragment(paraText)) continue
        // Drop very short fragments (headers/labels under 20 chars) UNLESS they look like full sentences
        if (paraText.length < 20 && !/[.!?]$/.test(paraText)) continue
        paragraphs.push(paraText)
      }

      if (paragraphs.length === 0) return ''
      return paragraphs.join(' ')
    }),
  )

  return slideTexts.filter(Boolean).join('\n\n')
}

export async function extractImageText(file: File) {
  const { createWorker } = await import('tesseract.js')
  const worker = await createWorker('eng')

  try {
    const {
      data: { text },
    } = await worker.recognize(file)
    return cleanupText(text)
  } finally {
    await worker.terminate()
  }
}

export async function extractTextFromFile(file: File) {
  const extension = file.name.split('.').pop()?.toLowerCase()

  if (extension === 'pdf') {
    return extractPdfText(file)
  }

  if (extension === 'pptx') {
    return extractPptxText(file)
  }

  if (extension === 'txt') {
    return cleanupText(await file.text())
  }

  if (extension && supportedImageTypes.has(extension)) {
    return extractImageText(file)
  }

  throw new Error('Please upload a PDF, PPTX, TXT, PNG, JPG, JPEG, or WEBP file.')
}
