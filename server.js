const express = require("express");
const multer = require("multer");
const crypto = require("crypto");
const { createClient } = require("@supabase/supabase-js");

const SUPABASE_URL = (process.env.SUPABASE_URL || "").trim();
const SUPABASE_SERVICE_KEY = (process.env.SUPABASE_SERVICE_KEY || "").trim();
const STORE = process.env.BUCKET || "uploads"; // the one real Supabase bucket
const MAX_MB = Number(process.env.MAX_MB || 10); // max size of one uploaded file
const MAX_TEXT_MB = Number(process.env.MAX_TEXT_MB || 10); // max size of one text box
const MAX_NOTES = Number(process.env.MAX_NOTES || 20); // text boxes per bucket
const MARKER = ".bucket"; // tiny file that proves a user bucket exists

if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) {
  console.error("Missing SUPABASE_URL or SUPABASE_SERVICE_KEY");
  process.exit(1);
}

// Service key stays on the server only. Browsers never see it.
const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY, {
  auth: { persistSession: false },
});
const store = supabase.storage.from(STORE);

const app = express();
app.set("trust proxy", 1);
app.use(express.static("public"));

/* ---------- Rate limiting ---------- */
// General limit, plus a stricter limit on "bucket not found" answers
// (this is what slows down people guessing bucket names).
const hits = new Map();
const misses = new Map();
const recent = (map, ip) => {
  const now = Date.now();
  const arr = (map.get(ip) || []).filter((t) => now - t < 60_000);
  map.set(ip, arr);
  return arr;
};
app.use("/api", (req, res, next) => {
  res.set("Cache-Control", "no-store");
  recent(hits, req.ip).push(Date.now());
  if (recent(hits, req.ip).length > 600 || recent(misses, req.ip).length > 30)
    return res.status(429).json({ error: "Too many requests. Wait a minute." });
  next();
});
setInterval(() => { hits.clear(); misses.clear(); }, 10 * 60_000).unref();

const missing = (req, res) => {
  recent(misses, req.ip).push(Date.now());
  return res.status(404).json({ error: "No bucket with that name." });
};

/* ---------- Helpers ---------- */
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_MB * 1024 * 1024 },
});

const cleanName = (n) => n.replace(/[^\w.\- ()]/g, "_").slice(0, 120) || "file";
const validBucket = (b) => /^[a-z0-9][a-z0-9-]{2,39}$/.test(b);

app.param("bucket", (req, res, next, b) => {
  if (!validBucket(b))
    return res.status(400).json({
      error: "Bucket names are 3–40 characters: lowercase letters, numbers and hyphens.",
    });
  next();
});
app.param("id", (req, res, next, id) => {
  if (!/^\d{13}-[a-f0-9]{8}$/.test(id))
    return res.status(400).json({ error: "Invalid id" });
  next();
});

const known = new Set(); // buckets confirmed to exist (they can't be deleted)
async function exists(bucket) {
  if (known.has(bucket)) return true;
  const { data, error } = await store.list(bucket, { limit: 1, search: MARKER });
  if (error) throw error;
  const ok = data.some((f) => f.name === MARKER);
  if (ok) known.add(bucket);
  return ok;
}

const wrap = (fn) => (req, res) =>
  fn(req, res).catch((e) => {
    console.error(e);
    res.status(500).json({ error: e.message || "Something went wrong" });
  });

/* ---------- Buckets ---------- */
app.post("/api/b/:bucket/create", wrap(async (req, res) => {
  const { bucket } = req.params;
  if (await exists(bucket))
    return res.status(409).json({ error: "That name is taken. Pick another one." });
  const { error } = await store.upload(`${bucket}/${MARKER}`, Buffer.from("1"), {
    contentType: "text/plain",
    upsert: false,
  });
  if (error) throw error;
  known.add(bucket);
  res.json({ ok: true });
}));

