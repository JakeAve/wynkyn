# The hosted site

The public site is plain files: no server, no API. The app picks a folder and
runs the `BookService` itself (`localBackend`, `references/web-app.md`).

## Building it

`deno task build:site` builds the client and writes the site to `dist/`
(gitignored):

- the static pages from `web/site/` at the root (`/`, `/about/`, `/faq/`), with
  their own small `site.css`;
- the app at `/app/`;
- the crawler files, and for agents helping an author `/llms.txt` (the entry
  point), `/spec.md` (`book-renderer-spec.md`) and `/convert-manuscript.md`
  (the `convert-manuscript` skill).

`FILES` in `scripts/build-site.ts` is the one map of source → published path.
The dev server serves the same paths from their sources (`siteFile`), so every
URL in the app and its pages is root-absolute. A new file the site needs is one
`FILES` entry.

`deno task serve:site` serves `dist/` on http://localhost:8010 the way any
static host would. `web/src/local-browser_test.ts` drives that build with no
server, so run `build:site` first or it is skipped.

## Deploys

- **Deno Deploy** builds with `build:site` and serves `dist/` (second-brain
  `playbooks/deno-deploy.md`).
- **GitHub Pages** serves it under `/wynkyn/`, so `.github/workflows/pages.yml`
  builds with `--base=/wynkyn/`, which prefixes those root-absolute links
  (`rebase` in `scripts/build-site.ts`).

## What runs in the browser there

- Print and Export EPUB run in the page; `web/src/book-zip.ts` zips a book for
  download out of browser storage.
- Browsers without the File System Access API (Firefox, Safari, Brave by
  default) get a notice pointing at Chrome or Edge, then the same Welcome with
  the folder buttons tagged Chromium only (a click fails with the browser's own
  error).
- A browser-storage library's Create dialog has Import from a folder.
