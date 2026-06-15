# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project overview

A React + Vite frontend for uploading ZIP files to S3, backed by a small Node.js service that generates presigned PUT URLs. The browser never holds AWS credentials — it fetches a short-lived signed URL from the backend, then PUTs the file directly to S3.

## Commands

### Frontend (project root)
```bash
npm install          # install deps
npm run dev          # Vite dev server on http://localhost:5173
npm run build        # production build → dist/
npm run preview      # serve the production build locally
```

### Backend (backend/)
```bash
cd backend && npm install
node server.js       # Express dev server on http://localhost:3001
```

In development, Vite proxies `/api/*` to `http://localhost:3001` (see `vite.config.js`), so the frontend and backend can each run on their own port without CORS issues.

## Architecture

```
src/
  App.jsx               — shell layout (card + header)
  components/
    FileUpload.jsx       — all upload logic and state machine
    FileUpload.css       — component styles
backend/
  handler.js            — AWS Lambda entry point + shared buildPresignedUrl()
  server.js             — thin Express wrapper for local dev; delegates to handler.js
```

### Upload flow
1. User drops / selects a `.zip` file in `FileUpload.jsx`
2. Frontend POSTs `{ filename, contentType }` to `/api/presign`
3. Backend generates an S3 `PutObject` presigned URL (15-min TTL) and returns `{ url, key }`
4. Frontend PUTs the file body directly to the presigned URL via `XMLHttpRequest` (XHR is used instead of fetch because it gives real upload-progress events)
5. On success, the S3 key is shown to the user

### State machine (`FileUpload.jsx`)
`IDLE → DRAGGING → UPLOADING → SUCCESS | ERROR`  
All state lives in a single component; there is no global store.

## S3 target
- **Bucket:** `raw-678865629508-ap-southeast-2-an`
- **Region:** `ap-southeast-2`
- **Key prefix:** `upload/`
- Keys are prefixed with `Date.now()` to avoid collisions.

### Required S3 CORS configuration
The bucket must allow PUT from the frontend origin. Apply this in the AWS console or via CLI:

```json
[
  {
    "AllowedHeaders": ["Content-Type"],
    "AllowedMethods": ["PUT"],
    "AllowedOrigins": ["*"],
    "ExposeHeaders": []
  }
]
```

### Backend IAM permissions
The Lambda execution role (or local AWS credentials) need `s3:PutObject` on `arn:aws:s3:::raw-678865629508-ap-southeast-2-an/upload/*`.

## Deploying the backend to Lambda
The `backend/handler.js` is a standard Lambda handler (`exports.handler`). Deploy it with your preferred tool (SAM, CDK, Serverless Framework, or manual zip upload). Wire it to an API Gateway `POST /api/presign` route. Set the API Gateway URL as the frontend's `VITE_API_BASE_URL` env var (then update `fetchPresignedUrl` in `FileUpload.jsx` to use `import.meta.env.VITE_API_BASE_URL + '/api/presign'`).
