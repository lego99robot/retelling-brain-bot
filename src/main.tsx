import { StrictMode, useEffect, useMemo, useState } from "react";
import { createRoot } from "react-dom/client";
import {
  BookOpen,
  Bot,
  Brain,
  CheckCircle2,
  FileText,
  FolderPlus,
  Image,
  Lock,
  MessageSquare,
  PenLine,
  Plus,
  RefreshCw,
  Send,
  Sparkles,
  Upload,
} from "lucide-react";
import "./styles.css";

type Role = "owner" | "teacher";

interface FolderRow {
  id: string;
  name: string;
  topic_count: number;
  note_count: number;
  photo_count: number;
}

interface TopicRow {
  id: string;
  folder_id: string;
  name: string;
  summary: string;
  note_count: number;
  photo_count: number;
}

interface NoteRow {
  id: string;
  content: string;
  tags_json: string;
  created_at: string;
}

interface PhotoRow {
  id: string;
  file_url: string;
  description: string;
  tags_json: string;
  created_at: string;
}

interface CommentRow {
  id: string;
  target_type: string;
  author_role: Role;
  content: string;
  created_at: string;
}

interface TopicFeed {
  topic: {
    id: string;
    name: string;
    folder_name: string;
    summary: string;
  };
  notes: NoteRow[];
  photos: PhotoRow[];
  comments: CommentRow[];
  tags: string[];
}

const AI_ACTIONS = [
  { id: "short", label: "Short", title: "Короткий пересказ" },
  { id: "a2", label: "A2", title: "Пересказ A2" },
  { id: "b1", label: "B1", title: "Пересказ B1" },
  { id: "plan", label: "Plan", title: "План" },
  { id: "tasks", label: "Tasks", title: "Задания" },
  { id: "extract", label: "Extract", title: "Слова, имена, факты" },
];

function studyBlockName(name?: string): string {
  return (name || "").trim().toLowerCase() === "general" ? "General study block" : name || "";
}

function App() {
  const [role, setRole] = useState<Role | null>(null);
  const [loadingSession, setLoadingSession] = useState(true);

  useEffect(() => {
    api<{ role: Role }>("/api/me")
      .then((data) => setRole(data.role))
      .catch(() => setRole(null))
      .finally(() => setLoadingSession(false));
  }, []);

  if (loadingSession) {
    return (
      <main className="boot">
        <Brain className="spin" />
        <span>Loading your retelling brain</span>
      </main>
    );
  }

  if (!role) return <Login onLogin={setRole} />;
  return <Workspace role={role} />;
}

function Login({ onLogin }: { onLogin: (role: Role) => void }) {
  const [password, setPassword] = useState("");
  const [role, setRole] = useState<Role>("owner");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError("");
    try {
      const data = await api<{ role: Role }>("/api/auth/login", {
        method: "POST",
        body: JSON.stringify({ password, role }),
      });
      onLogin(data.role);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Login failed");
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="login-page">
      <section className="login-copy">
        <div className="mark">
          <Bot />
          <span>Retelling Brain Bot</span>
        </div>
        <h1>Your quiet archive for English retelling practice.</h1>
        <p>
          Telegram captures fast notes and photos. This panel keeps the second brain tidy: folders, study blocks,
          teacher comments, and AI actions only when you ask.
        </p>
      </section>
      <form className="login-panel" onSubmit={submit}>
        <Lock />
        <h2>Protected access</h2>
        <label>
          Password
          <input
            type="password"
            value={password}
            onChange={(event) => setPassword(event.target.value)}
            autoComplete="current-password"
            required
          />
        </label>
        <div className="segmented" aria-label="Role">
          <button type="button" className={role === "owner" ? "active" : ""} onClick={() => setRole("owner")}>
            Owner
          </button>
          <button type="button" className={role === "teacher" ? "active" : ""} onClick={() => setRole("teacher")}>
            Teacher
          </button>
        </div>
        {error && <p className="error">{error}</p>}
        <button className="primary" disabled={busy}>
          {busy ? <RefreshCw className="spin" /> : <CheckCircle2 />}
          Enter
        </button>
      </form>
    </main>
  );
}

