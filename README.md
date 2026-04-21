# ⚡ NOVASPARK V6

**Version:** 6.0.0  
**Developer:** [Dev-Ntando](https://github.com/dev-modder)

A powerful, hardened multi-host dashboard for running multiple WhatsApp bots on Render.com. Features a full JWT auth system, coin economy, admin panel, custom bot upload, live server stats, animated UI, security hardening, leaderboard, in-app notifications, user profiles, and much more.

---

## ✨ What's New in v6.0.0

- **🔐 Security Hardening** — Helmet.js headers, rate limiting (auth + API), brute-force login lockout (5 attempts → 15 min block), password strength enforcement (min 8 chars + uppercase + number), MIME-type file upload validation
- **🔑 Password Change** — `/api/auth/change-password` endpoint with current-password verification
- **🏆 Leaderboard** — `/leaderboard.html` — Animated podium (top 3) + full rankings table with your position highlighted
- **🔔 In-App Notifications** — `/notifications.html` — Real-time WebSocket notification system with unread badge on sidebar, mark-as-read, delete
- **👤 Profile Page** — `/profile.html` — Stats, referral code copy, password change, recent activity log, VIP/admin badges
- **📋 Activity Log** — Every login, password change, and bot action recorded per user; viewable in profile
- **🎨 V6 Animated UI** — Particle canvas background on login/signup, aurora glow effects, glassmorphism cards, page fade-slide-up animations, confetti burst on daily reward, button ripple effects, skeleton loading screens, animated podium
- **🎉 Confetti on Daily Reward** — Visual burst celebration when daily coins claimed
- **🌈 Updated Theme** — Deeper dark palette with gradient accents (blue → purple), gradient logo icon
- **📊 Version bumped** to `6.0.0` across all files

---

## 🚀 All Features

| Feature | Status |
|---|---|
| JWT Login System | ✅ |
| Free Sign Up with Referrals | ✅ |
| Coin Economy (5 coins = 2 days) | ✅ |
| Daily Coin Reward | ✅ |
| VIP Server Tier (200 coins) | ✅ |
| Admin Panel | ✅ |
| Custom Bot Upload (ZIP) | ✅ |
| Panel Bots | ✅ |
| MongoDB + File Storage | ✅ |
| Redemption Codes | ✅ |
| Deleted Bot Recovery (7 days) | ✅ |
| Bot Logs (20-min / full admin) | ✅ |
| Bot Features Display Page | ✅ |
| Live Server Stats Widget | ✅ |
| Dark / Light Mode | ✅ |
| Toast Notification System | ✅ |
| Session Expiry Countdown | ✅ |
| Animated Status Badges | ✅ |
| `/api/stats` Endpoint | ✅ |
| `/api/bot-features` Endpoint | ✅ |
| WebSocket Real-Time Updates | ✅ |
| Render.com One-Click Deploy | ✅ |
| **Helmet.js Security Headers** | ✅ NEW v6 |
| **Rate Limiting (auth + API)** | ✅ NEW v6 |
| **Brute-Force Login Lockout** | ✅ NEW v6 |
| **Password Strength Enforcement** | ✅ NEW v6 |
| **Change Password Endpoint** | ✅ NEW v6 |
| **Leaderboard Page** | ✅ NEW v6 |
| **In-App Notification System** | ✅ NEW v6 |
| **User Profile Page** | ✅ NEW v6 |
| **Activity Log** | ✅ NEW v6 |
| **Particle Canvas Background** | ✅ NEW v6 |
| **Glassmorphism UI Cards** | ✅ NEW v6 |
| **Confetti Burst Animation** | ✅ NEW v6 |
| **Button Ripple Effects** | ✅ NEW v6 |
| **Skeleton Loading Screens** | ✅ NEW v6 |
| **Animated Podium Leaderboard** | ✅ NEW v6 |

---

## 🔒 Security (v6)

| Feature | Detail |
|---|---|
| Rate limiting (auth) | 20 req / 15 min per IP |
| Rate limiting (API) | 120 req / min per IP |
| Login lockout | 5 failed attempts → 15 min block |
| Password requirements | Min 8 chars, 1 uppercase, 1 number |
| Security headers | Helmet.js (XSS, CSRF, clickjacking protection) |
| File upload validation | ZIP only, 50MB max |
| JWT expiry | 7 days (access token) |
| Password hashing | bcrypt, 12 rounds |

---

## 📁 Project Structure

```
novaspark/
├── server.js
├── package.json
├── render.yaml
├── data/
│   ├── sessions.json
│   ├── users.json
│   ├── bot-configs.json
│   ├── notifications.json    # NEW v6
│   ├── activity.json         # NEW v6
│   └── uploaded-bots/
└── public/
    ├── index.html            # Dashboard
    ├── login.html            # Animated particle bg login
    ├── signup.html           # Password strength indicator
    ├── panel-bots.html
    ├── bot-features.html
    ├── leaderboard.html      # NEW v6 — Animated podium
    ├── notifications.html    # NEW v6 — Real-time alerts
    ├── profile.html          # NEW v6 — User profile
    └── terms.html
```

---

## 🛠️ API Endpoints

### Auth
- `POST /api/auth/login` · `POST /api/auth/signup` · `GET /api/auth/me`
- `POST /api/auth/change-password` *(NEW v6)*

### Sessions
- `GET /api/sessions` · `POST /api/sessions` · `PUT /api/sessions/:id` · `DELETE /api/sessions/:id`

### Panel Bots
- `GET /api/panel-bots` · `POST /api/panel-bots/upload` · `PUT /api/panel-bots/:id` · `DELETE /api/panel-bots/:id`
- `POST /api/panel-bots/:id/start` · `POST /api/panel-bots/:id/stop` · `POST /api/panel-bots/:id/restart`

### Coins
- `GET /api/coins` · `POST /api/coins/daily` · `POST /api/coins/purchase-vip` · `POST /api/coins/add`

### Admin
- `GET /api/users` · `POST /api/users` · `PUT /api/users/:id` · `DELETE /api/users/:id`
- `POST /api/codes` · `GET /api/codes` · `POST /api/codes/redeem`

### v6 New
- `GET /api/notifications` — Your notification feed
- `POST /api/notifications/read` — Mark notification(s) read
- `DELETE /api/notifications/:id` — Delete a notification
- `GET /api/activity` — Activity log (admin: all users; user: own)
- `GET /api/leaderboard` — Top 50 users by coins + your rank
- `GET /api/stats` — Live server metrics (authenticated)
- `GET /api/bot-features` — Full bot command catalogue (public)
- `GET /health` · `GET /api/status`

---

## 🚀 Deployment on Render.com

### Step 1: Push to GitHub
```bash
git init
git add .
git commit -m "🚀 NOVASPARK v6.0.0"
git remote add origin https://github.com/YOUR_USERNAME/YOUR_REPO.git
git push -u origin main
```

### Step 2: Create Web Service on Render
1. Go to [Render Dashboard](https://dashboard.render.com/)
2. Click **New → Web Service**
3. Connect your GitHub repository
4. Render auto-detects `render.yaml` — click **Create Web Service**

### Step 3: Set Environment Variables

| Variable | Required | Description |
|---|---|---|
| `RENDER_URL` | Yes | Your service URL (`https://xxx.onrender.com`) |
| `ADMIN_USERNAME` | Yes | Admin username (default: `devntando`) |
| `ADMIN_PASSWORD` | Yes | Admin password — **change this!** |
| `JWT_SECRET` | Auto | Auto-generated by render.yaml |
| `MONGODB_URI` | Optional | MongoDB URI (falls back to file storage) |

> ⚠️ **Always change `ADMIN_PASSWORD` before deploying!**

---

## 🔧 Local Development
```bash
cp .env.example .env
npm install
npm run dev   # → http://localhost:3000
```

---

## 📜 Changelog

### v6.0.0
- Security: Helmet, rate limiting, brute-force lockout, password strength
- `/api/auth/change-password` — Authenticated password change
- `/leaderboard.html` — Animated podium + ranked table
- `/notifications.html` — Real-time WebSocket notification system
- `/profile.html` — User profile, activity log, referral copy
- `/api/notifications` + `/api/activity` + `/api/leaderboard` endpoints
- V6 particle canvas background on auth pages
- Glassmorphism login/signup cards
- Confetti burst on daily reward
- Button ripple effects across all pages
- Skeleton loading screens
- Page fade-slide-up animations
- Version bumped to 6.0.0 everywhere

### v5.0.0
- Bot Features page with 40+ commands in 6 categories
- Live server stats widget, dark/light mode, toast notifications
- Session expiry countdown, animated status badges

### v2.1.0
- JWT login, coin economy, admin panel, custom bot ZIP upload

---

## 📜 License
MIT License — Free to use and modify!
