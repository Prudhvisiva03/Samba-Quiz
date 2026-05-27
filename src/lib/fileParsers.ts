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

function cleanPdfPageText(raw: string): string {
  return raw
    // Remove lone page numbers (lines that are just digits)
    .replace(/(?:^|\n)\s*\d{1,4}\s*(?:\n|$)/g, '\n')
    // Remove running headers/footers: short all-caps lines (< 60 chars)
    .replace(/(?:^|\n)([A-Z][A-Z\s\-]{0,58}[A-Z])(?:\n|$)/g, '\n')
    // Fix broken words: "photo syn thesis" → join if word halves are short
    .replace(/([a-z]{2,})-\s+([a-z]{2,})/g, '$1$2')
    // Collapse multiple spaces/newlines
    .replace(/\s{2,}/g, ' ')
    .trim()
}

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
    // Group items by their y-position to preserve paragraph structure
    const lines = new Map<number, string[]>()
    for (const item of content.items) {
      if (!('str' in item) || !item.str.trim()) continue
      const y = Math.round((item as { transform: number[] }).transform[5])
      if (!lines.has(y)) lines.set(y, [])
      lines.get(y)!.push(item.str)
    }
    // Sort lines top→bottom (higher y = higher on page in PDF coords)
    const sorted = [...lines.entries()]
      .sort((a, b) => b[0] - a[0])
      .map(([, parts]) => parts.join(' ').trim())
      .filter(Boolean)
    const pageText = cleanPdfPageText(sorted.join(' '))
    if (pageText.length > 20) pageTexts.push(pageText)
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

function extractShapeText(shapeXml: string): string {
  const paragraphs: string[] = []
  for (const paraMatch of shapeXml.matchAll(/<a:p>([\s\S]*?)<\/a:p>/g)) {
    const runs = Array.from(paraMatch[1].matchAll(/<a:t>(.*?)<\/a:t>/g))
      .map((m) => cleanupText(decodeXml(m[1])))
      .filter(Boolean)
    if (runs.length === 0) continue
    const paraText = runs.join(' ')
    if (isNavFragment(paraText)) continue
    // Keep paragraphs that are at least 15 chars or end with punctuation (real sentences)
    // (relaxed from 25 to catch short but meaningful bullet points like "RAM stores data temporarily")
    if (paraText.length < 15 && !/[.!?:)]$/.test(paraText)) continue
    paragraphs.push(paraText)
  }
  return paragraphs.join(' ')
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

      const parts: string[] = []

      // Process each shape (<p:sp>) individually so we can skip title placeholders
      for (const shapeMatch of xml.matchAll(/<p:sp>([\s\S]*?)<\/p:sp>/g)) {
        const shapeXml = shapeMatch[1]

        // Skip title / centered-title / subtitle placeholder shapes — they are
        // slide headings, not exam content
        if (/<p:ph\s[^>]*type="(?:title|ctrTitle|subTitle)"/.test(shapeXml)) continue

        // Skip shapes that are clearly navigation/watermark text boxes
        // (non-placeholder shapes with no idx that are very short)
        const text = extractShapeText(shapeXml)
        if (text) parts.push(text)
      }

      return parts.join(' ')
    }),
  )

  return slideTexts.filter(Boolean).join('\n\n')
}

function cleanOcrText(raw: string): string {
  return raw
    // Fix OCR artifacts: stray single characters on their own line
    .replace(/(?:^|\n)\s*[a-z]\s*(?:\n|$)/g, '\n')
    // Fix broken hyphenated words across lines: "photo-\nsynth" → "photosyn"
    .replace(/([a-z])-\n([a-z])/g, '$1$2')
    // Merge single newlines (paragraph continuation) but keep double-newlines
    .replace(/(?<!\n)\n(?!\n)/g, ' ')
    // Remove non-printable/garbage characters from scanner noise
    .replace(/[^\x20-\x7E\n]/g, '')
    // Collapse spaces
    .replace(/[ \t]{2,}/g, ' ')
    .trim()
}

export async function extractImageText(file: File) {
  const { createWorker } = await import('tesseract.js')
  const worker = await createWorker('eng')

  try {
    const { data } = await worker.recognize(file)
    const cleaned = cleanOcrText(data.text)
    if (!cleaned || cleaned.trim().length < 20) {
      throw new Error(
        'Could not read enough text from this image. Try a clearer photo, or paste the text manually below.',
      )
    }
    return cleaned
  } catch (err) {
    if (err instanceof Error && err.message.includes('Could not read')) throw err
    throw new Error(
      'Image text extraction failed. Please make sure the image is clear and well-lit, or paste the notes manually.',
    )
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
