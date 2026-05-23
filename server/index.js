import cors from 'cors'
import dotenv from 'dotenv'
import express from 'express'
import fs from 'node:fs'
import path from 'node:path'
import OpenAI from 'openai'

dotenv.config({ override: true })

const app = express()
const port = Number.parseInt(process.env.PORT ?? '8787', 10)
// llama-3.3-70b is fast, reliable at JSON, and doesn't produce thinking blocks.
// Users can override via OPENAI_MODEL env var.
const model = process.env.OPENAI_MODEL ?? 'meta/llama-3.3-70b-instruct'
const apiKey = process.env.OPENAI_API_KEY
const baseURL = process.env.OPENAI_BASE_URL
const openai = apiKey ? new OpenAI({ apiKey, ...(baseURL ? { baseURL } : {}) }) : null
const distPath = path.resolve('dist')

app.use(cors())
app.use(express.json({ limit: '3mb' }))

const stopWords = new Set([
  'about', 'after', 'again', 'because', 'between', 'chapter', 'could',
  'every', 'first', 'from', 'important', 'into', 'other', 'should',
  'their', 'there', 'these', 'those', 'through', 'topic', 'using',
  'where', 'which', 'while', 'would',
  // PPTX / document artifacts
  'slide', 'lesson', 'section', 'module', 'page', 'figure', 'table',
  'activity', 'objective', 'review', 'summary', 'intro', 'overview',
])

function cleanText(text) {
  return text.replace(/\s+/g, ' ').trim()
}

function stripPptxArtifacts(text) {
  return text
    // Slide prefixes
    .replace(/Slide\s+\d+\s*:\s*/gi, '')
    // Navigation / continuation markers
    .replace(/\(continued\s+on\s+next\s+slide\)/gi, '')
    .replace(/\bcontinued\b[^\n]*/gi, '')
    // Course/exam codes at start of phrase: "XKO-005", "N10-008", "CompTIA Linux+"
    .replace(/\b[A-Z]{2,5}\d*[-+]\d{3,}[A-Za-z]?\b/g, '')
    // Lesson / topic / module / unit / section structural labels
    .replace(/\b(Lesson|Topic|Module|Unit|Section|Chapter|Part|Lab|Objective|Activity|Exam)\s+\d+[A-Za-z]?\b[:\s]*/gi, '')
    // "Key Demonstration:" / "Learning Objectives" / "Review Questions"
    .replace(/\b(Lab Activity|Assisted Lab|Key Demonstration|Learning Objective[s]?|Review Question[s]?|Exam Objective[s]?)\b[:\s]*/gi, '')
    // Lines that start with a number followed by a heading (TOC/outline artifacts)
    .replace(/^\s*\d{1,3}\s+[A-Z][^\n]{0,60}$/gm, '')
    // "Administering Users and Groups" style section headers (all-title-case, no verb)
    .replace(/\s{2,}/g, ' ')
    .trim()
}

// Strips book front-matter so AI never generates questions about author/ISBN/publisher/title
function stripBookMetadata(text) {
  return text
    // ISBN — e.g. "ISBN 978-0-13-468599-1", "ISBN-13:", "ISBN-10:"
    .replace(/\bISBN[-\s]*(1[03])?[:\s]*[\d\s\-Xx]{9,17}/gi, '')
    // Copyright lines — "© 2023 Pearson", "Copyright 2022 by ..."
    .replace(/©[^\n]*/g, '')
    .replace(/copyright\s+(?:©\s*)?\d{4}[^\n]*/gi, '')
    .replace(/all rights reserved[^\n]*/gi, '')
    // Printed / published lines
    .replace(/printed in[^\n]*/gi, '')
    .replace(/published by[^\n]*/gi, '')
    .replace(/\bpublisher[:\s][^\n]*/gi, '')
    // Edition lines — "Third Edition", "2nd Edition", "Revised Edition"
    .replace(/\b(?:\d+(?:st|nd|rd|th)|revised|second|third|fourth|fifth|sixth)\s+edition\b[^\n]*/gi, '')
    // "by Author Name" standalone lines
    .replace(/^by\s+[A-Z][a-z]+(?:\s+[A-Z][a-z]+){1,3}\s*$/gm, '')
    // Table of contents entries: "Chapter Name .......... 42"
    .replace(/^.{5,70}[.\s]{4,}\d+\s*$/gm, '')
    // Lines that are just a number (page numbers from PDF)
    .replace(/^\s*\d{1,4}\s*$/gm, '')
    // "Version X.X" lines
    .replace(/\bversion\s+[\d.]+[^\n]*/gi, '')
    // Normalize whitespace
    .replace(/\s{2,}/g, ' ')
    .trim()
}

