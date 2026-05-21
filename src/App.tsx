import { type ChangeEvent, type DragEvent, useEffect, useMemo, useRef, useState } from 'react'
import './App.css'
import { extractTextFromFile } from './lib/fileParsers'
import type { Difficulty, QuizPayload, QuizQuestion } from './types'

type Step = 'upload' | 'configure' | 'quiz' | 'results'
type ExamType = 'mcq' | 'scenario' | 'mixed'
type MascotMood = 'idle' | 'ready' | 'thinking' | 'correct' | 'wrong' | 'celebrate' | 'sad'
type ChatMessage = { role: 'user' | 'ai'; text: string }

type QuizForm = {
  examName: string
  examType: ExamType
  questionCount: number
  difficultyMix: Difficulty
  learnerGoal: string
}

type AnswerState = Record<string, number>

const initialForm: QuizForm = {
  examName: '',
  examType: 'mcq',
  questionCount: 8,
  difficultyMix: 'medium',
  learnerGoal: 'Fast revision with memorable explanations.',
}

const examTypeOptions = [
  { id: 'university', label: 'University Exam' },
  { id: 'government', label: 'Government Exam' },
  { id: 'school', label: 'School Exam' },
  { id: 'practice', label: 'Practice Test' },
  { id: 'certification', label: 'Certification Exam' },
  { id: 'other', label: 'Other' },
]

const modes = [
  { id: 'rapid', title: 'Rapid Review', desc: 'Short, sharp MCQs for fast revision.' },
  { id: 'story', title: 'Story Coach', desc: 'Concepts explained like a friendly tutor.' },
  { id: 'challenge', title: 'Exam Pressure', desc: 'Tough distractors with full review.' },
]

const journeySteps = ['Upload', 'Tune', 'Practice', 'Review']

const heroHighlights = [
  {
    title: 'Upload once',
    text: 'Turn PDFs, PPTX decks, and copied notes into one clean practice stream.',
  },
  {
    title: 'Practice actively',
    text: 'Replace passive reading with quick recall and answer-driven learning.',
  },
  {
    title: 'Understand faster',
    text: 'Get instant explanations whenever a concept feels confusing.',
  },
  {
    title: 'Source grounded',
    text: 'Each answer can be checked against the uploaded notes for safer end-term revision.',
  },
]

const audienceBands = [
  { title: 'Class 5 to 10', text: 'Simple practice, colorful flow, and easy explanations.' },
  { title: 'Intermediate', text: 'Quick recall, chapter practice, and exam-friendly revision.' },
  { title: 'Degree & BTech', text: 'Source-based MCQs, tighter distractors, and concept review.' },
]

const landingJourney = [
  { title: '1. Upload Notes', text: 'Add a PDF, PPTX, or text in one tap and let the app clean it up.' },
  { title: '2. Build a Quiz', text: 'Get source-grounded MCQs with better options and short explanations.' },
  { title: '3. Learn Fast', text: 'Check answers, review mistakes, and ask the helper for simple explanations.' },
]

const landingTrust = [
  { title: 'Built for exams', text: 'Works for school tests, university internals, government prep, and practice sessions.' },
  { title: 'Friendly by design', text: 'Playful visuals, animated helpers, and low-stress practice make studying easier.' },
  { title: 'Safer revision', text: 'Answers now show proof from your notes so you can cross-check important facts.' },
]

const LETTERS = ['A', 'B', 'C', 'D', 'E', 'F']
const CONFETTI = ['#5b5ef4', '#f59e0b', '#16a34a', '#ef4444', '#8b5cf6', '#0ea5e9', '#f472b6']

const BUBBLE: Record<MascotMood, string> = {
  idle: 'Ready when you are.',
  ready: 'I am watching this question with you.',
  thinking: 'Building your quiz...',
  correct: 'Nice answer!',
  wrong: 'Let us fix this one.',
  celebrate: 'That was excellent!',
  sad: 'A few more rounds will help.',
}

function Mascot({ mood, compact = false }: { mood: MascotMood; compact?: boolean }) {
  const happy = mood === 'correct' || mood === 'celebrate'
  const sad = mood === 'wrong' || mood === 'sad'
  const think = mood === 'thinking'

  return (
    <div className={`mascot-wrap mascot--${mood}${compact ? ' mascot-wrap--compact' : ''}`}>
      <svg className="mascot-svg" viewBox="0 0 100 138" width={compact ? '104' : '148'} xmlns="http://www.w3.org/2000/svg">
        <ellipse cx="50" cy="44" rx="29" ry="27" fill="#3d2b1f" />
        <ellipse cx="50" cy="50" rx="23" ry="23" fill="#fcd5ae" />
        <path d="M27 40 Q31 24 50 22 Q69 24 73 40 Q62 30 50 32 Q38 30 27 40z" fill="#3d2b1f" />
        <circle cx="26" cy="32" r="9" fill="#3d2b1f" />
        <circle cx="74" cy="32" r="9" fill="#3d2b1f" />
        <circle cx="23" cy="29" r="2.5" fill="#5a3e30" opacity="0.5" />
        <circle cx="71" cy="29" r="2.5" fill="#5a3e30" opacity="0.5" />
        {happy ? (
          <>
            <path d="M40 48 Q43 44 46 48" stroke="#3d2b1f" strokeWidth="2.2" fill="none" strokeLinecap="round" />
            <path d="M54 48 Q57 44 60 48" stroke="#3d2b1f" strokeWidth="2.2" fill="none" strokeLinecap="round" />
          </>
        ) : sad ? (
          <>
            <path d="M40 46 Q43 50 46 46" stroke="#3d2b1f" strokeWidth="2.2" fill="none" strokeLinecap="round" />
            <path d="M54 46 Q57 50 60 46" stroke="#3d2b1f" strokeWidth="2.2" fill="none" strokeLinecap="round" />
          </>
        ) : (
          <>
            <circle cx="43" cy="48" r="3.8" fill="#3d2b1f" />
            <circle cx="57" cy="48" r="3.8" fill="#3d2b1f" />
            <circle cx="44.4" cy="46.6" r="1.4" fill="white" />
            <circle cx="58.4" cy="46.6" r="1.4" fill="white" />
          </>
        )}
        <ellipse cx="37" cy="55" rx="5" ry="3" fill="#f87171" opacity="0.28" />
        <ellipse cx="63" cy="55" rx="5" ry="3" fill="#f87171" opacity="0.28" />
        {happy && <path d="M43 57 Q50 64 57 57" stroke="#c0785a" strokeWidth="2" fill="none" strokeLinecap="round" />}
        {sad && <path d="M43 61 Q50 56 57 61" stroke="#c0785a" strokeWidth="2" fill="none" strokeLinecap="round" />}
        {think && <path d="M44 59 Q50 59 56 59" stroke="#c0785a" strokeWidth="2" fill="none" strokeLinecap="round" />}
        {!happy && !sad && !think && (
          <path d="M43 59 Q50 63 57 59" stroke="#c0785a" strokeWidth="1.8" fill="none" strokeLinecap="round" />
        )}
        <path d="M31 80 Q31 73 50 73 Q69 73 69 80 L71 118 Q71 121 50 121 Q29 121 29 118Z" fill="#5b5ef4" />
        <path d="M44 73 L50 82 L56 73" fill="white" opacity="0.9" />
        <path d="M31 82 Q19 84 17 97 Q16 102 22 102 L29 101 Q31 90 33 83Z" fill="#5b5ef4" />
        <ellipse cx="20" cy="106" rx="6" ry="5.5" fill="#fcd5ae" />
        <path d="M69 82 Q81 84 83 97 Q84 102 78 102 L71 101 Q69 90 67 83Z" fill="#5b5ef4" />
        <ellipse cx="80" cy="106" rx="6" ry="5.5" fill="#fcd5ae" />
        <rect x="10" y="93" width="19" height="24" rx="2.5" fill="#f59e0b" />
        <rect x="11.5" y="93" width="3" height="24" fill="#d97706" />
        <line x1="16" y1="98" x2="28" y2="98" stroke="#d97706" strokeWidth="0.9" />
        <line x1="16" y1="102" x2="28" y2="102" stroke="#d97706" strokeWidth="0.9" />
        <line x1="16" y1="106" x2="28" y2="106" stroke="#d97706" strokeWidth="0.9" />
        <path d="M29 114 Q29 134 40 136 Q50 137 60 136 Q71 134 71 114Z" fill="#6366f1" />
        {mood === 'celebrate' && (
          <>
            <text x="76" y="36" fontSize="15">⭐</text>
            <text x="4" y="48" fontSize="12">✨</text>
            <text x="80" y="70" fontSize="11">🌟</text>
          </>
        )}
        {think && (
          <>
            <circle cx="72" cy="30" r="2.5" fill="var(--accent)" opacity="0.7" />
            <circle cx="78" cy="23" r="3.5" fill="var(--accent)" opacity="0.6" />
            <circle cx="86" cy="14" r="5" fill="var(--accent)" opacity="0.5" />
          </>
        )}
      </svg>
      <div className="mascot-bubble">{BUBBLE[mood]}</div>
    </div>
  )
}

