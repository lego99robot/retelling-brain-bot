export interface Env {
  DB: D1Database;
  PHOTOS: R2Bucket;
  TELEGRAM_BOT_TOKEN?: string;
  OWNER_TELEGRAM_ID?: string;
  TEACHER_TELEGRAM_ID?: string;
  WEB_PASSWORD?: string;
  OPENROUTER_API_KEY?: string;
  OPENROUTER_MODEL?: string;
}

type Role = "owner" | "teacher";
type Session = { role: Role };
type ApiContext = EventContext<Env, string, unknown>;

const DEFAULT_FOLDERS = ["Books", "Films", "Videos", "Vocabulary", "Inbox"] as const;
const AI_DAILY_LIMIT = 10;
const NOTE_LIMIT = 1000;
const MAX_WEB_PHOTO_BYTES = 3 * 1024 * 1024;
const OPENROUTER_URL = "https://openrouter.ai/api/v1/chat/completions";

export const onRequest: PagesFunction<Env> = async (context) => {
  try {
    return await route(context);
  } catch (error) {
    if (error instanceof Error && "status" in error && typeof error.status === "number") {
      return json({ error: error.message }, error.status);
    }
    console.error(error);
    return json({ error: "Unexpected server error" }, 500);
  }
};

async function route(context: ApiContext): Promise<Response> {
  const { request, env } = context;
  const url = new URL(request.url);
  const path = url.pathname.replace(/^\/api\/?/, "");
  const parts = path.split("/").filter(Boolean);
  const method = request.method.toUpperCase();

  if (method === "OPTIONS") {
    return new Response(null, { status: 204, headers: corsHeaders() });
  }

  if (parts[0] === "telegram" && parts[1] === "webhook" && method === "POST") {
    await ensureDefaults(env.DB);
    return handleTelegramWebhook(request, env);
  }

  if (parts[0] === "auth" && parts[1] === "login" && method === "POST") {
    return login(request, env);
  }

  const session = await requireSession(request, env);
  await ensureDefaults(env.DB);

  if (parts[0] === "me" && method === "GET") {
    return json({ role: session.role });
  }

  if (parts[0] === "folders") {
    if (method === "GET") return listFolders(env.DB);
    if (method === "POST") return createFolder(request, env.DB, session);
  }

  if (parts[0] === "topics") {
    if (method === "GET" && parts.length === 1) return listTopics(request, env.DB);
    if (method === "POST" && parts.length === 1) return createTopic(request, env.DB, session);
    if (method === "GET" && parts[2] === "feed") return getTopicFeed(env, parts[1]);
  }

  if (parts[0] === "notes") {
    if (method === "POST") return createNote(request, env.DB, session);
    if (method === "PATCH" && parts[1]) return updateNote(request, env.DB, session, parts[1]);
  }

  if (parts[0] === "photos") {
    if (method === "POST") return createPhoto(request, env, session);
    if (method === "PATCH" && parts[1]) return updatePhoto(request, env.DB, session, parts[1]);
    if (method === "GET" && parts[1] && parts[2] === "file") return getPhotoFile(env, parts[1]);
  }

  if (parts[0] === "comments" && method === "POST") {
    return createComment(request, env.DB, session);
  }

  if (parts[0] === "ai" && parts[1] === "topic-action" && method === "POST") {
    return runTopicAiAction(request, env, session);
  }

  return json({ error: "Not found" }, 404);
}

async function login(request: Request, env: Env): Promise<Response> {
  const body = await readJson<{ password?: string; role?: Role }>(request);
  if (!env.WEB_PASSWORD) return json({ error: "WEB_PASSWORD is not configured" }, 500);
  if (!body.password || body.password !== env.WEB_PASSWORD) return json({ error: "Invalid password" }, 401);

  const role: Role = body.role === "teacher" ? "teacher" : "owner";
  const cookie = await createSessionCookie(env, role, request.url);
  return json({ role }, 200, { "Set-Cookie": cookie });
}

