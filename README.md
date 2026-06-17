# ZIP Uploader

React + Vite frontend for uploading ZIP files to AWS S3, with a Node.js backend that generates presigned URLs and a Cognito-based login.

---

## Local Development

### Prerequisites
- Node.js 18+
- AWS credentials configured (`~/.aws/credentials` or environment variables)

### Install dependencies

```bash
# Frontend
npm install

# Backend
cd backend && npm install
```

### Environment variables

Create `.env.local` in the project root:

```
VITE_COGNITO_USER_POOL_ID=ap-southeast-2_XXXXXXXX
VITE_COGNITO_CLIENT_ID=your_client_id
```

### Start servers

```bash
# Terminal 1 — backend (http://localhost:3001)
cd backend && node server.js

# Terminal 2 — frontend (http://localhost:5173)
npm run dev
```

> JWT auth is disabled on the backend when `COGNITO_USER_POOL_ID` is not set, useful for local dev without Cognito.

---

## Deployment

### Frontend — S3 + CloudFront

**Bucket:** `user-interface-678865629508-ap-southeast-2-an`  
**CloudFront distribution:** `E3LLXFENPNWOSU`

#### 1. Set production environment variables

Create `.env.production` in the project root:

```
VITE_API_URL=https://your-api-gateway-url.execute-api.ap-southeast-2.amazonaws.com
VITE_COGNITO_USER_POOL_ID=ap-southeast-2_XXXXXXXX
VITE_COGNITO_CLIENT_ID=your_client_id
```

#### 2. Build

```bash
npm run build
```

#### 3. Upload to S3

```bash
aws s3 sync dist/ s3://user-interface-678865629508-ap-southeast-2-an/ --delete
```

#### 4. Invalidate CloudFront cache

```bash
aws cloudfront create-invalidation \
  --distribution-id E3LLXFENPNWOSU \
  --paths "/*"
```

---

### Backend — Lambda + API Gateway

#### 

Use SAM to re-deploy
```bash
sam build && sam deploy --region ap-southeast-2 
```

#### 1. Package the function

```bash
cd backend
npm install --omit=dev
zip -r function.zip .
```

#### 2a. First-time deploy — create the Lambda function

```bash
aws lambda create-function \
  --function-name zip-uploader-api \
  --runtime nodejs20.x \
  --handler handler.handler \
  --zip-file fileb://function.zip \
  --role arn:aws:iam::678865629508:role/your-lambda-role \
  --region ap-southeast-2 \
  --environment Variables="{
    COGNITO_USER_POOL_ID=ap-southeast-2_XXXXXXXX,
    COGNITO_CLIENT_ID=your_client_id,
    ALLOWED_BUCKETS=raw-678865629508-ap-southeast-2-an
  }"
```

#### 2b. Subsequent deploys — update existing function

```bash
aws lambda update-function-code \
  --function-name zip-uploader-api \
  --zip-file fileb://function.zip \
  --region ap-southeast-2
```

#### 3. API Gateway (one-time setup)

In the AWS Console:

1. **API Gateway → Create HTTP API**
2. Add integration → Lambda → `zip-uploader-api`
3. Add routes:
   - `GET /api/buckets`
   - `GET /api/objects`
   - `POST /api/presign`
   - `GET /api/presign-download`
   - `OPTIONS /{proxy+}`
4. Deploy the API and copy the invoke URL into `.env.production` as `VITE_API_URL`

#### 4. Lambda environment variables

Set these in the Lambda console or via CLI:

| Key | Value |
|-----|-------|
| `COGNITO_USER_POOL_ID` | `ap-southeast-2_XXXXXXXX` |
| `COGNITO_CLIENT_ID` | your app client ID |
| `ALLOWED_BUCKETS` | `raw-678865629508-ap-southeast-2-an` |

#### 5. Lambda IAM role permissions

The Lambda execution role needs:

```json
{
  "Effect": "Allow",
  "Action": [
    "s3:ListAllMyBuckets"
  ],
  "Resource": "*"
},
{
  "Effect": "Allow",
  "Action": [
    "s3:ListBucket",
    "s3:ListObjectsV2"
  ],
  "Resource": "arn:aws:s3:::raw-678865629508-ap-southeast-2-an"
},
{
  "Effect": "Allow",
  "Action": [
    "s3:PutObject",
    "s3:GetObject"
  ],
  "Resource": "arn:aws:s3:::raw-678865629508-ap-southeast-2-an/*"
}
```

---

## User Management (Cognito)

### Create a user

```bash
# Create user
aws cognito-idp admin-create-user \
  --user-pool-id ap-southeast-2_XXXXXXXX \
  --username user@example.com \
  --user-attributes Name=email,Value=user@example.com Name=email_verified,Value=true \
  --message-action SUPPRESS \
  --region ap-southeast-2

# Set permanent password (skips forced reset)
aws cognito-idp admin-set-user-password \
  --user-pool-id ap-southeast-2_XXXXXXXX \
  --username user@example.com \
  --password "YourPassword123!" \
  --permanent \
  --region ap-southeast-2
```

### Delete a user

```bash
aws cognito-idp admin-delete-user \
  --user-pool-id ap-southeast-2_XXXXXXXX \
  --username user@example.com \
  --region ap-southeast-2
```

---

## S3 CORS (one-time setup)

The upload bucket needs a CORS rule to allow PUT requests from the browser:

```bash
aws s3api put-bucket-cors \
  --bucket raw-678865629508-ap-southeast-2-an \
  --cors-configuration '{
    "CORSRules": [{
      "AllowedHeaders": ["Content-Type"],
      "AllowedMethods": ["PUT"],
      "AllowedOrigins": ["https://your-cloudfront-domain.cloudfront.net"],
      "ExposeHeaders": []
    }]
  }'
```

---

## Project Structure

```
user-interface/
├── src/
│   ├── auth/
│   │   ├── cognito.js          # Cognito auth via fetch (no SDK)
│   │   └── authedFetch.js      # fetch wrapper that attaches JWT
│   ├── components/
│   │   ├── Login.jsx / .css    # Login form
│   │   ├── Sidebar.jsx / .css  # S3 tree navigator
│   │   └── FileUpload.jsx / .css
│   ├── App.jsx / .css
│   └── main.jsx
├── backend/
│   ├── handler.js              # Lambda entry point
│   └── server.js               # Local Express dev server
├── .env.example
└── vite.config.js
```