/* ---------- Files ---------- */
app.get("/api/b/:bucket/files", wrap(async (req, res) => {
  const { bucket } = req.params;
  if (!(await exists(bucket))) return missing(req, res);
  const { data, error } = await store.list(bucket, {
    limit: 500,
    sortBy: { column: "created_at", order: "desc" },
  });
  if (error) throw error;
  res.json(
    data
      .filter((f) => f.name.includes("__"))
      .map((f) => ({
        key: f.name,
        name: f.name.split("__").slice(1).join("__"),
        size: f.metadata?.size ?? 0,
        date: f.created_at,
      }))
  );
}));

app.post("/api/b/:bucket/upload", upload.single("file"), wrap(async (req, res) => {
  const { bucket } = req.params;
  if (!req.file) return res.status(400).json({ error: "No file received" });
  if (!(await exists(bucket))) return missing(req, res);
  const original = Buffer.from(req.file.originalname, "latin1").toString("utf8");
  const key = `${Date.now()}_${crypto.randomBytes(4).toString("hex")}__${cleanName(original)}`;
  const { error } = await store.upload(`${bucket}/${key}`, req.file.buffer, {
    contentType: req.file.mimetype,
    upsert: false,
  });
  if (error) throw error;
  res.json({ ok: true });
}));

app.get("/api/b/:bucket/download/:key", wrap(async (req, res) => {
  const { bucket, key } = req.params;
  if (!key.includes("__") || key.includes("/")) return res.status(400).end();
  const name = key.split("__").slice(1).join("__");
  const { data, error } = await store.createSignedUrl(`${bucket}/${key}`, 60, { download: name });
  if (error || !data) return res.status(404).send("File not found");
  res.redirect(data.signedUrl);
}));

app.delete("/api/b/:bucket/files/:key", wrap(async (req, res) => {
  const { bucket, key } = req.params;
  if (!key.includes("__") || key.includes("/")) return res.status(400).json({ error: "Invalid file" });
  if (!(await exists(bucket))) return missing(req, res);
  const { error } = await store.remove([`${bucket}/${key}`]);
  if (error) throw error;
  res.json({ ok: true });
}));

/* ---------- Live text boxes ----------
   Text lives in memory for instant live updates and is saved to Supabase
   (bucket/notes/<id>.json) about a second after the last change.            */
const rooms = new Map(); // bucket -> { notes: Map(id -> note), rev, last, ready }

const notePath = (bucket, id) => `${bucket}/notes/${id}.json`;

function flush(bucket, id, note) {
  clearTimeout(note.timer);
  note.flushing = (note.flushing || Promise.resolve())
    .then(async () => {
      if (!note.dirty || note.deleted) return;
      note.dirty = false;
      let error;
      try {
        ({ error } = await store.upload(
          notePath(bucket, id),
          Buffer.from(JSON.stringify({ text: note.text })),
          { contentType: "application/json", upsert: true }
        ));
      } catch (e) { error = e; }
      if (error && !note.deleted) {
        note.dirty = true;
        console.error("Saving text box failed:", error.message);
        note.timer = setTimeout(() => flush(bucket, id, note), 5000);
      }
    })
    .catch((e) => console.error(e));
  return note.flushing;
}

function schedulePersist(bucket, id, note) {
  note.dirty = true;
  clearTimeout(note.timer);
  note.timer = setTimeout(() => flush(bucket, id, note), 800);
}

async function loadNotes(bucket, room) {
  const { data, error } = await store.list(`${bucket}/notes`, {
    limit: 100,
    sortBy: { column: "name", order: "asc" },
  });
  if (error) throw error;
  for (const f of data) {
    if (!f.name.endsWith(".json")) continue;
    const { data: blob, error: e2 } = await store.download(`${bucket}/notes/${f.name}`);
    if (e2 || !blob) continue;
    try {
      const j = JSON.parse(await blob.text());
      room.notes.set(f.name.slice(0, -5), { text: String(j.text || "") });
    } catch { /* skip unreadable file */ }
  }
}

function getRoom(bucket) {
  let room = rooms.get(bucket);
  if (!room) {
    room = { notes: new Map(), rev: Date.now(), last: Date.now() };
    room.ready = loadNotes(bucket, room).catch((e) => {
      rooms.delete(bucket);
      throw e;
    });
    rooms.set(bucket, room);
  }
  room.last = Date.now();
  return room.ready.then(() => room);
}