async function requireSession(request: Request, env: Env): Promise<Session> {
  const raw = parseCookies(request.headers.get("Cookie")).rb_session;
  if (!raw) throw httpError(401, "Authentication required");

  const [version, role, expires, signature] = raw.split(".");
  if (version !== "v1" || (role !== "owner" && role !== "teacher") || !expires || !signature) {
    throw httpError(401, "Invalid session");
  }
  if (Number(expires) < Date.now()) throw httpError(401, "Session expired");

  const expected = await signSession(env, `${role}.${expires}`);
  if (signature !== expected) throw httpError(401, "Invalid session");
  return { role };
}

async function createSessionCookie(env: Env, role: Role, requestUrl: string): Promise<string> {
  const expires = String(Date.now() + 7 * 24 * 60 * 60 * 1000);
  const signature = await signSession(env, `${role}.${expires}`);
  const value = `v1.${role}.${expires}.${signature}`;
  const secure = new URL(requestUrl).protocol === "https:" ? " Secure;" : "";
  return `rb_session=${value}; Path=/; Max-Age=604800; HttpOnly; SameSite=Lax;${secure}`;
}

async function signSession(env: Env, data: string): Promise<string> {
  const secret = env.WEB_PASSWORD || "missing-web-password";
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(data));
  return base64Url(signature);
}

async function ensureDefaults(db: D1Database): Promise<void> {
  const statements: D1PreparedStatement[] = [];
  for (const name of DEFAULT_FOLDERS) {
    const folderId = `folder-${slug(name)}`;
    const topicId = `topic-${slug(name)}-general`;
    statements.push(db.prepare("INSERT OR IGNORE INTO folders (id, name) VALUES (?, ?)").bind(folderId, name));
    statements.push(db.prepare("INSERT OR IGNORE INTO topics (id, folder_id, name) VALUES (?, ?, ?)").bind(topicId, folderId, "General"));
  }
  await db.batch(statements);
}

async function listFolders(db: D1Database): Promise<Response> {
  const { results } = await db
    .prepare(
      `SELECT f.id, f.name, f.created_at,
        COUNT(DISTINCT t.id) AS topic_count,
        COUNT(DISTINCT n.id) AS note_count,
        COUNT(DISTINCT p.id) AS photo_count
       FROM folders f
       LEFT JOIN topics t ON t.folder_id = f.id
       LEFT JOIN notes n ON n.topic_id = t.id
       LEFT JOIN photos p ON p.topic_id = t.id
       GROUP BY f.id
       ORDER BY f.created_at ASC`,
    )
    .all();
  return json({ folders: results });
}

async function createFolder(request: Request, db: D1Database, session: Session): Promise<Response> {
  requireOwner(session);
  const body = await readJson<{ name?: string }>(request);
  const name = cleanName(body.name, 40);
  const id = crypto.randomUUID();
  await db.prepare("INSERT INTO folders (id, name) VALUES (?, ?)").bind(id, name).run();
  await db.prepare("INSERT INTO topics (id, folder_id, name) VALUES (?, ?, ?)").bind(crypto.randomUUID(), id, "General").run();
  return json({ id, name }, 201);
}

async function listTopics(request: Request, db: D1Database): Promise<Response> {
  const folderId = new URL(request.url).searchParams.get("folderId");
  if (!folderId) return json({ error: "folderId is required" }, 400);
  const { results } = await db
    .prepare(
      `SELECT t.id, t.folder_id, t.name, t.summary, t.created_at, t.updated_at,
        COUNT(DISTINCT n.id) AS note_count,
        COUNT(DISTINCT p.id) AS photo_count
       FROM topics t
       LEFT JOIN notes n ON n.topic_id = t.id
       LEFT JOIN photos p ON p.topic_id = t.id
       WHERE t.folder_id = ?
       GROUP BY t.id
       ORDER BY t.created_at ASC`,
    )
    .bind(folderId)
    .all();
  return json({ topics: results });
}

