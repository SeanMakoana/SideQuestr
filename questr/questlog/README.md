# Questlog

A free, private app for your side quests: a status board, a diary, and a funds tracker with a dashboard. Works on your phone and PC, installs like an app, and works offline.

## Try it right now (no setup)

Open `index.html` in your browser. Everything is saved on that device. Features like "install to home screen" and offline mode need it hosted (step 3), but the app itself works straight from the file.

## What is in it

- **Home**: your money sits at the top as progress tiles (income goals ring, net, in vs out, a dot-grid activity map and a progress bar per quest). Under it is a Pinterest-style grid of your quests. Each quest's cover is the most recent photo or video you added to it, and the grid is ordered by latest activity, newest first.
- **Quest board**: open a quest to get its own Pinterest board of photos, videos and diary notes, newest first going down. The description and long notes are clamped with a **Read more** so it stays tidy. Tap a photo or video to view it full size, add a caption, swipe or arrow through the rest, or delete it. The quest's money, goal bar and money log are at the top of the board.
- **Add from your phone**: the big + button (or buttons on a quest) lets you **Take photo**, **Record video**, pick from your **gallery** (several at once), write a note or log money. On a phone the first two open the camera.
- **Diary**: a general journal plus entries attached to quests, shown as note cards, newest first, searchable and filterable by quest.
- **Funds**: add money in or out per quest, a 6-month in-vs-out chart, totals per quest, and **import a bank statement CSV** (duplicates are flagged so re-importing is safe).
- **Look**: a retro computer-ad style: cream paper, heavy soft serif headlines, terminal-style mono labels and rainbow stripes. **Paper** is the light theme and **CRT** is the dark theme (warm black with faint scanlines). Use the moon/sun button at the top of any page, or Settings > Appearance (Auto follows your phone or PC).
- **Settings**: appearance, sign in to sync, see how much photo/video space you use, download or restore a backup of your notes and money, clear this device.

Photos are shrunk to a maximum of 1600 px (about 150-400 KB each) so your free storage lasts. Videos are kept as recorded, up to 50 MB each; record at 720p if your phone defaults to 4K.

## Setup for syncing phone and PC (all free)

### 1. Make a free Supabase project
1. Go to https://supabase.com and create an account, then **New project** (free plan). Pick any name and a database password you save somewhere.
2. In the project, open **SQL Editor > New query**, paste everything from `schema.sql`, and click **Run**. This also creates the private storage bucket for your photos and videos. If you set up an older version of Questlog, run the new `schema.sql` again; it upgrades your database and keeps your data.
3. Open **Authentication > Providers > Email**. For a personal app it is easiest to turn **Confirm email** off, so you can sign in straight after creating your account. (Leave it on if you prefer; you will just click a link in your email once.)

### 2. Connect the app
1. In Supabase open **Project Settings > API**. Copy the **Project URL** and the **anon public** key.
2. Open `config.js` and paste them in:
   ```js
   window.QUESTLOG_CONFIG = {
     SUPABASE_URL: 'https://yourproject.supabase.co',
     SUPABASE_ANON_KEY: 'your-long-anon-key',
   };
   ```
   The anon key is designed to be public. Your data is locked to your login by row level security (it is in `schema.sql`).

### 3. Host it for free
Any static host works. Easiest options:
- **Cloudflare Pages** or **Netlify**: drag and drop this whole folder in their dashboard.
- **GitHub Pages**: push the folder to a repo and enable Pages.

You get an https link. Open it on your PC and phone, then in the app go to **Settings > Sign in or create account** using the same email and password on both.

### 4. Put it on your phone
- **Android (Chrome)**: menu > **Install app** / **Add to Home screen**.
- **iPhone (Safari)**: Share > **Add to Home Screen**.

In Supabase, add your hosted link under **Authentication > URL Configuration > Site URL** (only matters if you keep email confirmation on).

## Good to know

- **Free storage**: Supabase's free plan includes about 1 GB of file storage and 500 MB of database. Settings shows how much photo/video space you have used. Photos and videos live on the device you took them on and in your private cloud storage; other devices download them as you scroll.
- **Camera needs https**: the camera only works on the hosted https link (or localhost), not when `index.html` is opened as a plain file. Picking from the gallery works everywhere.

- **Free tier pause**: Supabase pauses free projects after about a week with no activity. Your data is kept; open the Supabase dashboard and click **Restore** if it happens. Opening the app regularly keeps it awake.
- **Local first**: every change saves on the device immediately and syncs when you are online. If a sync fails you see a red dot on Settings and it retries on the next change.
- **Backups**: **Settings > Download backup** saves your quests, notes and money as a file. Photos and videos are not in that file; they are safe in your cloud storage once synced.
- **Updating the app**: replace the files on your host. The app checks for new files each time you open it with internet.
- **Bank CSVs**: the importer guesses the date, description and amount columns and lets you change them. If your bank splits Debit and Credit columns, pick those instead of Amount. Dates like 24/10/2026 and 2026-10-24 both work.

## Files

| File | What it does |
| --- | --- |
| `index.html`, `styles.css`, `app.js` | The app |
| `config.js` | Your Supabase URL and key |
| `schema.sql` | Database tables and security rules |
| `sw.js`, `manifest.webmanifest`, `icons/` | Offline mode and install to home screen |
| `vendor/supabase.js` | Supabase client, bundled so no CDN is needed |
| `fonts/` | Fraunces and IBM Plex Mono, bundled so it looks right offline (both are free under the SIL Open Font License) |
