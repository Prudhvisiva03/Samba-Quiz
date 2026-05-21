export type Difficulty = 'easy' | 'medium' | 'hard'

export type QuizQuestion = {
  id: string
  question: string
  options: string[]
  answerIndex: number
  explanation: string
  difficulty: Difficulty
  sourceHint?: string
  sourceExcerpt?: string
}

export type QuizPayload = {
  title: string
  flashSummary: string[]
  questions: QuizQuestion[]
  sourceType: string
}