async function createTopic(request: Request, db: D1Database, session: Session): Promise<Response> {
  requireOwner(session);
  const body = await readJson<{ folderId?: string; name?: string }>(request);
  if (!body.folderId) return json({ error: "folderId is required" }, 400);
  const name = cleanName(body.name, 60);
  const id = crypto.randomUUID();
  await db.prepare("INSERT INTO topics (id, folder_id, name) VALUES (?, ?, ?)").bind(id, body.folderId, name).run();
  return json({ id, folder_id: body.folderId, name }, 201);
}

async function getTopicFeed(env: Env, topicId: string): Promise<Response> {
  const topic = await env.DB
    .prepare(
      `SELECT t.id, t.folder_id, t.name, t.summary, t.created_at, t.updated_at, f.name AS folder_name
       FROM topics t JOIN folders f ON f.id = t.folder_id WHERE t.id = ?`,
    )
    .bind(topicId)
    .first();
  if (!topic) return json({ error: "Topic not found" }, 404);

  const [notes, photos, comments] = await Promise.all([
    env.DB.prepare("SELECT * FROM notes WHERE topic_id = ? ORDER BY created_at DESC").bind(topicId).all(),
    env.DB.prepare("SELECT * FROM photos WHERE topic_id = ? ORDER BY created_at DESC").bind(topicId).all(),
    env.DB.prepare("SELECT * FROM teacher_comments WHERE topic_id = ? ORDER BY created_at DESC").bind(topicId).all(),
  ]);

  const photoRows = (photos.results || []).map((photo) => ({
    ...photo,
    file_url: `/api/photos/${photo.id}/file`,
  }));

  return json({
    topic,
    notes: notes.results,
    photos: photoRows,
    comments: comments.results,
    tags: collectTags([...(notes.results || []), ...photoRows]),
  });
}

async function createNote(request: Request, db: D1Database, session: Session): Promise<Response> {
  requireOwner(session);
  const body = await readJson<{ topicId?: string; content?: string }>(request);
  if (!body.topicId) return json({ error: "topicId is required" }, 400);
  const content = cleanContent(body.content, NOTE_LIMIT);
  const id = crypto.randomUUID();
  await db
    .prepare("INSERT INTO notes (id, topic_id, author_role, content, tags_json) VALUES (?, ?, ?, ?, ?)")
    .bind(id, body.topicId, "owner", content, JSON.stringify(extractTags(content)))
    .run();
  await touchTopic(db, body.topicId);
  return json({ id }, 201);
}

async function updateNote(request: Request, db: D1Database, session: Session, noteId: string): Promise<Response> {
  requireOwner(session);
  const body = await readJson<{ content?: string }>(request);
  const content = cleanContent(body.content, NOTE_LIMIT);
  const row = await db.prepare("SELECT topic_id FROM notes WHERE id = ?").bind(noteId).first<{ topic_id: string }>();
  if (!row) return json({ error: "Note not found" }, 404);
  await db
    .prepare("UPDATE notes SET content = ?, tags_json = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?")
    .bind(content, JSON.stringify(extractTags(content)), noteId)
    .run();
  await touchTopic(db, row.topic_id);
  return json({ ok: true });
}

