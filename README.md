# Retelling Brain Bot

Telegram-first MVP for saving English retelling notes and compressed photos, then reviewing them in a protected Cloudflare Pages dashboard.

## Stack

- React + Vite + TypeScript frontend on Cloudflare Pages.
- Cloudflare Pages Functions backend.
- Cloudflare D1 for folders, topics, notes, comments, AI limits and cache.
- Cloudflare R2 for compressed photo files.
- OpenRouter for explicit text-only AI actions.

## Local Setup

1. Install dependencies:

   ```bash
   npm install
   ```

2. Create local secrets in `.dev.vars` using `.env.example` as a template.

3. Create/apply D1 migration:

   ```bash
   npm run db:migrate:local
   ```

4. Build:

   ```bash
   npm run build
   ```

5. Run Cloudflare Pages locally:

   ```bash
   npm run cf:dev
   ```

## Cloudflare Setup Notes

- Replace `database_id` in `wrangler.jsonc` after creating the D1 database.
- Create an R2 bucket named `retelling-brain-photos` or change `bucket_name`.
- Set secrets in Cloudflare Pages:
  - `TELEGRAM_BOT_TOKEN`
  - `OWNER_TELEGRAM_ID`
  - `TEACHER_TELEGRAM_ID`
  - `WEB_PASSWORD`
  - `OPENROUTER_API_KEY`
  - `OPENROUTER_MODEL`

## Telegram Webhook

After deployment, point Telegram to:

```text
https://YOUR_DOMAIN/api/telegram/webhook
```

No Tavily, URL parsing, link analysis, automatic AI-on-save, or AI photo analysis is included in MVP-1.
