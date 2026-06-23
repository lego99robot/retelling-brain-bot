export interface Env {
  DB: D1Database;
  PHOTOS?: R2Bucket;
  TELEGRAM_BOT_TOKEN?: string;
  OWNER_TELEGRAM_ID?: string;
  TEACHER_TELEGRAM_ID?: string;
  WEB_PASSWORD?: string;
  WEB_PASSWORD_TEATH?: string;
  OPENROUTER_API_KEY?: string;
  OPENROUTER_MODEL?: string;
  UPSTASH_VECTOR_REST_URL?: string;
  UPSTASH_VECTOR_REST_TOKEN?: string;
  UPSTASH_VECTOR_NAMESPACE?: string;
  UPSTASH_VECTOR_INDEX_ID?: string;
}

type Role = "owner" | "teacher";
type Session = { role: Role };
type ApiContext = EventContext<Env, string, unknown>;
type AiContext = { topicName: string; text: string; fingerprint: string; ragFilter?: string; ragQuery?: string };
type UpstashVectorResult = { id: string; score?: number; data?: unknown; metadata?: Record<string, unknown> };
type RagReindexOptions = { offset?: unknown; limit?: unknown; reset?: unknown };
type RagVector = { id: string; data: string; metadata: Record<string, unknown> };
type OpenLibraryBook = {
  title: string;
  authors: string[];
  firstPublishYear?: number;
  coverUrl?: string;
  workKey?: string;
  openLibraryUrl?: string;
};

const DEFAULT_FOLDERS = ["Books", "Films", "Videos", "Vocabulary", "Inbox"] as const;
const AI_DAILY_LIMIT = 10;
const NOTE_LIMIT = 1000;
const MAX_WEB_PHOTO_BYTES = 3 * 1024 * 1024;
const OPENROUTER_URL = "https://openrouter.ai/api/v1/chat/completions";
const OPENROUTER_TIMEOUT_MS = 60_000;
const OPEN_LIBRARY_SEARCH_URL = "https://openlibrary.org/search.json";
const NOTE_TYPES = [
  { id: "photo", label: "Photo", tag: "#photo" },
  { id: "plot", label: "Plot", tag: "#plot" },
  { id: "words", label: "Words", tag: "#words" },
  { id: "facts", label: "Facts", tag: "#facts" },
  { id: "names", label: "Names", tag: "#names" },
  { id: "opinion", label: "Opinion", tag: "#opinion" },
  { id: "retelling", label: "Retelling", tag: "#retelling" },
] as const;

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
    return handleTelegramWebhook(request, env, context);
  }

  if (parts[0] === "auth" && parts[1] === "login" && method === "POST") {
    return login(request, env);
  }

  if (parts[0] === "auth" && parts[1] === "logout" && method === "POST") {
    return logout(request);
  }

  const session = await requireSession(request, env);
  await ensureDefaults(env.DB);

  if (parts[0] === "me" && method === "GET") {
    return json({ role: session.role });
  }

  if (parts[0] === "admin" && parts[1] === "telegram-webhook" && method === "POST") {
    requireOwner(session);
    return setTelegramWebhook(request, env);
  }

  if (parts[0] === "folders") {
    if (method === "GET") return listFolders(env.DB);
    if (method === "POST") return createFolder(request, env.DB, session);
  }

  if (parts[0] === "topics") {
    if (method === "GET" && parts.length === 1) return listTopics(request, env.DB);
    if (method === "POST" && parts.length === 1) return createTopic(request, env.DB, session);
    if (method === "PATCH" && parts[1] && parts.length === 2) return updateTopic(request, env.DB, session, parts[1]);
    if (method === "GET" && parts[2] === "feed") return getTopicFeed(env, parts[1]);
  }

  if (parts[0] === "notes") {
    if (method === "POST") return createNote(request, env, session, context);
    if (method === "PATCH" && parts[1]) return updateNote(request, env, session, parts[1], context);
  }

  if (parts[0] === "photos") {
    if (method === "POST") return createPhoto(request, env, session, context);
    if (method === "PATCH" && parts[1]) return updatePhoto(request, env, session, parts[1], context);
    if (method === "GET" && parts[1] && parts[2] === "file") return getPhotoFile(env, parts[1]);
  }

  if (parts[0] === "comments" && method === "POST") {
    return createComment(request, env.DB, session);
  }

  if (parts[0] === "ai" && parts[1] === "topic-action" && method === "POST") {
    return runTopicAiAction(request, env, session);
  }

  if (parts[0] === "open-library" && parts[1] === "search" && method === "GET") {
    return openLibrarySearch(request);
  }

  if (parts[0] === "rag" && parts[1] === "reindex" && method === "POST") {
    return reindexRag(request, env, session);
  }

  return json({ error: "Not found" }, 404);
}

async function login(request: Request, env: Env): Promise<Response> {
  const body = await readJson<{ password?: string; role?: Role }>(request);
  const role: Role = body.role === "teacher" ? "teacher" : "owner";
  if (!env.WEB_PASSWORD) return json({ error: "WEB_PASSWORD is not configured" }, 500);
  const expectedPassword = role === "teacher" ? env.WEB_PASSWORD_TEATH || env.WEB_PASSWORD : env.WEB_PASSWORD;
  if (!body.password || body.password !== expectedPassword) return json({ error: "Invalid password" }, 401);

  const cookie = await createSessionCookie(env, role, request.url);
  return json({ role }, 200, { "Set-Cookie": cookie });
}

