import cors from 'cors'
import dotenv from 'dotenv'
import express from 'express'
import fs from 'node:fs'
import path from 'node:path'
import OpenAI from 'openai'

dotenv.config({ override: true })

const app = express()
const port = Number.parseInt(process.env.PORT ?? '8787', 10)
// Primary model (set via OPENAI_MODEL env var on Render/server).
// FAST_MODEL is the guaranteed-fast fallback used when the primary times out.
const model = process.env.OPENAI_MODEL ?? 'meta/llama-3.1-8b-instruct'
const FAST_MODEL = 'meta/llama-3.1-8b-instruct'
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

// Detects an option that is a raw sentence fragment rather than a concise MCQ answer
function isFragmentOption(o) {
  if (!o || o.length < 3) return false
  // Ends with a dangling preposition or conjunction — always a cut-off sentence
  if (/\s(of|on|in|at|to|from|by|for|with|and|or|the|a|an|that|this|these|those|are|is|be|been|its|it)$/i.test(o)) return true
  // Ends mid-word: trailing 1-2 lone letters
  if (/\s[a-z]{1,2}$/.test(o)) return true
  // Starts with essay-instruction verbs — these are prompts, not answer choices
  if (/^(discuss|explain|describe|list|identify|outline|compare|contrast|analyze|evaluate|state|define)\b/i.test(o)) return true
  // Phrased as a question (options should never be questions)
  if (/^(where|when|what|why|how|which|who)\b/i.test(o)) return true
  // Over 60 chars with no terminal punctuation = raw sentence fragment
  if (o.length > 60 && !/[.!?:)]$/.test(o)) return true
  return false
}

// Detects a bad question stem
function isBadQuestion(q) {
  if (!q || q.length < 15) return true
  // Too short to be meaningful
  if (q.length < 20) return true
  // Generic "which statement" questions
  if (/which (statement|of the following).*(correct|true|best|applies)/i.test(q)) return true
  // Questions that are clearly material text dressed up as a question
  if (/^what are more/i.test(q)) return true
  if (/review this concept/i.test(q)) return true
  // Sentence fragments used as questions (ends without "?" or ends in lowercase mid-sentence)
  if (!/\?$/.test(q) && /[a-z]$/.test(q) && q.split(' ').length < 6) return true
  return false
}

// Returns true if AI quiz looks like real questions (not slide-text garbage)
function isGoodQuiz(quiz) {
  if (!quiz?.questions?.length) return false
  const bad = quiz.questions.filter((q) => {
    const badQ = isBadQuestion(q.question)
    const fragmentOpts = (q.options ?? []).filter(isFragmentOption).length
    return badQ || fragmentOpts >= 2
  }).length
  return bad < quiz.questions.length * 0.25  // tighter: reject if >25% are bad
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
    const cand = pool[index % pool.length] ?? { question: `What is a key idea in ${options.examName || 'this topic'}?`, answer: keywords[0] ?? 'concept', sentence: safeSentences[0] ?? '' }

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
    // Use keywords as filler rather than "Option N" placeholders
    const kwExtra = keywords.filter(k => !distractors.includes(cap(k))).map(cap)
    let xi = 0
    while (distractors.length < 3) distractors.push(kwExtra[xi++] ?? keywords[xi] ?? 'Other concept')

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

function shuffleOptions(opts, answerIndex) {
  // Fisher-Yates shuffle, tracking where the correct answer lands
  const arr = opts.map((text, i) => ({ text, correct: i === answerIndex }))
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]]
  }
  return {
    options: arr.map((o) => o.text),
    answerIndex: arr.findIndex((o) => o.correct),
  }
}