async function createPhoto(request: Request, env: Env, session: Session): Promise<Response> {
  requireOwner(session);
  const form = await request.formData();
  const topicId = String(form.get("topicId") || "");
  const description = String(form.get("description") || "").trim().slice(0, NOTE_LIMIT);
  const file = form.get("file");
  if (!topicId) return json({ error: "topicId is required" }, 400);
  if (!(file instanceof File)) return json({ error: "file is required" }, 400);
  if (file.type !== "image/jpeg") return json({ error: "Only compressed JPEG uploads are accepted" }, 400);
  if (file.size > MAX_WEB_PHOTO_BYTES) return json({ error: "Compressed photo is too large" }, 413);

  const id = crypto.randomUUID();
  const r2Key = `photos/${topicId}/${id}.jpg`;
  await env.PHOTOS.put(r2Key, await file.arrayBuffer(), {
    httpMetadata: { contentType: "image/jpeg" },
  });
  await env.DB
    .prepare(
      `INSERT INTO photos (id, topic_id, r2_key, filename, content_type, size_bytes, description, tags_json)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(id, topicId, r2Key, safeFilename(file.name || `${id}.jpg`), "image/jpeg", file.size, description, JSON.stringify(extractTags(description)))
    .run();
  await touchTopic(env.DB, topicId);
  return json({ id }, 201);
}

async function updatePhoto(request: Request, db: D1Database, session: Session, photoId: string): Promise<Response> {
  requireOwner(session);
  const body = await readJson<{ description?: string }>(request);
  const description = String(body.description || "").trim().slice(0, NOTE_LIMIT);
  const row = await db.prepare("SELECT topic_id FROM photos WHERE id = ?").bind(photoId).first<{ topic_id: string }>();
  if (!row) return json({ error: "Photo not found" }, 404);
  await db
    .prepare("UPDATE photos SET description = ?, tags_json = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?")
    .bind(description, JSON.stringify(extractTags(description)), photoId)
    .run();
  await touchTopic(db, row.topic_id);
  return json({ ok: true });
}

async function getPhotoFile(env: Env, photoId: string): Promise<Response> {
  const photo = await env.DB.prepare("SELECT r2_key, content_type FROM photos WHERE id = ?").bind(photoId).first<{ r2_key: string; content_type: string }>();
  if (!photo) return json({ error: "Photo not found" }, 404);
  const object = await env.PHOTOS.get(photo.r2_key);
  if (!object) return json({ error: "Photo file not found" }, 404);
  return new Response(object.body, {
    headers: {
      "Content-Type": photo.content_type,
      "Cache-Control": "private, max-age=300",
    },
  });
}

async function createComment(request: Request, db: D1Database, session: Session): Promise<Response> {
  const body = await readJson<{ topicId?: string; targetType?: string; targetId?: string; content?: string }>(request);
  if (!body.topicId) return json({ error: "topicId is required" }, 400);
  const targetType = body.targetType === "note" || body.targetType === "photo" ? body.targetType : "topic";
  const content = cleanContent(body.content, NOTE_LIMIT);
  const id = crypto.randomUUID();
  await db
    .prepare(
      `INSERT INTO teacher_comments (id, topic_id, target_type, target_id, author_role, content)
       VALUES (?, ?, ?, ?, ?, ?)`,
    )
    .bind(id, body.topicId, targetType, body.targetId || null, session.role, content)
    .run();
  return json({ id }, 201);
}

async function runTopicAiAction(request: Request, env: Env, session: Session): Promise<Response> {
  requireOwner(session);
  const body = await readJson<{ topicId?: string; action?: string }>(request);
  if (!body.topicId) return json({ error: "topicId is required" }, 400);
  const action = normalizeAiAction(body.action);
  if (!action) return json({ error: "Unknown AI action" }, 400);

  const context = await buildTopicContext(env.DB, body.topicId);
  if (!context.topicName) return json({ error: "Topic not found" }, 404);
  if (context.text.trim().length < 40) {
    return json({
      cached: false,
      response: "Данных недостаточно: в текущей теме слишком мало сохраненных заметок или описаний фото. Добавьте 2-3 короткие заметки о сюжете, героях, фактах или своем мнении.",
    });
  }

  const contentHash = await sha256(`${action}\n${context.fingerprint}`);
  const cacheKey = await sha256(`${body.topicId}\n${action}\n${contentHash}`);
  const cached = await env.DB.prepare("SELECT response FROM ai_cache WHERE cache_key = ?").bind(cacheKey).first<{ response: string }>();
  if (cached) return json({ cached: true, response: cached.response });

  const usageDate = new Date().toISOString().slice(0, 10);
  const usage = await env.DB
    .prepare("SELECT count FROM ai_usage WHERE usage_date = ? AND user_key = ?")
    .bind(usageDate, "owner")
    .first<{ count: number }>();
  if ((usage?.count || 0) >= AI_DAILY_LIMIT) {
    return json({ error: "Daily AI limit reached. Try again tomorrow." }, 429);
  }

  const response = await callOpenRouter(env, action, context);
  await env.DB
    .prepare(
      `INSERT INTO ai_usage (usage_date, user_key, count) VALUES (?, ?, 1)
       ON CONFLICT(usage_date, user_key) DO UPDATE SET count = count + 1`,
    )
    .bind(usageDate, "owner")
    .run();
  await env.DB
    .prepare("INSERT INTO ai_cache (cache_key, topic_id, action, content_hash, response) VALUES (?, ?, ?, ?, ?)")
    .bind(cacheKey, body.topicId, action, contentHash, response)
    .run();

  return json({ cached: false, response });
}

async function buildTopicContext(db: D1Database, topicId: string): Promise<{ topicName: string; text: string; fingerprint: string }> {
  const topic = await db.prepare("SELECT name FROM topics WHERE id = ?").bind(topicId).first<{ name: string }>();
  if (!topic) return { topicName: "", text: "", fingerprint: "" };
  const notes = await db.prepare("SELECT id, content, updated_at FROM notes WHERE topic_id = ? ORDER BY created_at ASC").bind(topicId).all();
  const photos = await db.prepare("SELECT id, description, updated_at FROM photos WHERE topic_id = ? AND description <> '' ORDER BY created_at ASC").bind(topicId).all();
  const textParts = [
    `Topic: ${topic.name}`,
    ...(notes.results || []).map((note) => `Note: ${note.content}`),
    ...(photos.results || []).map((photo) => `Photo description: ${photo.description}`),
  ];
  const fingerprint = JSON.stringify({ topic, notes: notes.results, photos: photos.results });
  return { topicName: topic.name, text: textParts.join("\n"), fingerprint };
}

async function callOpenRouter(env: Env, action: string, topicContext: { topicName: string; text: string }): Promise<string> {
  if (!env.OPENROUTER_API_KEY) throw httpError(500, "OPENROUTER_API_KEY is not configured");
  const model = env.OPENROUTER_MODEL || "nvidia/nemotron-3-ultra-550b-a55b:free";
  const prompt = aiInstruction(action);
  const response = await fetch(OPENROUTER_URL, {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${env.OPENROUTER_API_KEY}`,
      "Content-Type": "application/json",
      "HTTP-Referer": "https://retelling-brain-bot.local",
      "X-Title": "Retelling Brain Bot",
    },
    body: JSON.stringify({
      model,
      messages: [
        {
          role: "system",
          content:
            "You are an English retelling tutor. Use only the provided saved notes and manual photo descriptions. If there is not enough information, say so honestly in Russian first. Never invent facts.",
        },
        {
          role: "user",
          content: `${prompt}\n\nSaved material:\n${topicContext.text}`,
        },
      ],
      temperature: 0.35,
      max_tokens: 900,
    }),
  });

  if (!response.ok) {
    const details = await response.text();
    console.error("OpenRouter error", response.status, details.slice(0, 500));
    throw httpError(502, "OpenRouter request failed. Please try again later.");
  }

  const data = (await response.json()) as {
    choices?: Array<{ message?: { content?: string } }>;
  };
  const content = data.choices?.[0]?.message?.content?.trim();
  if (!content) throw httpError(502, "OpenRouter returned an empty response");
  return content;
}