function clampText(text, maxLength = 6000) {
  return text.length > maxLength ? `${text.slice(0, maxLength)}...` : text
}

function buildTopicSource(sourceText, options = {}, metadata = {}) {
  const topic = cleanText(sourceText || options.examName || metadata.fileName || 'General revision topic')
  return [
    `Topic: ${topic}.`,
    options.examName ? `Exam focus: ${options.examName}.` : '',
    options.learnerGoal ? `Learner goal: ${options.learnerGoal}.` : '',
    options.difficultyMix ? `Difficulty target: ${options.difficultyMix}.` : '',
    'Create exam-ready multiple-choice questions using reliable standard knowledge for this topic.',
    'Keep answers practical, correct, and easy to revise.',
  ]
    .filter(Boolean)
    .join(' ')
}

function cleanRaw(rawText) {
  return rawText
    .replace(/<think>[\s\S]*?<\/think>/gi, '')   // strip reasoning blocks
    .replace(/^```(?:json)?\s*/im, '')             // strip opening code fence
    .replace(/\s*```\s*$/im, '')                   // strip closing code fence
    .trim()
}

function extractJson(rawText) {
  const cleaned = cleanRaw(rawText)
  const start = cleaned.indexOf('{')
  const end = cleaned.lastIndexOf('}')
  if (start === -1 || end === -1 || end <= start) return null
  try { return JSON.parse(cleaned.slice(start, end + 1)) } catch { return null }
}

// Try to salvage a JSON response that was cut off mid-generation
function repairJson(rawText) {
  const text = cleanRaw(rawText)
  const start = text.indexOf('{')
  if (start === -1) return null
  const body = text.slice(start)

  // Try appending common closing sequences
  for (const suffix of ['"}]}', '"]}', ']}', '}]', '}}', '}']) {
    try {
      const r = JSON.parse(body + suffix)
      if (r?.questions?.length > 0) return r
    } catch { /* try next */ }
  }

  // Find the last fully-formed question object by scanning for the last answerIndex
  const hits = [...body.matchAll(/"answerIndex"\s*:\s*\d/g)]
  if (hits.length === 0) return null
  const lastHit = hits[hits.length - 1]
  let depth = 0, closeIdx = -1
  for (let i = lastHit.index; i < body.length; i++) {
    if (body[i] === '{') depth++
    else if (body[i] === '}') { depth--; if (depth <= 0) { closeIdx = i; break } }
  }
  if (closeIdx === -1) return null

  // Wrap partial questions array
  const arrStart = body.indexOf('[')
  if (arrStart === -1) return null
  try {
    const partial = body.slice(arrStart, closeIdx + 1) + ']'
    const questions = JSON.parse(partial)
    if (Array.isArray(questions) && questions.length > 0) {
      return { title: 'Quiz', flashSummary: [], questions }
    }
  } catch { /* no luck */ }
  return null
}

// Returns true if AI quiz looks like real questions (not slide-text garbage)
function isGoodQuiz(quiz) {
  if (!quiz?.questions?.length) return false
  const bad = quiz.questions.filter((q) => {
    // Bad signal: options that are very long raw-text fragments with no sentence structure
    const longRaw = q.options?.filter((o) => o.length > 90 && !/[.!?]$/.test(o)).length ?? 0
    // Bad signal: question text is under 20 chars or is just "Review this concept"
    const trivialQ = !q.question || q.question.length < 18 || /review this concept/i.test(q.question)
    return longRaw >= 2 || trivialQ
  }).length
  return bad < quiz.questions.length * 0.4
}

