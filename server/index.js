import cors from 'cors'
import dotenv from 'dotenv'
import express from 'express'
import fs from 'node:fs'
import path from 'node:path'
import OpenAI from 'openai'

dotenv.config({ override: true })

const app = express()
const port = Number.parseInt(process.env.PORT ?? '8787', 10)
const model = process.env.OPENAI_MODEL ?? 'deepseek-ai/deepseek-r1'
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
    .replace(/Slide\s+\d+\s*:\s*/gi, '')
    .replace(/\b(Lab Activity|Assisted Lab|Learning Objective[s]?|Review Question[s]?)\b[:\s]*/gi, '')
    .replace(/\s+/g, ' ')
    .trim()
}

function clampText(text, maxLength = 10000) {
  return text.length > maxLength ? `${text.slice(0, maxLength)}...` : text
}

function extractJson(rawText) {
  // Strip <think>...</think> reasoning blocks produced by kimi-k2, deepseek-r1, etc.
  let cleaned = rawText.replace(/<think>[\s\S]*?<\/think>/gi, '').trim()
  // Strip markdown code fences  (```json ... ```)
  cleaned = cleaned.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '').trim()
  const start = cleaned.indexOf('{')
  const end = cleaned.lastIndexOf('}')
  if (start === -1 || end === -1 || end <= start) return null
  try {
    return JSON.parse(cleaned.slice(start, end + 1))
  } catch {
    return null
  }
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

function buildCandidates(safeSentences) {
  const candidates = []
  for (const sentence of safeSentences) {
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

    // General: pick a prominent noun phrase as the answer
    const nouns = sentence.match(/[A-Z][a-z]{3,}/g)
    if (nouns && nouns.length >= 2) {
      const noun = nouns[0]
      const rest = sentence.replace(noun, '').trim()
      if (rest.length > 20) {
        candidates.push({ question: `Which of the following correctly describes "${noun}"?`, answer: sentence.slice(0, 90), sentence })
      }
    }
  }
  return candidates
}

function buildFallbackQuiz(sourceText, options, metadata) {
  const sentences = splitSentences(sourceText)
  const keywords = collectKeywords(sourceText)
  const count = Math.min(Math.max(Number(options.questionCount) || 8, 5), 15)
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

function normalizeQuiz(payload, fallbackQuiz) {
  if (!payload || typeof payload !== 'object') {
    return fallbackQuiz
  }

  const questions = Array.isArray(payload.questions) ? payload.questions : []
  if (questions.length === 0) {
    return fallbackQuiz
  }

  return {
    title: typeof payload.title === 'string' ? payload.title : fallbackQuiz.title,
    flashSummary:
      Array.isArray(payload.flashSummary) && payload.flashSummary.length > 0
        ? payload.flashSummary.map((item) => String(item)).slice(0, 5)
        : fallbackQuiz.flashSummary,
    questions: questions.slice(0, fallbackQuiz.questions.length).map((question, index) => {
      const fallbackQuestion = fallbackQuiz.questions[index]
      const optionsList = Array.isArray(question.options)
        ? question.options.map((option) => String(option)).slice(0, 4)
        : fallbackQuestion.options
      const answerIndex =
        typeof question.answerIndex === 'number' && question.answerIndex >= 0 && question.answerIndex < optionsList.length
          ? question.answerIndex
          : fallbackQuestion.answerIndex

      return {
        id: `ai-${index + 1}`,
        question: typeof question.question === 'string' ? question.question : fallbackQuestion.question,
        options: optionsList.length >= 4 ? optionsList : fallbackQuestion.options,
        answerIndex,
        explanation:
          typeof question.explanation === 'string' ? question.explanation : fallbackQuestion.explanation,
        difficulty:
          question.difficulty === 'easy' || question.difficulty === 'medium' || question.difficulty === 'hard'
            ? question.difficulty
            : fallbackQuestion.difficulty,
        sourceHint:
          typeof question.sourceHint === 'string' ? question.sourceHint : fallbackQuestion.sourceHint,
        sourceExcerpt:
          typeof question.sourceExcerpt === 'string' && answerSupportedByExcerpt(optionsList[answerIndex], question.sourceExcerpt)
            ? shortenExcerpt(question.sourceExcerpt)
            : fallbackQuestion.sourceExcerpt,
      }
    }),
    sourceType: 'OpenAI generated',
  }
}

async function generateWithOpenAI(sourceText, options, metadata, fallbackQuiz) {
  if (!openai) {
    return fallbackQuiz
  }

  const examTypeLabel = {
    mcq: 'standard multiple-choice questions',
    scenario: 'scenario-based questions (give a real-world situation, then ask)',
    mixed: 'mix of standard MCQs and scenario-based questions (roughly 50/50)',
  }[options.examType] ?? 'standard multiple-choice questions'

  const prompt = `You are an expert exam coach. Build an exam-prep quiz from the material below.
Return ONLY valid JSON — no extra text, no markdown fences.

{
  "title": "string",
  "flashSummary": ["string","string","string"],
  "questions": [
    {
      "question": "string",
      "options": ["string","string","string","string"],
      "answerIndex": 0,
      "explanation": "string (max 2 sentences, clear and direct)",
      "difficulty": "easy"|"medium"|"hard",
      "sourceHint": "string",
      "sourceExcerpt": "string"
    }
  ]
}

Rules:
- Exactly ${fallbackQuiz.questions.length} questions.
- Question style: ${examTypeLabel}.
- Difficulty: ${options.difficultyMix}.${options.examName ? `\n- Subject/context: ${options.examName} — frame questions appropriately for this subject.` : ''}
- Distractors must be plausible — not obviously wrong.
- Explanations: short, direct, no filler.
- Every question must include "sourceExcerpt" copied from the material.
- The correct answer must be directly supported by "sourceExcerpt".
- If support is weak, skip that fact and choose a better-supported one.
- Do NOT reference slide numbers or page numbers in questions.
- Only use facts from the material below.

Material:
${clampText(sourceText)}`

  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), 120000)
  let completion
  try {
    completion = await openai.chat.completions.create(
      {
        model,
        messages: [{ role: 'user', content: prompt }],
        temperature: 0.55,
        max_tokens: 6000,
        extra_body: { chat_template_kwargs: { thinking: false } },
      },
      { signal: controller.signal },
    )
  } finally {
    clearTimeout(timeout)
  }

  const rawText = completion.choices[0]?.message?.content?.trim()
  if (!rawText) return fallbackQuiz

  const parsed = extractJson(rawText)
  if (!parsed) {
    console.error('[AI error] Could not extract JSON from response. Raw (first 400 chars):', rawText.slice(0, 400))
    return fallbackQuiz
  }
  return normalizeQuiz(parsed, fallbackQuiz)
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

  if (sourceText.length < 120) {
    response.status(400).json({
      message: 'Please provide a bit more study material so the quiz can be meaningful.',
    })
    return
  }

  // Strip PPTX "Slide N:" artifacts before building fallback so questions don't ask about "Slide"
  const cleanedText = stripPptxArtifacts(sourceText)
  const fallbackQuiz = buildFallbackQuiz(cleanedText, options, metadata)

  try {
    const quiz = await generateWithOpenAI(sourceText, options, metadata, fallbackQuiz)
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