function Workspace({ role }: { role: Role }) {
  const [folders, setFolders] = useState<FolderRow[]>([]);
  const [topics, setTopics] = useState<TopicRow[]>([]);
  const [feed, setFeed] = useState<TopicFeed | null>(null);
  const [selectedFolderId, setSelectedFolderId] = useState("");
  const [selectedTopicId, setSelectedTopicId] = useState("");
  const [notice, setNotice] = useState("");

  async function loadFolders(selectFirst = false) {
    const data = await api<{ folders: FolderRow[] }>("/api/folders");
    setFolders(data.folders);
    if (selectFirst && data.folders[0]) setSelectedFolderId(data.folders[0].id);
  }

  async function loadTopics(folderId: string, selectFirst = false) {
    const data = await api<{ topics: TopicRow[] }>(`/api/topics?folderId=${encodeURIComponent(folderId)}`);
    setTopics(data.topics);
    if (selectFirst && data.topics[0]) setSelectedTopicId(data.topics[0].id);
  }

  async function loadFeed(topicId: string) {
    const data = await api<TopicFeed>(`/api/topics/${topicId}/feed`);
    setFeed(data);
  }

  useEffect(() => {
    loadFolders(true).catch(showError(setNotice));
  }, []);

  useEffect(() => {
    if (!selectedFolderId) return;
    setTopics([]);
    setFeed(null);
    setSelectedTopicId("");
    loadTopics(selectedFolderId, true).catch(showError(setNotice));
  }, [selectedFolderId]);

  useEffect(() => {
    if (!selectedTopicId) return;
    loadFeed(selectedTopicId).catch(showError(setNotice));
  }, [selectedTopicId]);

  const selectedFolder = folders.find((folder) => folder.id === selectedFolderId);
  const selectedTopic = topics.find((topic) => topic.id === selectedTopicId);

  function selectTopic(topicId: string) {
    setFeed(null);
    setSelectedTopicId(topicId);
  }

  async function refreshAll() {
    await loadFolders();
    if (selectedFolderId) await loadTopics(selectedFolderId);
    if (selectedTopicId) await loadFeed(selectedTopicId);
  }

  return (
    <main className="workspace">
      <aside className="folders-column">
        <header className="app-head">
          <div className="mark compact">
            <Brain />
            <span>Retelling Brain</span>
          </div>
          <span className="role-pill">{role}</span>
        </header>
        <CreateFolder disabled={role !== "owner"} onCreated={loadFolders} />
        <nav className="folder-list" aria-label="Folders">
          {folders.map((folder) => (
            <button
              key={folder.id}
              className={folder.id === selectedFolderId ? "selected" : ""}
              onClick={() => setSelectedFolderId(folder.id)}
            >
              <BookOpen />
              <span>
                <strong>{folder.name}</strong>
                <small>
                  {folder.topic_count} study blocks · {folder.note_count} notes · {folder.photo_count} photos
                </small>
              </span>
            </button>
          ))}
        </nav>
      </aside>

      <section className="center-column">
        <header className="toolbar">
          <div>
            <p className="eyebrow">{selectedFolder?.name || "Folder"}</p>
            <h1>{studyBlockName(feed?.topic.name || selectedTopic?.name) || "Choose a study block"}</h1>
          </div>
          <button className="ghost" onClick={refreshAll} title="Refresh">
            <RefreshCw />
          </button>
          {role === "owner" && (
            <button
              className="ghost"
              onClick={() =>
                api<{ description: string }>("/api/admin/telegram-webhook", { method: "POST", body: "{}" })
                  .then((data) => setNotice(data.description || "Telegram webhook is set"))
                  .catch(showError(setNotice))
              }
              title="Set Telegram webhook"
            >
              <Bot />
            </button>
          )}
        </header>

        {notice && <p className="notice">{notice}</p>}

        <TopicTabs
          role={role}
          topics={topics}
          selectedTopicId={selectedTopicId}
          folderId={selectedFolderId}
          onSelect={selectTopic}
          onCreated={() => loadTopics(selectedFolderId, true)}
        />

        {feed && (
          <>
            <Composer role={role} topicId={feed.topic.id} onSaved={refreshAll} />
            <AiPanel key={feed.topic.id} topicId={feed.topic.id} disabled={role !== "owner"} />
            <FeedStream feed={feed} role={role} onChanged={refreshAll} />
          </>
        )}
      </section>

      <aside className="topic-column">
        {feed ? <TopicCard feed={feed} role={role} onChanged={refreshAll} /> : <EmptyTopicCard />}
      </aside>
    </main>
  );
}

function CreateFolder({ disabled, onCreated }: { disabled: boolean; onCreated: () => Promise<void> }) {
  const [name, setName] = useState("");

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    if (!name.trim()) return;
    await api("/api/folders", { method: "POST", body: JSON.stringify({ name }) });
    setName("");
    await onCreated();
  }

  return (
    <form className="inline-form" onSubmit={submit}>
      <input
        value={name}
        onChange={(event) => setName(event.target.value)}
        placeholder={disabled ? "Owner can add folders" : "New folder"}
        disabled={disabled}
      />
      <button disabled={disabled || !name.trim()} title="Add folder">
        <FolderPlus />
      </button>
    </form>
  );
}