function splitSentences(sourceText) {
  return sourceText
    .split(/(?<=[.!?])\s+/)
    .map((sentence) => cleanText(sentence))
    .filter((sentence) => sentence.length >= 45)
}

function collectKeywords(sourceText) {
  return Array.from(
    new Set(
      sourceText
        .toLowerCase()
        .match(/[a-z][a-z-]{4,}/g)
        ?.filter((word) => !stopWords.has(word))
        .sort((left, right) => right.length - left.length) ?? [],
    ),
  ).slice(0, 28)
}

function cap(str) {
  return str.charAt(0).toUpperCase() + str.slice(1)
}

function shortenExcerpt(text, maxLength = 180) {
  const clean = cleanText(String(text ?? ''))
  return clean.length > maxLength ? `${clean.slice(0, maxLength).trim()}...` : clean
}

function answerSupportedByExcerpt(answer, excerpt) {
  const safeAnswer = cleanText(String(answer ?? '')).toLowerCase()
  const safeExcerpt = cleanText(String(excerpt ?? '')).toLowerCase()
  if (!safeAnswer || !safeExcerpt) return false

  const answerTokens = safeAnswer
    .replace(/[^a-z0-9\s-]/g, ' ')
    .split(/\s+/)
    .filter((token) => token.length > 3)

  if (answerTokens.length === 0) {
    return safeExcerpt.includes(safeAnswer)
  }

  const matched = answerTokens.filter((token) => safeExcerpt.includes(token)).length
  return matched >= Math.max(1, Math.ceil(answerTokens.length * 0.6))
}

// Sentences that are purely book metadata — never make good quiz questions
const metaSentencePattern = /\b(author|authors|publisher|isbn|copyright|edition|textbook|this book|this text|printed|published by|all rights|acknowledgement|preface|foreword|dedication|acknowledgment|lesson\s*\d|topic\s*\d|module\s*\d|continued on next|key demonstration|lab activity|learning objectives?|exam objectives?|review questions?)\b/i

function buildCandidates(safeSentences) {
  const candidates = []
  for (const sentence of safeSentences) {
    if (metaSentencePattern.test(sentence)) continue
    // "X is/are [the|a|an] Y..." → "What is/are X?"
    const defMatch = sentence.match(/^([A-Z][^,]{2,50}?)\s+(is|are)\s+(?:the\s+|a\s+|an\s+)?(.{20,200})$/i)
    if (defMatch) {
      const subject = defMatch[1].trim()
      const verb = defMatch[2].toLowerCase()
      const definition = defMatch[3].replace(/\.$/, '').trim()
      // Skip passive constructions like "X are produced/split/converted"
      const isPassive = /^(produced|split|converted|used|formed|released|required|called|known|found)\b/i.test(definition)
      if (!isPassive && subject.split(/\s+/).length <= 6 && definition.length > 15) {
        candidates.push({ question: `What ${verb} ${subject.toLowerCase()}?`, answer: definition, sentence })
        continue
      }
    }

    // "X contain(s)/produce(s)/convert(s)/use(s)/require(s)/release(s)/absorb(s) Y"
    const verbMatch = sentence.match(/^([A-Z][^,]{2,40}?)\s+(contain|produce|convert|use|require|allow|absorb|release|form|create)s?\s+(.{10,150})$/i)
    if (verbMatch) {
      const subj = verbMatch[1].trim()
      const verb = verbMatch[2].toLowerCase()
      const obj = verbMatch[3].replace(/\.$/, '').trim()
      const isPlural = /\band\b/.test(subj) || /[^s]s$/.test(subj.split(/\s+/).pop() ?? '')
      const doWord = isPlural ? 'do' : 'does'
      candidates.push({ question: `What ${doWord} ${subj.toLowerCase()} ${verb}?`, answer: obj, sentence })
      continue
    }

    // "X occurs in/at Y"
    const locationMatch = sentence.match(/^([A-Z][^,]{4,50}?)\s+occurs?\s+(?:in|at|within|inside)\s+(.{5,80})\.?$/i)
    if (locationMatch) {
      const process = locationMatch[1].trim()
      const location = locationMatch[2].trim()
      candidates.push({ question: `Where does ${process.toLowerCase()} occur?`, answer: location, sentence })
      continue
    }

    // Last resort: only use sentences that have a clear "X is Y" or "X does Y"
    // structure but didn't match the stricter patterns above. Skip pure nav text.
    const hasVerb = /\b(is|are|was|were|can|will|must|should|provides?|enables?|allows?|defines?|means?)\b/i.test(sentence)
    if (hasVerb && sentence.length > 60) {
      candidates.push({ question: `Which statement about the material is correct?`, answer: sentence.slice(0, 90), sentence })
    }
  }
  return candidates
}