export function BikeProgress({
  progress,
  current,
  total,
  onAsk,
}: {
  progress: number
  current: number
  total: number
  onAsk?: () => void
}) {
  const riderPosition = Math.max(4, Math.min(92, progress))
  const stops = Array.from({ length: total }, (_, index) => ({
    left: total === 1 ? 50 : (index / Math.max(total - 1, 1)) * 100,
    collected: index + 1 < current,
    active: index + 1 === current,
  }))

  return (
    <div className="bike-track-wrap" aria-hidden>
      <div className="bike-track-road">
        {/* lane dashes */}
        <div className="bike-lane-line" />
        <div className="bike-track-fill" style={{ width: `${progress}%` }} />
        {stops.map((stop, index) => (
          <div
            key={index}
            className={`bike-token${stop.collected ? ' collected' : ''}${stop.active ? ' active' : ''}`}
            style={{ left: `${stop.left}%` }}
          >
            {stop.collected ? '★' : stop.active ? '✦' : '•'}
          </div>
        ))}
        <div
          className={`bike-rider${onAsk ? ' bike-rider--askable' : ''}`}
          style={{ left: `${riderPosition}%` }}
          onClick={onAsk}
          title={onAsk ? 'Click for AI help!' : undefined}
        >
          {onAsk && <div className="bike-rider-ask">?</div>}
          <div className="bike-rider-shadow" />
          <div className="bike-rider-spark bike-rider-spark--one" />
          <div className="bike-rider-spark bike-rider-spark--two" />
          <svg viewBox="0 0 180 100" className="bike-rider-svg" xmlns="http://www.w3.org/2000/svg">
            <defs>
              <linearGradient id="bikeBodyGrad" x1="0%" y1="0%" x2="100%" y2="100%">
                <stop offset="0%" stopColor="#a5b4fc" />
                <stop offset="50%" stopColor="#5b5ef4" />
                <stop offset="100%" stopColor="#312e81" />
              </linearGradient>
              <linearGradient id="bikeMetalGrad" x1="0%" y1="0%" x2="0%" y2="100%">
                <stop offset="0%" stopColor="#f0f4ff" />
                <stop offset="100%" stopColor="#c7d2fe" />
              </linearGradient>
              <radialGradient id="tyreShin" cx="35%" cy="30%" r="55%">
                <stop offset="0%" stopColor="rgba(255,255,255,0.14)" />
                <stop offset="100%" stopColor="rgba(255,255,255,0)" />
              </radialGradient>
            </defs>

            {/* ── speed blur lines ── */}
            <path d="M32 62 L8 56"  stroke="rgba(124,140,255,0.55)" strokeWidth="2.4" strokeLinecap="round" strokeDasharray="6 5" />
            <path d="M28 70 L4 68"  stroke="rgba(124,140,255,0.35)" strokeWidth="1.8" strokeLinecap="round" strokeDasharray="4 6" />
            <path d="M35 75 L14 76" stroke="rgba(124,140,255,0.25)" strokeWidth="1.4" strokeLinecap="round" strokeDasharray="3 7" />

            {/* ── rear wheel ── */}
            <g className="bike-wheel bike-wheel--rear">
              {/* tyre */}
              <circle cx="50" cy="68" r="21" fill="#1a1b35" />
              <circle cx="50" cy="68" r="21" fill="url(#tyreShin)" />
              {/* rim */}
              <circle cx="50" cy="68" r="16.5" fill="none" stroke="url(#bikeMetalGrad)" strokeWidth="2.5" />
              <circle cx="50" cy="68" r="14.5" fill="rgba(200,210,255,0.07)" />
              {/* 8 spokes */}
              <g className="bike-spokes">
                <line x1="50" y1="47" x2="50" y2="89" />
                <line x1="29" y1="68" x2="71" y2="68" />
                <line x1="35.5" y1="53.5" x2="64.5" y2="82.5" />
                <line x1="35.5" y1="82.5" x2="64.5" y2="53.5" />
                <line x1="44" y1="47.7" x2="56" y2="88.3" />
                <line x1="29.7" y1="62" x2="70.3" y2="74" />
              </g>
              {/* hub */}
              <circle cx="50" cy="68" r="5.8" fill="url(#bikeMetalGrad)" stroke="rgba(91,94,244,0.3)" strokeWidth="1.2" />
              <circle cx="50" cy="68" r="2.6" fill="#1a1b35" />
            </g>

            {/* ── front wheel ── */}
            <g className="bike-wheel bike-wheel--front">
              {/* tyre */}
              <circle cx="132" cy="68" r="21" fill="#1a1b35" />
              <circle cx="132" cy="68" r="21" fill="url(#tyreShin)" />
              {/* rim */}
              <circle cx="132" cy="68" r="16.5" fill="none" stroke="url(#bikeMetalGrad)" strokeWidth="2.5" />
              <circle cx="132" cy="68" r="14.5" fill="rgba(200,210,255,0.07)" />
              {/* 8 spokes */}
              <g className="bike-spokes">
                <line x1="132" y1="47" x2="132" y2="89" />
                <line x1="111" y1="68" x2="153" y2="68" />
                <line x1="117.5" y1="53.5" x2="146.5" y2="82.5" />
                <line x1="117.5" y1="82.5" x2="146.5" y2="53.5" />
                <line x1="126" y1="47.7" x2="138" y2="88.3" />
                <line x1="111.7" y1="62" x2="152.3" y2="74" />
              </g>
              {/* hub */}
              <circle cx="132" cy="68" r="5.8" fill="url(#bikeMetalGrad)" stroke="rgba(91,94,244,0.3)" strokeWidth="1.2" />
              <circle cx="132" cy="68" r="2.6" fill="#1a1b35" />
              {/* headlight */}
              <ellipse cx="152" cy="62" rx="5" ry="3.5" fill="#fef08a" opacity="0.9" />
              <ellipse cx="153" cy="62" rx="3" ry="2" fill="white" opacity="0.7" />
            </g>

            {/* ── bike frame ── */}
            <path d="M56 66 L80 66 L102 50 L132 66" stroke="url(#bikeBodyGrad)" strokeWidth="5" fill="none" strokeLinecap="round" strokeLinejoin="round" />
            <path d="M80 66 L90 38" stroke="url(#bikeBodyGrad)" strokeWidth="4.5" fill="none" strokeLinecap="round" />
            <path d="M102 50 L132 66" stroke="url(#bikeBodyGrad)" strokeWidth="4" fill="none" strokeLinecap="round" />
            {/* chainstay */}
            <path d="M68 65 L60 82" stroke="#3730a3" strokeWidth="3.5" strokeLinecap="round" />
            <path d="M120 65 L113 82" stroke="#3730a3" strokeWidth="3.5" strokeLinecap="round" />
            {/* top tube accent */}
            <path d="M80 64 L94 55 L116 58" stroke="rgba(255,255,255,0.55)" strokeWidth="2" fill="none" strokeLinecap="round" />
            {/* seat tube + seat */}
            <path d="M90 38 L87 30" stroke="#1e1b4b" strokeWidth="4" strokeLinecap="round" />
            <path d="M82 29 L93 29" stroke="#1e1b4b" strokeWidth="5" strokeLinecap="round" />
            {/* handlebar stem */}
            <path d="M136 52 L148 40" stroke="#3730a3" strokeWidth="4" strokeLinecap="round" />
            <path d="M145 38 L155 40 L155 48" stroke="#3730a3" strokeWidth="3.8" fill="none" strokeLinecap="round" />
            {/* engine block */}
            <ellipse cx="96" cy="62" rx="16" ry="8.5" fill="rgba(200,210,255,0.18)" stroke="rgba(91,94,244,0.3)" strokeWidth="1.5" />
            {/* chrome line */}
            <path d="M74 52 L128 50" stroke="url(#bikeMetalGrad)" strokeWidth="2.2" strokeLinecap="round" opacity="0.85" />

            {/* ── rider (mascot girl) ── */}
            {/* hair back */}
            <ellipse cx="97" cy="16" rx="12.5" ry="11.5" fill="#3d2b1f" />
            {/* face */}
            <circle cx="97" cy="20" r="10.5" fill="#fcd5ae" />
            {/* hair buns */}
            <circle cx="86" cy="11" r="6" fill="#3d2b1f" />
            <circle cx="108" cy="11" r="6" fill="#3d2b1f" />
            {/* bangs */}
            <path d="M86 13 Q97 4 108 13 Q101 8 97 9 Q93 8 86 13z" fill="#3d2b1f" />
            {/* helmet */}
            <path d="M86 16 Q87 7 97 6 Q107 7 108 16 Q105 11 97 10 Q89 11 86 16z" fill="#5b5ef4" opacity="0.85" />
            {/* visor */}
            <path d="M88 18 Q97 15 106 18" stroke="#312e81" strokeWidth="2" fill="none" strokeLinecap="round" />
            {/* eyes */}
            <circle cx="93.5" cy="21" r="2.2" fill="#3d2b1f" />
            <circle cx="100.5" cy="21" r="2.2" fill="#3d2b1f" />
            <circle cx="94.2" cy="20.2" r="0.9" fill="white" />
            <circle cx="101.2" cy="20.2" r="0.9" fill="white" />
            {/* blush */}
            <ellipse cx="90" cy="23" rx="2.5" ry="1.5" fill="#f87171" opacity="0.3" />
            <ellipse cx="104" cy="23" rx="2.5" ry="1.5" fill="#f87171" opacity="0.3" />
            {/* mouth / smile */}
            <path d="M93 25 Q97 28 101 25" stroke="#c0785a" strokeWidth="1.5" fill="none" strokeLinecap="round" />
            {/* body / jacket */}
            <path d="M91 30 L84 44 L110 44 L115 36 L107 29 Z" fill="url(#bikeBodyGrad)" />
            {/* collar stripe */}
            <path d="M94 30 L97 36 L100 30" fill="white" opacity="0.8" />
            {/* left arm reaching handlebar */}
            <path d="M108 36 L142 40" stroke="#fcd5ae" strokeWidth="5.5" strokeLinecap="round" />
            {/* left leg to pedal */}
            <path d="M87 43 L76 60" stroke="#3d2b1f" strokeWidth="4.5" strokeLinecap="round" />
            {/* right leg */}
            <path d="M93 43 L103 58" stroke="#3d2b1f" strokeWidth="4.5" strokeLinecap="round" />
            {/* shoes */}
            <ellipse cx="73" cy="62" rx="5.5" ry="3.2" fill="#1e1b4b" />
            <ellipse cx="105" cy="60" rx="5.5" ry="3.2" fill="#1e1b4b" />
          </svg>
        </div>
      </div>
    </div>
  )
}

