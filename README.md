# Quiz Study Room

Upload a `PDF`, `PPTX`, or `TXT` file and turn dry study material into a student-friendly MCQ practice flow.

## Features

- Client-side PDF and PPTX text extraction
- Beautiful responsive UI for students and friend groups
- Quiz generation API with OpenAI support
- Local fallback generator when `OPENAI_API_KEY` is not configured
- Instant answer checking with explanations and flash summary

## Run locally

1. Install packages:
   `npm install`
2. Optional: create `.env` from `.env.example` and add your OpenAI key.
3. Start both frontend and backend:
   `npm run dev`

Frontend runs at [http://localhost:5173](http://localhost:5173) and the API runs at [http://localhost:8787](http://localhost:8787).

## Production build

- Build the frontend: `npm run build`
- Start the server: `npm run start`

If `dist/` exists, the Express server also serves the built frontend.
