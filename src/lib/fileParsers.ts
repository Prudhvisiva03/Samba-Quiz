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
    slideNames.map(async (name, index) => {
      const xml = await zip.file(name)?.async('string')
      if (!xml) {
        return ''
      }

      const fragments = Array.from(xml.matchAll(/<a:t>(.*?)<\/a:t>/g)).map((match) =>
        cleanupText(decodeXml(match[1])),
      )

      const slideText = fragments.filter(Boolean).join(' ')
      return slideText ? `Slide ${index + 1}: ${slideText}` : ''
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