/* ── FLOATING CAT COMPANION ─────────────────────────────────────────────── */
function FloatingCompanion({ question, eatTick }: { question?: QuizQuestion; eatTick?: number }) {
  const svgRef = useRef<SVGSVGElement>(null)
  const posRef = useRef(14)
  const [pupil, setPupil] = useState({ x: 0, y: 0 })
  const [pos, setPos] = useState(14)
  const [moving, setMoving] = useState(false)
  const [facingLeft, setFacingLeft] = useState(false)
  const [paused, setPaused] = useState(false)
  const [chatOpen, setChatOpen] = useState(false)
  const [eating, setEating] = useState(false)
  const [messages, setMessages] = useState<ChatMessage[]>([
    { role: 'ai', text: question ? 'Meow! Ask me about this question — I can explain anything!' : 'Meow! I am your quiz buddy. Ask me anything!' },
  ])
  const [input, setInput] = useState('')
  const [busy, setBusy] = useState(false)
  const endRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    function onMove(e: MouseEvent) {
      if (!svgRef.current) return
      const r = svgRef.current.getBoundingClientRect()
      const cx = r.left + r.width * 0.5
      const cy = r.top + r.height * 0.38
      const dx = e.clientX - cx
      const dy = e.clientY - cy
      const dist = Math.hypot(dx, dy)
      const scale = dist > 0 ? Math.min(2.5 / dist, 0.025) : 0
      setPupil({ x: dx * scale, y: dy * scale })
    }
    window.addEventListener('mousemove', onMove)
    return () => window.removeEventListener('mousemove', onMove)
  }, [])

  useEffect(() => {
    if (paused) return
    const id = window.setInterval(() => {
      const next = Math.floor(8 + Math.random() * 74)
      setFacingLeft(next < posRef.current)
      posRef.current = next
      setPos(next)
      setMoving(true)
    }, 4200)
    return () => window.clearInterval(id)
  }, [paused])

  // Clear walking animation once the CSS transition finishes (3.6s)
  useEffect(() => {
    if (!moving) return
    const id = window.setTimeout(() => setMoving(false), 3700)
    return () => window.clearTimeout(id)
  }, [moving])

  useEffect(() => {
    if (!eatTick) return
    const startId = window.setTimeout(() => setEating(true), 0)
    const endId = window.setTimeout(() => setEating(false), 1100)
    return () => {
      window.clearTimeout(startId)
      window.clearTimeout(endId)
    }
  }, [eatTick])

  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [messages])

  async function sendMessage() {
    const msg = input.trim()
    if (!msg || busy) return
    setMessages((prev) => [...prev, { role: 'user', text: msg }])
    setInput('')
    setBusy(true)
    try {
      const res = await fetch('/api/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          context: question
            ? { question: question.question, options: question.options, answerIndex: question.answerIndex, explanation: question.explanation }
            : null,
          userMessage: msg,
        }),
      })
      const payload = (await res.json()) as { reply?: string }
      setMessages((prev) => [...prev, { role: 'ai', text: payload.reply ?? 'Sorry, no reply came through.' }])
    } catch {
      setMessages((prev) => [...prev, { role: 'ai', text: 'Could not connect right now. Try again in a moment!' }])
    } finally {
      setBusy(false)
    }
  }

  // Negate pupil.x when flipped so eyes track cursor correctly through mirror
  const px = facingLeft ? -pupil.x : pupil.x
  const py = pupil.y

  const isWalking = moving && !paused && !eating

  function handleCatClick() {
    setPaused((p) => {
      if (!p) setMoving(false)
      return !p
    })
  }

  return (
    <div className="companion-root" style={{ '--companion-left': `${pos}%` } as React.CSSProperties}>
      {chatOpen && (
        <div className="companion-panel">
          <div className="companion-panel-hdr">
            <span>🐱 Quiz Buddy</span>
            <button className="ghost-btn" onClick={() => setChatOpen(false)}>✕</button>
          </div>
          {question && (
            <p className="companion-panel-ctx">
              {question.question.length > 72 ? question.question.slice(0, 69) + '…' : question.question}
            </p>
          )}
          <div className="companion-panel-msgs">
            {messages.map((m, i) => (
              <div key={i} className={`companion-bubble companion-bubble--${m.role}`}>
                {m.role === 'ai' && <span className="companion-avatar">🐱</span>}
                <span>{m.text}</span>
              </div>
            ))}
            {busy && (
              <div className="companion-bubble companion-bubble--ai">
                <span className="companion-avatar">🐱</span>
                <span className="ai-typing-dots"><span /><span /><span /></span>
              </div>
            )}
            <div ref={endRef} />
          </div>
          <div className="companion-panel-input">
            <input
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter') void sendMessage() }}
              placeholder="Ask me anything…"
              disabled={busy}
              autoFocus
            />
            <button className="primary-btn ai-send-btn" onClick={() => void sendMessage()} disabled={busy || !input.trim()}>➤</button>
          </div>
        </div>
      )}

      {eating && <div className="companion-nom">nom nom! 🐟</div>}

      <button
        className={`companion-cat${eating ? ' companion-cat--eating' : ''}${isWalking ? ' companion-cat--walking' : ''}${paused ? ' companion-cat--paused' : ''}`}
        onClick={handleCatClick}
        title={paused ? 'Click to walk!' : 'Click to stop!'}
        aria-label={paused ? 'Resume cat walking' : 'Stop cat'}
      >
        {/* Flip wrapper — mirrors SVG for direction */}
        <div className={facingLeft ? 'companion-flip companion-flip--left' : 'companion-flip'}>
          <svg ref={svgRef} viewBox="0 0 80 100" className="companion-svg" xmlns="http://www.w3.org/2000/svg">
            {/* tail — behind body */}
            <g className="companion-tail-grp">
              <path d="M52 78 Q72 70 70 87 Q68 97 56 92" stroke="#f97316" strokeWidth="6.5" fill="none" strokeLinecap="round" />
              <path d="M52 78 Q72 70 70 87 Q68 97 56 92" stroke="#c2410c" strokeWidth="2" fill="none" strokeLinecap="round" opacity="0.32" />
            </g>
            {/* ears */}
            <polygon points="14,28 20,6 32,25" fill="#f97316" />
            <polygon points="18,26 21,10 30,23" fill="#fda4af" />
            <polygon points="66,28 60,6 48,25" fill="#f97316" />
            <polygon points="62,26 59,10 50,23" fill="#fda4af" />
            {/* head */}
            <ellipse cx="40" cy="37" rx="23" ry="22" fill="#f97316" />
            {/* tabby M forehead mark */}
            <path d="M29 22 Q33 17 37 22" stroke="#c2410c" strokeWidth="1.5" fill="none" strokeLinecap="round" />
            <path d="M37 22 Q40 17 43 22" stroke="#c2410c" strokeWidth="1.5" fill="none" strokeLinecap="round" />
            <path d="M43 22 Q47 17 51 22" stroke="#c2410c" strokeWidth="1.5" fill="none" strokeLinecap="round" />
            {/* cheek stripes */}
            <path d="M18 35 Q22 34 26 36" stroke="#c2410c" strokeWidth="1.3" fill="none" strokeLinecap="round" opacity="0.55" />
            <path d="M54 36 Q58 34 62 35" stroke="#c2410c" strokeWidth="1.3" fill="none" strokeLinecap="round" opacity="0.55" />
            {/* eye whites */}
            <ellipse cx="30" cy="36" rx="8.5" ry="9" fill="white" />
            <ellipse cx="50" cy="36" rx="8.5" ry="9" fill="white" />
            {/* amber iris — tracks cursor, corrected for flip */}
            <ellipse cx={30 + px} cy={36 + py} rx="5.5" ry="6.8" fill="#d97706" />
            <ellipse cx={50 + px} cy={36 + py} rx="5.5" ry="6.8" fill="#d97706" />
            {/* vertical slit pupils */}
            <ellipse cx={30 + px} cy={36 + py} rx="2" ry="5.5" fill="#1c1917" />
            <ellipse cx={50 + px} cy={36 + py} rx="2" ry="5.5" fill="#1c1917" />
            {/* eye shine */}
            <ellipse cx={31.6 + px * 0.5} cy={33.5 + py * 0.5} rx="2" ry="2.8" fill="white" opacity="0.88" />
            <ellipse cx={51.6 + px * 0.5} cy={33.5 + py * 0.5} rx="2" ry="2.8" fill="white" opacity="0.88" />
            {/* nose */}
            <polygon points="40,44 37,47 43,47" fill="#fb7185" />
            {/* mouth */}
            <path d="M37 47 Q40 51 43 47" stroke="#c0785a" strokeWidth="1.6" fill="none" strokeLinecap="round" />
            <path d="M40 47 Q38 52 36 54" stroke="#c0785a" strokeWidth="1.3" fill="none" strokeLinecap="round" />
            <path d="M40 47 Q42 52 44 54" stroke="#c0785a" strokeWidth="1.3" fill="none" strokeLinecap="round" />
            {/* whiskers left */}
            <line x1="17" y1="44" x2="34" y2="45" stroke="#7c3f00" strokeWidth="0.9" opacity="0.5" />
            <line x1="16" y1="48" x2="34" y2="47.5" stroke="#7c3f00" strokeWidth="0.9" opacity="0.5" />
            <line x1="18" y1="52" x2="34" y2="50" stroke="#7c3f00" strokeWidth="0.9" opacity="0.5" />
            {/* whiskers right */}
            <line x1="63" y1="44" x2="46" y2="45" stroke="#7c3f00" strokeWidth="0.9" opacity="0.5" />
            <line x1="64" y1="48" x2="46" y2="47.5" stroke="#7c3f00" strokeWidth="0.9" opacity="0.5" />
            <line x1="62" y1="52" x2="46" y2="50" stroke="#7c3f00" strokeWidth="0.9" opacity="0.5" />
            {/* body */}
            <ellipse cx="40" cy="71" rx="17" ry="20" fill="#f97316" />
            {/* body stripes */}
            <path d="M24 64 Q27 61 30 64" stroke="#c2410c" strokeWidth="1.5" fill="none" strokeLinecap="round" opacity="0.45" />
            <path d="M50 64 Q53 61 56 64" stroke="#c2410c" strokeWidth="1.5" fill="none" strokeLinecap="round" opacity="0.45" />
            <path d="M23 71 Q26 68 29 71" stroke="#c2410c" strokeWidth="1.3" fill="none" strokeLinecap="round" opacity="0.38" />
            <path d="M51 71 Q54 68 57 71" stroke="#c2410c" strokeWidth="1.3" fill="none" strokeLinecap="round" opacity="0.38" />
            {/* belly */}
            <ellipse cx="40" cy="73" rx="10.5" ry="14" fill="#fff7ed" />
            {/* back paws — drawn first so they sit behind front paws */}
            <g className="cat-paw-bl">
              <ellipse cx="26" cy="90" rx="8.5" ry="5" fill="#ea6c10" />
              <circle cx="21" cy="92" r="2.2" fill="#fc9fae" />
              <circle cx="26" cy="94" r="2.2" fill="#fc9fae" />
              <circle cx="31" cy="92" r="2.2" fill="#fc9fae" />
            </g>
            <g className="cat-paw-br">
              <ellipse cx="54" cy="90" rx="8.5" ry="5" fill="#ea6c10" />
              <circle cx="49" cy="92" r="2.2" fill="#fc9fae" />
              <circle cx="54" cy="94" r="2.2" fill="#fc9fae" />
              <circle cx="59" cy="92" r="2.2" fill="#fc9fae" />
            </g>
            {/* front paws — drawn on top */}
            <g className="cat-paw-l">
              <ellipse cx="30" cy="88" rx="9.5" ry="6" fill="#f97316" />
              <circle cx="25" cy="90" r="2.8" fill="#fda4af" />
              <circle cx="30" cy="92" r="2.8" fill="#fda4af" />
              <circle cx="35" cy="90" r="2.8" fill="#fda4af" />
            </g>
            <g className="cat-paw-r">
              <ellipse cx="50" cy="88" rx="9.5" ry="6" fill="#f97316" />
              <circle cx="45" cy="90" r="2.8" fill="#fda4af" />
              <circle cx="50" cy="92" r="2.8" fill="#fda4af" />
              <circle cx="55" cy="90" r="2.8" fill="#fda4af" />
            </g>
          </svg>
        </div>
        <div className="companion-label">{paused ? 'Zzz...' : 'Tap me!'}</div>
      </button>

      {/* Chat badge — after cat so sibling selector works; abs-positioned to cat's shoulder */}
      {!chatOpen && (
        <button
          className={`companion-chat-badge${paused ? ' companion-chat-badge--visible' : ''}`}
          onClick={(e) => { e.stopPropagation(); setChatOpen(true) }}
          title="Chat with quiz buddy"
          aria-label="Open chat"
        >💬</button>
      )}
    </div>
  )
}