// Free memory for buckets nobody has touched for 30 minutes
setInterval(() => {
  const now = Date.now();
  for (const [b, r] of rooms) {
    const busy = [...r.notes.values()].some((n) => n.dirty);
    if (now - r.last > 30 * 60_000 && !busy) rooms.delete(b);
  }
}, 5 * 60_000).unref();

// Make sure nothing is lost when Render restarts the service
async function flushAll() {
  const jobs = [];
  for (const [b, r] of rooms)
    for (const [id, n] of r.notes) if (n.dirty) jobs.push(flush(b, id, n));
  await Promise.allSettled(jobs);
}
for (const sig of ["SIGTERM", "SIGINT"])
  process.on(sig, async () => { await flushAll(); process.exit(0); });

async function roomFor(req, res) {
  const { bucket } = req.params;
  if (!(await exists(bucket))) { missing(req, res); return null; }
  return getRoom(bucket);
}

// All text boxes. Pass ?since=<rev> to get a tiny "nothing changed" reply.
app.get("/api/b/:bucket/notes", wrap(async (req, res) => {
  const room = await roomFor(req, res);
  if (!room) return;
  if (String(room.rev) === req.query.since) return res.json({ rev: room.rev, same: true });
  const notes = [...room.notes.entries()]
    .sort((a, b) => (a[0] < b[0] ? -1 : 1))
    .map(([id, n]) => ({ id, text: n.text }));
  res.json({ rev: room.rev, notes });
}));

app.post("/api/b/:bucket/notes", wrap(async (req, res) => {
  const room = await roomFor(req, res);
  if (!room) return;
  if (room.notes.size >= MAX_NOTES)
    return res.status(400).json({ error: `A bucket can have up to ${MAX_NOTES} text boxes.` });
  const id = `${Date.now()}-${crypto.randomBytes(4).toString("hex")}`;
  const note = { text: "" };
  room.notes.set(id, note);
  room.rev++;
  schedulePersist(req.params.bucket, id, note);
  res.json({ id });
}));

app.put(
  "/api/b/:bucket/notes/:id",
  express.json({ limit: `${Math.ceil(MAX_TEXT_MB * 1.3)}mb` }),
  wrap(async (req, res) => {
    const room = await roomFor(req, res);
    if (!room) return;
    const note = room.notes.get(req.params.id);
    if (!note) return res.status(404).json({ error: "This text box was deleted." });
    const text = req.body && req.body.text;
    if (typeof text !== "string") return res.status(400).json({ error: "Missing text" });
    if (Buffer.byteLength(text) > MAX_TEXT_MB * 1024 * 1024)
      return res.status(413).json({ error: `Text is larger than ${MAX_TEXT_MB} MB` });
    note.text = text;
    room.rev++;
    schedulePersist(req.params.bucket, req.params.id, note);
    res.json({ ok: true });
  })
);

app.delete("/api/b/:bucket/notes/:id", wrap(async (req, res) => {
  const room = await roomFor(req, res);
  if (!room) return;
  const { bucket, id } = req.params;
  const note = room.notes.get(id);
  if (!note) return res.json({ ok: true });
  note.deleted = true;
  clearTimeout(note.timer);
  room.notes.delete(id);
  room.rev++;
  if (note.flushing) await note.flushing;
  const { error } = await store.remove([notePath(bucket, id)]);
  if (error) throw error;
  res.json({ ok: true });
}));

/* ---------- Errors ---------- */
app.use((err, _req, res, _next) => {
  if (err.code === "LIMIT_FILE_SIZE")
    return res.status(413).json({ error: `File is larger than ${MAX_MB} MB` });
  if (err.type === "entity.too.large")
    return res.status(413).json({ error: `Text is larger than ${MAX_TEXT_MB} MB` });
  console.error(err);
  res.status(500).json({ error: "Something went wrong" });
});

app.listen(process.env.PORT || 3000, () => console.log("Running"));