function buildFallbackQuiz(sourceText, options, metadata) {
  const sentences = splitSentences(sourceText)
  const keywords = collectKeywords(sourceText)
  const count = Math.min(Math.max(Number(options.questionCount) || 8, 5), 50)
  const safeSentences = sentences.length > 0 ? sentences : [cleanText(sourceText)]
  const flashSummary = safeSentences.slice(0, 4).map((sentence) => sentence.slice(0, 120))

  const candidates = buildCandidates(safeSentences)
  const pool = candidates.length >= count ? candidates : [...candidates, ...candidates, ...candidates]

  const questions = Array.from({ length: count }, (_, index) => {
    const cand = pool[index % pool.length] ?? { question: 'Review this concept:', answer: keywords[0] ?? 'concept', sentence: safeSentences[0] }

    // Collect distractor answers from other candidates + keywords
    const otherAnswers = pool
      .filter((c, i) => i !== index % pool.length)
      .map((c) => c.answer.split(/[,;]/)[0].trim().slice(0, 70))
      .filter((a) => a.length > 4 && a.toLowerCase() !== cand.answer.toLowerCase().slice(0, a.length))

    const kwFallback = keywords
      .filter((k) => !cand.answer.toLowerCase().includes(k))
      .slice(index % Math.max(keywords.length - 3, 1), index % Math.max(keywords.length - 3, 1) + 4)
      .map((k) => cap(k))

    const distractors = [...new Set([...otherAnswers, ...kwFallback])].slice(0, 3)
    while (distractors.length < 3) distractors.push(`Option ${distractors.length + 1}`)

    const answerIndex = index % 4
    const answer = cap(cand.answer.split(/[,;]/)[0].trim().slice(0, 80))
    const optionsList = [...distractors.slice(0, 3)]
    optionsList.splice(answerIndex, 0, answer)

    return {
      id: `fallback-${index + 1}`,
      question: cand.question,
      options: optionsList.slice(0, 4),
      answerIndex,
      explanation: `Correct answer: ${answer}. From the material: "${cand.sentence.slice(0, 160)}"`,
      difficulty: options.difficultyMix ?? 'medium',
      sourceHint: metadata.fileName || metadata.mode || 'Uploaded notes',
      sourceExcerpt: shortenExcerpt(cand.sentence),
    }
  })

  return {
    title: `${options.examName || 'Study'} Quiz Builder`,
    flashSummary,
    questions,
    sourceType: openai ? 'OpenAI fallback backup' : 'Local smart generator',
  }
}

