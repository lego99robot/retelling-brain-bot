# Retelling Brain Bot

Telegram-first MVP for saving English retelling notes and compressed photos, then reviewing them in a protected Cloudflare Pages dashboard.

## Stack

- React + Vite + TypeScript frontend on Cloudflare Pages.
- Cloudflare Pages Functions backend.
- Cloudflare D1 for folders, topics, notes, comments, AI limits and cache.
- Cloudflare R2 for compressed photo files when R2 is enabled. Without R2, Telegram photos are stored by Telegram file id and served through the backend.
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
- Optional for full photo support: enable R2 and add a bucket named `retelling-brain-photos`. Without R2, Telegram photo capture still works, but web-panel photo uploads return a storage-not-configured message.
- Set secrets in Cloudflare Pages:
  - `TELEGRAM_BOT_TOKEN`
  - `OWNER_TELEGRAM_ID`
  - `TEACHER_TELEGRAM_ID`
  - `WEB_PASSWORD`
  - `WEB_PASSWORD_TEATH`
  - `OPENROUTER_API_KEY`
  - `OPENROUTER_MODEL`

## Pre-RAG Memory Rules

- For books, use `Books` as the folder and one study block per chapter, for example `Harry Potter - Chapter 1`.
- Use `topics.summary` as the short chapter description.
- Use note tags for information type: `#plot`, `#words`, `#facts`, `#names`, `#opinion`, `#retelling`, `#photo`.
- Future vector chunks should be small semantic pieces from text notes and manual photo descriptions only.
- Future chunk metadata should include `folder`, `book`, `studyBlock/chapter`, `noteType`, `tags`, and `createdAt`.
- Do not index or analyze raw photos until a separate vision feature is added.

## Telegram Webhook

After deployment, point Telegram to:

```text
https://YOUR_DOMAIN/api/telegram/webhook
```

No Tavily, URL parsing, link analysis, automatic AI-on-save, or AI photo analysis is included in MVP-1.
