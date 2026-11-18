# Free native search collection on standard GitHub Actions runners

Only public source code belongs in this directory. Keyword lists are passed through repository Actions secrets, never committed or logged. Reports are AES-256-GCM encrypted with a random per-batch key before uploading as artifacts (one-day retention). The key stays in the user's private ASO home and a repository Actions secret. The local importer validates app, keyword, source and authentication tag before inserting data.

Each app has one Ubuntu runner, paced at 24 requests/minute. Repeated 403/429 stops that runner with a partial encrypted checkpoint. No iTunes catalog fallback. GitHub-hosted standard runners are free for public repositories; artifact storage is limited separately. Five small encrypted reports fit well below the default allowance.

Rebuild collector.mjs after changing the TypeScript collector or its imports:
`node_modules/.bin/esbuild tools/aso-actions/collector.ts --bundle --platform=node --format=esm --outfile=tools/aso-actions/collector.mjs`