function buildTopicFallbackQuiz(sourceText, options, metadata) {
  const topic = cleanText(sourceText || options.examName || 'This topic')
  const count = Math.min(Math.max(Number(options.questionCount) || 8, 5), 50)

  return {
    title: `${options.examName || topic} Quiz Builder`,
    flashSummary: [
      `Topic focus: ${topic}`,
      `Exam style: ${options.examType ?? 'mcq'}`,
      `Difficulty: ${options.difficultyMix ?? 'medium'}`,
    ],
    questions: Array.from({ length: count }, (_, index) => ({
      id: `topic-${index + 1}`,
      question:
        index % 3 === 0
          ? `Which statement best describes ${topic}?`
          : index % 3 === 1
            ? `Which point is most important when revising ${topic}?`
            : `Which option is most closely related to ${topic}?`,
      options: [
        `A core idea of ${topic}`,
        'An unrelated point from another topic',
        'A vague distractor with weak relevance',
        'A random option without exam value',
      ],
      answerIndex: 0,
      explanation: `This quiz was built from a short topic prompt. Upload notes, paste text, or add an image for more exact source-based questions on ${topic}.`,
      difficulty: options.difficultyMix ?? 'medium',
      sourceHint: metadata.fileName || 'Typed topic',
      sourceExcerpt: `Topic prompt: ${topic}`,
    })),
    sourceType: openai ? 'OpenAI topic generator backup' : 'Local topic generator',
  }
}

function normalizeQuiz(payload, fallbackQuiz) {
  if (!payload || typeof payload !== 'object') return fallbackQuiz
  const rawQs = Array.isArray(payload.questions) ? payload.questions : []
  if (rawQs.length === 0) return fallbackQuiz

  const diff = fallbackQuiz.questions[0]?.difficulty ?? 'medium'

  const questions = rawQs
    .slice(0, fallbackQuiz.questions.length)
    .map((q, i) => {
      if (!q || typeof q !== 'object') return null
      const opts = Array.isArray(q.options)
        ? q.options.map((o) => String(o).slice(0, 200)).slice(0, 4)
        : []
      if (opts.length < 4) return null   // drop malformed question entirely — never pad with garbage
      const ai = typeof q.answerIndex === 'number' && q.answerIndex >= 0 && q.answerIndex < opts.length
        ? q.answerIndex : 0
      return {
        id: `ai-${i + 1}`,
        question: typeof q.question === 'string' && q.question.length > 5 ? q.question : null,
        options: opts,
        answerIndex: ai,
        explanation: typeof q.explanation === 'string' ? q.explanation : '',
        difficulty: ['easy', 'medium', 'hard'].includes(q.difficulty) ? q.difficulty : diff,
        sourceHint: typeof q.sourceHint === 'string' ? q.sourceHint : '',
        sourceExcerpt:
          typeof q.sourceExcerpt === 'string' && answerSupportedByExcerpt(opts[ai], q.sourceExcerpt)
            ? shortenExcerpt(q.sourceExcerpt)
            : '',
      }
    })
    .filter((q) => q !== null && q.question !== null)

  if (questions.length === 0) return fallbackQuiz
  return {
    title: typeof payload.title === 'string' ? payload.title : fallbackQuiz.title,
    flashSummary:
      Array.isArray(payload.flashSummary) && payload.flashSummary.length > 0
        ? payload.flashSummary.map(String).slice(0, 5)
        : fallbackQuiz.flashSummary,
    questions,
    sourceType: 'AI generated',
  }
}