function normalizeAiAction(action?: string): string | null {
  const allowed = new Set(["short", "a2", "b1", "plan", "tasks", "extract"]);
  return action && allowed.has(action) ? action : null;
}

function aiInstruction(action: string): string {
  const map: Record<string, string> = {
    short: "Make a short English retelling from the saved material. Keep it concise and clear.",
    a2: "Make an A2-level English retelling. Use simple sentences and common words.",
    b1: "Make a B1-level English retelling. Use connectors and natural but not advanced vocabulary.",
    plan: "Create an English retelling plan with 5-8 short points.",
    tasks: "Create review tasks in English for practicing this material: questions, gap-fill prompts, and 3 retelling prompts.",
    extract: "Extract useful English words, names, and facts from the saved material. Group them clearly.",
  };
  return map[action] || map.short;
}

async function handleTelegramWebhook(request: Request, env: Env): Promise<Response> {
  const update = (await request.json()) as TelegramUpdate;
  const userId = getTelegramUserId(update);
  if (!userId || !isAllowedTelegramUser(env, userId)) {
    if (userId) await telegramSend(env, userId, "Access denied.");
    return json({ ok: true });
  }

  if (update.callback_query) {
    await handleTelegramCallback(env, update.callback_query, String(userId));
    return json({ ok: true });
  }

  const message = update.message;
  if (!message) return json({ ok: true });

  if (message.text?.startsWith("/start")) {
    await telegramSend(env, userId, "Retelling Brain Bot готов. Отправьте заметку или фото, затем выберите папку и тему.");
    return json({ ok: true });
  }

  if (String(userId) === String(env.TEACHER_TELEGRAM_ID) && String(userId) !== String(env.OWNER_TELEGRAM_ID)) {
    await telegramSend(env, userId, "Доступ преподавателя активен. Комментарии удобнее добавлять в веб-панели.");
    return json({ ok: true });
  }

  if (message.text) {
    const content = cleanContent(message.text, NOTE_LIMIT);
    const draftId = crypto.randomUUID();
    await env.DB.prepare("INSERT INTO telegram_drafts (id, telegram_user_id, kind, text_content) VALUES (?, ?, 'text', ?)").bind(draftId, String(userId), content).run();
    await sendFolderPicker(env, userId, draftId);
    return json({ ok: true });
  }

  if (message.photo?.length) {
    const chosen = chooseTelegramPhoto(message.photo);
    const draftId = crypto.randomUUID();
    await env.DB
      .prepare("INSERT INTO telegram_drafts (id, telegram_user_id, kind, telegram_file_id, width, height) VALUES (?, ?, 'photo', ?, ?, ?)")
      .bind(draftId, String(userId), chosen.file_id, chosen.width, chosen.height)
      .run();
    await sendFolderPicker(env, userId, draftId);
    return json({ ok: true });
  }

  await telegramSend(env, userId, "Пока я сохраняю только текстовые заметки и фото.");
  return json({ ok: true });
}