function Confetti() {
  return (
    <div className="confetti-wrap" aria-hidden>
      {Array.from({ length: 64 }, (_, i) => (
        <span
          key={i}
          className="confetti-piece"
          style={
            {
              '--d': `${((i % 9) * 0.17).toFixed(2)}s`,
              '--x': `${((i * 13.7) % 96).toFixed(1)}vw`,
              '--r': `${(i * 37) % 360}deg`,
              '--c': CONFETTI[i % CONFETTI.length],
              '--s': `${7 + (i % 7)}px`,
            } as React.CSSProperties
          }
        />
      ))}
    </div>
  )
}

export default function App() {
  const [step, setStep] = useState<Step>('upload')
  const [form, setForm] = useState<QuizForm>(initialForm)
  const [selectedSubject, setSelectedSubject] = useState('')
  const [customSubject, setCustomSubject] = useState('')
  const [studyText, setStudyText] = useState('')
  const [fileName, setFileName] = useState('')
  const [mode, setMode] = useState('rapid')
  const [isParsing, setParsing] = useState(false)
  const [isBuilding, setBuilding] = useState(false)
  const [error, setError] = useState('')
  const [quiz, setQuiz] = useState<QuizPayload | null>(null)
  const [answers, setAnswers] = useState<AnswerState>({})
  const [userName, setUserName] = useState('')
  const [idx, setIdx] = useState(0)
  const [dragging, setDragging] = useState(false)
  const [catEat, setCatEat] = useState(0)
  const quizScreenRef = useRef<HTMLDivElement>(null)

  const stats = useMemo(() => {
    const words = studyText.trim() ? studyText.trim().split(/\s+/).length : 0
    const topics = Array.from(
      new Set(studyText.split(/[\n,.]/).map((s) => s.trim()).filter((s) => s.length > 18).slice(0, 5)),
    )
    return { words, topics }
  }, [studyText])

  const score = useMemo(() => {
    if (!quiz) {
      return { correct: 0, answered: 0, total: 0 }
    }
    const answered = Object.keys(answers).length
    const correct = quiz.questions.reduce((n, q) => n + (answers[q.id] === q.answerIndex ? 1 : 0), 0)
    return { correct, answered, total: quiz.questions.length }
  }, [answers, quiz])

  const pct = quiz ? Math.round((score.correct / score.total) * 100) : 0

  // Scroll quiz screen to top whenever the question index changes
  useEffect(() => {
    quizScreenRef.current?.scrollTo({ top: 0, behavior: 'smooth' })
  }, [idx])

  const mascotMood = useMemo<MascotMood>(() => {
    if (isBuilding) return 'thinking'
    if (step === 'results') return pct >= 70 ? 'celebrate' : 'sad'
    if (step === 'quiz' && quiz) {
      const q = quiz.questions[idx]
      const chosen = answers[q.id]
      if (typeof chosen === 'number') {
        return chosen === q.answerIndex ? 'correct' : 'wrong'
      }
      return 'ready'
    }
    return 'idle'
  }, [answers, idx, isBuilding, pct, quiz, step])

  function retryWrong() {
    if (!quiz) return
    const wrongQs = quiz.questions.filter((q) => answers[q.id] !== q.answerIndex)
    if (wrongQs.length === 0) return
    setQuiz({ ...quiz, questions: wrongQs })
    setAnswers({})
    setIdx(0)
    setStep('quiz')
  }

  async function processFile(file: File) {
    setParsing(true)
    setError('')
    try {
      const text = await extractTextFromFile(file)
      if (!text.trim()) throw new Error('This file does not contain enough readable text.')
      setStudyText(text)
      setFileName(file.name)
    } catch (value) {
      setError(value instanceof Error ? value.message : 'Could not read this file.')
    } finally {
      setParsing(false)
    }
  }

  async function handleFile(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0]
    if (file) {
      await processFile(file)
      event.target.value = ''
    }
  }

  async function handleDrop(event: DragEvent<HTMLLabelElement>) {
    event.preventDefault()
    setDragging(false)
    const file = event.dataTransfer.files?.[0]
    if (file) {
      await processFile(file)
    }
  }

  function setField<Key extends keyof QuizForm>(key: Key, value: QuizForm[Key]) {
    setForm((current) => ({ ...current, [key]: value }))
  }

  async function buildQuiz() {
    setError('')
    setBuilding(true)
    try {
      const response = await fetch('/api/generate-quiz', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          sourceText: studyText,
          metadata: { fileName, mode },
          options: { ...form, tone: 'clear and direct' },
        }),
      })
      const payload = (await response.json()) as QuizPayload & { message?: string }
      if (!response.ok) throw new Error(payload.message ?? 'Quiz generation failed.')
      setQuiz(payload)
      setAnswers({})
      setIdx(0)
      setStep('quiz')
    } catch (value) {
      setError(value instanceof Error ? value.message : 'Something went wrong while generating the quiz.')
    } finally {
      setBuilding(false)
    }
  }

  function answer(question: QuizQuestion, optionIndex: number) {
    setAnswers((current) => (question.id in current ? current : { ...current, [question.id]: optionIndex }))
  }

  function reset() {
    setStudyText('')
    setFileName('')
    setQuiz(null)
    setAnswers({})
    setError('')
    setIdx(0)
    setSelectedSubject('')
    setCustomSubject('')
    setForm(initialForm)
    setStep('upload')
  }

  if (step === 'upload') {
    return (
      <>
      <div className="screen">
        <div className="screen-glow screen-glow--one" />
        <div className="screen-glow screen-glow--two" />

        <header className="screen-hdr">
          <div className="brand">⚡ Quiz Generator</div>
        </header>

        <main className="screen-body screen-body--wide">
          <section className="surface-card hero-panel">
            <div className="hero-kicker-row">
              {journeySteps.map((item, index) => (
                <span key={item} className={`hero-kicker hero-kicker--${index + 1}`}>
                  {item}
                </span>
              ))}
            </div>

            <div className="upload-hero">
              <div className="landing-sparkles" aria-hidden>
                <span>Learn</span>
                <span>Practice</span>
                <span>Score</span>
              </div>
              <h1 className="upload-title">
                Turn notes into a
                <br />
                <span>beautiful quiz flow</span>
              </h1>
              <p className="upload-sub">
                Upload a PDF, PPTX, or plain text and get a playful, source-grounded quiz experience built for everyone from Class 5 students to BTech learners.
              </p>
            </div>

            <div className="hero-mini-grid">
              {heroHighlights.map((item) => (
                <article key={item.title} className="hero-mini-card">
                  <strong>{item.title}</strong>
                  <span>{item.text}</span>
                </article>
              ))}
            </div>

            <div className="audience-strip">
              {audienceBands.map((item) => (
                <article key={item.title} className="audience-card">
                  <strong>{item.title}</strong>
                  <span>{item.text}</span>
                </article>
              ))}
            </div>
          </section>

          <section className="surface-card upload-stack">
            <div className="field">
              <label className="field-label" htmlFor="u-name">Your name (optional)</label>
              <input
                id="u-name"
                placeholder="Enter your name..."
                value={userName}
                onChange={(event) => setUserName(event.target.value)}
              />
            </div>

            <label
              className={`drop-zone${dragging ? ' drag-on' : ''}${fileName ? ' loaded' : ''}`}
              htmlFor="up-input"
              onDragOver={(event) => {
                event.preventDefault()
                setDragging(true)
              }}
              onDragLeave={() => setDragging(false)}
              onDrop={handleDrop}
            >
              <input id="up-input" type="file" accept=".pdf,.pptx,.txt" onChange={handleFile} disabled={isParsing} />
              <div className="dz-icon">{isParsing ? '⏳' : fileName ? '✅' : dragging ? '📂' : '📄'}</div>
              <strong className="dz-title">
                {isParsing ? 'Reading file...' : fileName ? fileName : dragging ? 'Drop your file here' : 'Click or drag your file here'}
              </strong>
              <span className="dz-sub">PDF · PPTX · TXT supported</span>
              {fileName && <span className="dz-change">Choose another file</span>}
            </label>

            <div className="or-divider"><span>or paste your notes</span></div>

            <textarea
              className="paste-area"
              value={studyText}
              onChange={(event) => setStudyText(event.target.value)}
              placeholder="Paste notes, chapter text, or revision points here."
            />

            {stats.words > 0 && (
              <div className="word-stats">
                <span><strong>{stats.words}</strong> words loaded</span>
                <span><strong>{stats.topics.length}</strong> key topics found</span>
              </div>
            )}

            {stats.topics.length > 0 && (
              <div className="topic-preview-row">
                {stats.topics.map((topic) => (
                  <span key={topic} className="topic-preview-chip">{topic}</span>
                ))}
              </div>
            )}

            {error && <div className="alert alert-error">{error}</div>}

            <button
              className="primary-btn btn-lg btn-full"
              disabled={!studyText.trim() || isParsing}
              onClick={() => {
                setError('')
                setStep('configure')
              }}
            >
              Continue to settings
            </button>
          </section>

          <section className="surface-card landing-storyboard">
            <div className="landing-storyboard-top">
              <p className="section-label">How it works</p>
              <h2 className="landing-heading">Study less passively. Practice more actively.</h2>
              <p className="configure-sub">
                The flow is simple enough for younger students, but strong enough for serious end-term and semester revision.
              </p>
            </div>

            <div className="landing-journey-grid">
              {landingJourney.map((item) => (
                <article key={item.title} className="landing-journey-card">
                  <strong>{item.title}</strong>
                  <p>{item.text}</p>
                </article>
              ))}
            </div>
          </section>

          <section className="surface-card landing-trust-panel">
            <div className="landing-storyboard-top">
              <p className="section-label">Why students like it</p>
              <h2 className="landing-heading">Animations, guidance, and safer answers in one place.</h2>
            </div>

            <div className="landing-trust-grid">
              {landingTrust.map((item) => (
                <article key={item.title} className="landing-trust-card">
                  <strong>{item.title}</strong>
                  <p>{item.text}</p>
                </article>
              ))}
            </div>
          </section>
        </main>

        <p className="screen-footnote">
          Add <code>OPENAI_API_KEY</code> to <code>.env</code> for live AI explanations. Local fallback mode still works.
        </p>
      </div>
      <FloatingCompanion />
      </>
    )
  }

  if (step === 'configure') {
    return (
      <>
      <div className="screen">
        <div className="screen-glow screen-glow--one" />

        <header className="screen-hdr">
          <button className="ghost-btn" onClick={() => setStep('upload')}>Back</button>
          <span className="hdr-title">Quiz Settings</span>
        </header>

        <main className="screen-body screen-body--wide">
          <section className="surface-card configure-shell">
            <div className="configure-overview">
              <div>
                <p className="section-label">Almost ready</p>
                <h2 className="configure-heading">{form.examName || 'Your quiz'}</h2>
                <p className="configure-sub">
                  Pick a learning mode, set the difficulty, and hit Generate — your quiz will be ready in seconds.
                </p>
              </div>
              <div className="material-badge">
                📄 {fileName || 'Pasted text'}
                <span className="badge-count">{stats.words} words</span>
              </div>
            </div>

            <div className="config-section">
              <p className="section-label">Learning mode</p>
              <div className="mode-cards">
                {modes.map((item) => (
                  <button
                    key={item.id}
                    className={`mode-card${mode === item.id ? ' active' : ''}`}
                    onClick={() => setMode(item.id)}
                  >
                    <strong>{item.title}</strong>
                    <span>{item.desc}</span>
                  </button>
                ))}
              </div>
            </div>

            <div className="config-section">
              <p className="section-label">Settings</p>
              <div className="config-grid">
                <div className="field field-full">
                  <label className="field-label" htmlFor="f-exam-category">Exam type</label>
                  <select
                    id="f-exam-category"
                    value={selectedSubject}
                    onChange={(event) => {
                      const value = event.target.value
                      setSelectedSubject(value)
                      if (value !== 'other') {
                        const option = examTypeOptions.find((item) => item.id === value)
                        setField('examName', option?.label ?? '')
                        setCustomSubject('')
                      } else {
                        setField('examName', customSubject)
                      }
                    }}
                  >
                    <option value="">Select exam type</option>
                    {examTypeOptions.map((option) => (
                      <option key={option.id} value={option.id}>
                        {option.label}
                      </option>
                    ))}
                  </select>
                  {selectedSubject === 'other' && (
                    <input
                      className="custom-subject-input"
                      value={customSubject}
                      onChange={(e) => {
                        setCustomSubject(e.target.value)
                        setField('examName', e.target.value)
                      }}
                      placeholder="Type your exam name..."
                      autoFocus
                    />
                  )}
                </div>
                <div className="field">
                  <label className="field-label" htmlFor="f-count">Number of questions</label>
                  <input
                    id="f-count"
                    type="number"
                    min={5}
                    max={15}
                    value={form.questionCount}
                    onChange={(event) => setField('questionCount', Number(event.target.value))}
                  />
                </div>
                <div className="field">
                  <label className="field-label" htmlFor="f-diff">Difficulty level</label>
                  <select
                    id="f-diff"
                    value={form.difficultyMix}
                    onChange={(event) => setField('difficultyMix', event.target.value as Difficulty)}
                  >
                    <option value="easy">Easy</option>
                    <option value="medium">Medium</option>
                    <option value="hard">Hard</option>
                  </select>
                </div>
                <div className="field field-full">
                  <label className="field-label" htmlFor="f-type">Question format</label>
                  <select id="f-type" value={form.examType} onChange={(event) => setField('examType', event.target.value as ExamType)}>
                    <option value="mcq">Standard MCQs</option>
                    <option value="scenario">Scenario-based MCQs</option>
                    <option value="mixed">Mixed mode</option>
                  </select>
                </div>
                <div className="field field-full">
                  <label className="field-label" htmlFor="f-goal">Study goal</label>
                  <input id="f-goal" value={form.learnerGoal} onChange={(event) => setField('learnerGoal', event.target.value)} placeholder="e.g. Quick revision before exam…" />
                </div>
              </div>
            </div>

            <div className="config-preview-grid">
              <article className="config-preview-card">
                <span className="config-preview-label">Quiz summary</span>
                <strong>
                  {form.questionCount} questions · {form.difficultyMix}
                </strong>
                <p>
                  {form.examType === 'mixed' ? 'Mixed MCQ format' : form.examType === 'scenario' ? 'Scenario-based questions' : 'Standard MCQ format'}
                </p>
              </article>
              <article className="config-preview-card">
                <span className="config-preview-label">Study mode</span>
                <strong>{mode === 'rapid' ? 'Rapid Review' : mode === 'story' ? 'Story Coach' : 'Exam Pressure'}</strong>
                <p>{form.learnerGoal || 'No goal set yet.'}</p>
              </article>
            </div>

            {error && <div className="alert alert-error">{error}</div>}

            <button className="primary-btn btn-lg btn-full" disabled={isBuilding} onClick={() => void buildQuiz()}>
              {isBuilding ? (
                <span className="loading-dots">
                  <span className="dot" />
                  <span className="dot" />
                  <span className="dot" />
                  Building...
                </span>
              ) : (
                'Generate quiz'
              )}
            </button>

            {isBuilding && <p className="gen-hint">Creating your questions now...</p>}
          </section>
        </main>
      </div>
      <FloatingCompanion />
      </>
    )
  }

  if (step === 'quiz' && quiz) {
    const question = quiz.questions[idx]
    const chosen = answers[question.id]
    const isAnswered = typeof chosen === 'number'
    const progress = Math.round(((idx + 1) / quiz.questions.length) * 100)

    return (
      <>
        <div className="screen screen--quiz" ref={quizScreenRef}>
          <header className="screen-hdr quiz-hdr">
            <button className="ghost-btn" onClick={() => setStep('configure')}>← Close</button>
            <div className="quiz-hdr-mid">
              <div className="quiz-prog-bar">
                <div className="quiz-prog-fill" style={{ width: `${progress}%` }} />
              </div>
              <span className="q-progress-label">Q {idx + 1} of {quiz.questions.length}</span>
            </div>
            <div className="hdr-right">
              {userName && <span className="hdr-name">{userName}</span>}
              <div className="score-chip">
                <strong>{score.correct}</strong>/{score.total} ✓
              </div>
            </div>
          </header>

          <main className="quiz-main">
            <div className="quiz-card-row">
            <div className="question-card" key={question.id}>
              <div className="q-badges">
                <span className="q-num-badge">Q {idx + 1}</span>
                <span className={`q-diff-pill q-diff-pill--${question.difficulty}`}>{question.difficulty}</span>
              </div>

              <p className="q-text">{question.question}</p>

              <div className="opts">
                {question.options.map((option, optionIndex) => {
                  const isCorrect = optionIndex === question.answerIndex
                  const isWrong = chosen === optionIndex && !isCorrect
                  return (
                    <button
                      key={`${question.id}-${option}`}
                      className={`opt${isAnswered && isCorrect ? ' correct' : ''}${isWrong ? ' wrong' : ''}`}
                      onClick={() => answer(question, optionIndex)}
                      disabled={isAnswered}
                      style={{ '--opt-i': optionIndex } as React.CSSProperties}
                    >
                      <span className="opt-letter">{LETTERS[optionIndex]}</span>
                      <span className="opt-text">{option}</span>
                    </button>
                  )
                })}
              </div>

              {isAnswered && (
                <div className={`explain-panel${chosen === question.answerIndex ? ' correct' : ' wrong'}`}>
                  <strong>{chosen === question.answerIndex ? '✓ Correct!' : '✗ Not quite.'}</strong>
                  <p>{question.explanation}</p>
                  {question.sourceHint && <p className="source-hint">📚 {question.sourceHint}</p>}
                  {question.sourceExcerpt && <p className="source-proof">From your notes: "${question.sourceExcerpt}"</p>}
                </div>
              )}
            </div>
            {/* Mascot floats to the right side of the card */}
            <div className="quiz-mascot-side">
              <Mascot mood={mascotMood} compact />
            </div>
            </div>
          </main>

          <footer className="screen-footer">
            <button className="nav-btn" disabled={idx === 0} onClick={() => setIdx((current) => current - 1)}>
              ← Back
            </button>
            {idx < quiz.questions.length - 1 ? (
              <button className="nav-btn nav-primary" onClick={() => { setIdx((current) => current + 1); setCatEat((t) => t + 1) }}>
                Next →
              </button>
            ) : (
              <button className="nav-btn nav-primary" disabled={score.answered < quiz.questions.length} onClick={() => setStep('results')}>
                See results ✓
              </button>
            )}
          </footer>
        </div>
        <FloatingCompanion question={question} eatTick={catEat} />
      </>
    )
  }

  if (step === 'results' && quiz) {
    return (
      <>
      <div className="screen">
        {pct >= 70 && <Confetti />}

        <header className="screen-hdr">
          <div className="brand">⚡ Quiz Generator</div>
          {userName && <span className="hdr-name">{userName}</span>}
        </header>

        <main className="screen-body results-body">
          <section className="surface-card results-hero">
            <div className="results-hero-top">
              <Mascot mood={mascotMood} />
              <div className="results-ring" style={{ '--ring-pct': `${pct}` } as React.CSSProperties}>
                <strong>{pct}%</strong>
                <span>Score</span>
              </div>
            </div>

            <div className="results-copy">
              <span className="results-kicker">Quiz complete</span>
              <h2 className="results-heading">
                {userName
                  ? pct >= 80
                    ? `Incredible work, ${userName}!`
                    : pct >= 60
                      ? `Good progress, ${userName}!`
                      : `Keep going, ${userName}!`
                  : pct >= 80
                    ? 'Outstanding!'
                    : pct >= 60
                      ? 'Good work!'
                      : 'Keep practicing!'}
              </h2>
              <p className="results-sub">{score.correct} of {score.total} questions answered correctly.</p>
            </div>

            <div className="results-stat-grid">
              <article className="results-stat-card">
                <strong>{score.correct}</strong>
                <span>Correct answers</span>
              </article>
              <article className="results-stat-card">
                <strong>{score.total - score.correct}</strong>
                <span>Need review</span>
              </article>
              <article className="results-stat-card">
                <strong>{score.total}</strong>
                <span>Total questions</span>
              </article>
            </div>

            <div className="results-actions">
              {score.total - score.correct > 0 && (
                <button className="retry-wrong-btn" onClick={retryWrong}>
                  Retry missed questions <span className="wrong-count-badge">{score.total - score.correct}</span>
                </button>
              )}
              <button className="secondary-btn btn-lg" onClick={() => { setAnswers({}); setIdx(0); setStep('quiz') }}>
                Try again
              </button>
              <button className="primary-btn btn-lg" onClick={reset}>
                New quiz
              </button>
            </div>
          </section>

          {score.total - score.correct > 0 && (
            <section className="surface-card review-section">
              <div className="results-section-top">
                <p className="section-label">Review missed answers</p>
                <span className="results-section-note">See the correct option and a quick explanation.</span>
              </div>
              {quiz.questions
                .filter((item) => answers[item.id] !== item.answerIndex)
                .map((item, reviewIndex) => (
                  <div key={item.id} className="review-card" style={{ '--delay': `${reviewIndex * 80}ms` } as React.CSSProperties}>
                    <p className="review-q"><span className="review-num">{reviewIndex + 1}</span>{item.question}</p>
                    <div className="review-opts">
                      {item.options.map((option, optionIndex) => (
                        <div
                          key={`${item.id}-${option}`}
                          className={`review-opt${optionIndex === item.answerIndex ? ' rev-correct' : ''}${answers[item.id] === optionIndex && optionIndex !== item.answerIndex ? ' rev-wrong' : ''}`}
                        >
                          <span className="opt-letter">{LETTERS[optionIndex]}</span>
                          <span>{option}</span>
                          {optionIndex === item.answerIndex && <span className="rev-tag">Correct</span>}
                          {answers[item.id] === optionIndex && optionIndex !== item.answerIndex && (
                            <span className="rev-tag rev-tag-wrong">Your answer</span>
                          )}
                        </div>
                      ))}
                    </div>
                    {item.explanation && <p className="review-explain">{item.explanation}</p>}
                    {item.sourceExcerpt && <p className="review-proof">From your notes: "${item.sourceExcerpt}"</p>}
                  </div>
                ))}
            </section>
          )}

          {quiz.flashSummary.length > 0 && (
            <section className="surface-card results-topics">
              <div className="results-section-top">
                <p className="topics-label">Topics covered</p>
                <span className="results-section-note">Quick concepts from this session.</span>
              </div>
              <div className="topics-wrap">
                {quiz.flashSummary.map((topic) => (
                  <span className="topic-tag" key={topic}>{topic}</span>
                ))}
              </div>
            </section>
          )}
        </main>
      </div>
      <FloatingCompanion />
      </>
    )
  }

  return null
}
