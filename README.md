# Samba Quiz

Samba Quiz is a playful study app that turns uploaded notes into source-grounded MCQ practice for learners from Class 5 to BTech.

## What it does

- Upload `PDF`, `PPTX`, or `TXT` files
- Generate quiz questions with explanations
- Show supporting note snippets for safer revision
- Offer simple AI helper replies for question doubts and normal study doubts
- Work with OpenAI or with a built-in local fallback generator

## Local run

1. Install packages:
   `npm install`
2. Optional: copy `.env.example` to `.env`
3. Add `OPENAI_API_KEY` if you want live AI generation and richer chat replies
4. Start the app:
   `npm run dev`

Frontend:
- [http://localhost:5173](http://localhost:5173)

Backend:
- [http://localhost:8787](http://localhost:8787)

## Production

- Build:
  `npm run build`
- Start server:
  `npm run start`

The Express server serves the built frontend from `dist/`.

## Deploy

This repo includes [render.yaml](C:/Users/Prudhvi/Videos/Quiz/render.yaml) for Render deployment.

Recommended steps:

1. Push this repo to GitHub
2. Create a new Render Web Service from the repo
3. Render will detect `render.yaml`
4. Add `OPENAI_API_KEY` in Render environment variables
5. Deploy

## Accuracy note

Questions are now designed to stay closer to uploaded material by attaching a `sourceExcerpt` for each answer. For important end-term topics, always compare the answer with your class notes or textbook once before final memorization.