function buildPrompt(sourceText, options, count, inputLimit, topicOnly) {
  const examTypeLabel = {
    mcq: 'multiple-choice questions (MCQ)',
    scenario: 'scenario-based questions (describe a real situation, then ask)',
    mixed: 'mix of standard MCQs and scenario-based questions',
  }[options.examType] ?? 'multiple-choice questions'

  return `You are an expert exam question writer. Output ONLY valid JSON, nothing else.

JSON format:
{"title":"string","flashSummary":["tip1","tip2","tip3"],"questions":[{"question":"string","options":["A","B","C","D"],"answerIndex":0,"explanation":"string","difficulty":"medium","sourceHint":"string","sourceExcerpt":"string"}]}

Requirements:
- Exactly ${count} questions total. Write all of them.
- Style: ${examTypeLabel}
- Difficulty: ${options.difficultyMix}${options.examName ? ` | Topic: ${options.examName}` : ''}
- Each question MUST have exactly 4 short, clear answer options (under 60 chars each)
- answerIndex is the index (0-3) of the correct option
- Distractors must be plausible but wrong
- explanation: 1-2 sentences, factual, explains WHY the answer is correct
- sourceExcerpt: short phrase copied from the material supporting the answer
- DO NOT ask about book titles, authors, slide numbers, course codes, or ISBNs
- DO NOT use raw slide text or navigation labels as answer options
- ${topicOnly ? 'Use your knowledge of the topic below.' : 'Only use facts from the material below.'}

Material:
${clampText(sourceText, inputLimit)}`
}

async function callAI(prompt, maxTokens, timeoutMs = 160000) {
  const controller = new AbortController()
  const tid = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const completion = await openai.chat.completions.create(
      { model, messages: [{ role: 'user', content: prompt }], temperature: 0.45, max_tokens: maxTokens },
      { signal: controller.signal },
    )
    return completion.choices[0]?.message?.content?.trim() ?? ''
  } finally {
    clearTimeout(tid)
  }
}

async function generateWithOpenAI(sourceText, options, metadata, fallbackQuiz) {
  if (!openai) return fallbackQuiz

  const topicOnly = cleanText(String(metadata.inputMode ?? '')) === 'topic'
  const totalCount = fallbackQuiz.questions.length

  // Attempt 1: full question count
  // Attempt 2 (if needed): half count, simpler prompt, shorter input
  const attempts = [
    { count: totalCount, inputLimit: Math.min(Math.max(totalCount * 300, 5500), 14000) },
    { count: Math.max(Math.ceil(totalCount / 2), 5), inputLimit: 5000 },
  ]

  for (let a = 0; a < attempts.length; a++) {
    const { count, inputLimit } = attempts[a]
    const maxTokens = Math.min(count * 400 + 900, 16000)

    // Build a temporary fallback sized for this attempt's count
    const attemptFallback = { ...fallbackQuiz, questions: fallbackQuiz.questions.slice(0, count) }

    try {
      const prompt = buildPrompt(sourceText, options, count, inputLimit, topicOnly)
      const rawText = await callAI(prompt, maxTokens)
      if (!rawText) { console.error(`[AI] Attempt ${a + 1}: empty response`); continue }

      const parsed = extractJson(rawText) ?? repairJson(rawText)
      if (!parsed) {
        console.error(`[AI] Attempt ${a + 1}: JSON parse failed. Preview:`, rawText.slice(0, 300))
        continue
      }

      const quiz = normalizeQuiz(parsed, attemptFallback)
      if (isGoodQuiz(quiz)) {
        console.log(`[AI] Attempt ${a + 1}: success — ${quiz.questions.length} questions`)
        return quiz
      }
      console.error(`[AI] Attempt ${a + 1}: quality check failed`)
    } catch (err) {
      console.error(`[AI] Attempt ${a + 1} error:`, err?.message ?? err)
    }

    if (a < attempts.length - 1) {
      console.log(`[AI] Retrying with ${attempts[a + 1].count} questions...`)
    }
  }

  console.error('[AI] All attempts failed — using local fallback')
  return fallbackQuiz
}

function buildLocalChatReply(context, userMessage) {
  const ask = cleanText(String(userMessage ?? '')).toLowerCase()
  const hasContext = context && context.question

  if (hasContext) {
    const correctAnswer = context.options?.[context.answerIndex] ?? 'the correct option'
    const explanation = cleanText(String(context.explanation ?? ''))

    if (ask.includes('correct') || ask.includes('answer')) {
      return `The correct answer is "${correctAnswer}". ${explanation || 'It best matches the main idea from your notes.'}`
    }

    if (ask.includes('simple') || ask.includes('easy') || ask.includes('why') || ask.includes('explain')) {
      return `In simple words, "${correctAnswer}" is the right choice. ${explanation || 'Look for the option that matches the key concept in the question.'}`
    }

    return `This question is mainly about the idea behind "${correctAnswer}". ${explanation || 'Ask me to explain it in simpler words or compare the options one by one.'}`
  }

  return 'I can help with normal study doubts too. Ask me any topic or concept, and I will explain it in simple exam-friendly English.'
}