async function handleTelegramCallback(env: Env, callback: TelegramCallbackQuery, userId: string): Promise<void> {
  const data = callback.data || "";
  const [kind, draftId, selectedId] = data.split(":");

  if (kind === "folder" && draftId && selectedId) {
    const topics = await env.DB.prepare("SELECT id, name FROM topics WHERE folder_id = ? ORDER BY created_at ASC").bind(selectedId).all<{ id: string; name: string }>();
    const rows = (topics.results || []).map((topic) => [{ text: topic.name, callback_data: `topic:${draftId}:${topic.id}` }]);
    await telegramEdit(env, callback.message.chat.id, callback.message.message_id, "Теперь выберите тему:", rows);
    return;
  }

  if (kind === "topic" && draftId && selectedId) {
    const draft = await env.DB.prepare("SELECT * FROM telegram_drafts WHERE id = ? AND telegram_user_id = ?").bind(draftId, userId).first<TelegramDraft>();
    if (!draft) {
      await telegramSend(env, callback.message.chat.id, "Черновик не найден или устарел.");
      return;
    }

    if (draft.kind === "text" && draft.text_content) {
      await env.DB
        .prepare("INSERT INTO notes (id, topic_id, author_role, content, tags_json) VALUES (?, ?, 'owner', ?, ?)")
        .bind(crypto.randomUUID(), selectedId, draft.text_content, JSON.stringify(extractTags(draft.text_content)))
        .run();
    }

    if (draft.kind === "photo" && draft.telegram_file_id) {
      await saveTelegramPhoto(env, selectedId, draft.telegram_file_id);
    }

    await env.DB.prepare("DELETE FROM telegram_drafts WHERE id = ?").bind(draftId).run();
    await touchTopic(env.DB, selectedId);
    await telegramEdit(env, callback.message.chat.id, callback.message.message_id, "Сохранено в выбранную тему.", []);
  }
}

