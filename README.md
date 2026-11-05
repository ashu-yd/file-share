# File Share

Create a bucket with a unique name. Anyone who knows the name (or has the link) can open it, upload files and download files. There are no accounts: the name is the key, so use a long, hard-to-guess one for anything private.

## 1. Storage (Supabase, free)
1. Create a free project at https://supabase.com
2. Go to **Storage → New bucket**, name it `uploads`, keep it **Private**. (This is the one real storage bucket; each user bucket is a folder inside it.)
3. Go to **Project Settings → API** and copy:
   - Project URL → `SUPABASE_URL`
   - `service_role` key → `SUPABASE_SERVICE_KEY` (secret, never put it in the browser or commit it)

Free tier: 1 GB total storage, 50 MB max per file. This app limits files to 10 MB (change with `MAX_MB`).

## 2. Run locally (optional)
```
npm install
export SUPABASE_URL=... SUPABASE_SERVICE_KEY=...
npm start
```
Open http://localhost:3000

## 3. Deploy on Render
1. Push this folder to GitHub.
2. Render → **New → Web Service** → pick the repo.
3. Build command: `npm install`  Start command: `npm start`
4. Add environment variables: `SUPABASE_URL`, `SUPABASE_SERVICE_KEY` (and optionally `BUCKET`, `MAX_MB`).
5. Deploy.

Note: Render's free plan sleeps after inactivity, so the first load may take ~30 seconds. Files are safe because they live in Supabase, not on Render.
