# CozyQuiz Backend Deployment

Deploy targets (pick one):

## 1. Railway
1. Create new project → Deploy from GitHub (backend folder or separate repo).
2. If mono-repo, set Root Directory to `backend`.
3. Add Env Vars as needed:
   - PORT=3001 (Railway sets automatically)
   - ALLOWED_ORIGINS=https://play.cozyquiz.app
4. Deploy.

## 2. Render
1. New Web Service → from GitHub.
2. Root Directory: `backend`.
3. Build Command: `npm install` (or let auto). Start Command: `node server.js`.
4. Set Environment Variables:
   - NODE_VERSION=20
   - ALLOWED_ORIGINS=https://play.cozyquiz.app
5. Deploy.

## 3. Fly.io (Docker)
1. `fly launch` inside `backend` (do not deploy yet if you want to edit).
2. Fly will detect Dockerfile.
3. Set secrets:
   `fly secrets set ALLOWED_ORIGINS=https://play.cozyquiz.app`
4. `fly deploy`.

## 4. Docker (self-host)
```
docker build -t cozyquiz-backend ./backend
docker run -d -p 3001:3001 --name cozyquiz-backend -e ALLOWED_ORIGINS=https://play.cozyquiz.app cozyquiz-backend
```

## Socket URL in Frontend
Set `VITE_SOCKET_URL` (Vercel Env) to the deployed backend base URL (e.g. https://cozyquiz-backend.onrender.com).

## Health Check
`GET /` returns a simple HTML page.
`/socket.io/?EIO=4&transport=polling` returns handshake payload.

## CORS Extension
You can add more comma separated origins with ALLOWED_ORIGINS env.