function TopicTabs({
  role,
  topics,
  selectedTopicId,
  folderId,
  onSelect,
  onCreated,
}: {
  role: Role;
  topics: TopicRow[];
  selectedTopicId: string;
  folderId: string;
  onSelect: (id: string) => void;
  onCreated: () => Promise<void>;
}) {
  const [name, setName] = useState("");

  async function createTopic(event: React.FormEvent) {
    event.preventDefault();
    if (!name.trim()) return;
    await api("/api/topics", { method: "POST", body: JSON.stringify({ folderId, name }) });
    setName("");
    await onCreated();
  }

  return (
    <section className="topic-strip">
      <div className="topic-tabs">
        {topics.map((topic) => (
          <button key={topic.id} className={topic.id === selectedTopicId ? "active" : ""} onClick={() => onSelect(topic.id)}>
            {studyBlockName(topic.name)}
          </button>
        ))}
      </div>
      <form className="topic-create" onSubmit={createTopic}>
        <input
          value={name}
          onChange={(event) => setName(event.target.value)}
          placeholder={role === "owner" ? "New study block" : "Owner can add study blocks"}
          disabled={role !== "owner"}
        />
        <button disabled={role !== "owner" || !name.trim()} title="Add study block">
          <Plus />
        </button>
      </form>
    </section>
  );
}

function Composer({ role, topicId, onSaved }: { role: Role; topicId: string; onSaved: () => Promise<void> }) {
  const [content, setContent] = useState("");
  const [description, setDescription] = useState("");
  const [file, setFile] = useState<File | null>(null);
  const [busy, setBusy] = useState(false);

  async function saveNote(event: React.FormEvent) {
    event.preventDefault();
    setBusy(true);
    try {
      await api("/api/notes", { method: "POST", body: JSON.stringify({ topicId, content }) });
      setContent("");
      await onSaved();
    } finally {
      setBusy(false);
    }
  }

  async function savePhoto(event: React.FormEvent) {
    event.preventDefault();
    if (!file) return;
    setBusy(true);
    try {
      const compressed = await compressImage(file);
      const form = new FormData();
      form.append("topicId", topicId);
      form.append("description", description);
      form.append("file", compressed, normalizedJpegName(file.name));
      await fetchApi("/api/photos", { method: "POST", body: form });
      setDescription("");
      setFile(null);
      await onSaved();
    } finally {
      setBusy(false);
    }
  }

  if (role !== "owner") {
    return (
      <section className="composer readonly">
        <MessageSquare />
        <span>Teacher mode: add feedback in the study block card.</span>
      </section>
    );
  }

  return (
    <section className="composer">
      <form className="note-form" onSubmit={saveNote}>
        <label>
          <span>New note</span>
          <textarea
            value={content}
            onChange={(event) => setContent(event.target.value.slice(0, 1000))}
            placeholder="#книга #сюжет Today I read the first chapter..."
            maxLength={1000}
          />
        </label>
        <div className="composer-actions">
          <small>{content.length}/1000</small>
          <button className="primary" disabled={busy || !content.trim()}>
            <Send />
            Save note
          </button>
        </div>
      </form>

      <form className="photo-form" onSubmit={savePhoto}>
        <label className="file-drop">
          <Upload />
          <span>{file ? file.name : "Upload compressed photo source"}</span>
          <input type="file" accept="image/*" onChange={(event) => setFile(event.target.files?.[0] || null)} />
        </label>
        <input
          value={description}
          onChange={(event) => setDescription(event.target.value.slice(0, 1000))}
          placeholder="Manual photo description, optional"
        />
        <button disabled={busy || !file}>
          <Image />
          Save photo
        </button>
      </form>
    </section>
  );
}

function AiPanel({ topicId, disabled }: { topicId: string; disabled: boolean }) {
  const [output, setOutput] = useState("");
  const [busyAction, setBusyAction] = useState("");

  useEffect(() => {
    setOutput("");
    setBusyAction("");
  }, [topicId]);

  async function run(action: string) {
    setBusyAction(action);
    setOutput("");
    try {
      const data = await api<{ response: string; cached: boolean }>("/api/ai/topic-action", {
        method: "POST",
        body: JSON.stringify({ topicId, action }),
      });
      setOutput(`${data.cached ? "Cached response\n\n" : ""}${data.response}`);
    } catch (err) {
      setOutput(err instanceof Error ? err.message : "AI request failed");
    } finally {
      setBusyAction("");
    }
  }

  return (
    <section className="ai-panel">
      <div className="ai-head">
        <Sparkles />
        <span>AI uses only this study block</span>
      </div>
      <div className="ai-actions">
        {AI_ACTIONS.map((action) => (
          <button key={action.id} disabled={disabled || Boolean(busyAction)} onClick={() => run(action.id)} title={action.title}>
            {busyAction === action.id ? <RefreshCw className="spin" /> : <Sparkles />}
            {action.label}
          </button>
        ))}
      </div>
      {output && <pre className="ai-output">{output}</pre>}
    </section>
  );
}

