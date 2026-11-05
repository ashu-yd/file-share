const express = require("express");
const multer = require("multer");
const crypto = require("crypto");
const { createClient } = require("@supabase/supabase-js");

const { SUPABASE_URL, SUPABASE_SERVICE_KEY } = process.env;
const STORE = process.env.BUCKET || "uploads"; // the one real Supabase bucket
const MAX_MB = Number(process.env.MAX_MB || 10);
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

// Simple per-IP rate limit (slows down people guessing bucket names)
const hits = new Map();
app.use("/api", (req, res, next) => {
  const now = Date.now();
  const rec = (hits.get(req.ip) || []).filter((t) => now - t < 60_000);
  rec.push(now);
  hits.set(req.ip, rec);
  if (rec.length > 60) return res.status(429).json({ error: "Too many requests. Wait a minute." });
  next();
});
setInterval(() => hits.clear(), 10 * 60_000).unref();

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

async function exists(bucket) {
  const { data, error } = await store.list(bucket, { limit: 1, search: MARKER });
  if (error) throw error;
  return data.some((f) => f.name === MARKER);
}

const wrap = (fn) => (req, res) =>
  fn(req, res).catch((e) => res.status(500).json({ error: e.message || "Something went wrong" }));

// Create a new bucket (fails if the name is taken)
app.post("/api/b/:bucket/create", wrap(async (req, res) => {
  const { bucket } = req.params;
  if (await exists(bucket))
    return res.status(409).json({ error: "That name is taken. Pick another one." });
  const { error } = await store.upload(`${bucket}/${MARKER}`, Buffer.from("1"), {
    contentType: "text/plain",
    upsert: false,
  });
  if (error) throw error;
  res.json({ ok: true });
}));

// List files in a bucket (also used to check the bucket exists)
app.get("/api/b/:bucket/files", wrap(async (req, res) => {
  const { bucket } = req.params;
  if (!(await exists(bucket)))
    return res.status(404).json({ error: "No bucket with that name." });
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
  if (!(await exists(bucket)))
    return res.status(404).json({ error: "No bucket with that name." });
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
  if (!(await exists(bucket)))
    return res.status(404).json({ error: "No bucket with that name." });
  const { error } = await store.remove([`${bucket}/${key}`]);
  if (error) throw error;
  res.json({ ok: true });
}));

app.use((err, _req, res, _next) => {
  if (err.code === "LIMIT_FILE_SIZE")
    return res.status(413).json({ error: `File is larger than ${MAX_MB} MB` });
  res.status(500).json({ error: "Something went wrong" });
});

app.listen(process.env.PORT || 3000, () => console.log("Running"));