app.post('/api/generate-quiz', async (request, response) => {
  const sourceText = cleanText(String(request.body?.sourceText ?? ''))
  const options = request.body?.options ?? {}
  const metadata = request.body?.metadata ?? {}
  const topicOnly = cleanText(String(metadata.inputMode ?? '')) === 'topic'
  const hasEnoughMaterial = sourceText.length >= 120

  // Strip PPTX artifacts + book front-matter (author, ISBN, publisher, copyright, TOC)
  const cleanedText = stripBookMetadata(stripPptxArtifacts(sourceText))
  const fallbackQuiz = hasEnoughMaterial
    ? buildFallbackQuiz(cleanedText, options, metadata)
    : buildTopicFallbackQuiz(sourceText, options, metadata)

  if (!hasEnoughMaterial && !topicOnly) {
    response.status(400).json({
      message: 'Please paste more text, upload a file or image, or type a clear exam topic to continue.',
    })
    return
  }

  try {
    const generationText = hasEnoughMaterial ? cleanedText : buildTopicSource(sourceText, options, metadata)
    const quiz = await generateWithOpenAI(generationText, options, metadata, fallbackQuiz)
    response.json(quiz)
  } catch (err) {
    console.error('[AI error]', err?.message ?? err)
    response.json({
      ...fallbackQuiz,
      sourceType: openai ? 'Local fallback after AI error' : fallbackQuiz.sourceType,
    })
  }
})

app.post('/api/chat', async (request, response) => {
  const { context, userMessage } = request.body
  if (!userMessage?.trim()) {
    response.status(400).json({ message: 'Message required.' })
    return
  }

  if (!openai) {
    response.json({ reply: buildLocalChatReply(context, userMessage) })
    return
  }

  const hasContext = context && context.question
  const opts = hasContext ? (context.options ?? []).map((o, i) => `${String.fromCharCode(65 + i)}) ${o}`).join('\n') : ''
  const prompt = hasContext
    ? `You are a friendly exam tutor helping a student with one quiz question.

Q: "${context.question}"
Options:
${opts}
Correct Answer: ${context.options?.[context.answerIndex] ?? ''}
Explanation: ${context.explanation ?? ''}

Student asks: "${userMessage}"

Rules:
- Explain in simple English.
- Be correct, calm, and easy to follow.
- Use 3 to 5 short sentences.
- If useful, say the correct answer clearly.
- If a hard word appears, explain it simply.
- Focus on helping the student understand fast.`
    : `You are a friendly quiz and study assistant.

Student asks: "${userMessage}"

Rules:
- Reply in simple English.
- Be helpful for both question-specific and normal study doubts.
- Use 3 to 5 short sentences.
- If useful, give one tiny example.
- Avoid long theory unless the student asks for detail.`

  try {
    const completion = await openai.chat.completions.create({
      model,
      messages: [{ role: 'user', content: prompt }],
      temperature: 0.7,
      max_tokens: 350,
      extra_body: { chat_template_kwargs: { thinking: false } },
    })
    response.json({ reply: completion.choices[0]?.message?.content ?? 'No response.' })
  } catch (err) {
    console.error('[Chat error]', err?.message ?? err)
    response.status(500).json({ reply: buildLocalChatReply(context, userMessage) })
  }
})

if (fs.existsSync(distPath)) {
  app.use(express.static(distPath))
  app.use((_request, response) => {
    response.sendFile(path.join(distPath, 'index.html'))
  })
}

app.listen(port, () => {
  console.log(`Quiz server running on http://localhost:${port}`)
})