function FeedStream({ feed, role, onChanged }: { feed: TopicFeed; role: Role; onChanged: () => Promise<void> }) {
  const entries = useMemo(
    () =>
      [
        ...feed.notes.map((note) => ({ type: "note" as const, created_at: note.created_at, item: note })),
        ...feed.photos.map((photo) => ({ type: "photo" as const, created_at: photo.created_at, item: photo })),
      ].sort((a, b) => Date.parse(b.created_at) - Date.parse(a.created_at)),
    [feed],
  );

  if (!entries.length) {
    return (
      <section className="empty-stream">
        <FileText />
        <p>No notes yet. Send a Telegram message or add one to this study block.</p>
      </section>
    );
  }

  return (
    <section className="stream">
      {entries.map((entry) =>
        entry.type === "note" ? (
          <NoteItem key={entry.item.id} note={entry.item} role={role} onChanged={onChanged} />
        ) : (
          <PhotoItem key={entry.item.id} photo={entry.item} role={role} onChanged={onChanged} />
        ),
      )}
    </section>
  );
}

function NoteItem({ note, role, onChanged }: { note: NoteRow; role: Role; onChanged: () => Promise<void> }) {
  const [editing, setEditing] = useState(false);
  const [content, setContent] = useState(note.content);

  async function save() {
    await api(`/api/notes/${note.id}`, { method: "PATCH", body: JSON.stringify({ content }) });
    setEditing(false);
    await onChanged();
  }

  return (
    <article className="feed-item">
      <div className="item-icon">
        <FileText />
      </div>
      <div className="item-body">
        {editing ? (
          <>
            <textarea value={content} onChange={(event) => setContent(event.target.value.slice(0, 1000))} />
            <button className="tiny" onClick={save}>
              Save
            </button>
          </>
        ) : (
          <>
            <p>{note.content}</p>
            <TagLine tags={parseTags(note.tags_json)} />
          </>
        )}
      </div>
      {role === "owner" && (
        <button className="icon-button" onClick={() => setEditing((value) => !value)} title="Edit note">
          <PenLine />
        </button>
      )}
    </article>
  );
}

function PhotoItem({ photo, role, onChanged }: { photo: PhotoRow; role: Role; onChanged: () => Promise<void> }) {
  const [editing, setEditing] = useState(false);
  const [description, setDescription] = useState(photo.description);

  async function save() {
    await api(`/api/photos/${photo.id}`, { method: "PATCH", body: JSON.stringify({ description }) });
    setEditing(false);
    await onChanged();
  }

  return (
    <article className="feed-item photo-feed">
      <img src={photo.file_url} alt={photo.description || "Saved study material"} />
      <div className="item-body">
        {editing ? (
          <>
            <textarea value={description} onChange={(event) => setDescription(event.target.value.slice(0, 1000))} />
            <button className="tiny" onClick={save}>
              Save
            </button>
          </>
        ) : (
          <>
            <p>{photo.description || "No manual description yet."}</p>
            <TagLine tags={parseTags(photo.tags_json)} />
          </>
        )}
      </div>
      {role === "owner" && (
        <button className="icon-button" onClick={() => setEditing((value) => !value)} title="Edit photo description">
          <PenLine />
        </button>
      )}
    </article>
  );
}