// Returns a normalized quiz object on success, or null if the AI output is unusable.
// Never returns the fallback — caller decides what to do with null.
function normalizeQuiz(payload, requestedCount, difficulty) {
  if (!payload || typeof payload !== 'object') return null
  const rawQs = Array.isArray(payload.questions) ? payload.questions : []
  if (rawQs.length === 0) return null

  const diff = difficulty ?? 'medium'

  const questions = rawQs
    .slice(0, requestedCount)
    .map((q, i) => {
      if (!q || typeof q !== 'object') return null
      const opts = Array.isArray(q.options)
        ? q.options.map((o) => String(o).trim().slice(0, 200)).slice(0, 4)
        : []
      if (opts.length < 4) return null
      if (opts.filter(isFragmentOption).length >= 2) return null
      const ai = typeof q.answerIndex === 'number' && q.answerIndex >= 0 && q.answerIndex < opts.length
        ? q.answerIndex : 0
      const { options: shuffledOpts, answerIndex: shuffledAi } = shuffleOptions(opts, ai)
      const questionText = typeof q.question === 'string' && !isBadQuestion(q.question) ? q.question : null
      if (!questionText) return null
      return {
        id: `ai-${i + 1}`,
        question: questionText,
        options: shuffledOpts,
        answerIndex: shuffledAi,
        explanation: typeof q.explanation === 'string' ? q.explanation : '',
        difficulty: ['easy', 'medium', 'hard'].includes(q.difficulty) ? q.difficulty : diff,
        sourceHint: typeof q.sourceHint === 'string' ? q.sourceHint : '',
        sourceExcerpt:
          typeof q.sourceExcerpt === 'string' && answerSupportedByExcerpt(shuffledOpts[shuffledAi], q.sourceExcerpt)
            ? shortenExcerpt(q.sourceExcerpt)
            : '',
      }
    })
    .filter(Boolean)

  if (questions.length === 0) return null
  return {
    title: typeof payload.title === 'string' ? payload.title : 'Quiz',
    flashSummary: Array.isArray(payload.flashSummary) && payload.flashSummary.length > 0
      ? payload.flashSummary.map(String).slice(0, 5) : [],
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

  return `You are an expert exam question writer. Output ONLY valid JSON, no other text.

JSON format (strict):
{"title":"string","flashSummary":["tip1","tip2","tip3"],"questions":[{"question":"string","options":["A","B","C","D"],"answerIndex":0,"explanation":"string","difficulty":"medium","sourceHint":"string","sourceExcerpt":"string"}]}

RULES — read every rule before writing:
1. Exactly ${count} questions. Style: ${examTypeLabel}. Difficulty: ${options.difficultyMix}.${options.examName ? ` Topic: ${options.examName}.` : ''}
2. Every question MUST be a complete, specific sentence ending with "?". It must name the concept, command, term, or scenario being tested.
3. Every option MUST be a short, standalone fact or term — 3 to 50 characters, NO trailing prepositions (of/in/on/to/from/by/the/a/an/that), NO trailing single letters.
4. Options must NEVER be copied raw from the material. Distill them into crisp answer phrases.
5. Options must NEVER be phrased as a question or start with Discuss/Explain/Describe/List/Identify.
6. answerIndex = index (0–3) of the ONE correct option. Distractors are plausible but wrong.
7. explanation: 1–2 factual sentences explaining WHY the answer is correct.
8. sourceExcerpt: ≤80 chars copied verbatim from the material that supports the answer (or "" if none).
9. NEVER ask about book title, author name, ISBN, publisher, slide number, or course code.
10. ${topicOnly ? 'Use your own knowledge of the topic.' : 'Base every question on facts from the material below — no invented facts.'}${options.customPrompt ? `\n11. Additional instructions: ${options.customPrompt}` : ''}

BAD example (NEVER do this):
{"question":"What are more shortcuts?","options":["Discuss the fact that the above steps are the minimum capabilities of","Available","minimum text-editing skill","no GUI installed on the system in question"]}

GOOD example (always do this):
{"question":"Which command opens a file for editing in vi?","options":["vi filename","nano filename","edit filename","open filename"],"answerIndex":0}

Material:
${clampText(sourceText, inputLimit)}`
}

async function callAI(prompt, maxTokens, timeoutMs = 75000, useModel = model) {
  const controller = new AbortController()
  const tid = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const completion = await openai.chat.completions.create(
      { model: useModel, messages: [{ role: 'user', content: prompt }], temperature: 0.45, max_tokens: maxTokens },
      { signal: controller.signal },
    )
    return completion.choices[0]?.message?.content?.trim() ?? ''
  } finally {
    clearTimeout(tid)
  }
}