async function sendFolderPicker(env: Env, chatId: number, draftId: string): Promise<void> {
  const folders = await env.DB.prepare("SELECT id, name FROM folders ORDER BY created_at ASC").all<{ id: string; name: string }>();
  const rows = (folders.results || []).map((folder) => [{ text: folder.name, callback_data: `folder:${draftId}:${folder.id}` }]);
  await telegramSend(env, chatId, "Выберите папку:", rows);
}

async function saveTelegramPhoto(env: Env, topicId: string, fileId: string): Promise<void> {
  if (!env.TELEGRAM_BOT_TOKEN) throw new Error("TELEGRAM_BOT_TOKEN is not configured");
  const fileResponse = await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/getFile?file_id=${encodeURIComponent(fileId)}`);
  const fileData = (await fileResponse.json()) as { ok: boolean; result?: { file_path?: string } };
  const filePath = fileData.result?.file_path;
  if (!fileData.ok || !filePath) throw new Error("Telegram getFile failed");

  const imageResponse = await fetch(`https://api.telegram.org/file/bot${env.TELEGRAM_BOT_TOKEN}/${filePath}`);
  if (!imageResponse.ok) throw new Error("Telegram photo download failed");
  const bytes = await imageResponse.arrayBuffer();
  const id = crypto.randomUUID();
  const r2Key = `photos/${topicId}/${id}.jpg`;
  await env.PHOTOS.put(r2Key, bytes, { httpMetadata: { contentType: "image/jpeg" } });
  await env.DB
    .prepare(
      `INSERT INTO photos (id, topic_id, r2_key, filename, content_type, size_bytes, description, tags_json)
       VALUES (?, ?, ?, ?, 'image/jpeg', ?, '', '[]')`,
    )
    .bind(id, topicId, r2Key, `${id}.jpg`, bytes.byteLength)
    .run();
}

function chooseTelegramPhoto(photos: TelegramPhotoSize[]): TelegramPhotoSize {
  const sorted = [...photos].sort((a, b) => Math.max(a.width, a.height) - Math.max(b.width, b.height));
  return sorted.find((photo) => Math.max(photo.width, photo.height) >= 1000 && Math.max(photo.width, photo.height) <= 1600) || sorted[sorted.length - 1];
}

async function telegramSend(env: Env, chatId: number | string, text: string, keyboard?: Array<Array<{ text: string; callback_data: string }>>): Promise<void> {
  if (!env.TELEGRAM_BOT_TOKEN) return;
  await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      chat_id: chatId,
      text,
      reply_markup: keyboard?.length ? { inline_keyboard: keyboard } : undefined,
    }),
  });
}

