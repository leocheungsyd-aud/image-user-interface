const {
  S3Client,
  PutObjectCommand,
  GetObjectCommand,
  ListObjectsV2Command,
  CreateMultipartUploadCommand,
  UploadPartCommand,
  CompleteMultipartUploadCommand,
  AbortMultipartUploadCommand,
} = require('@aws-sdk/client-s3')
const { getSignedUrl } = require('@aws-sdk/s3-request-presigner')
const { CognitoJwtVerifier } = require('aws-jwt-verify')

const REGION = 'ap-southeast-2'
const ALLOWED_BUCKETS = (process.env.ALLOWED_BUCKETS ?? 'raw-678865629508-ap-southeast-2-an').split(',')
const PREFIX = 'upload/'
const EXPIRES_IN = 1800 // 30 minutes

const s3 = new S3Client({ region: REGION })

// JWT verifier — skipped if Cognito env vars are absent (local dev without auth)
const verifier =
  process.env.COGNITO_USER_POOL_ID && process.env.COGNITO_CLIENT_ID
    ? CognitoJwtVerifier.create({
        userPoolId: process.env.COGNITO_USER_POOL_ID,
        clientId: process.env.COGNITO_CLIENT_ID,
        tokenUse: 'id',
      })
    : null

async function verifyToken(authHeader) {
  if (!verifier) return // auth disabled locally
  if (!authHeader?.startsWith('Bearer ')) throw Object.assign(new Error('Unauthorized'), { status: 401 })
  try {
    await verifier.verify(authHeader.slice(7))
  } catch {
    throw Object.assign(new Error('Unauthorized'), { status: 401 })
  }
}

function corsHeaders(origin = '*') {
  return {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': origin,
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  }
}

function authError(origin) {
  return { statusCode: 401, headers: corsHeaders(origin), body: JSON.stringify({ error: 'Unauthorized' }) }
}

// ── S3 helpers ───────────────────────────────────────────────────────────────

async function buildPresignedUrl(filename, contentType, bucket = ALLOWED_BUCKETS[0]) {
  const safeFilename = filename.replace(/[^a-zA-Z0-9.\-_]/g, '_')
  const key = `${PREFIX}${Date.now()}-${safeFilename}`
  const command = new PutObjectCommand({ Bucket: bucket, Key: key, ContentType: contentType })
  const url = await getSignedUrl(s3, command, { expiresIn: EXPIRES_IN })
  return { url, key }
}

async function createMultipartUpload(filename, contentType, bucket = ALLOWED_BUCKETS[0]) {
  const safeFilename = filename.replace(/[^a-zA-Z0-9.\-_]/g, '_')
  const key = `${PREFIX}${Date.now()}-${safeFilename}`
  const { UploadId } = await s3.send(
    new CreateMultipartUploadCommand({ Bucket: bucket, Key: key, ContentType: contentType }),
  )
  return { uploadId: UploadId, key }
}

async function presignParts(bucket, key, uploadId, partNumbers) {
  return Promise.all(
    partNumbers.map(async (partNumber) => {
      const url = await getSignedUrl(
        s3,
        new UploadPartCommand({ Bucket: bucket, Key: key, UploadId: uploadId, PartNumber: partNumber }),
        { expiresIn: 3600 },
      )
      return { partNumber, url }
    }),
  )
}

async function completeMultipartUpload(bucket, key, uploadId, parts) {
  await s3.send(
    new CompleteMultipartUploadCommand({
      Bucket: bucket,
      Key: key,
      UploadId: uploadId,
      MultipartUpload: { Parts: parts.map(({ partNumber, etag }) => ({ PartNumber: partNumber, ETag: etag })) },
    }),
  )
  return { key }
}

async function abortMultipartUpload(bucket, key, uploadId) {
  await s3.send(new AbortMultipartUploadCommand({ Bucket: bucket, Key: key, UploadId: uploadId }))
}

async function buildPresignedDownloadUrl(bucket, key) {
  const command = new GetObjectCommand({ Bucket: bucket, Key: key })
  const url = await getSignedUrl(s3, command, { expiresIn: EXPIRES_IN })
  return { url }
}

async function listBuckets() {
  return ALLOWED_BUCKETS.map((name) => ({ name }))
}

async function listObjects(bucket, prefix = '') {
  const { CommonPrefixes, Contents } = await s3.send(
    new ListObjectsV2Command({ Bucket: bucket, Prefix: prefix, Delimiter: '/', MaxKeys: 1000 }),
  )
  return {
    prefixes: (CommonPrefixes ?? []).map((p) => p.Prefix),
    objects: (Contents ?? [])
      .filter((o) => o.Key !== prefix)
      .map((o) => ({ key: o.Key, size: o.Size, lastModified: o.LastModified })),
  }
}

