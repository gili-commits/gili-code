# ACT — מלווה נפשי אישי

A personal mental wellness app based on **Acceptance and Commitment Therapy (ACT)** with AI-powered support via Claude.

## Features

- **Crisis Check-in** — Log anxiety in real time with intensity, thoughts, and body sensations. Receive immediate ACT-based feedback from Claude.
- **Dream Journal** — Record dreams and receive interpretations combining ACT psychology and Jungian archetypes.
- **Avoidance Tracker** — Identify avoidance patterns and break them into small, actionable steps.
- **Values Map** — Explore your core values across 10 life domains and track alignment.
- **Guided Exercises** — Breathing, body scan, defusion, and mindfulness exercises.
- **Personal Profile** — Upload personal files so Claude learns to know you over time.
- **Progress Graphs** — Track anxiety intensity and wins over time.
- **Continuous Chat** — Continue conversations with Claude after each response.
- **Multi-user Support** — Each user has a private, password-protected account.

## Tech Stack

- **Backend:** Node.js + Express
- **Database:** PostgreSQL (Supabase)
- **AI:** Anthropic Claude API (claude-sonnet)
- **Frontend:** Single-file HTML with RTL Hebrew support
- **Hosting:** Render
- **Uptime:** UptimeRobot

## Setup

### Local Development

```bash
nvm use 20
cd ~/Desktop/cluade
npm install
node server.js
```

Open at: http://localhost:3000

### Environment Variables

| Variable | Description |
|----------|-------------|
| `ANTHROPIC_API_KEY` | Your Anthropic API key |
| `DATABASE_URL` | Supabase PostgreSQL connection string |
| `PORT` | Server port (default: 3000) |

### Deploy to Render

1. Push to GitHub
2. Connect repo on [render.com](https://render.com)
3. Set environment variables
4. Build command: `npm install`
5. Start command: `node server.js`

## Usage

1. Register a new account
2. Fill in your personal profile
3. Optionally upload personal files for Claude to learn from
4. Use the app during moments of anxiety, or for daily journaling

## Privacy

- All personal data is stored in your private Supabase database
- Messages are processed by Anthropic's Claude API
- Anthropic does not use API data for model training