async function telegramEdit(
  env: Env,
  chatId: number | string,
  messageId: number,
  text: string,
  keyboard: Array<Array<{ text: string; callback_data: string }>>,
): Promise<void> {
  if (!env.TELEGRAM_BOT_TOKEN) return;
  await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/editMessageText`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      chat_id: chatId,
      message_id: messageId,
      text,
      reply_markup: keyboard.length ? { inline_keyboard: keyboard } : undefined,
    }),
  });
}

function isAllowedTelegramUser(env: Env, userId: number): boolean {
  return String(userId) === String(env.OWNER_TELEGRAM_ID) || String(userId) === String(env.TEACHER_TELEGRAM_ID || "126041348");
}

function getTelegramUserId(update: TelegramUpdate): number | null {
  return update.message?.from?.id || update.callback_query?.from?.id || null;
}

function extractTags(value: string): string[] {
  const matches = value.match(/#[\p{L}\p{N}_-]+/gu) || [];
  return [...new Set(matches.map((tag) => tag.toLowerCase()))];
}

function collectTags(rows: Array<Record<string, unknown>>): string[] {
  const tags = new Set<string>();
  for (const row of rows) {
    try {
      const parsed = JSON.parse(String(row.tags_json || "[]")) as string[];
      parsed.forEach((tag) => tags.add(tag));
    } catch {
      // Ignore malformed legacy tag JSON.
    }
  }
  return [...tags].sort();
}

function cleanName(value: string | undefined, limit: number): string {
  const name = String(value || "").trim().replace(/\s+/g, " ").slice(0, limit);
  if (!name) throw httpError(400, "Name is required");
  return name;
}

function cleanContent(value: string | undefined, limit: number): string {
  const content = String(value || "").trim();
  if (!content) throw httpError(400, "Content is required");
  if (content.length > limit) throw httpError(400, `Content is limited to ${limit} characters`);
  return content;
}

function safeFilename(value: string): string {
  return value.replace(/[^\p{L}\p{N}._-]/gu, "_").slice(0, 120) || "photo.jpg";
}

function slug(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/(^-|-$)/g, "");
}

async function readJson<T>(request: Request): Promise<T> {
  try {
    return (await request.json()) as T;
  } catch {
    throw httpError(400, "Invalid JSON");
  }
}

async function touchTopic(db: D1Database, topicId: string): Promise<void> {
  await db.prepare("UPDATE topics SET updated_at = CURRENT_TIMESTAMP WHERE id = ?").bind(topicId).run();
}

function requireOwner(session: Session): void {
  if (session.role !== "owner") throw httpError(403, "Owner access required");
}

function httpError(status: number, message: string): Error & { status?: number } {
  const error = new Error(message) as Error & { status?: number };
  error.status = status;
  return error;
}

async function sha256(value: string): Promise<string> {
  return base64Url(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value)));
}

function base64Url(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function parseCookies(header: string | null): Record<string, string> {
  const cookies: Record<string, string> = {};
  for (const part of (header || "").split(";")) {
    const [key, ...rest] = part.trim().split("=");
    if (key) cookies[key] = rest.join("=");
  }
  return cookies;
}

function corsHeaders(): HeadersInit {
  return {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET,POST,PATCH,OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
  };
}

function json(data: unknown, status = 200, headers: HeadersInit = {}): Response {
  return Response.json(data, {
    status,
    headers: {
      "Cache-Control": "no-store",
      ...headers,
    },
  });
}

interface TelegramUpdate {
  message?: TelegramMessage;
  callback_query?: TelegramCallbackQuery;
}

interface TelegramMessage {
  message_id: number;
  from?: { id: number };
  chat: { id: number };
  text?: string;
  photo?: TelegramPhotoSize[];
}

interface TelegramPhotoSize {
  file_id: string;
  width: number;
  height: number;
}

interface TelegramCallbackQuery {
  id: string;
  from: { id: number };
  data?: string;
  message: {
    message_id: number;
    chat: { id: number };
  };
}

interface TelegramDraft {
  id: string;
  telegram_user_id: string;
  kind: "text" | "photo";
  text_content?: string;
  telegram_file_id?: string;
}