// ── Lambda handler ────────────────────────────────────────────────────────────
exports.handler = async (event) => {
  const origin = event.headers?.origin ?? event.headers?.Origin ?? '*'
  const method = event.httpMethod ?? event.requestContext?.http?.method
  const path = event.path ?? event.rawPath ?? '/'
  const qs = event.queryStringParameters ?? {}
  const authHeader = event.headers?.Authorization ?? event.headers?.authorization

  if (method === 'OPTIONS') {
    return { statusCode: 204, headers: corsHeaders(origin), body: '' }
  }

  try {
    await verifyToken(authHeader)
  } catch {
    return authError(origin)
  }

  // GET /api/buckets
  if (method === 'GET' && path.endsWith('/buckets')) {
    try {
      return { statusCode: 200, headers: corsHeaders(origin), body: JSON.stringify({ buckets: await listBuckets() }) }
    } catch (err) {
      console.error('Failed to list buckets', err)
      return { statusCode: 500, headers: corsHeaders(origin), body: JSON.stringify({ error: 'Failed to list buckets' }) }
    }
  }

  // GET /api/objects?bucket=<name>&prefix=<prefix>
  if (method === 'GET' && path.endsWith('/objects')) {
    const { bucket, prefix = '' } = qs
    if (!bucket) {
      return { statusCode: 400, headers: corsHeaders(origin), body: JSON.stringify({ error: 'bucket is required' }) }
    }
    if (!ALLOWED_BUCKETS.includes(bucket)) {
      return { statusCode: 403, headers: corsHeaders(origin), body: JSON.stringify({ error: 'Bucket not allowed' }) }
    }
    try {
      return { statusCode: 200, headers: corsHeaders(origin), body: JSON.stringify(await listObjects(bucket, prefix)) }
    } catch (err) {
      console.error('Failed to list objects', err)
      return { statusCode: 500, headers: corsHeaders(origin), body: JSON.stringify({ error: 'Failed to list objects' }) }
    }
  }

  // POST /api/presign
  if (method === 'POST' && path.endsWith('/presign')) {
    let body
    try {
      body = JSON.parse(event.body || '{}')
    } catch {
      return { statusCode: 400, headers: corsHeaders(origin), body: JSON.stringify({ error: 'Invalid JSON body' }) }
    }
    const { filename, contentType, bucket } = body
    if (!filename || !contentType) {
      return { statusCode: 400, headers: corsHeaders(origin), body: JSON.stringify({ error: 'filename and contentType are required' }) }
    }
    if (!filename.toLowerCase().endsWith('.zip')) {
      return { statusCode: 400, headers: corsHeaders(origin), body: JSON.stringify({ error: 'Only .zip files are accepted' }) }
    }
    if (bucket && !ALLOWED_BUCKETS.includes(bucket)) {
      return { statusCode: 403, headers: corsHeaders(origin), body: JSON.stringify({ error: 'Bucket not allowed' }) }
    }
    try {
      return { statusCode: 200, headers: corsHeaders(origin), body: JSON.stringify(await buildPresignedUrl(filename, contentType, bucket)) }
    } catch (err) {
      console.error('Failed to generate presigned URL', err)
      return { statusCode: 500, headers: corsHeaders(origin), body: JSON.stringify({ error: 'Failed to generate upload URL' }) }
    }
  }

  // GET /api/presign-download?bucket=<name>&key=<key>
  if (method === 'GET' && path.endsWith('/presign-download')) {
    const { bucket, key } = qs
    if (!bucket || !key) {
      return { statusCode: 400, headers: corsHeaders(origin), body: JSON.stringify({ error: 'bucket and key are required' }) }
    }
    if (!ALLOWED_BUCKETS.includes(bucket)) {
      return { statusCode: 403, headers: corsHeaders(origin), body: JSON.stringify({ error: 'Bucket not allowed' }) }
    }
    try {
      return { statusCode: 200, headers: corsHeaders(origin), body: JSON.stringify(await buildPresignedDownloadUrl(bucket, key)) }
    } catch (err) {
      console.error('Failed to generate download URL', err)
      return { statusCode: 500, headers: corsHeaders(origin), body: JSON.stringify({ error: 'Failed to generate download URL' }) }
    }
  }

  // POST /api/multipart/create
  if (method === 'POST' && path.endsWith('/multipart/create')) {
    let body
    try {
      body = JSON.parse(event.body || '{}')
    } catch {
      return { statusCode: 400, headers: corsHeaders(origin), body: JSON.stringify({ error: 'Invalid JSON body' }) }
    }
    const { filename, contentType, bucket } = body
    if (!filename || !contentType) {
      return { statusCode: 400, headers: corsHeaders(origin), body: JSON.stringify({ error: 'filename and contentType are required' }) }
    }
    if (!filename.toLowerCase().endsWith('.zip')) {
      return { statusCode: 400, headers: corsHeaders(origin), body: JSON.stringify({ error: 'Only .zip files are accepted' }) }
    }
    if (bucket && !ALLOWED_BUCKETS.includes(bucket)) {
      return { statusCode: 403, headers: corsHeaders(origin), body: JSON.stringify({ error: 'Bucket not allowed' }) }
    }
    try {
      return { statusCode: 200, headers: corsHeaders(origin), body: JSON.stringify(await createMultipartUpload(filename, contentType, bucket)) }
    } catch (err) {
      console.error('Failed to create multipart upload', err)
      return { statusCode: 500, headers: corsHeaders(origin), body: JSON.stringify({ error: 'Failed to create multipart upload' }) }
    }
  }

  // POST /api/multipart/presign-parts
  if (method === 'POST' && path.endsWith('/multipart/presign-parts')) {
    let body
    try {
      body = JSON.parse(event.body || '{}')
    } catch {
      return { statusCode: 400, headers: corsHeaders(origin), body: JSON.stringify({ error: 'Invalid JSON body' }) }
    }
    const { key, bucket, uploadId, partNumbers } = body
    if (!key || !bucket || !uploadId || !Array.isArray(partNumbers) || partNumbers.length === 0) {
      return { statusCode: 400, headers: corsHeaders(origin), body: JSON.stringify({ error: 'key, bucket, uploadId, and partNumbers are required' }) }
    }
    if (!ALLOWED_BUCKETS.includes(bucket)) {
      return { statusCode: 403, headers: corsHeaders(origin), body: JSON.stringify({ error: 'Bucket not allowed' }) }
    }
    if (!key.startsWith(PREFIX)) {
      return { statusCode: 403, headers: corsHeaders(origin), body: JSON.stringify({ error: 'Invalid key' }) }
    }
    try {
      const parts = await presignParts(bucket, key, uploadId, partNumbers)
      return { statusCode: 200, headers: corsHeaders(origin), body: JSON.stringify({ parts }) }
    } catch (err) {
      console.error('Failed to presign parts', err)
      return { statusCode: 500, headers: corsHeaders(origin), body: JSON.stringify({ error: 'Failed to presign parts' }) }
    }
  }

  // POST /api/multipart/complete
  if (method === 'POST' && path.endsWith('/multipart/complete')) {
    let body
    try {
      body = JSON.parse(event.body || '{}')
    } catch {
      return { statusCode: 400, headers: corsHeaders(origin), body: JSON.stringify({ error: 'Invalid JSON body' }) }
    }
    const { key, bucket, uploadId, parts } = body
    if (!key || !bucket || !uploadId || !Array.isArray(parts) || parts.length === 0) {
      return { statusCode: 400, headers: corsHeaders(origin), body: JSON.stringify({ error: 'key, bucket, uploadId, and parts are required' }) }
    }
    if (!ALLOWED_BUCKETS.includes(bucket)) {
      return { statusCode: 403, headers: corsHeaders(origin), body: JSON.stringify({ error: 'Bucket not allowed' }) }
    }
    if (!key.startsWith(PREFIX)) {
      return { statusCode: 403, headers: corsHeaders(origin), body: JSON.stringify({ error: 'Invalid key' }) }
    }
    try {
      return { statusCode: 200, headers: corsHeaders(origin), body: JSON.stringify(await completeMultipartUpload(bucket, key, uploadId, parts)) }
    } catch (err) {
      console.error('Failed to complete multipart upload', err)
      return { statusCode: 500, headers: corsHeaders(origin), body: JSON.stringify({ error: 'Failed to complete multipart upload' }) }
    }
  }

  // POST /api/multipart/abort
  if (method === 'POST' && path.endsWith('/multipart/abort')) {
    let body
    try {
      body = JSON.parse(event.body || '{}')
    } catch {
      return { statusCode: 400, headers: corsHeaders(origin), body: JSON.stringify({ error: 'Invalid JSON body' }) }
    }
    const { key, bucket, uploadId } = body
    if (!key || !bucket || !uploadId) {
      return { statusCode: 400, headers: corsHeaders(origin), body: JSON.stringify({ error: 'key, bucket, and uploadId are required' }) }
    }
    if (!ALLOWED_BUCKETS.includes(bucket)) {
      return { statusCode: 403, headers: corsHeaders(origin), body: JSON.stringify({ error: 'Bucket not allowed' }) }
    }
    try {
      await abortMultipartUpload(bucket, key, uploadId)
      return { statusCode: 200, headers: corsHeaders(origin), body: JSON.stringify({ ok: true }) }
    } catch (err) {
      console.error('Failed to abort multipart upload', err)
      return { statusCode: 500, headers: corsHeaders(origin), body: JSON.stringify({ error: 'Failed to abort multipart upload' }) }
    }
  }

  return { statusCode: 404, headers: corsHeaders(origin), body: JSON.stringify({ error: 'Not found' }) }
}

module.exports.buildPresignedUrl = buildPresignedUrl
module.exports.buildPresignedDownloadUrl = buildPresignedDownloadUrl
module.exports.listBuckets = listBuckets
module.exports.listObjects = listObjects
module.exports.verifyToken = verifyToken
module.exports.ALLOWED_BUCKETS = ALLOWED_BUCKETS
module.exports.createMultipartUpload = createMultipartUpload
module.exports.presignParts = presignParts
module.exports.completeMultipartUpload = completeMultipartUpload
module.exports.abortMultipartUpload = abortMultipartUpload