function logout(request: Request): Response {
  const secure = new URL(request.url).protocol === "https:" ? " Secure;" : "";
  return json({ ok: true }, 200, {
    "Set-Cookie": `rb_session=; Path=/; Max-Age=0; HttpOnly; SameSite=Lax;${secure}`,
  });
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
  statements.push(
    db.prepare(
      "CREATE TABLE IF NOT EXISTS telegram_processed_updates (update_id INTEGER PRIMARY KEY, telegram_user_id TEXT, status TEXT NOT NULL DEFAULT 'processing', created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP)",
    ),
  );
  statements.push(db.prepare("CREATE INDEX IF NOT EXISTS idx_processed_updates_created ON telegram_processed_updates(created_at)"));
  statements.push(db.prepare("CREATE INDEX IF NOT EXISTS idx_processed_updates_status_updated ON telegram_processed_updates(status, updated_at)"));
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

async function updateTopic(request: Request, db: D1Database, session: Session, topicId: string): Promise<Response> {
  requireOwner(session);
  const body = await readJson<{ name?: string; summary?: string }>(request);
  const existing = await db.prepare("SELECT id, name, summary FROM topics WHERE id = ?").bind(topicId).first<{ id: string; name: string; summary: string }>();
  if (!existing) return json({ error: "Study block not found" }, 404);

  const name = body.name === undefined ? existing.name : cleanName(body.name, 60);
  const summary = body.summary === undefined ? existing.summary : String(body.summary || "").trim().slice(0, 600);
  await db
    .prepare("UPDATE topics SET name = ?, summary = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?")
    .bind(name, summary, topicId)
    .run();
  return json({ ok: true, id: topicId, name, summary });
}

async function getTopicFeed(env: Env, topicId: string): Promise<Response> {
  const topic = await env.DB
    .prepare(
      `SELECT t.id, t.folder_id, t.name, t.summary, t.created_at, t.updated_at, f.name AS folder_name
       FROM topics t JOIN folders f ON f.id = t.folder_id WHERE t.id = ?`,
    )
    .bind(topicId)
    .first();
  if (!topic) return json({ error: "Study block not found" }, 404);

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

async function createNote(request: Request, env: Env, session: Session, context: ApiContext): Promise<Response> {
  requireOwner(session);
  const body = await readJson<{ topicId?: string; content?: string }>(request);
  if (!body.topicId) return json({ error: "topicId is required" }, 400);
  const content = cleanContent(body.content, NOTE_LIMIT);
  const id = crypto.randomUUID();
  await env.DB
    .prepare("INSERT INTO notes (id, topic_id, author_role, content, tags_json) VALUES (?, ?, ?, ?, ?)")
    .bind(id, body.topicId, "owner", content, JSON.stringify(extractTags(content)))
    .run();
  await touchTopic(env.DB, body.topicId);
  queueRagAutoIndex(context, env, "note", id);
  return json({ id }, 201);
}

async function updateNote(request: Request, env: Env, session: Session, noteId: string, context: ApiContext): Promise<Response> {
  requireOwner(session);
  const body = await readJson<{ content?: string }>(request);
  const content = cleanContent(body.content, NOTE_LIMIT);
  const row = await env.DB.prepare("SELECT topic_id FROM notes WHERE id = ?").bind(noteId).first<{ topic_id: string }>();
  if (!row) return json({ error: "Note not found" }, 404);
  await env.DB
    .prepare("UPDATE notes SET content = ?, tags_json = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?")
    .bind(content, JSON.stringify(extractTags(content)), noteId)
    .run();
  await touchTopic(env.DB, row.topic_id);
  queueRagAutoIndex(context, env, "note", noteId);
  return json({ ok: true });
}

async function createPhoto(request: Request, env: Env, session: Session, context: ApiContext): Promise<Response> {
  requireOwner(session);
  if (!env.PHOTOS) {
    return json({ error: "Photo storage is not configured. Enable R2 to upload photos from the web panel." }, 503);
  }
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
  queueRagAutoIndex(context, env, "photo", id);
  return json({ id }, 201);
}

async function updatePhoto(request: Request, env: Env, session: Session, photoId: string, context: ApiContext): Promise<Response> {
  requireOwner(session);
  const body = await readJson<{ description?: string }>(request);
  const description = String(body.description || "").trim().slice(0, NOTE_LIMIT);
  const row = await env.DB.prepare("SELECT topic_id FROM photos WHERE id = ?").bind(photoId).first<{ topic_id: string }>();
  if (!row) return json({ error: "Photo not found" }, 404);
  await env.DB
    .prepare("UPDATE photos SET description = ?, tags_json = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?")
    .bind(description, JSON.stringify(extractTags(description)), photoId)
    .run();
  await touchTopic(env.DB, row.topic_id);
  queueRagAutoIndex(context, env, "photo", photoId);
  return json({ ok: true });
}
async function getPhotoFile(env: Env, photoId: string): Promise<Response> {
  const photo = await env.DB.prepare("SELECT r2_key, content_type FROM photos WHERE id = ?").bind(photoId).first<{ r2_key: string; content_type: string }>();
  if (!photo) return json({ error: "Photo not found" }, 404);
  if (photo.r2_key.startsWith("telegram:")) {
    return getTelegramPhotoFile(env, photo.r2_key.slice("telegram:".length));
  }
  if (!env.PHOTOS) return json({ error: "Photo storage is not configured" }, 503);
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

async function openLibrarySearch(request: Request): Promise<Response> {
  const query = new URL(request.url).searchParams.get("q") || "";
  const results = await searchOpenLibrary(query, 5);
  return json({ results });
}

async function searchOpenLibrary(rawQuery: string, limit = 3): Promise<OpenLibraryBook[]> {
  const query = rawQuery.trim().replace(/\s+/g, " ").slice(0, 120);
  if (!query) throw httpError(400, "Search query is required");

  const url = new URL(OPEN_LIBRARY_SEARCH_URL);
  url.searchParams.set("q", query);
  url.searchParams.set("limit", String(Math.min(5, Math.max(1, limit))));
  url.searchParams.set("fields", "key,title,author_name,first_publish_year,cover_i");

  const response = await fetch(url.toString(), {
    headers: { "Accept": "application/json" },
  });
  if (!response.ok) throw httpError(502, "Open Library is temporarily unavailable");

  const data = (await response.json()) as {
    docs?: Array<{
      key?: string;
      title?: string;
      author_name?: string[];
      first_publish_year?: number;
      cover_i?: number;
    }>;
  };

  return (data.docs || [])
    .filter((item) => item.title)
    .slice(0, limit)
    .map((item) => {
      const workKey = item.key || "";
      const openLibraryUrl = workKey ? `https://openlibrary.org${workKey}` : undefined;
      const coverUrl = item.cover_i ? `https://covers.openlibrary.org/b/id/${item.cover_i}-M.jpg` : undefined;
      return {
        title: String(item.title),
        authors: Array.isArray(item.author_name) ? item.author_name.slice(0, 3).map(String) : [],
        firstPublishYear: item.first_publish_year,
        coverUrl,
        workKey,
        openLibraryUrl,
      };
    });
}

function extractOpenLibraryQuery(text: string): string | null {
  const trimmed = text.trim().replace(/\s+/g, " ");
  if (!trimmed) return null;

  const direct = trimmed.match(/^(?:open\s*library|�����\s+�\s+open\s*library|�����\s+�\s+open\s*library)\s+(.+)$/iu);
  if (direct?.[1]) return cleanOpenLibraryQuery(direct[1]);

  const bookSearch = trimmed.match(/^(?:�����|�����|�����)\s+(?:�����|book)\s+(.+)$/iu);
  if (bookSearch?.[1]) return cleanOpenLibraryQuery(bookSearch[1]);

  return null;
}

function cleanOpenLibraryQuery(value: string): string | null {
  const query = value.replace(/\s+(?:�\s+)?open\s*library\s*$/iu, "").trim();
  return query.length >= 2 ? query.slice(0, 120) : null;
}

async function handleTelegramOpenLibrarySearch(env: Env, chatId: number, text: string): Promise<boolean> {
  const query = extractOpenLibraryQuery(text);
  if (!query) return false;

  try {
    const results = await searchOpenLibrary(query, 3);
    if (!results.length) {
      await telegramSend(env, chatId, `Open Library ������ �� ����� �� �������: ${query}`);
      return true;
    }
    await telegramSendLong(env, chatId, formatOpenLibraryTelegramResults(query, results));
  } catch (error) {
    console.error("Open Library Telegram search failed", error);
    await telegramSend(env, chatId, "Open Library ������ ����������. ���������� �����, ������� ������� � ����� �� ������ ���������� ��������.");
  }
  return true;
}

function formatOpenLibraryTelegramResults(query: string, results: OpenLibraryBook[]): string {
  const lines = [`Open Library: ���������� �� ������� "${query}"`];
  results.forEach((book, index) => {
    lines.push("", `${index + 1}. ${book.title}`);
    if (book.authors.length) lines.push(`Author: ${book.authors.join(", ")}`);
    if (book.firstPublishYear) lines.push(`First published: ${book.firstPublishYear}`);
    if (book.openLibraryUrl) lines.push(`Open Library: ${book.openLibraryUrl}`);
    if (book.coverUrl) lines.push(`Cover: ${book.coverUrl}`);
  });
  lines.push("", "��� ���������� ��������. ��� �� ��������� � ���� ������ � �� ��������� � RAG.");
  return lines.join("\n");
}
async function runTopicAiAction(request: Request, env: Env, session: Session): Promise<Response> {
  requireOwner(session);
  const body = await readJson<{ topicId?: string; action?: string }>(request);
  if (!body.topicId) return json({ error: "topicId is required" }, 400);
  const action = normalizeAiAction(body.action);
  if (!action) return json({ error: "Unknown AI action" }, 400);

  const context = await buildRagEnhancedTopicContext(env, body.topicId, action);
  if (!context.topicName) return json({ error: "Study block not found" }, 404);
  if (context.text.trim().length < 40) {
    return json({
      cached: false,
      response: "Данных недостаточно: в текущем учебном блоке слишком мало сохраненных заметок или описаний фото. Добавьте 2-3 короткие заметки о сюжете, героях, фактах или своем мнении.",
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

async function buildTopicContext(db: D1Database, topicId: string): Promise<AiContext> {
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
  return { topicName: topic.name, text: textParts.join("\n"), fingerprint, ragFilter: `topicId = '${escapeRagFilterValue(topicId)}'`, ragQuery: topic.name };
}

async function buildFolderContext(db: D1Database, folderId: string): Promise<AiContext> {
  const folder = await db.prepare("SELECT id, name FROM folders WHERE id = ?").bind(folderId).first<{ id: string; name: string }>();
  if (!folder) return { topicName: "", text: "", fingerprint: "" };
  const notes = await db
    .prepare(
      `SELECT t.name AS topic_name, n.id, n.content, n.updated_at
       FROM notes n JOIN topics t ON t.id = n.topic_id
       WHERE t.folder_id = ?
       ORDER BY t.created_at ASC, n.created_at ASC`,
    )
    .bind(folderId)
    .all<{ topic_name: string; id: string; content: string; updated_at: string }>();
  const photos = await db
    .prepare(
      `SELECT t.name AS topic_name, p.id, p.description, p.updated_at
       FROM photos p JOIN topics t ON t.id = p.topic_id
       WHERE t.folder_id = ? AND p.description <> ''
       ORDER BY t.created_at ASC, p.created_at ASC`,
    )
    .bind(folderId)
    .all<{ topic_name: string; id: string; description: string; updated_at: string }>();
  const textParts = [
    `Folder: ${folder.name}`,
    ...(notes.results || []).map((note) => `Study block "${note.topic_name}" note: ${note.content}`),
    ...(photos.results || []).map((photo) => `Study block "${photo.topic_name}" photo description: ${photo.description}`),
  ];
  const fingerprint = JSON.stringify({ folder, notes: notes.results, photos: photos.results });
  return { topicName: folder.name, text: textParts.join("\n").slice(0, 12000), fingerprint, ragFilter: `folderId = '${escapeRagFilterValue(folder.id)}'`, ragQuery: folder.name };
}

async function buildTopicsContext(db: D1Database, topics: Array<{ id: string; name: string }>, label: string): Promise<AiContext> {
  if (!topics.length) return { topicName: "", text: "", fingerprint: "" };
  const contexts = await Promise.all(topics.map((topic) => buildTopicContext(db, topic.id)));
  const textParts = [`Selected study blocks: ${label}`];
  for (const context of contexts) {
    if (context.text.trim()) textParts.push(context.text);
  }
  const fingerprint = JSON.stringify({ label, topics, contexts: contexts.map((context) => context.fingerprint) });
  const topicIds = topics.map((topic) => `'${escapeRagFilterValue(topic.id)}'`).join(", ");
  return { topicName: label, text: textParts.join("\n\n").slice(0, 12000), fingerprint, ragFilter: `topicId IN (${topicIds})`, ragQuery: label };
}

async function buildRagEnhancedTopicContext(env: Env, topicId: string, action: string): Promise<AiContext> {
  const context = await buildTopicContext(env.DB, topicId);
  if (!context.topicName) return context;
  return enhanceContextWithRag(env, context, `${aiInstruction(action)} ${context.topicName}`);
}

async function enhanceContextWithRag(env: Env, context: AiContext, query: string): Promise<AiContext> {
  if (!hasRagConfig(env) || !context.ragFilter) return context;

  try {
    const results = (await upstashVectorRequest(env, `query-data/${encodeURIComponent(getRagNamespace(env))}`, {
      data: `${query}\n${context.ragQuery || context.topicName}`,
      topK: 10,
      includeData: true,
      includeMetadata: true,
      filter: context.ragFilter,
    })) as UpstashVectorResult[];

    const chunks = results
      .filter((result) => String(result.data || "").trim())
      .map((result, index) => {
        const metadata = result.metadata || {};
        const location = [metadata.folder, metadata.book, metadata.studyBlock, metadata.noteType].filter(Boolean).join(" / ");
        return `RAG chunk ${index + 1}${location ? ` (${location})` : ""}: ${String(result.data).trim()}`;
      });

    if (!chunks.length) return context;
    const text = [`Relevant RAG memory for: ${context.topicName}`, ...chunks, "Fallback saved material:", context.text].join("\n\n").slice(0, 12000);
    const fingerprint = JSON.stringify({ base: context.fingerprint, rag: results.map((result) => ({ id: result.id, score: result.score, metadata: result.metadata })) });
    return { ...context, text, fingerprint };
  } catch (error) {
    console.error("Upstash RAG query failed", error);
    return context;
  }
}
async function reindexRag(request: Request, env: Env, session: Session): Promise<Response> {
  requireOwner(session);
  if (!hasRagConfig(env)) return json({ error: "UPSTASH_VECTOR_REST_URL and UPSTASH_VECTOR_REST_TOKEN are not configured" }, 500);

  let step = "parse";
  try {
    const options = await readRagReindexOptions(request);
    const offset = Math.max(0, Math.floor(Number(options.offset) || 0));
    const rawLimit = Math.floor(Number(options.limit) || 5);
    const limit = Math.min(10, Math.max(1, rawLimit));
    const shouldReset = options.reset === true || (options.reset !== false && offset === 0);

    step = "collect";
    const namespaceName = getRagNamespace(env);
    const namespacePath = encodeURIComponent(namespaceName);
    const rows = await collectRagRows(env.DB);
    const vectors = rows.map((row) => {
      const tags = parseTagsJson(row.tags_json);
      const noteType = inferNoteTypeFromTags(tags);
      const book = bookTitleFromStudyBlock(row.topic_name) || row.topic_name;
      const chapter = extractChapterNumber(row.topic_name);
      const data = [
        `Folder: ${row.folder_name}`,
        `Book: ${book}`,
        `Study block: ${row.topic_name}`,
        chapter ? `Chapter: ${chapter}` : "",
        `Type: ${noteType}`,
        row.content,
      ]
        .filter(Boolean)
        .join("\n");
      return {
        id: `${row.source_type}:${row.source_id}`,
        data,
        metadata: {
          folder: row.folder_name,
          folderId: row.folder_id,
          book,
          studyBlock: row.topic_name,
          topicId: row.topic_id,
          chapter,
          noteType,
          tags,
          sourceType: row.source_type,
          sourceId: row.source_id,
          createdAt: row.created_at,
          updatedAt: row.updated_at,
        },
      };
    });

    if (shouldReset) {
      step = "reset";
      await upstashVectorRequest(env, `reset/${namespacePath}`, []);
    }

    const batch = vectors.slice(offset, offset + limit);
    step = "upsert";
    if (batch.length) {
      await upstashVectorRequest(env, `upsert-data/${namespacePath}`, batch);
    }

    const nextOffset = offset + batch.length;
    return json({
      ok: true,
      namespace: namespaceName,
      total: vectors.length,
      offset,
      limit,
      indexed: batch.length,
      nextOffset,
      done: nextOffset >= vectors.length,
    });
  } catch (error) {
    console.error("Upstash RAG reindex failed", { step, error });
    return json({ ok: false, error: "Upstash RAG reindex failed", step, message: error instanceof Error ? error.message : String(error) }, 200);
  }
}

async function readRagReindexOptions(request: Request): Promise<RagReindexOptions> {
  if (!request.headers.get("content-type")?.toLowerCase().includes("application/json")) return {};
  try {
    const value = await request.json();
    return value && typeof value === "object" ? (value as RagReindexOptions) : {};
  } catch {
    return {};
  }
}
function ragVectorFromRow(row: RagSourceRow): RagVector {
  const tags = parseTagsJson(row.tags_json);
  const noteType = inferNoteTypeFromTags(tags);
  const book = bookTitleFromStudyBlock(row.topic_name) || row.topic_name;
  const chapter = extractChapterNumber(row.topic_name);
  const data = [
    `Folder: ${row.folder_name}`,
    `Book: ${book}`,
    `Study block: ${row.topic_name}`,
    chapter ? `Chapter: ${chapter}` : "",
    `Type: ${noteType}`,
    row.content,
  ]
    .filter(Boolean)
    .join("\n");
  return {
    id: `${row.source_type}:${row.source_id}`,
    data,
    metadata: {
      folder: row.folder_name,
      folderId: row.folder_id,
      book,
      studyBlock: row.topic_name,
      topicId: row.topic_id,
      chapter,
      noteType,
      tags,
      sourceType: row.source_type,
      sourceId: row.source_id,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    },
  };
}

function queueRagAutoIndex(context: ApiContext, env: Env, sourceType: "note" | "photo", sourceId: string): void {
  if (!hasRagConfig(env)) return;
  context.waitUntil(
    autoIndexRagSource(env, sourceType, sourceId).catch((error) => {
      console.error("RAG auto-index failed", { sourceType, sourceId, error });
    }),
  );
}

async function autoIndexRagSource(env: Env, sourceType: "note" | "photo", sourceId: string): Promise<void> {
  const row = await getRagSourceRow(env.DB, sourceType, sourceId);
  if (!row) {
    await deleteRagVector(env, `${sourceType}:${sourceId}`);
    return;
  }
  await upstashVectorRequest(env, `upsert-data/${encodeURIComponent(getRagNamespace(env))}`, [ragVectorFromRow(row)]);
}

async function deleteRagVector(env: Env, vectorId: string): Promise<void> {
  if (!hasRagConfig(env)) return;
  await upstashVectorRequest(env, `delete/${encodeURIComponent(getRagNamespace(env))}`, { ids: [vectorId] });
}

async function getRagSourceRow(db: D1Database, sourceType: "note" | "photo", sourceId: string): Promise<RagSourceRow | null> {
  if (sourceType === "note") {
    return db
      .prepare(
        `SELECT 'note' AS source_type, n.id AS source_id, n.content AS content, n.tags_json,
          n.created_at AS created_at, n.updated_at AS updated_at, t.id AS topic_id, t.name AS topic_name, f.id AS folder_id, f.name AS folder_name
         FROM notes n
         JOIN topics t ON t.id = n.topic_id
         JOIN folders f ON f.id = t.folder_id
         WHERE n.id = ? AND f.name = 'Books'`,
      )
      .bind(sourceId)
      .first<RagSourceRow>();
  }

  return db
    .prepare(
      `SELECT 'photo' AS source_type, p.id AS source_id, p.description AS content, p.tags_json,
        p.created_at AS created_at, p.updated_at AS updated_at, t.id AS topic_id, t.name AS topic_name, f.id AS folder_id, f.name AS folder_name
       FROM photos p
       JOIN topics t ON t.id = p.topic_id
       JOIN folders f ON f.id = t.folder_id
       WHERE p.id = ? AND f.name = 'Books' AND p.description <> ''`,
    )
    .bind(sourceId)
    .first<RagSourceRow>();
}
async function collectRagRows(db: D1Database): Promise<RagSourceRow[]> {
  const result = await db
    .prepare(
      `SELECT 'note' AS source_type, n.id AS source_id, n.content AS content, n.tags_json,
        n.created_at AS created_at, n.updated_at AS updated_at, t.id AS topic_id, t.name AS topic_name, f.id AS folder_id, f.name AS folder_name
       FROM notes n
       JOIN topics t ON t.id = n.topic_id
       JOIN folders f ON f.id = t.folder_id
       WHERE f.name = 'Books'
       UNION ALL
       SELECT 'photo' AS source_type, p.id AS source_id, p.description AS content, p.tags_json,
        p.created_at AS created_at, p.updated_at AS updated_at, t.id AS topic_id, t.name AS topic_name, f.id AS folder_id, f.name AS folder_name
       FROM photos p
       JOIN topics t ON t.id = p.topic_id
       JOIN folders f ON f.id = t.folder_id
       WHERE f.name = 'Books' AND p.description <> ''
       ORDER BY topic_name ASC, created_at ASC`,
    )
    .all<RagSourceRow>();
  return (result.results || []).filter((row) => row.content.trim());
}

function hasRagConfig(env: Env): boolean {
  return Boolean(env.UPSTASH_VECTOR_REST_URL && env.UPSTASH_VECTOR_REST_TOKEN);
}

function cleanEnvValue(value: string): string {
  return value.trim().replace(/^['"]|['"]$/g, "");
}

async function upstashVectorRequest(env: Env, endpoint: string, body: unknown): Promise<unknown> {
  if (!env.UPSTASH_VECTOR_REST_URL || !env.UPSTASH_VECTOR_REST_TOKEN) {
    throw new Error("Upstash Vector is not configured");
  }

  const baseUrl = cleanEnvValue(env.UPSTASH_VECTOR_REST_URL).replace(/\/+$/, "");
  const response = await fetch(`${baseUrl}/${endpoint}`, {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${cleanEnvValue(env.UPSTASH_VECTOR_REST_TOKEN)}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });

  const text = await response.text();
  let payload: { result?: unknown; error?: unknown } | null = null;
  if (text) {
    try {
      payload = JSON.parse(text) as { result?: unknown; error?: unknown };
    } catch {
      payload = null;
    }
  }

  if (!response.ok || payload?.error) {
    const message = payload?.error ? String(payload.error) : text.slice(0, 300) || response.statusText;
    throw new Error(`Upstash ${endpoint} failed (${response.status}): ${message}`);
  }

  return payload && "result" in payload ? payload.result : payload;
}
function getRagNamespace(env: Env): string {
  return env.UPSTASH_VECTOR_NAMESPACE || "retelling-brain-bot";
}

function parseTagsJson(value: string): string[] {
  try {
    const parsed = JSON.parse(value) as unknown;
    return Array.isArray(parsed) ? parsed.map(String) : [];
  } catch {
    return [];
  }
}

function inferNoteTypeFromTags(tags: string[]): string {
  const normalized = tags.map((tag) => tag.toLowerCase());
  const known = ["#plot", "#words", "#facts", "#names", "#opinion", "#retelling", "#photo"];
  return known.find((tag) => normalized.includes(tag))?.replace("#", "") || "note";
}

function escapeRagFilterValue(value: string): string {
  return value.replace(/'/g, "''");
}

async function callOpenRouter(env: Env, action: string, topicContext: AiContext, languageInstruction = ""): Promise<string> {
  if (!env.OPENROUTER_API_KEY) throw httpError(500, "OPENROUTER_API_KEY is not configured");
  const model = env.OPENROUTER_MODEL || "nvidia/nemotron-3-ultra-550b-a55b:free";
  const prompt = `${aiInstruction(action)}${languageInstruction ? `\n${languageInstruction}` : ""}`;
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), OPENROUTER_TIMEOUT_MS);
  let response: Response;
  try {
    response = await fetch(OPENROUTER_URL, {
      method: "POST",
      signal: controller.signal,
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
              "You are an English retelling tutor. Use only the provided saved notes and manual photo descriptions. If there is not enough information, say so honestly in the requested answer language; if no language is requested, say it in Russian. Never invent facts.",
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
  } catch (error) {
    if (error instanceof Error && error.name === "AbortError") {
      throw httpError(504, "OpenRouter request timed out. Please try again later.");
    }
    throw error;
  } finally {
    clearTimeout(timeoutId);
  }

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
    answer: "Answer the user question using only the saved material. If the saved material does not contain the answer, say that the information is not in the saved memory and suggest what to add.",
  };
  return map[action] || map.short;
}

async function handleTelegramAiTextRequest(env: Env, chatId: number, text: string): Promise<boolean> {
  const action = inferAiAction(text);
  if (!action) return false;

  const scope = await inferTelegramAiScope(env.DB, text);
  if ("message" in scope) {
    await telegramSend(env, chatId, scope.message);
    return true;
  }

  const context = await enhanceContextWithRag(env, scope.context, text);
  if (!context.topicName) {
    await telegramSend(env, chatId, "Не нашла подходящую папку или главу. Напишите, например: \"Сделай короткое описание по папке Books на английском\" или \"Сделай B1 пересказ по первой главе\".");
    return true;
  }
  if (context.text.trim().length < 40) {
    await telegramSend(env, chatId, "Данных недостаточно: в выбранной папке или главе мало сохраненных заметок и ручных описаний фото. Добавьте несколько заметок с типами #plot, #facts, #names, #words или #retelling.");
    return true;
  }

  const usageDate = new Date().toISOString().slice(0, 10);
  const usage = await env.DB
    .prepare("SELECT count FROM ai_usage WHERE usage_date = ? AND user_key = ?")
    .bind(usageDate, "owner")
    .first<{ count: number }>();
  if ((usage?.count || 0) >= AI_DAILY_LIMIT) {
    await telegramSend(env, chatId, "Дневной лимит AI-запросов достигнут. Попробуйте завтра.");
    return true;
  }

  await telegramSend(env, chatId, "Готовлю ответ по сохраненной информации...");
  try {
    const response = await callOpenRouter(env, action, context, telegramQuestionInstruction(text));
    await env.DB
      .prepare(
        `INSERT INTO ai_usage (usage_date, user_key, count) VALUES (?, ?, 1)
         ON CONFLICT(usage_date, user_key) DO UPDATE SET count = count + 1`,
      )
      .bind(usageDate, "owner")
      .run();
    await telegramSendLong(env, chatId, response);
  } catch (error) {
    console.error("Telegram AI request failed", error);
    await telegramSend(env, chatId, "OpenRouter сейчас не ответил. Обычное сохранение заметок и фото продолжает работать.");
  }
  return true;
}

async function handleTelegramMemorySearch(env: Env, chatId: number, text: string): Promise<boolean> {
  if (!isMemoryQuestion(text)) return false;

  const scope = await inferTelegramAiScope(env.DB, text);
  if ("message" in scope) {
    await telegramSend(env, chatId, scope.message);
    return true;
  }

  const context = hasRagConfig(env) ? await enhanceContextWithRag(env, scope.context, text) : scope.context;
  if (!context.topicName || context.text.trim().length < 40) {
    await telegramSend(env, chatId, memoryNoDataMessage(text, "выбранной папке или главе"));
    return true;
  }

  const entries = extractMemoryEntries(context.text);
  const keywords = extractSearchKeywords(text);
  const matches = keywords.length
    ? entries.filter((entry) => memoryEntryMatchesKeywords(entry, keywords))
    : entries;

  if (!matches.length) {
    await telegramSend(env, chatId, memoryNoDataMessage(text, context.topicName));
    return true;
  }

  const answerInEnglish = /english|английск|на английском|in english/i.test(text);
  const header = answerInEnglish
    ? `I found this in saved memory (${context.topicName}):`
    : `Нашла в сохраненной памяти (${context.topicName}):`;
  const body = matches.slice(0, 6).map((entry) => `- ${entry}`).join("\n\n");
  const footer = matches.length > 6 ? (answerInEnglish ? "\n\nThere is more saved material, but I showed the closest notes." : "\n\nЕсть еще материалы, я показала самые близкие заметки.") : "";
  await telegramSendLong(env, chatId, `${header}\n\n${body}${footer}`);
  return true;
}

function extractMemoryEntries(contextText: string): string[] {
  const entries: string[] = [];

  for (const block of contextText.split(/\n\n+/)) {
    const trimmed = block.trim();
    if (!trimmed) continue;

    if (trimmed.startsWith("RAG chunk")) {
      const withoutHeader = trimmed.replace(/^RAG chunk \d+(?: \([^)]*\))?:\s*/i, "").trim();
      const content = withoutHeader
        .split("\n")
        .map((line) => line.trim())
        .filter((line) => line && !/^(Folder|Book|Study block|Chapter|Type):/i.test(line))
        .join(" ")
        .trim();
      if (content) entries.push(content);
      continue;
    }

    for (const line of trimmed.split("\n")) {
      const cleaned = line.trim();
      if (cleaned.startsWith("Note:") || cleaned.startsWith("Photo description:")) {
        entries.push(cleaned.replace(/^(Note:|Photo description:)\s*/i, "").trim());
      }
    }
  }

  return [...new Set(entries.filter(Boolean))];
}

function memoryEntryMatchesKeywords(entry: string, keywords: string[]): boolean {
  const normalized = normalizeSearchText(entry);
  const tokens = new Set(normalized.split(" ").filter(Boolean));
  return keywords.some((keyword) => {
    const normalizedKeyword = normalizeSearchText(keyword);
    if (!normalizedKeyword) return false;
    if (normalizedKeyword.includes(" ")) return normalized.includes(normalizedKeyword);
    return tokens.has(normalizedKeyword);
  });
}
function extractSearchKeywords(text: string): string[] {
  const normalized = normalizeSearchText(text);
  const stopWords = new Set([
    "найти", "найди", "ищи", "поиск", "информацию", "информация", "информац", "из", "по", "о", "об", "про", "мне", "дай", "покажи", "расскажи",
    "глава", "главы", "главе", "главу", "папка", "папке", "книга", "книги", "на", "английском", "русском", "сделай", "уже", "имеющейся",
    "find", "search", "information", "info", "about", "from", "chapter", "chapters", "book", "books", "in", "english", "russian", "tell", "show", "give",
  ]);
  const words = normalized
    .split(" ")
    .filter((word) => word.length > 1 && !/^\d+$/.test(word) && !stopWords.has(word));
  const expanded = new Set<string>();
  for (const word of words) {
    expanded.add(word);
    addKeywordAliases(expanded, word);
  }
  return [...expanded].map((word) => normalizeSearchText(word)).filter(Boolean);
}

function addKeywordAliases(expanded: Set<string>, word: string): void {
  const aliasGroups = [
    {
      ru: ["еда", "еде", "еду", "едой", "пища", "пищу"],
      en: ["food", "eat", "eating", "ate", "meal", "breakfast", "lunch", "dinner", "cake", "hamburger", "hamburgers", "sausage", "sausages"],
    },
    {
      ru: ["змея", "змею", "змее", "змеи"],
      en: ["snake", "reptile", "reptile house"],
    },
    {
      ru: ["зоопарк", "зоопарке", "зоопарка"],
      en: ["zoo", "reptile house"],
    },
    {
      ru: ["животное", "животные", "животных", "животными", "кот", "кота", "кошка", "кошку", "кошки", "птица", "птицы", "совы", "сова", "змея", "змею", "змеи"],
      en: ["animal", "animals", "cat", "cats", "owl", "owls", "bird", "birds", "snake", "snakes", "reptile", "reptile house"],
    },
    {
      ru: ["машина", "машины", "машинах", "авто", "автомобиль", "автомобиле", "машине"],
      en: ["car", "cars", "drive", "driving", "drove", "route", "work"],
    },
    {
      ru: ["работа", "работе", "работу", "работой", "работы"],
      en: ["work", "job", "office", "director", "drills", "drive to work", "route"],
    },
    {
      ru: ["эмоция", "эмоции", "эмоциях", "чувство", "чувства", "настроение", "реакция", "реакции"],
      en: ["emotion", "emotions", "reaction", "reactions", "mood", "proud", "normal", "strange", "shocked", "furious", "scared", "amazed", "surprised", "annoyed", "lonely", "delighted"],
    },
    {
      ru: ["мантия", "мантии", "мантию", "плащ", "плаще", "плаща"],
      en: ["cloak", "cloaks", "robe", "robes", "mantle"],
    },
    {
      ru: ["семья", "семье", "семью", "родители", "родителях"],
      en: ["family", "parents", "aunt", "uncle", "cousin", "dursley", "dursleys"],
    },
    {
      ru: ["письмо", "письме", "письма"],
      en: ["letter", "letters", "envelope", "address"],
    },
  ];

  for (const group of aliasGroups) {
    if (group.ru.includes(word) || group.en.includes(word)) {
      group.ru.forEach((item) => expanded.add(item));
      group.en.forEach((item) => expanded.add(item));
    }
  }
}
function memoryNoDataMessage(text: string, scopeName: string): string {
  const answerInEnglish = /english|английск|на английском|in english/i.test(text);
  return answerInEnglish
    ? `There is no saved information about this in ${scopeName}. I can answer only from your saved notes and manual photo descriptions.`
    : `В ${scopeName} нет сохраненной информации по этому вопросу. Я могу отвечать только по твоим заметкам и ручным описаниям фото.`;
}
function queueTelegramAiTextRequest(context: ApiContext, env: Env, chatId: number, text: string, updateId?: number): void {
  context.waitUntil(
    (async () => {
      try {
        await handleTelegramAiTextRequest(env, chatId, text);
        if (typeof updateId === "number") {
          await finishTelegramUpdate(env.DB, updateId, "done");
        }
      } catch (error) {
        console.error("Telegram AI background request failed", error);
        if (typeof updateId === "number") {
          await finishTelegramUpdate(env.DB, updateId, "failed");
        }
        try {
          await telegramSend(env, chatId, "AI-запрос не успел обработаться. Попробуйте ещё раз или задайте вопрос короче.");
        } catch (sendError) {
          console.error("Telegram AI failure notification failed", sendError);
        }
      }
    })(),
  );
}
function inferAiAction(text: string): string | null {
  if (isMemoryQuestion(text)) return "answer";
  const normalized = text.toLowerCase();
  if (/\ba2\b|а2|уровн[яю]\s*a2/.test(normalized)) return "a2";
  if (/\bb1\b|в1|b 1|уровн[яю]\s*b1/.test(normalized)) return "b1";
  if (/план|plan/.test(normalized)) return "plan";
  if (/задан|упражнен|повторен|tasks?/.test(normalized)) return "tasks";
  if (/extract|выдел|слова|имена|факты/.test(normalized)) return "extract";
  if (/коротк|кратк|short|описан|summary|пересказ/.test(normalized)) return "short";
  return null;
}

function isMemoryQuestion(text: string): boolean {
  const normalized = normalizeSearchText(text);
  if (!normalized) return false;
  const savePrefixes = ["добав", "сохран", "созда", "запиши"];
  if (/^(add|save|create)\b/.test(normalized) || savePrefixes.some((prefix) => normalized.startsWith(prefix))) return false;
  const questionWords = ["найти", "найди", "ищи", "поиск", "информац", "что", "кто", "где", "когда", "почему", "как", "расскажи", "покажи", "дай"];
  return /\b(find|search|tell|what|who|where|when|why|how|information|info)\b/.test(normalized) || questionWords.some((word) => normalized.includes(word));
}

function telegramQuestionInstruction(text: string): string {
  const language = inferLanguageInstruction(text);
  return `${language ? `${language}\n` : ""}User question: ${text.trim()}\nAnswer this question directly. Use only the saved material above. Do not treat the question as a note to save.`;
}
type TelegramAiScope = { context: AiContext } | { message: string };

async function inferTelegramAiScope(db: D1Database, text: string): Promise<TelegramAiScope> {
  const booksFolder = await db.prepare("SELECT id, name FROM folders WHERE lower(name) = lower('Books')").first<{ id: string; name: string }>();
  if (booksFolder && isBooksAiRequest(text)) {
    const bookScope = await inferBooksAiScope(db, booksFolder, text);
    if (bookScope) return bookScope;
  }

  const folderId = await inferFolderId(db, text);
  if (!folderId) {
    if (booksFolder && isMemoryQuestion(text)) {
      return { context: await buildFolderContext(db, booksFolder.id) };
    }
    return {
      message:
        "Я понял AI-запрос, но не понял папку, книгу или главу. Напишите, например: \"Сделай короткое описание по папке Books на английском\" или \"Сделай B1 пересказ по первой главе\".",
    };
  }
  return { context: await buildFolderContext(db, folderId) };
}

async function inferBooksAiScope(db: D1Database, booksFolder: { id: string; name: string }, text: string): Promise<TelegramAiScope | null> {
  const topicsResult = await db
    .prepare("SELECT id, name FROM topics WHERE folder_id = ? ORDER BY created_at ASC")
    .bind(booksFolder.id)
    .all<{ id: string; name: string }>();
  const topics = topicsResult.results || [];
  if (!topics.length) {
    return { message: "В папке Books пока нет глав. Создайте Study block вроде \"Harry Potter — Chapter 1\" и добавьте заметки." };
  }

  const chapterRange = parseChapterRange(text);
  const bookMatchedTopics = topics.filter((topic) => topicMatchesBookRequest(topic.name, text));
  if (chapterRange) {
    const chapterMatches = topics.filter((topic) => {
      const chapterNumber = extractChapterNumber(topic.name);
      return chapterNumber !== null && chapterNumber >= chapterRange.start && chapterNumber <= chapterRange.end;
    });
    const scopedMatches = bookMatchedTopics.length
      ? chapterMatches.filter((topic) => bookMatchedTopics.some((matched) => matched.id === topic.id))
      : chapterMatches;

    if (!scopedMatches.length) {
      return { message: `По глав${chapterRange.start === chapterRange.end ? "е" : "ам"} ${formatChapterRange(chapterRange)} данных нет. Создайте нужную главу в Books и добавьте заметки.` };
    }

    if (!bookMatchedTopics.length && hasAmbiguousBookChapters(scopedMatches)) {
      const names = scopedMatches.map((topic) => studyBlockDisplayName(topic.name)).join(", ");
      return { message: `Я нашла несколько похожих глав: ${names}. Уточните название книги в запросе.` };
    }

    return { context: await buildTopicsContext(db, scopedMatches, `Books / chapters ${formatChapterRange(chapterRange)}`) };
  }

  if (bookMatchedTopics.length) {
    const label = `Books / ${bookTitleFromStudyBlock(bookMatchedTopics[0].name) || "selected book"}`;
    return { context: await buildTopicsContext(db, bookMatchedTopics, label) };
  }

  return null;
}

function isBooksAiRequest(text: string): boolean {
  const normalized = normalizeSearchText(text);
  return (
    /\b(book|books|chapter|chapters)\b/.test(normalized) ||
    /книг|глав|поттер|гарри/.test(normalized) ||
    parseChapterRange(text) !== null
  );
}

function parseChapterRange(text: string): { start: number; end: number } | null {
  const normalized = text.toLowerCase().replace(/ё/g, "е");
  const range =
    normalized.match(/(?:глав\p{L}*|chapter|chapters)\s*(\d+)\s*[-–—]\s*(\d+)/u) ||
    normalized.match(/(\d+)\s*[-–—]\s*(\d+)\s*(?:глав\p{L}*|chapter|chapters)/u);
  if (range) return normalizeRange(Number(range[1]), Number(range[2]));

  const single = normalized.match(/(?:глав\p{L}*|chapter)\s*(\d+)/u);
  if (single) return normalizeRange(Number(single[1]), Number(single[1]));

  const singleBefore = normalized.match(/(\d+)\s*(?:глав\p{L}*|chapter|chapters)/u);
  if (singleBefore) return normalizeRange(Number(singleBefore[1]), Number(singleBefore[1]));

  const ordinals: Array<[number, string[]]> = [
    [1, ["первая", "первой", "первую", "первую"]],
    [2, ["вторая", "второй", "вторую"]],
    [3, ["третья", "третьей", "третью"]],
    [4, ["четвертая", "четвертой", "четвертую"]],
    [5, ["пятая", "пятой", "пятую"]],
    [6, ["шестая", "шестой", "шестую"]],
    [7, ["седьмая", "седьмой", "седьмую"]],
    [8, ["восьмая", "восьмой", "восьмую"]],
    [9, ["девятая", "девятой", "девятую"]],
    [10, ["десятая", "десятой", "десятую"]],
  ];
  for (const [number, words] of ordinals) {
    if (words.some((word) => normalized.includes(`${word} глав`))) return { start: number, end: number };
  }
  return null;
}

function normalizeRange(first: number, second: number): { start: number; end: number } | null {
  if (!Number.isFinite(first) || !Number.isFinite(second) || first < 1 || second < 1) return null;
  return { start: Math.min(first, second), end: Math.max(first, second) };
}

function extractChapterNumber(name: string): number | null {
  const normalized = name.toLowerCase().replace(/ё/g, "е");
  const match = normalized.match(/(?:chapter|глава)\s*(\d+)/u);
  if (!match) return null;
  const number = Number(match[1]);
  return Number.isFinite(number) ? number : null;
}

function topicMatchesBookRequest(topicName: string, requestText: string): boolean {
  const bookTitle = bookTitleFromStudyBlock(topicName);
  const titleWords = normalizeSearchText(bookTitle)
    .split(" ")
    .filter((word) => word.length >= 4 && !["book", "chapter", "глава"].includes(word));
  if (!titleWords.length) return false;
  const request = normalizeSearchText(requestText);
  const transliteratedRequest = normalizeSearchText(transliterateRussian(requestText));
  return titleWords.some((word) => request.includes(word) || transliteratedRequest.includes(word));
}

function bookTitleFromStudyBlock(name: string): string {
  return name
    .replace(/\s*[-–—]\s*(chapter|глава)\s*\d+.*$/iu, "")
    .replace(/\s*(chapter|глава)\s*\d+.*$/iu, "")
    .trim();
}

function hasAmbiguousBookChapters(topics: Array<{ name: string }>): boolean {
  const titles = new Set(topics.map((topic) => normalizeSearchText(bookTitleFromStudyBlock(topic.name))).filter(Boolean));
  return titles.size > 1;
}

function formatChapterRange(range: { start: number; end: number }): string {
  return range.start === range.end ? String(range.start) : `${range.start}-${range.end}`;
}

function normalizeSearchText(value: string): string {
  return value
    .toLowerCase()
    .replace(/ё/g, "е")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function transliterateRussian(value: string): string {
  const map: Record<string, string> = {
    а: "a",
    б: "b",
    в: "v",
    г: "g",
    д: "d",
    е: "e",
    ё: "e",
    ж: "zh",
    з: "z",
    и: "i",
    й: "y",
    к: "k",
    л: "l",
    м: "m",
    н: "n",
    о: "o",
    п: "p",
    р: "r",
    с: "s",
    т: "t",
    у: "u",
    ф: "f",
    х: "h",
    ц: "ts",
    ч: "ch",
    ш: "sh",
    щ: "sch",
    ы: "y",
    э: "e",
    ю: "yu",
    я: "ya",
  };
  return [...value.toLowerCase()].map((char) => map[char] || char).join("");
}

async function inferFolderId(db: D1Database, text: string): Promise<string | null> {
  const normalized = text.toLowerCase();
  const aliases: Array<[string[], string]> = [
    [["book", "books", "книга", "книги", "книге", "папке книга"], "Books"],
    [["film", "films", "movie", "movies", "фильм", "фильмы", "кино"], "Films"],
    [["video", "videos", "видео", "ролик"], "Videos"],
    [["vocabulary", "words", "слова", "словар", "лексика"], "Vocabulary"],
    [["inbox", "инбокс", "входящие"], "Inbox"],
  ];
  for (const [words, folderName] of aliases) {
    if (words.some((word) => normalized.includes(word))) {
      const folder = await db.prepare("SELECT id FROM folders WHERE lower(name) = lower(?)").bind(folderName).first<{ id: string }>();
      if (folder) return folder.id;
    }
  }

  const folders = await db.prepare("SELECT id, name FROM folders ORDER BY created_at ASC").all<{ id: string; name: string }>();
  const matched = (folders.results || []).find((folder) => normalized.includes(folder.name.toLowerCase()));
  return matched?.id || null;
}

function inferLanguageInstruction(text: string): string {
  const normalized = text.toLowerCase();
  if (/английск|english|in english/.test(normalized)) return "Answer in English.";
  if (/русск|russian|по-русски/.test(normalized)) return "Answer in Russian.";
  return "";
}

async function handleTelegramWebhook(request: Request, env: Env, context: ApiContext): Promise<Response> {
  const update = (await request.json()) as TelegramUpdate;
  const userId = getTelegramUserId(update);
  if (!userId || !isAllowedTelegramUser(env, userId)) {
    if (userId) await telegramSend(env, userId, "Access denied.");
    return json({ ok: true });
  }

  if (typeof update.update_id === "number") {
    const firstTime = await beginTelegramUpdate(env.DB, update.update_id, String(userId));
    if (!firstTime) return json({ ok: true, duplicate: true });
  }

  const complete = async (body: Record<string, unknown> = { ok: true }): Promise<Response> => {
    if (typeof update.update_id === "number") {
      await finishTelegramUpdate(env.DB, update.update_id, "done");
    }
    return json(body);
  };

  try {
  if (update.callback_query) {
    await handleTelegramCallback(env, update.callback_query, String(userId), context);
    return complete();
  }

  const message = update.message;
  if (!message) return complete();

  if (message.text?.startsWith("/start")) {
    await telegramSend(env, userId, "Retelling Brain Bot готов. Отправьте заметку или фото, затем выберите папку, учебный блок и тип заметки.");
    return complete();
  }

  if (String(userId) === String(env.TEACHER_TELEGRAM_ID) && String(userId) !== String(env.OWNER_TELEGRAM_ID)) {
    await telegramSend(env, userId, "Доступ преподавателя активен. Комментарии удобнее добавлять в веб-панели.");
    return complete();
  }

  if (message.text && /^фото$/iu.test(message.text.trim())) {
    await telegramSend(env, userId, "Отправьте само изображение через кнопку 📎 / Фото. Тогда я сохраню его как фото и спрошу папку, учебный блок и тип.");
    return complete();
  }

  if (message.text) {
    const handledPendingName = await handlePendingStudyBlockName(env, String(userId), message.chat.id, message.text);
    if (handledPendingName) return complete();

    const handledOpenLibrarySearch = await handleTelegramOpenLibrarySearch(env, message.chat.id, message.text);
    if (handledOpenLibrarySearch) return complete();

    const handledMemorySearch = await handleTelegramMemorySearch(env, message.chat.id, message.text);
    if (handledMemorySearch) return complete();

    if (inferAiAction(message.text)) {
      queueTelegramAiTextRequest(context, env, message.chat.id, message.text, update.update_id);
      return json({ ok: true, queued: true });
    }

    const content = cleanContent(message.text, NOTE_LIMIT);
    const draftId = telegramDraftId();
    await env.DB
      .prepare("INSERT INTO telegram_drafts (id, telegram_user_id, kind, text_content, pending_step) VALUES (?, ?, 'text', ?, 'folder')")
      .bind(draftId, String(userId), content)
      .run();
    await sendFolderPicker(env, userId, draftId);
    return complete();
  }

  if (message.photo?.length) {
    const chosen = chooseTelegramPhoto(message.photo);
    const draftId = telegramDraftId();
    await env.DB
      .prepare("INSERT INTO telegram_drafts (id, telegram_user_id, kind, text_content, telegram_file_id, width, height, pending_step) VALUES (?, ?, 'photo', ?, ?, ?, ?, 'folder')")
      .bind(draftId, String(userId), String(message.caption || "").trim().slice(0, NOTE_LIMIT), chosen.file_id, chosen.width, chosen.height)
      .run();
    await sendFolderPicker(env, userId, draftId);
    return complete();
  }

  if (message.document?.mime_type?.startsWith("image/")) {
    const draftId = telegramDraftId();
    await env.DB
      .prepare("INSERT INTO telegram_drafts (id, telegram_user_id, kind, text_content, telegram_file_id, width, height, pending_step) VALUES (?, ?, 'photo', ?, ?, ?, ?, 'folder')")
      .bind(draftId, String(userId), String(message.caption || "").trim().slice(0, NOTE_LIMIT), message.document.file_id, null, null)
      .run();
    await sendFolderPicker(env, userId, draftId);
    return complete();
  }

  await telegramSend(env, userId, "Пока я сохраняю только текстовые заметки и фото.");
  return complete();
  } catch (error) {
    if (typeof update.update_id === "number") {
      await finishTelegramUpdate(env.DB, update.update_id, "failed");
    }
    throw error;
  }
}

async function beginTelegramUpdate(db: D1Database, updateId: number, userId: string): Promise<boolean> {
  const existing = await db
    .prepare("SELECT status, created_at, updated_at FROM telegram_processed_updates WHERE update_id = ?")
    .bind(updateId)
    .first<{ status?: string; created_at?: string; updated_at?: string }>();

  if (existing) {
    const timestamp = Date.parse(existing.updated_at || existing.created_at || "");
    const isStale = Number.isFinite(timestamp) && Date.now() - timestamp > 90_000;
    if (existing.status === "failed" || isStale) {
      await db
        .prepare("UPDATE telegram_processed_updates SET telegram_user_id = ?, status = 'processing', updated_at = CURRENT_TIMESTAMP WHERE update_id = ?")
        .bind(userId, updateId)
        .run();
      return true;
    }
    return false;
  }

  await db
    .prepare("INSERT INTO telegram_processed_updates (update_id, telegram_user_id, status, updated_at) VALUES (?, ?, 'processing', CURRENT_TIMESTAMP)")
    .bind(updateId, userId)
    .run();
  await db.prepare("DELETE FROM telegram_processed_updates WHERE created_at < datetime('now', '-2 days')").run();
  return true;
}

async function finishTelegramUpdate(db: D1Database, updateId: number, status: "done" | "failed"): Promise<void> {
  await db
    .prepare("UPDATE telegram_processed_updates SET status = ?, updated_at = CURRENT_TIMESTAMP WHERE update_id = ?")
    .bind(status, updateId)
    .run();
}

async function setTelegramWebhook(request: Request, env: Env): Promise<Response> {
  if (!env.TELEGRAM_BOT_TOKEN) return json({ error: "TELEGRAM_BOT_TOKEN is not configured" }, 500);
  const origin = new URL(request.url).origin;
  const webhookUrl = `${origin}/api/telegram/webhook`;
  const response = await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/setWebhook`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ url: webhookUrl }),
  });
  const data = (await response.json()) as { ok?: boolean; description?: string };
  if (!response.ok || !data.ok) {
    return json({ error: data.description || "Telegram webhook setup failed" }, 502);
  }
  return json({ ok: true, webhookUrl, description: data.description || "Webhook was set" });
}

async function handleTelegramCallback(env: Env, callback: TelegramCallbackQuery, userId: string, context: ApiContext): Promise<void> {
  const data = callback.data || "";
  const [kind, draftId, selectedId] = data.split(":");

  if (kind === "folder" && draftId && selectedId) {
    const draft = await getTelegramDraft(env, draftId, userId);
    if (!draft) {
      await telegramAnswerCallback(env, callback.id, "Черновик не найден.");
      return;
    }
    await env.DB
      .prepare("UPDATE telegram_drafts SET selected_folder_id = ?, pending_step = 'topic' WHERE id = ? AND telegram_user_id = ?")
      .bind(selectedId, draftId, userId)
      .run();
    await telegramAnswerCallback(env, callback.id, "Папка выбрана.");
    await sendStudyBlockPicker(env, callback.message.chat.id, callback.message.message_id, draftId, selectedId);
    return;
  }

  if (kind === "topic" && draftId && selectedId) {
    const draft = await getTelegramDraft(env, draftId, userId);
    if (!draft) {
      await telegramAnswerCallback(env, callback.id, "Черновик не найден.");
      return;
    }
    await env.DB
      .prepare("UPDATE telegram_drafts SET selected_topic_id = ?, pending_step = 'type' WHERE id = ? AND telegram_user_id = ?")
      .bind(selectedId, draftId, userId)
      .run();
    await telegramAnswerCallback(env, callback.id, "Учебный блок выбран.");
    await sendNoteTypePicker(env, callback.message.chat.id, callback.message.message_id, draftId);
    return;
  }

  if (kind === "newtopic" && draftId) {
    const draft = await getTelegramDraft(env, draftId, userId);
    if (!draft?.selected_folder_id) {
      await telegramAnswerCallback(env, callback.id, "Сначала выберите папку.");
      return;
    }
    const folder = await env.DB.prepare("SELECT name FROM folders WHERE id = ?").bind(draft.selected_folder_id).first<{ name: string }>();
    const isBooks = isBooksFolderName(folder?.name || "");
    await env.DB.prepare("UPDATE telegram_drafts SET pending_step = 'new_topic' WHERE id = ? AND telegram_user_id = ?").bind(draftId, userId).run();
    await telegramAnswerCallback(env, callback.id, "Жду название.");
    await telegramEdit(
      env,
      callback.message.chat.id,
      callback.message.message_id,
      isBooks
        ? "Отправьте название новой главы одним сообщением. Например: Harry Potter — Chapter 1"
        : "Отправьте название нового учебного блока одним сообщением. Например: Lesson 1",
      [],
    );
    return;
  }

  if (kind === "type" && draftId && selectedId) {
    const draft = await getTelegramDraft(env, draftId, userId);
    const noteType = getNoteType(selectedId);
    if (!draft?.selected_topic_id || !noteType) {
      await telegramAnswerCallback(env, callback.id, "Не хватает данных для сохранения.");
      return;
    }
    await telegramAnswerCallback(env, callback.id, "Сохраняю...");
    await saveDraftAsStudyMaterial(env, draft, noteType.tag, context);
    await env.DB.prepare("UPDATE telegram_drafts SET note_type = ? WHERE id = ?").bind(noteType.id, draftId).run();
    await env.DB.prepare("DELETE FROM telegram_drafts WHERE id = ?").bind(draftId).run();
    const topic = await env.DB
      .prepare(
        `SELECT t.name, f.name AS folder_name
         FROM topics t JOIN folders f ON f.id = t.folder_id
         WHERE t.id = ?`,
      )
      .bind(draft.selected_topic_id)
      .first<{ name: string; folder_name: string }>();
    await telegramEdit(
      env,
      callback.message.chat.id,
      callback.message.message_id,
      `Готово. Сохранено в ${isBooksFolderName(topic?.folder_name || "") ? "Chapter" : "Study block"}: ${studyBlockDisplayName(topic?.name || "General")} · ${noteType.label}.`,
      [],
    );
    return;
  }

  if (kind === "folder" && draftId && selectedId) {
    await telegramAnswerCallback(env, callback.id, "Папка выбрана. Теперь выберите тему.");
    const topics = await env.DB.prepare("SELECT id, name FROM topics WHERE folder_id = ? ORDER BY created_at ASC").bind(selectedId).all<{ id: string; name: string }>();
    const rows = (topics.results || []).map((topic) => [{ text: `Сохранить в тему: ${topic.name}`, callback_data: `topic:${draftId}:${topic.id}` }]);
    await telegramEdit(
      env,
      callback.message.chat.id,
      callback.message.message_id,
      "Шаг 2 из 2. Нажмите тему, куда сохранить заметку:",
      rows,
    );
    return;
  }

  if (kind === "topic" && draftId && selectedId) {
    await telegramAnswerCallback(env, callback.id, "Сохраняю...");
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
    const topic = await env.DB.prepare("SELECT name FROM topics WHERE id = ?").bind(selectedId).first<{ name: string }>();
    await telegramEdit(env, callback.message.chat.id, callback.message.message_id, `Готово. Сохранено в тему: ${topic?.name || "выбранная тема"}.`, []);
  }
}

async function sendStudyBlockPicker(env: Env, chatId: number | string, messageId: number, draftId: string, folderId: string): Promise<void> {
  const folder = await env.DB.prepare("SELECT name FROM folders WHERE id = ?").bind(folderId).first<{ name: string }>();
  const topics = await env.DB.prepare("SELECT id, name FROM topics WHERE folder_id = ? ORDER BY created_at ASC").bind(folderId).all<{ id: string; name: string }>();
  const isBooks = isBooksFolderName(folder?.name || "");
  const rows = (topics.results || []).map((topic) => [
    { text: `${isBooks ? "Chapter" : "Study block"}: ${studyBlockDisplayName(topic.name)}`, callback_data: `topic:${draftId}:${topic.id}` },
  ]);
  rows.push([{ text: isBooks ? "+ Create new chapter" : "+ Create new study block", callback_data: `newtopic:${draftId}` }]);
  await telegramEdit(
    env,
    chatId,
    messageId,
    isBooks ? "Шаг 2 из 3. Выберите главу / Study block:" : "Шаг 2 из 3. Выберите учебный блок:",
    rows,
  );
}

async function sendNoteTypePicker(env: Env, chatId: number | string, messageId: number, draftId: string): Promise<void> {
  const draft = await env.DB.prepare("SELECT selected_folder_id FROM telegram_drafts WHERE id = ?").bind(draftId).first<{ selected_folder_id?: string }>();
  const folder = draft?.selected_folder_id
    ? await env.DB.prepare("SELECT name FROM folders WHERE id = ?").bind(draft.selected_folder_id).first<{ name: string }>()
    : null;
  await telegramEdit(
    env,
    chatId,
    messageId,
    isBooksFolderName(folder?.name || "") ? "Шаг 3 из 3. Выберите тип заметки для главы:" : "Шаг 3 из 3. Выберите тип заметки:",
    noteTypeKeyboard(draftId),
  );
}

async function handlePendingStudyBlockName(env: Env, userId: string, chatId: number, rawName: string): Promise<boolean> {
  const draft = await env.DB
    .prepare(
      `SELECT * FROM telegram_drafts
       WHERE telegram_user_id = ? AND pending_step = 'new_topic'
       ORDER BY created_at DESC LIMIT 1`,
    )
    .bind(userId)
    .first<TelegramDraft>();
  if (!draft?.selected_folder_id) return false;

  const name = cleanName(rawName, 60);
  const folder = await env.DB.prepare("SELECT name FROM folders WHERE id = ?").bind(draft.selected_folder_id).first<{ name: string }>();
  const isBooks = isBooksFolderName(folder?.name || "");
  const topicId = crypto.randomUUID();
  await env.DB.prepare("INSERT INTO topics (id, folder_id, name) VALUES (?, ?, ?)").bind(topicId, draft.selected_folder_id, name).run();
  await env.DB
    .prepare("UPDATE telegram_drafts SET selected_topic_id = ?, pending_step = 'type' WHERE id = ? AND telegram_user_id = ?")
    .bind(topicId, draft.id, userId)
    .run();
  await telegramSend(
    env,
    chatId,
    `${isBooks ? "Глава" : "Учебный блок"} создан${isBooks ? "а" : ""}: ${studyBlockDisplayName(name)}. Теперь выберите тип заметки:`,
    noteTypeKeyboard(draft.id),
  );
  return true;
}

async function saveDraftAsStudyMaterial(env: Env, draft: TelegramDraft, typeTag: string, context: ApiContext): Promise<void> {
  if (!draft.selected_topic_id) throw new Error("Missing selected study block");

  if (draft.kind === "text" && draft.text_content) {
    const content = withTypeTag(draft.text_content, typeTag);
    const noteId = crypto.randomUUID();
    await env.DB
      .prepare("INSERT INTO notes (id, topic_id, author_role, content, tags_json) VALUES (?, ?, 'owner', ?, ?)")
      .bind(noteId, draft.selected_topic_id, content, JSON.stringify(extractTags(content)))
      .run();
    queueRagAutoIndex(context, env, "note", noteId);
  }

  if (draft.kind === "photo" && draft.telegram_file_id) {
    const photoId = await saveTelegramPhoto(env, draft.selected_topic_id, draft.telegram_file_id, withTypeTag(draft.text_content || "", typeTag));
    queueRagAutoIndex(context, env, "photo", photoId);
  }

  await touchTopic(env.DB, draft.selected_topic_id);
}
async function getTelegramDraft(env: Env, draftId: string, userId: string): Promise<TelegramDraft | null> {
  return env.DB.prepare("SELECT * FROM telegram_drafts WHERE id = ? AND telegram_user_id = ?").bind(draftId, userId).first<TelegramDraft>();
}

function noteTypeKeyboard(draftId: string): Array<Array<{ text: string; callback_data: string }>> {
  return NOTE_TYPES.map((type) => [{ text: `Type: ${type.label}`, callback_data: `type:${draftId}:${type.id}` }]);
}

function getNoteType(id: string): (typeof NOTE_TYPES)[number] | undefined {
  return NOTE_TYPES.find((type) => type.id === id);
}

function withTypeTag(content: string, tag: string): string {
  const tags = extractTags(content);
  if (tags.includes(tag.toLowerCase())) return content;
  const trimmed = content.trim();
  return trimmed ? `${tag} ${trimmed}` : tag;
}

function studyBlockDisplayName(name: string): string {
  return name.trim().toLowerCase() === "general" ? "General study block" : name;
}

function isBooksFolderName(name: string): boolean {
  return name.trim().toLowerCase() === "books";
}

async function sendFolderPicker(env: Env, chatId: number, draftId: string): Promise<void> {
  const folders = await env.DB.prepare("SELECT id, name FROM folders ORDER BY created_at ASC").all<{ id: string; name: string }>();
  const rows = (folders.results || []).map((folder) => [{ text: `Папка: ${folder.name}`, callback_data: `folder:${draftId}:${folder.id}` }]);
  await telegramSend(env, chatId, "Шаг 1 из 3. Куда сохранить?", rows);
}

async function saveTelegramPhoto(env: Env, topicId: string, fileId: string, description = ""): Promise<string> {
  const id = crypto.randomUUID();
  const tagsJson = JSON.stringify(extractTags(description));

  if (!env.PHOTOS) {
    await env.DB
      .prepare(
        `INSERT INTO photos (id, topic_id, r2_key, filename, content_type, size_bytes, description, tags_json)
         VALUES (?, ?, ?, ?, 'image/jpeg', 0, ?, ?)`,
      )
      .bind(id, topicId, `telegram:${fileId}`, `${id}.jpg`, description, tagsJson)
      .run();
    return id;
  }

  const bytes = await downloadTelegramPhoto(env, fileId);
  const r2Key = `photos/${topicId}/${id}.jpg`;
  await env.PHOTOS.put(r2Key, bytes, { httpMetadata: { contentType: "image/jpeg" } });
  await env.DB
    .prepare(
      `INSERT INTO photos (id, topic_id, r2_key, filename, content_type, size_bytes, description, tags_json)
       VALUES (?, ?, ?, ?, 'image/jpeg', ?, ?, ?)`,
    )
    .bind(id, topicId, r2Key, `${id}.jpg`, bytes.byteLength, description, tagsJson)
    .run();
  return id;
}
async function getTelegramPhotoFile(env: Env, fileId: string): Promise<Response> {
  const bytes = await downloadTelegramPhoto(env, fileId);
  return new Response(bytes, {
    headers: {
      "Content-Type": "image/jpeg",
      "Cache-Control": "private, max-age=300",
    },
  });
}

async function downloadTelegramPhoto(env: Env, fileId: string): Promise<ArrayBuffer> {
  if (!env.TELEGRAM_BOT_TOKEN) throw new Error("TELEGRAM_BOT_TOKEN is not configured");
  const fileResponse = await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/getFile?file_id=${encodeURIComponent(fileId)}`);
  const fileData = (await fileResponse.json()) as { ok: boolean; result?: { file_path?: string } };
  const filePath = fileData.result?.file_path;
  if (!fileData.ok || !filePath) throw new Error("Telegram getFile failed");

  const imageResponse = await fetch(`https://api.telegram.org/file/bot${env.TELEGRAM_BOT_TOKEN}/${filePath}`);
  if (!imageResponse.ok) throw new Error("Telegram photo download failed");
  return imageResponse.arrayBuffer();
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

async function telegramSendLong(env: Env, chatId: number | string, text: string): Promise<void> {
  const limit = 3800;
  const chunks: string[] = [];
  let remaining = text.trim();
  while (remaining.length > limit) {
    const cutAt = Math.max(remaining.lastIndexOf("\n", limit), remaining.lastIndexOf(". ", limit), limit);
    chunks.push(remaining.slice(0, cutAt).trim());
    remaining = remaining.slice(cutAt).trim();
  }
  if (remaining) chunks.push(remaining);
  for (const chunk of chunks) {
    await telegramSend(env, chatId, chunk);
  }
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

async function telegramAnswerCallback(env: Env, callbackQueryId: string, text: string): Promise<void> {
  if (!env.TELEGRAM_BOT_TOKEN) return;
  await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/answerCallbackQuery`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      callback_query_id: callbackQueryId,
      text,
      show_alert: false,
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

function telegramDraftId(): string {
  return crypto.randomUUID().replace(/-/g, "").slice(0, 16);
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

interface RagSourceRow {
  source_type: "note" | "photo";
  source_id: string;
  content: string;
  tags_json: string;
  created_at: string;
  updated_at: string;
  topic_id: string;
  topic_name: string;
  folder_id: string;
  folder_name: string;
}
interface TelegramUpdate {
  update_id?: number;
  message?: TelegramMessage;
  callback_query?: TelegramCallbackQuery;
}

interface TelegramMessage {
  message_id: number;
  from?: { id: number };
  chat: { id: number };
  text?: string;
  caption?: string;
  photo?: TelegramPhotoSize[];
  document?: {
    file_id: string;
    file_name?: string;
    mime_type?: string;
    file_size?: number;
  };
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
  selected_folder_id?: string;
  selected_topic_id?: string;
  pending_step?: string;
  note_type?: string;
}
