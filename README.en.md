# Bymark｜留印

English · [中文](README.md)

Bymark is a personalized share-card generator designed for short-form writers. It doesn't write for you, and it doesn't speak for you — it takes the viewpoints, fragments, and feelings you have already written and lays them out as a share image that carries your personal mark. Avatar, byline, time, location, images, and layout all combine the way you want; export directly when you're done, and let your words travel with your identity. Less template, more human trace, so that when a single sentence goes out, people can tell who it came from.

## Preview

### Dark mode

![Bymark dark mode preview](docs/images/bymark-dark.png)

### Warm white mode

![Bymark warm white mode preview](docs/images/bymark-light.png)

### Pure white mode

![Bymark pure white mode preview](docs/images/bymark-white.png)

## Features

- Live editing and preview: body copy, author details, time, location, avatar, and images update the card immediately; the editor also includes undo, redo, and character metrics.
- Markdown writing: level 1/2 headings, quotes, unordered/ordered lists, bold, and italic are supported, with one-click plain-text copying.
- Carousel director: review every page's excerpt and text density, pin or restore page starts, and batch-export the full sequence.
- Publishing formats: `3:4`, `2:3`, `9:16`, and a Douyin cover mode with a safe-area guide in the preview.
- Scene image mode: use a full-bleed background with a fixed floating card and focused readability controls.
- High-resolution export: PNG or JPG at `1K`, `2K`, `3K`, or `4K` resolution, with one-click copying for the current page.
- Publish-ready action: opens the system share sheet when available, or copies the text and downloads the image package.
- Local drafts: drafts autosave in the browser and can be created, opened, renamed, deleted, or restored.
- Next issue: derive an independent draft that keeps the author and layout, then clears the copy and content imagery.
- Settings presets: save reusable author information, canvas, theme, and layout settings.
- Workspace backup: export the current work, drafts, and settings presets to JSON and merge them back into another browser.
- Three themes and responsive editing: dark, warm white, and pure white; both desktop and mobile can finish editing and exporting.

The first launch shows built-in sample copy, author details, and publishing settings. These are initialization values only and do not overwrite later local edits.

## Run locally

Prerequisites: the current Node.js LTS release and npm.

```bash
git clone <your-repository-url>
cd Bymark
npm install
npm run dev
```

Open the URL printed by the development server. It prefers `http://localhost:5174`, but another port works when 5174 is occupied or `--port` is provided.

Local Vite development and preview servers share drafts, archives, presets, avatars, images, and settings through `.bymark-local-data/` in the project. Opening another localhost or 127.0.0.1 port and refreshing reads the same data. Each old browser origin imports its existing data the first time it opens after this update. To bring in drafts previously stored at `localhost:5174`, open that address once after updating; browsers cannot read another port's old IndexedDB directly. The shared directory is Git ignored. Keep workspace backups for moving to another computer.

## Production build and deployment

Bymark is a static Vite application with no backend dependency. The build output is written to `dist/` and can be deployed to Vercel, Netlify, Cloudflare Pages, GitHub Pages, or any static file server.

```bash
npm run build
npm run preview
```

Typical platform settings:

| Platform | Build command | Output directory |
| --- | --- | --- |
| Vercel / Netlify / Cloudflare Pages | `npm run build` | `dist` |
| GitHub Pages | `npm run build` | `dist` |
| Self-hosted static server | Build locally, then upload `dist/` | `dist` |

There are no required environment variables or server APIs. If the app is deployed under a non-root path, configure Vite's `base` option and verify icon, Manifest, and asset URLs.

### Publishing a new version

The app checks the latest stable GitHub Release every four hours and compares it with the deployed version from `package.json`. Until the repository has its first Release, it falls back to the version on the `main` branch. Before publishing, update `version` in `package.json` (for example, `0.2.0`) and preferably create a matching GitHub Release (for example, `v0.2.0`). When a newer version is found, a green update link appears beside the logo.

## Commands

```bash
# TypeScript check and production build
npm run build

# ESLint
npm run lint

# Unit checks
npm run unit

# Browser feature and UI regression checks
npm run qa

# Preview the production build
npm run preview
```

If Chromium is not installed locally, run:

```bash
npx playwright install chromium
```

QA can also target an already-running site:

```bash
BYMARK_URL=http://127.0.0.1:4173 npm run qa
```

## Stack

- Vue 3 + TypeScript
- Vite
- `html-to-image` for image export
- Lucide for interface icons
- Playwright for browser regression checks

## Project structure

```text
src/
  components/       editor, preview, draft, and template components
  App.tsx           app orchestration, autosave, pagination, and image export
  drafts.ts         draft storage and snapshot logic
  sharedStorage.ts  local shared-storage client and migration
  brandTemplates.ts local settings-preset storage
  markdown.tsx      Markdown rendering and plain-text copying
  pagination.ts     long-text pagination and manual page breaks
  workspace.ts      workspace backup format and merge logic
  bymark.ts         editor state, local settings, and image storage
scripts/            Vite local shared-storage service
public/             icons, default avatar, and PWA Manifest
docs/images/        README preview images
tests/              unit checks and browser QA
```

## Data and privacy

Deployed Bymark has no backend service: settings stay in browser `localStorage`, while drafts, presets, and image assets use IndexedDB. Only local Vite development and preview servers use the shared project directory. Nothing is synced to the cloud automatically; use workspace backup for a portable copy.

Before deployment, verify:

- Production build, lint, unit checks, and QA all pass.
- The target platform serves all static assets from `dist/` correctly.
- Whether users need cross-device sync or cloud backup; the current release provides manual workspace backup, not cloud sync.
- If deploying under a subpath such as GitHub Pages, add the correct Vite `base` setting and verify asset URLs.

## License

Released under the [MIT License](LICENSE). Copyright © 2026 Rainxen.