// Generate one chunk of questions. Tries primary model first (30s), then fast model (60s).
async function generateChunk(sourceText, options, metadata, chunkSize, inputLimit, topicOnly) {
  const diff = options.difficultyMix ?? 'medium'
  const maxTokens = Math.min(chunkSize * 380 + 600, 8000)
  const prompt = buildPrompt(sourceText, options, chunkSize, inputLimit, topicOnly)

  // Try primary model with short timeout first
  try {
    const rawText = await callAI(prompt, maxTokens, 30000, model)
    if (rawText) {
      const parsed = extractJson(rawText) ?? repairJson(rawText)
      if (parsed) {
        const quiz = normalizeQuiz(parsed, chunkSize, diff)
        if (quiz?.questions?.length) return quiz.questions
      }
    }
  } catch { /* fall through to fast model */ }

  // Primary timed out or returned garbage — retry with guaranteed-fast model
  if (model !== FAST_MODEL) {
    console.log(`[chunk] primary model slow/failed, retrying with ${FAST_MODEL}`)
    try {
      const rawText = await callAI(prompt, maxTokens, 60000, FAST_MODEL)
      if (rawText) {
        const parsed = extractJson(rawText) ?? repairJson(rawText)
        if (parsed) {
          const quiz = normalizeQuiz(parsed, chunkSize, diff)
          if (quiz?.questions?.length) return quiz.questions
        }
      }
    } catch (err) {
      console.error('[chunk fast-model error]', err?.message ?? err)
    }
  }
  return []
}

async function generateWithOpenAI(sourceText, options, metadata) {
  if (!openai) throw new Error('AI service is not configured on this server.')

  const topicOnly = cleanText(String(metadata.inputMode ?? '')) === 'topic'
  const totalCount = Math.min(Math.max(Number(options.questionCount) || 8, 5), 50)
  const diff = options.difficultyMix ?? 'medium'
  const inputLimit = Math.min(Math.max(totalCount * 250, 4000), 12000)

  // Split into chunks of 10 and fire in parallel — 30 questions = 3 simultaneous calls
  const CHUNK = 10
  const chunks = []
  for (let i = 0; i < totalCount; i += CHUNK) {
    chunks.push(Math.min(CHUNK, totalCount - i))
  }

  console.log(`[AI] Generating ${totalCount} questions in ${chunks.length} parallel chunk(s) of ${CHUNK}`)
  const startMs = Date.now()

  const chunkResults = await Promise.all(
    chunks.map(size => generateChunk(sourceText, options, metadata, size, inputLimit, topicOnly))
  )

  // Flatten, re-id, deduplicate by question text
  let allQuestions = chunkResults.flat()
  const seen = new Set()
  allQuestions = allQuestions
    .filter(q => { const key = q.question.toLowerCase().slice(0, 60); if (seen.has(key)) return false; seen.add(key); return true })
    .slice(0, totalCount)
    .map((q, i) => ({ ...q, id: `ai-${i + 1}` }))

  console.log(`[AI] Got ${allQuestions.length}/${totalCount} questions in ${Date.now() - startMs}ms`)

  if (allQuestions.length >= Math.ceil(totalCount * 0.6)) {
    // Have at least 60% of requested count — good enough, return it
    const quiz = {
      title: options.examName ? `${options.examName} Quiz` : 'Quiz',
      flashSummary: [],
      questions: allQuestions,
      sourceType: 'AI generated',
    }
    if (isGoodQuiz(quiz)) return quiz
  }

  // Fallback: single attempt with shorter input if chunks failed badly
  console.log('[AI] Chunks insufficient, trying single full-count attempt...')
  const maxTokens = Math.min(totalCount * 380 + 800, 12000)
  try {
    const prompt = buildPrompt(sourceText, options, totalCount, 4000, topicOnly)
    const rawText = await callAI(prompt, maxTokens, 90000, FAST_MODEL)
    if (rawText) {
      const parsed = extractJson(rawText) ?? repairJson(rawText)
      if (parsed) {
        const quiz = normalizeQuiz(parsed, totalCount, diff)
        if (quiz && isGoodQuiz(quiz)) return quiz
      }
    }
  } catch (err) {
    console.error('[AI] Single attempt error:', err?.message ?? err)
  }

  throw new Error('Quiz generation failed. Please try again.')
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

  if (!hasEnoughMaterial && !topicOnly) {
    response.status(400).json({
      message: 'Please paste more text, upload a file or image, or type a clear exam topic to continue.',
    })
    return
  }

  // Strip PPTX artifacts + book front-matter before sending to AI
  const cleanedText = stripBookMetadata(stripPptxArtifacts(sourceText))
  const generationText = hasEnoughMaterial ? cleanedText : buildTopicSource(sourceText, options, metadata)

  try {
    const quiz = await generateWithOpenAI(generationText, options, metadata)
    response.json(quiz)
  } catch (err) {
    console.error('[AI error]', err?.message ?? err)
    response.status(503).json({ message: 'The AI couldn\'t generate questions right now. Please try again in a moment.' })
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