function TopicCard({ feed, role, onChanged }: { feed: TopicFeed; role: Role; onChanged: () => Promise<void> }) {
  const [comment, setComment] = useState("");
  const [summary, setSummary] = useState(feed.topic.summary || "");
  const displayName = studyBlockName(feed.topic.name);

  useEffect(() => {
    setSummary(feed.topic.summary || "");
  }, [feed.topic.id, feed.topic.summary]);

  async function addComment(event: React.FormEvent) {
    event.preventDefault();
    if (!comment.trim()) return;
    await api("/api/comments", {
      method: "POST",
      body: JSON.stringify({ topicId: feed.topic.id, targetType: "topic", content: comment }),
    });
    setComment("");
    await onChanged();
  }

  async function saveBlock(event: React.FormEvent) {
    event.preventDefault();
    await api(`/api/topics/${feed.topic.id}`, { method: "PATCH", body: JSON.stringify({ summary }) });
    await onChanged();
  }

  return (
    <section className="topic-card">
      <p className="eyebrow">{feed.topic.folder_name} / {displayName}</p>
      <h2>{displayName}</h2>
      <div className="metrics">
        <span>{feed.notes.length} notes</span>
        <span>{feed.photos.length} photos</span>
        <span>{feed.comments.length} comments</span>
      </div>
      <TagLine tags={feed.tags} />

      <form className="block-summary" onSubmit={saveBlock}>
        <label>
          <span>What this block is about</span>
          <textarea
            value={summary}
            onChange={(event) => setSummary(event.target.value.slice(0, 600))}
            placeholder="Chapter, scene, lesson, video fragment, or word group..."
            disabled={role !== "owner"}
          />
        </label>
        <p>AI uses only notes and manual photo descriptions from this study block.</p>
        {role === "owner" && (
          <button disabled={summary === (feed.topic.summary || "")}>
            <CheckCircle2 />
            Save block
          </button>
        )}
      </form>

      <div className="photo-grid">
        {feed.photos.map((photo) => (
          <img key={photo.id} src={photo.file_url} alt={photo.description || "Saved photo"} />
        ))}
      </div>

      <form className="comment-form" onSubmit={addComment}>
        <label>
          <span>{role === "teacher" ? "Teacher comment" : "Private comment"}</span>
          <textarea value={comment} onChange={(event) => setComment(event.target.value.slice(0, 1000))} />
        </label>
        <button disabled={!comment.trim()}>
          <MessageSquare />
          Add comment
        </button>
      </form>

      <div className="comments">
        {feed.comments.map((item) => (
          <p key={item.id}>
            <strong>{item.author_role}</strong>
            {item.content}
          </p>
        ))}
      </div>
    </section>
  );
}

function EmptyTopicCard() {
  return (
    <section className="topic-card empty">
      <Brain />
      <h2>Choose a study block</h2>
      <p>The right side will collect photos, tags and teacher feedback for the current block.</p>
    </section>
  );
}

function TagLine({ tags }: { tags: string[] }) {
  if (!tags.length) return null;
  return (
    <div className="tags">
      {tags.map((tag) => (
        <span key={tag}>{tag}</span>
      ))}
    </div>
  );
}

async function compressImage(file: File): Promise<Blob> {
  const imageUrl = URL.createObjectURL(file);
  try {
    const image = await new Promise<HTMLImageElement>((resolve, reject) => {
      const img = document.createElement("img");
      img.onload = () => resolve(img);
      img.onerror = () => reject(new Error("Could not read image"));
      img.src = imageUrl;
    });
    const maxSide = 1600;
    const ratio = Math.min(1, maxSide / Math.max(image.naturalWidth, image.naturalHeight));
    const canvas = document.createElement("canvas");
    canvas.width = Math.max(1, Math.round(image.naturalWidth * ratio));
    canvas.height = Math.max(1, Math.round(image.naturalHeight * ratio));
    const context = canvas.getContext("2d");
    if (!context) throw new Error("Canvas is not available");
    context.drawImage(image, 0, 0, canvas.width, canvas.height);
    return await new Promise<Blob>((resolve, reject) => {
      canvas.toBlob((blob) => (blob ? resolve(blob) : reject(new Error("Could not compress image"))), "image/jpeg", 0.8);
    });
  } finally {
    URL.revokeObjectURL(imageUrl);
  }
}

function normalizedJpegName(name: string): string {
  const base = name.replace(/\.[^.]+$/, "");
  return `${base || "photo"}.jpg`;
}

function parseTags(value: string): string[] {
  try {
    return JSON.parse(value) as string[];
  } catch {
    return [];
  }
}

async function api<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetchApi(url, {
    ...init,
    headers: {
      "Content-Type": "application/json",
      ...(init?.headers || {}),
    },
  });
  return (await response.json()) as T;
}

async function fetchApi(url: string, init?: RequestInit): Promise<Response> {
  const response = await fetch(url, {
    credentials: "same-origin",
    ...init,
  });
  if (!response.ok) {
    let message = `Request failed: ${response.status}`;
    try {
      const data = (await response.json()) as { error?: string };
      if (data.error) message = data.error;
    } catch {
      // Keep the status-based fallback.
    }
    throw new Error(message);
  }
  return response;
}

function showError(setNotice: (value: string) => void) {
  return (error: unknown) => setNotice(error instanceof Error ? error.message : "Something went wrong");
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
