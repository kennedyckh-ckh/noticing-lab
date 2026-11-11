# Deploying Noticing Lab

The app stores everything in one SQLite file, so it needs a host with a **persistent disk** and a **single running instance**.
Vercel and other serverless hosts do not keep files between requests: do not use them without first moving to a hosted database.

## Render (blueprint included)

1. Put this folder in a GitHub repository (the assistant can push it for you).
2. Render dashboard: **New > Blueprint**, choose the repository. It reads `render.yaml`, builds the `Dockerfile`, and mounts a 1 GB disk at `/data`.
3. When asked, enter the three `BOOTSTRAP_FACILITATOR_*` values: your email, your name and a starting password (8+ characters). The first sign-in forces a new password.
4. Optional: add `ANTHROPIC_API_KEY` for real AI drafts. Leave it out to keep the labelled simulator.
5. Open the service URL, sign in as the facilitator, create a session, add teachers (their temporary passwords appear once).
6. After the first sign-in, delete the three `BOOTSTRAP_FACILITATOR_*` variables.

## Any other host with a disk (Fly.io, Railway, a VPS)

Build the `Dockerfile`, mount persistent storage at `/data`, expose port 3000 over HTTPS, set the same variables. Health check: `GET /api/health`.
If your proxy rewrites the Host header and sign-in fails with "Cross-site request blocked", set `PUBLIC_HOST` to your public host name (for example `pd.example.org`).

## Do not

* Run `npm run seed` in production (demo accounts have a published password).
* Run more than one instance (login throttling is in memory; SQLite is one writer).
* Forget backups: copy `/data/pd.sqlite` regularly. Exports contain names and emails.

## About the lockfile

This repository ships without `package-lock.json`; `package.json` pins every dependency to an exact version and the Dockerfile uses `npm install`.
To lock transitive dependencies too, run `npm install` locally, commit the generated `package-lock.json`, and change the Dockerfile to copy it and use `npm ci`.
