'use strict';

require('dotenv').config();

const express    = require('express');
const http       = require('http');
const path       = require('path');
const fs         = require('fs');
const { execSync, spawn } = require('child_process');
const cron       = require('node-cron');
const WebSocket  = require('ws');
const bcrypt     = require('bcryptjs');
const jwt        = require('jsonwebtoken');
const { v4: uuidv4 } = require('uuid');
const fetch      = require('node-fetch');
const chalk      = require('chalk');
const multer     = require('multer');
const mongoose   = require('mongoose');
const rateLimit  = require('express-rate-limit');
const helmet     = require('helmet');
const { body, validationResult } = require('express-validator');

// ─────────────────────────────────────────────────────────────────────────────
// CONFIG
// ─────────────────────────────────────────────────────────────────────────────
const PORT         = process.env.PORT || 3000;
const RENDER_URL   = process.env.RENDER_URL || '';
const JWT_SECRET   = process.env.JWT_SECRET || 'novaspark-secret-change-me';
const MONGODB_URI  = process.env.MONGODB_URI || process.env.MONGO_URL || '';
const PING_INTERVAL_MS = 14 * 60 * 1000;  // 14 minutes

// Default admin credentials
const ADMIN_USERNAME = process.env.ADMIN_USERNAME || 'devntando';
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'ntando';


// ── V6 Security: brute-force lockout map ─────────────────────────────────────
const loginAttempts = new Map(); // key = username, val = { count, lockedUntil }
const MAX_LOGIN_ATTEMPTS = 5;
const LOCKOUT_MS = 15 * 60 * 1000; // 15 minutes

// ── PLAN DEFINITIONS ─────────────────────────────────────────────────────────
// Pricing is enforced here. Payments are handled externally (e.g. PayPal/Stripe).
// Admin manually upgrades users via /api/plans/set or the admin panel.
const PLANS = {
  free:  { name: 'Free',  price: 0,  maxBots: 1,  label: 'FREE' },
  basic: { name: 'Basic', price: 5,  maxBots: 3,  label: '$5/mo' },
  pro:   { name: 'Pro',   price: 10, maxBots: 10, label: '$10/mo' }
};

// Legacy coin constants kept for backward-compat (coins still exist but are cosmetic)
const COIN_COST_START = 5;
const COIN_DAILY_REWARD = 2;
const COIN_REFERRAL_REWARD = 5;
const VIP_SERVER_COST = 200;
const BOT_DURATION_DAYS = 2;
const LOG_VIEWING_MINUTES = 20;

// ─────────────────────────────────────────────────────────────────────────────
// MONGODB CONNECTION
// ─────────────────────────────────────────────────────────────────────────────
let useMongoDB = false;
let mongoConnection = null;

// Fallback to file-based storage
const DATA_DIR      = path.join(__dirname, 'data');
const SESSIONS_FILE = path.join(DATA_DIR, 'sessions.json');
const USERS_FILE    = path.join(DATA_DIR, 'users.json');
const UPLOADED_BOTS_DIR = path.join(DATA_DIR, 'uploaded-bots');
const BOT_CONFIGS_FILE = path.join(DATA_DIR, 'bot-configs.json');
const DELETED_BOTS_FILE = path.join(DATA_DIR, 'deleted-bots.json');
const REDEMPTION_CODES_FILE = path.join(DATA_DIR, 'redemption-codes.json');
const NOTIFICATIONS_FILE    = path.join(DATA_DIR, 'notifications.json');
const ACTIVITY_FILE         = path.join(DATA_DIR, 'activity.json');

if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
if (!fs.existsSync(UPLOADED_BOTS_DIR)) fs.mkdirSync(UPLOADED_BOTS_DIR, { recursive: true });

// MongoDB Schemas
const userSchema = new mongoose.Schema({
  username: { type: String, required: true, unique: true },
  password: { type: String, required: true },
  role: { type: String, enum: ['admin', 'user'], default: 'user' },
  plan: { type: String, enum: ['free', 'basic', 'pro'], default: 'free' },
  coins: { type: Number, default: 0 },
  whatsappNumber: { type: String, default: null, sparse: true },
  referredBy: { type: String, default: null },
  referralCode: { type: String, default: () => uuidv4().slice(0, 8).toUpperCase() },
  referralCount: { type: Number, default: 0 },
  lastDailyReward: { type: Date, default: null },
  hasVIPAccess: { type: Boolean, default: false },
  createdAt: { type: Date, default: Date.now }
});

// Drop any existing problematic indexes on startup
userSchema.post('init', async function() {
  try {
    await this.collection.dropIndex('whatsappNumber_1');
  } catch (e) {
    // Index doesn't exist, ignore
  }
});

const sessionSchema = new mongoose.Schema({
  ownerId: { type: String, required: true },
  ownerName: { type: String, required: true },
  ownerNumber: { type: String, default: '' },
  sessionIdString: { type: String, required: true },
  botName: { type: String, default: 'NovaSpark Bot' },
  prefix: { type: String, default: '.' },
  timezone: { type: String, default: 'Africa/Harare' },
  botId: { type: String, default: null },
  serverTier: { type: String, enum: ['basic', 'vip'], default: 'basic' },
  status: { type: String, enum: ['stopped', 'running', 'starting', 'crashed'], default: 'stopped' },
  startTime: { type: Date, default: null },
  paidUntil: { type: Date, default: null },
  createdAt: { type: Date, default: Date.now }
});

const botConfigSchema = new mongoose.Schema({
  name: { type: String, required: true },
  description: { type: String, default: '' },
  entryPoint: { type: String, default: 'index.js' },
  ownerId: { type: String, required: true },
  ownerUsername: { type: String, required: true },
  status: { type: String, enum: ['stopped', 'running', 'starting', 'crashed'], default: 'stopped' },
  serverTier: { type: String, enum: ['basic', 'vip'], default: 'basic' },
  startTime: { type: Date, default: null },
  paidUntil: { type: Date, default: null },
  path: { type: String, required: true },
  createdAt: { type: Date, default: Date.now }
});

const deletedBotSchema = new mongoose.Schema({
  originalId: { type: String, required: true },
  type: { type: String, enum: ['session', 'panel-bot'], required: true },
  ownerId: { type: String, required: true },
  data: { type: Object, required: true },
  deletedAt: { type: Date, default: Date.now },
  expiresAt: { type: Date, default: () => new Date(Date.now() + 7 * 24 * 60 * 60 * 1000) } // 7 days
});

const redemptionCodeSchema = new mongoose.Schema({
  code: { type: String, required: true, unique: true },
  coins: { type: Number, default: 0 },
  plan: { type: String, enum: ['free', 'basic', 'pro'], default: 'basic' },
  durationDays: { type: Number, default: 30 },
  usedBy: { type: String, default: null },
  usedAt: { type: Date, default: null },
  createdBy: { type: String, required: true },
  createdAt: { type: Date, default: Date.now }
});

let User, Session, BotConfig, DeletedBot, RedemptionCode;

// ─────────────────────────────────────────────────────────────────────────────
// FILE-BASED STORAGE (Fallback)
// ─────────────────────────────────────────────────────────────────────────────
function loadUsers() {
  try { return JSON.parse(fs.readFileSync(USERS_FILE, 'utf8')); }
  catch { return []; }
}

function saveUsers(users) {
  fs.writeFileSync(USERS_FILE, JSON.stringify(users, null, 2));
}

function loadSessions() {
  try { return JSON.parse(fs.readFileSync(SESSIONS_FILE, 'utf8')); }
  catch { return []; }
}

function saveSessions(sessions) {
  fs.writeFileSync(SESSIONS_FILE, JSON.stringify(sessions, null, 2));
}

function loadBotConfigs() {
  try { return JSON.parse(fs.readFileSync(BOT_CONFIGS_FILE, 'utf8')); }
  catch { return []; }
}

function saveBotConfigs(configs) {
  fs.writeFileSync(BOT_CONFIGS_FILE, JSON.stringify(configs, null, 2));
}

function loadDeletedBots() {
  try { return JSON.parse(fs.readFileSync(DELETED_BOTS_FILE, 'utf8')); }
  catch { return []; }
}

function saveDeletedBots(bots) {
  fs.writeFileSync(DELETED_BOTS_FILE, JSON.stringify(bots, null, 2));
}

function loadRedemptionCodes() {
  try { return JSON.parse(fs.readFileSync(REDEMPTION_CODES_FILE, 'utf8')); }
  catch { return []; }
}

function saveRedemptionCodes(codes) {
  fs.writeFileSync(REDEMPTION_CODES_FILE, JSON.stringify(codes, null, 2));
}

// ── V6: Notifications helpers ─────────────────────────────────────────────────
function loadNotifications() {
  try { return JSON.parse(fs.readFileSync(NOTIFICATIONS_FILE, 'utf8')); } catch { return []; }
}
function saveNotifications(n) {
  try { fs.writeFileSync(NOTIFICATIONS_FILE, JSON.stringify(n, null, 2)); } catch {}
}
function pushNotification(userId, title, body, icon = '🔔') {
  const notes = loadNotifications();
  notes.push({ id: uuidv4(), userId: String(userId), title, body, icon, read: false, createdAt: new Date().toISOString() });
  const cleaned = notes.filter(n => n.userId === String(userId)).slice(-100);
  const others  = notes.filter(n => n.userId !== String(userId));
  saveNotifications([...others, ...cleaned]);
  broadcast({ type: 'notification', userId: String(userId), title, body, icon });
}

// ── V6: Activity log helpers ──────────────────────────────────────────────────
function loadActivity() {
  try { return JSON.parse(fs.readFileSync(ACTIVITY_FILE, 'utf8')); } catch { return []; }
}
function saveActivity(a) {
  try { fs.writeFileSync(ACTIVITY_FILE, JSON.stringify(a, null, 2)); } catch {}
}
function logActivity(userId, username, action, meta = {}) {
  const acts = loadActivity();
  acts.push({ id: uuidv4(), userId: String(userId), username, action, meta, ts: new Date().toISOString() });
  saveActivity(acts.slice(-500));
}

// ─────────────────────────────────────────────────────────────────────────────
// MONGODB CONNECTION
// ─────────────────────────────────────────────────────────────────────────────
async function connectMongoDB() {
  if (!MONGODB_URI) {
    log('No MongoDB URI provided, using file-based storage', 'warn');
    return false;
  }

  try {
    await mongoose.connect(MONGODB_URI, {
      serverSelectionTimeoutMS: 5000,
      connectTimeoutMS: 10000
    });
    
    useMongoDB = true;
    log('Connected to MongoDB successfully', 'ok');

    // Initialize models
    User = mongoose.models.User || mongoose.model('User', userSchema);
    Session = mongoose.models.Session || mongoose.model('Session', sessionSchema);
    BotConfig = mongoose.models.BotConfig || mongoose.model('BotConfig', botConfigSchema);
    DeletedBot = mongoose.models.DeletedBot || mongoose.model('DeletedBot', deletedBotSchema);
    RedemptionCode = mongoose.models.RedemptionCode || mongoose.model('RedemptionCode', redemptionCodeSchema);

    // Drop problematic indexes that might exist from old schemas
    try {
      await User.collection.dropIndex('whatsappNumber_1');
      log('Dropped old whatsappNumber index', 'ok');
    } catch (e) {
      // Index doesn't exist, ignore
    }

    // Ensure admin exists
    await ensureAdminExistsMongo();
    
    return true;
  } catch (err) {
    log(`MongoDB connection failed: ${err.message}, using file-based storage`, 'warn');
    useMongoDB = false;
    return false;
  }
}

async function ensureAdminExistsMongo() {
  if (!useMongoDB) return;
  
  const admin = await User.findOne({ username: ADMIN_USERNAME });
  if (!admin) {
    const hash = await bcrypt.hash(ADMIN_PASSWORD, 10);
    await User.create({
      username: ADMIN_USERNAME,
      password: hash,
      role: 'admin',
      plan: 'pro',
      coins: 0,
      referralCode: uuidv4().slice(0, 8).toUpperCase()
    });
    log(`Admin user "${ADMIN_USERNAME}" created in MongoDB`, 'ok');
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// MULTER CONFIG
// ─────────────────────────────────────────────────────────────────────────────
const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    const botDir = path.join(UPLOADED_BOTS_DIR, req.params.botId || uuidv4());
    if (!fs.existsSync(botDir)) fs.mkdirSync(botDir, { recursive: true });
    cb(null, botDir);
  },
  filename: (req, file, cb) => {
    cb(null, file.originalname);
  }
});

const upload = multer({ 
  storage,
  fileFilter: (req, file, cb) => {
    const allowedExtensions = ['.js', '.json', '.md', '.zip'];
    const ext = path.extname(file.originalname).toLowerCase();
    if (allowedExtensions.includes(ext) || file.originalname === 'package.json') {
      cb(null, true);
    } else {
      cb(new Error('Only .js, .json, .md, .zip files are allowed'));
    }
  },
  limits: { fileSize: 50 * 1024 * 1024 }
});

const uploadZip = multer({
  dest: UPLOADED_BOTS_DIR,
  fileFilter: (req, file, cb) => {
    if (file.mimetype === 'application/zip' || file.mimetype === 'application/x-zip-compressed' || path.extname(file.originalname).toLowerCase() === '.zip') {
      cb(null, true);
    } else {
      cb(new Error('Only .zip files are allowed'));
    }
  },
  limits: { fileSize: 100 * 1024 * 1024 }
});

// ─────────────────────────────────────────────────────────────────────────────
// INIT USER STORE (File-based)
// ─────────────────────────────────────────────────────────────────────────────
function ensureAdminExists() {
  if (useMongoDB) return;
  let users = loadUsers();
  if (!users.find(u => u.username === ADMIN_USERNAME)) {
    const hash = bcrypt.hashSync(ADMIN_PASSWORD, 10);
    users.push({
      id: uuidv4(),
      username: ADMIN_USERNAME,
      password: hash,
      role: 'admin',
      plan: 'pro',
      coins: 0,
      referralCode: uuidv4().slice(0, 8).toUpperCase(),
      referralCount: 0,
      hasVIPAccess: true,
      createdAt: new Date().toISOString()
    });
    saveUsers(users);
    console.log(`[OK] Admin user "${ADMIN_USERNAME}" created.`);
  }
}

// ensureAdminExists() deferred to start() — called after MongoDB connection

// ─────────────────────────────────────────────────────────────────────────────
// SERVER STATE
// ─────────────────────────────────────────────────────────────────────────────
const state = {
  pingCount: 0,
  cleanCount: 0,
  startTime: Date.now(),
  botProcesses: {},
  panelBotProcesses: {}
};

// ─────────────────────────────────────────────────────────────────────────────
// LOG BUFFER
// ─────────────────────────────────────────────────────────────────────────────
const MAX_LOG = 500;
const logBuffer = [];

function log(msg, level = 'info', sessionId = null) {
  const entry = { ts: Date.now(), level, msg, sessionId };
  logBuffer.push(entry);
  if (logBuffer.length > MAX_LOG) logBuffer.shift();
  broadcast({ type: 'log', ...entry });

  const colors = { info: chalk.cyan, ok: chalk.green, warn: chalk.yellow, error: chalk.red, bot: chalk.magenta };
  const fn = colors[level] || chalk.white;
  console.log(fn(`[${level.toUpperCase()}] ${msg}`));
}

// ─────────────────────────────────────────────────────────────────────────────
// EXPRESS APP
// ─────────────────────────────────────────────────────────────────────────────
const app = express();
const server = http.createServer(app);

// ── V6 Security Middleware ────────────────────────────────────────────────────
app.use(helmet({
  contentSecurityPolicy: false, // Allow inline scripts in HTML pages
  crossOriginEmbedderPolicy: false
}));

// Rate limiting
const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 20,
  message: { error: 'Too many attempts. Please try again in 15 minutes.' },
  standardHeaders: true,
  legacyHeaders: false
});
const apiLimiter = rateLimit({
  windowMs: 1 * 60 * 1000,
  max: 120,
  message: { error: 'Rate limit exceeded. Slow down.' }
});

app.use('/api/auth', authLimiter);
app.use('/api', apiLimiter);

app.use(express.json({ limit: '10mb' }));
app.use(express.static(path.join(__dirname, 'public')));

// ─────────────────────────────────────────────────────────────────────────────
// AUTH MIDDLEWARE
// ─────────────────────────────────────────────────────────────────────────────
function requireAuth(req, res, next) {
  const authHeader = req.headers.authorization || '';
  const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : req.query.token;
  if (!token) return res.status(401).json({ error: 'Unauthorized' });
  try {
    req.user = jwt.verify(token, JWT_SECRET);
    next();
  } catch {
    return res.status(401).json({ error: 'Invalid or expired token' });
  }
}

function requireAdmin(req, res, next) {
  requireAuth(req, res, () => {
    if (req.user.role !== 'admin') return res.status(403).json({ error: 'Admin only' });
    next();
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// HELPER: Get user (MongoDB or file)
// ─────────────────────────────────────────────────────────────────────────────
async function getUserById(userId) {
  if (useMongoDB) {
    return await User.findById(userId);
  }
  const users = loadUsers();
  return users.find(u => u.id === userId);
}

async function getUserByUsername(username) {
  if (useMongoDB) {
    return await User.findOne({ username });
  }
  const users = loadUsers();
  return users.find(u => u.username === username);
}

async function updateUserCoins(userId, coins) {
  if (useMongoDB) {
    await User.findByIdAndUpdate(userId, { $set: { coins } });
  } else {
    const users = loadUsers();
    const user = users.find(u => u.id === userId);
    if (user) {
      user.coins = coins;
      saveUsers(users);
    }
  }
}

async function getAllUsers() {
  if (useMongoDB) {
    return await User.find({}, '-password');
  }
  return loadUsers().map(u => {
    const { password, ...rest } = u;
    return rest;
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// AUTH ROUTES
// ─────────────────────────────────────────────────────────────────────────────

// Free Sign Up
app.post('/api/auth/signup', async (req, res) => {
  const { username, password, referralCode } = req.body || {};
  if (!username || !password) {
    return res.status(400).json({ error: 'Username and password required' });
  }

  if (username.length < 3 || username.length > 20) {
    return res.status(400).json({ error: 'Username must be 3-20 characters' });
  }

  if (password.length < 4) {
    return res.status(400).json({ error: 'Password must be at least 4 characters' });
  }

  try {
    if (useMongoDB) {
      const existing = await User.findOne({ username });
      if (existing) {
        return res.status(409).json({ error: 'Username already exists' });
      }

      const hash = await bcrypt.hash(password, 10);
      const newReferralCode = uuidv4().slice(0, 8).toUpperCase();
      
      let referredBy = null;
      let initialCoins = 0;
      
      if (referralCode) {
        const referrer = await User.findOne({ referralCode });
        if (referrer) {
          referredBy = referrer._id.toString();
          initialCoins += COIN_REFERRAL_REWARD;
          await User.findByIdAndUpdate(referrer._id, { 
            $inc: { coins: COIN_REFERRAL_REWARD, referralCount: 1 } 
          });
          log(`Referral: ${referrer.username} earned ${COIN_REFERRAL_REWARD} coins from ${username}`, 'ok');
        }
      }

      const user = await User.create({
        username,
        password: hash,
        plan: 'free',
        coins: initialCoins,
        referralCode: newReferralCode,
        referredBy
      });

      const token = jwt.sign({ id: user._id, username: user.username, role: user.role }, JWT_SECRET, { expiresIn: '7d' });
      log(`User "${username}" signed up with ${initialCoins} coins`, 'ok');
      
      return res.json({ 
        ok: true, 
        token, 
        user: { 
          id: user._id, 
          username: user.username, 
          role: user.role, 
          plan: user.plan || 'free',
          coins: user.coins,
          referralCode: user.referralCode,
          hasVIPAccess: user.hasVIPAccess
        } 
      });
    } else {
      // File-based
      const users = loadUsers();
      if (users.find(u => u.username === username)) {
        return res.status(409).json({ error: 'Username already exists' });
      }

      const hash = bcrypt.hashSync(password, 10);
      const newReferralCode = uuidv4().slice(0, 8).toUpperCase();
      
      let referredBy = null;
      let initialCoins = 0;
      
      if (referralCode) {
        const referrer = users.find(u => u.referralCode === referralCode);
        if (referrer) {
          referredBy = referrer.id;
          initialCoins += COIN_REFERRAL_REWARD;
          referrer.coins = (referrer.coins || 0) + COIN_REFERRAL_REWARD;
          referrer.referralCount = (referrer.referralCount || 0) + 1;
          log(`Referral: ${referrer.username} earned ${COIN_REFERRAL_REWARD} coins from ${username}`, 'ok');
        }
      }

      const newUser = {
        id: uuidv4(),
        username,
        password: hash,
        role: 'user',
        plan: 'free',
        coins: initialCoins,
        referralCode: newReferralCode,
        referredBy,
        referralCount: 0,
        hasVIPAccess: false,
        createdAt: new Date().toISOString()
      };
      
      users.push(newUser);
      saveUsers(users);

      const token = jwt.sign({ id: newUser.id, username: newUser.username, role: newUser.role }, JWT_SECRET, { expiresIn: '7d' });
      log(`User "${username}" signed up with ${initialCoins} coins`, 'ok');
      
      return res.json({ 
        ok: true, 
        token, 
        user: { 
          id: newUser.id, 
          username: newUser.username, 
          role: newUser.role, 
          coins: newUser.coins,
          referralCode: newUser.referralCode,
          hasVIPAccess: newUser.hasVIPAccess
        } 
      });
    }
  } catch (err) {
    log(`Signup error: ${err.message}`, 'error');
    return res.status(500).json({ error: 'Internal server error' });
  }
});

// Login
app.post('/api/auth/login', async (req, res) => {
  const { username, password } = req.body || {};
  if (!username || !password) return res.status(400).json({ error: 'Username and password required' });

  // ── V6: Brute-force protection ─────────────────────────────────────────────
  const key = username.toLowerCase();
  const attempt = loginAttempts.get(key) || { count: 0, lockedUntil: 0 };
  if (attempt.lockedUntil > Date.now()) {
    const remaining = Math.ceil((attempt.lockedUntil - Date.now()) / 60000);
    return res.status(429).json({ error: `Account locked. Try again in ${remaining} minute(s).` });
  }

  try {
    let user = null;
    let passwordMatch = false;

    if (useMongoDB) {
      user = await User.findOne({ username });
      if (user) passwordMatch = await bcrypt.compare(password, user.password);
    } else {
      const users = loadUsers();
      user = users.find(u => u.username === username);
      if (user) passwordMatch = bcrypt.compareSync(password, user.password);
    }

    if (!user || !passwordMatch) {
      attempt.count += 1;
      if (attempt.count >= MAX_LOGIN_ATTEMPTS) {
        attempt.lockedUntil = Date.now() + LOCKOUT_MS;
        attempt.count = 0;
        log(`Account "${username}" locked after ${MAX_LOGIN_ATTEMPTS} failed attempts`, 'warn');
      }
      loginAttempts.set(key, attempt);
      return res.status(401).json({ error: 'Invalid credentials' });
    }

    // Reset attempts on success
    loginAttempts.delete(key);

    const userId = user._id || user.id;
    const token = jwt.sign({ id: userId, username: user.username, role: user.role }, JWT_SECRET, { expiresIn: '7d' });
    log(`User "${username}" logged in`, 'ok');
    logActivity(userId, user.username, 'login', { ip: req.ip });

    return res.json({ 
      ok: true, 
      token, 
      user: { 
        id: userId, 
        username: user.username, 
        role: user.role, 
        plan: user.plan || 'free',
        coins: user.coins,
        referralCode: user.referralCode,
        hasVIPAccess: user.hasVIPAccess
      } 
    });
  } catch (err) {
    log(`Login error: \${err.message}`, 'error');
    return res.status(500).json({ error: 'Internal server error' });
  }
});

// Get current user
app.get('/api/auth/me', requireAuth, async (req, res) => {
  try {
    if (useMongoDB) {
      const user = await User.findById(req.user.id, '-password');
      if (!user) return res.status(404).json({ error: 'User not found' });
      return res.json({
        id: user._id,
        username: user.username,
        role: user.role,
        plan: user.plan || 'free',
        coins: user.coins,
        referralCode: user.referralCode,
        referralCount: user.referralCount,
        hasVIPAccess: user.hasVIPAccess,
        lastDailyReward: user.lastDailyReward
      });
    } else {
      const users = loadUsers();
      const user = users.find(u => u.id === req.user.id);
      if (!user) return res.status(404).json({ error: 'User not found' });
      const { password, ...rest } = user;
      return res.json(rest);
    }
  } catch (err) {
    return res.status(500).json({ error: 'Internal server error' });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// V6: CHANGE PASSWORD ROUTE
// ─────────────────────────────────────────────────────────────────────────────
app.post('/api/auth/change-password', requireAuth, async (req, res) => {
  const { currentPassword, newPassword } = req.body || {};
  if (!currentPassword || !newPassword) return res.status(400).json({ error: 'Both passwords required' });
  if (newPassword.length < 8) return res.status(400).json({ error: 'New password must be at least 8 characters' });
  if (!/[A-Z]/.test(newPassword) || !/[0-9]/.test(newPassword)) {
    return res.status(400).json({ error: 'Password must contain at least one uppercase letter and one number' });
  }
  try {
    if (useMongoDB) {
      const user = await User.findById(req.user.id);
      if (!user) return res.status(404).json({ error: 'User not found' });
      const ok = await bcrypt.compare(currentPassword, user.password);
      if (!ok) return res.status(401).json({ error: 'Current password incorrect' });
      user.password = await bcrypt.hash(newPassword, 12);
      await user.save();
    } else {
      const users = loadUsers();
      const user = users.find(u => u.id === req.user.id);
      if (!user) return res.status(404).json({ error: 'User not found' });
      const ok = bcrypt.compareSync(currentPassword, user.password);
      if (!ok) return res.status(401).json({ error: 'Current password incorrect' });
      user.password = bcrypt.hashSync(newPassword, 12);
      saveUsers(users);
    }
    logActivity(req.user.id, req.user.username, 'change-password');
    return res.json({ ok: true, message: 'Password changed successfully' });
  } catch (err) {
    log(`Change password error: ${err.message}`, 'error');
    return res.status(500).json({ error: 'Internal server error' });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// V6: NOTIFICATIONS ROUTES
// ─────────────────────────────────────────────────────────────────────────────
app.get('/api/notifications', requireAuth, (req, res) => {
  const notes = loadNotifications();
  const mine = notes.filter(n => n.userId === String(req.user.id));
  res.json(mine.slice(-50).reverse());
});

app.post('/api/notifications/read', requireAuth, (req, res) => {
  const { id } = req.body || {};
  const notes = loadNotifications();
  const updated = notes.map(n => {
    if (n.userId !== String(req.user.id)) return n;
    if (!id || n.id === id) return { ...n, read: true };
    return n;
  });
  saveNotifications(updated);
  res.json({ ok: true });
});

app.delete('/api/notifications/:id', requireAuth, (req, res) => {
  const notes = loadNotifications();
  const filtered = notes.filter(n => !(n.id === req.params.id && n.userId === String(req.user.id)));
  saveNotifications(filtered);
  res.json({ ok: true });
});

// ─────────────────────────────────────────────────────────────────────────────
// V6: ACTIVITY LOG ROUTES
// ─────────────────────────────────────────────────────────────────────────────
app.get('/api/activity', requireAuth, (req, res) => {
  const acts = loadActivity();
  const mine = req.user.role === 'admin' ? acts : acts.filter(a => a.userId === String(req.user.id));
  res.json(mine.slice(-100).reverse());
});

// ─────────────────────────────────────────────────────────────────────────────
// V6: LEADERBOARD ROUTE
// ─────────────────────────────────────────────────────────────────────────────
app.get('/api/leaderboard', requireAuth, async (req, res) => {
  try {
    let users = [];
    if (useMongoDB) {
      const all = await User.find({}, 'username plan referralCount hasVIPAccess createdAt').sort({ referralCount: -1 }).limit(50);
      users = all.map((u, i) => ({ rank: i+1, username: u.username, plan: u.plan||'free', referrals: u.referralCount||0, vip: u.hasVIPAccess, joined: u.createdAt }));
    } else {
      const all = loadUsers();
      users = [...all].sort((a,b) => (b.referralCount||0)-(a.referralCount||0)).slice(0,50).map((u, i) => ({ rank: i+1, username: u.username, plan: u.plan||'free', referrals: u.referralCount||0, vip: u.hasVIPAccess||false, joined: u.createdAt }));
    }
    // Mark current user rank
    const meIdx = users.findIndex(u => u.username === req.user.username);
    const me = meIdx >= 0 ? users[meIdx] : null;
    res.json({ leaderboard: users, myRank: meIdx === -1 ? null : meIdx+1, me });
  } catch(err) {
    res.status(500).json({ error: 'Failed to load leaderboard' });
  }
});


// ─────────────────────────────────────────────────────────────────────────────
// PLAN ROUTES
// ─────────────────────────────────────────────────────────────────────────────

// Public: return all plan definitions
app.get('/api/plans', (req, res) => {
  res.json(PLANS);
});

// Auth: get current user's plan info
app.get('/api/plans/me', requireAuth, async (req, res) => {
  try {
    let user;
    if (useMongoDB) {
      user = await User.findById(req.user.id);
    } else {
      const users = loadUsers();
      user = users.find(u => u.id === req.user.id);
    }
    if (!user) return res.status(404).json({ error: 'User not found' });
    const plan = user.plan || 'free';
    const planInfo = PLANS[plan] || PLANS.free;
    // Count existing bots
    let existingCount = 0;
    if (useMongoDB) {
      existingCount = await Session.countDocuments({ ownerId: req.user.id });
    } else {
      const sessions = loadSessions();
      existingCount = sessions.filter(s => String(s.ownerId) === req.user.id).length;
    }
    return res.json({ plan, ...planInfo, usedBots: existingCount });
  } catch (err) {
    return res.status(500).json({ error: 'Internal server error' });
  }
});

// Admin: set a user's plan
app.post('/api/plans/set', requireAdmin, async (req, res) => {
  const { userId, username, plan } = req.body || {};
  if (!plan || !PLANS[plan]) return res.status(400).json({ error: 'Invalid plan. Must be: free, basic, or pro' });
  if (!userId && !username) return res.status(400).json({ error: 'userId or username required' });
  try {
    if (useMongoDB) {
      const user = userId ? await User.findById(userId) : await User.findOne({ username });
      if (!user) return res.status(404).json({ error: 'User not found' });
      user.plan = plan;
      user.hasVIPAccess = plan === 'pro';
      await user.save();
      log(`Admin set plan "${plan}" for user "${user.username}"`, 'ok');
      return res.json({ ok: true, plan, maxBots: PLANS[plan].maxBots });
    } else {
      const users = loadUsers();
      const user = userId ? users.find(u => u.id === userId) : users.find(u => u.username === username);
      if (!user) return res.status(404).json({ error: 'User not found' });
      user.plan = plan;
      user.hasVIPAccess = plan === 'pro';
      saveUsers(users);
      log(`Admin set plan "${plan}" for user "${user.username}"`, 'ok');
      return res.json({ ok: true, plan, maxBots: PLANS[plan].maxBots });
    }
  } catch (err) {
    return res.status(500).json({ error: 'Internal server error' });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// COIN ROUTES
// ─────────────────────────────────────────────────────────────────────────────

// Get coins
app.get('/api/coins', requireAuth, async (req, res) => {
  try {
    if (useMongoDB) {
      const user = await User.findById(req.user.id);
      return res.json({ coins: user ? user.coins : 0 });
    } else {
      const users = loadUsers();
      const user = users.find(u => u.id === req.user.id);
      return res.json({ coins: user ? user.coins : 0 });
    }
  } catch {
    return res.json({ coins: 0 });
  }
});

// Claim daily reward
app.post('/api/coins/daily', requireAuth, async (req, res) => {
  try {
    const now = new Date();
    const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    
    if (useMongoDB) {
      const user = await User.findById(req.user.id);
      if (!user) return res.status(404).json({ error: 'User not found' });
      
      if (user.lastDailyReward && new Date(user.lastDailyReward) >= today) {
        return res.status(400).json({ error: 'Daily reward already claimed today' });
      }
      
      user.coins += COIN_DAILY_REWARD;
      user.lastDailyReward = now;
      await user.save();
      
      broadcast({ type: 'coins-updated', userId: user._id, coins: user.coins });
      log(`User "${user.username}" claimed daily reward of ${COIN_DAILY_REWARD} coins`, 'ok');
      
      return res.json({ ok: true, coins: user.coins, rewarded: COIN_DAILY_REWARD });
    } else {
      const users = loadUsers();
      const user = users.find(u => u.id === req.user.id);
      if (!user) return res.status(404).json({ error: 'User not found' });
      
      if (user.lastDailyReward && new Date(user.lastDailyReward) >= today) {
        return res.status(400).json({ error: 'Daily reward already claimed today' });
      }
      
      user.coins = (user.coins || 0) + COIN_DAILY_REWARD;
      user.lastDailyReward = now.toISOString();
      saveUsers(users);
      
      broadcast({ type: 'coins-updated', userId: user.id, coins: user.coins });
      log(`User "${user.username}" claimed daily reward of ${COIN_DAILY_REWARD} coins`, 'ok');
      
      return res.json({ ok: true, coins: user.coins, rewarded: COIN_DAILY_REWARD });
    }
  } catch (err) {
    log(`Daily reward error: ${err.message}`, 'error');
    return res.status(500).json({ error: 'Internal server error' });
  }
});

// Purchase VIP access
app.post('/api/coins/purchase-vip', requireAuth, async (req, res) => {
  try {
    if (useMongoDB) {
      const user = await User.findById(req.user.id);
      if (!user) return res.status(404).json({ error: 'User not found' });
      
      if (user.hasVIPAccess) {
        return res.status(400).json({ error: 'You already have VIP access' });
      }
      
      if (user.coins < VIP_SERVER_COST) {
        return res.status(400).json({ error: `Not enough coins. VIP access costs ${VIP_SERVER_COST} coins.` });
      }
      
      user.coins -= VIP_SERVER_COST;
      user.hasVIPAccess = true;
      await user.save();
      
      broadcast({ type: 'coins-updated', userId: user._id, coins: user.coins });
      log(`User "${user.username}" purchased VIP access for ${VIP_SERVER_COST} coins`, 'ok');
      
      return res.json({ ok: true, coins: user.coins, hasVIPAccess: true });
    } else {
      const users = loadUsers();
      const user = users.find(u => u.id === req.user.id);
      if (!user) return res.status(404).json({ error: 'User not found' });
      
      if (user.hasVIPAccess) {
        return res.status(400).json({ error: 'You already have VIP access' });
      }
      
      if (user.coins < VIP_SERVER_COST) {
        return res.status(400).json({ error: `Not enough coins. VIP access costs ${VIP_SERVER_COST} coins.` });
      }
      
      user.coins -= VIP_SERVER_COST;
      user.hasVIPAccess = true;
      saveUsers(users);
      
      broadcast({ type: 'coins-updated', userId: user.id, coins: user.coins });
      log(`User "${user.username}" purchased VIP access for ${VIP_SERVER_COST} coins`, 'ok');
      
      return res.json({ ok: true, coins: user.coins, hasVIPAccess: true });
    }
  } catch (err) {
    log(`VIP purchase error: ${err.message}`, 'error');
    return res.status(500).json({ error: 'Internal server error' });
  }
});

// Admin: add/set coins for a user
app.post('/api/coins/add', requireAdmin, async (req, res) => {
  const { userId, username, amount } = req.body || {};
  if (isNaN(amount) || Number(amount) === 0) return res.status(400).json({ error: 'Valid amount required' });

  try {
    if (useMongoDB) {
      const user = userId 
        ? await User.findById(userId)
        : await User.findOne({ username });
      
      if (!user) return res.status(404).json({ error: 'User not found' });
      
      user.coins = Math.max(0, (user.coins || 0) + Number(amount));
      await user.save();
      
      broadcast({ type: 'coins-updated', userId: user._id, coins: user.coins });
      log(`Admin added ${amount} coins to "${user.username}" (total: ${user.coins})`, 'ok');
      
      return res.json({ ok: true, coins: user.coins });
    } else {
      const users = loadUsers();
      const user = userId
        ? users.find(u => u.id === userId)
        : users.find(u => u.username === username);
      
      if (!user) return res.status(404).json({ error: 'User not found' });
      
      user.coins = Math.max(0, (user.coins || 0) + Number(amount));
      saveUsers(users);
      
      broadcast({ type: 'coins-updated', userId: user.id, coins: user.coins });
      log(`Admin added ${amount} coins to "${user.username}" (total: ${user.coins})`, 'ok');
      
      return res.json({ ok: true, coins: user.coins });
    }
  } catch (err) {
    return res.status(500).json({ error: 'Internal server error' });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// REDEMPTION CODES ROUTES
// ─────────────────────────────────────────────────────────────────────────────

// Admin: Create redemption code
app.post('/api/codes', requireAdmin, async (req, res) => {
  const { plan = 'basic', durationDays = 30, coins = 0 } = req.body || {};
  if (!PLANS[plan]) return res.status(400).json({ error: 'Invalid plan' });
  
  try {
    const code = uuidv4().slice(0, 12).toUpperCase();
    
    if (useMongoDB) {
      await RedemptionCode.create({
        code,
        plan,
        coins: 0,
        durationDays: Number(durationDays),
        createdBy: req.user.id
      });
    } else {
      const codes = loadRedemptionCodes();
      codes.push({
        id: uuidv4(),
        code,
        plan,
        coins: 0,
        durationDays: Number(durationDays),
        createdBy: req.user.id,
        usedBy: null,
        usedAt: null,
        createdAt: new Date().toISOString()
      });
      saveRedemptionCodes(codes);
    }
    
    log(`Admin created redemption code "${code}" for ${plan} plan (${durationDays} days)`, 'ok');
    return res.json({ ok: true, code, plan, durationDays });
  } catch (err) {
    log(`Code creation error: ${err.message}`, 'error');
    return res.status(500).json({ error: 'Internal server error' });
  }
});

// Admin: List all codes
app.get('/api/codes', requireAdmin, async (req, res) => {
  try {
    if (useMongoDB) {
      const codes = await RedemptionCode.find().sort({ createdAt: -1 });
      return res.json(codes);
    } else {
      return res.json(loadRedemptionCodes());
    }
  } catch {
    return res.json([]);
  }
});

// User: Redeem code
app.post('/api/codes/redeem', requireAuth, async (req, res) => {
  const { code } = req.body || {};
  if (!code) return res.status(400).json({ error: 'Code required' });
  
  try {
    if (useMongoDB) {
      const redemptionCode = await RedemptionCode.findOne({ code });
      if (!redemptionCode) return res.status(404).json({ error: 'Invalid code' });
      if (redemptionCode.usedBy) return res.status(400).json({ error: 'Code already used' });
      
      const user = await User.findById(req.user.id);
      if (!user) return res.status(404).json({ error: 'User not found' });
      
      const grantedPlan = redemptionCode.plan || 'basic';
      user.plan = grantedPlan;
      user.hasVIPAccess = grantedPlan === 'pro';
      await user.save();
      
      redemptionCode.usedBy = req.user.id;
      redemptionCode.usedAt = new Date();
      await redemptionCode.save();
      
      broadcast({ type: 'plan-updated', userId: user._id.toString(), plan: grantedPlan });
      log(`User "${user.username}" redeemed code "${code}" — upgraded to ${grantedPlan} plan`, 'ok');
      
      return res.json({ ok: true, plan: grantedPlan, maxBots: PLANS[grantedPlan].maxBots });
    } else {
      const codes = loadRedemptionCodes();
      const redemptionCode = codes.find(c => c.code === code);
      if (!redemptionCode) return res.status(404).json({ error: 'Invalid code' });
      if (redemptionCode.usedBy) return res.status(400).json({ error: 'Code already used' });
      
      const users = loadUsers();
      const user = users.find(u => u.id === req.user.id);
      if (!user) return res.status(404).json({ error: 'User not found' });
      
      const grantedPlan = redemptionCode.plan || 'basic';
      user.plan = grantedPlan;
      user.hasVIPAccess = grantedPlan === 'pro';
      saveUsers(users);
      
      redemptionCode.usedBy = req.user.id;
      redemptionCode.usedAt = new Date().toISOString();
      saveRedemptionCodes(codes);
      
      broadcast({ type: 'plan-updated', userId: user.id, plan: grantedPlan });
      log(`User "${user.username}" redeemed code "${code}" — upgraded to ${grantedPlan} plan`, 'ok');
      
      return res.json({ ok: true, plan: grantedPlan, maxBots: PLANS[grantedPlan].maxBots });
    }
  } catch (err) {
    log(`Code redemption error: ${err.message}`, 'error');
    return res.status(500).json({ error: 'Internal server error' });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// USERS ROUTES (Admin)
// ─────────────────────────────────────────────────────────────────────────────
app.get('/api/users', requireAdmin, async (req, res) => {
  try {
    const users = await getAllUsers();
    return res.json(users.map(u => ({
      id: u.id || u._id,
      username: u.username,
      role: u.role,
      plan: u.plan || 'free',
      coins: u.coins,
      referralCode: u.referralCode,
      referralCount: u.referralCount || 0,
      hasVIPAccess: u.hasVIPAccess || false,
      createdAt: u.createdAt
    })));
  } catch {
    return res.json([]);
  }
});

// Admin creates a new user
app.post('/api/users', requireAdmin, async (req, res) => {
  const { username, password, coins, role, hasVIPAccess } = req.body || {};
  
  if (!username || !password) {
    return res.status(400).json({ error: 'Username and password required' });
  }
  
  if (username.length < 3 || username.length > 20) {
    return res.status(400).json({ error: 'Username must be 3-20 characters' });
  }
  
  try {
    if (useMongoDB) {
      const existing = await User.findOne({ username });
      if (existing) {
        return res.status(409).json({ error: 'Username already exists' });
      }
      
      const hash = await bcrypt.hash(password, 10);
      const newReferralCode = uuidv4().slice(0, 8).toUpperCase();
      
      const user = await User.create({
        username,
        password: hash,
        role: role || 'user',
        coins: coins || 50,
        referralCode: newReferralCode,
        hasVIPAccess: hasVIPAccess || false
      });
      
      log(`Admin created user "${username}" with ${coins || 50} coins`, 'ok');
      
      return res.json({
        ok: true,
        user: {
          id: user._id,
          username: user.username,
          role: user.role,
          coins: user.coins,
          referralCode: user.referralCode,
          hasVIPAccess: user.hasVIPAccess
        }
      });
    } else {
      const users = loadUsers();
      if (users.find(u => u.username === username)) {
        return res.status(409).json({ error: 'Username already exists' });
      }
      
      const hash = bcrypt.hashSync(password, 10);
      const newUser = {
        id: uuidv4(),
        username,
        password: hash,
        role: role || 'user',
        coins: coins || 50,
        referralCode: uuidv4().slice(0, 8).toUpperCase(),
        referralCount: 0,
        hasVIPAccess: hasVIPAccess || false,
        createdAt: new Date().toISOString()
      };
      
      users.push(newUser);
      saveUsers(users);
      
      log(`Admin created user "${username}" with ${coins || 50} coins`, 'ok');
      
      return res.json({
        ok: true,
        user: {
          id: newUser.id,
          username: newUser.username,
          role: newUser.role,
          coins: newUser.coins,
          referralCode: newUser.referralCode,
          hasVIPAccess: newUser.hasVIPAccess
        }
      });
    }
  } catch (err) {
    log(`Admin user creation error: ${err.message}`, 'error');
    return res.status(500).json({ error: 'Internal server error' });
  }
});

// Admin updates a user
app.put('/api/users/:id', requireAdmin, async (req, res) => {
  const { coins, role, hasVIPAccess, plan } = req.body || {};
  
  try {
    if (useMongoDB) {
      const user = await User.findById(req.params.id);
      if (!user) return res.status(404).json({ error: 'User not found' });
      
      if (coins !== undefined) user.coins = coins;
      if (role !== undefined) user.role = role;
      if (hasVIPAccess !== undefined) user.hasVIPAccess = hasVIPAccess;
      if (plan !== undefined && PLANS[plan]) user.plan = plan;
      
      await user.save();
      
      log(`Admin updated user "${user.username}"`, 'ok');
      
      return res.json({
        ok: true,
        user: {
          id: user._id,
          username: user.username,
          role: user.role,
          coins: user.coins,
          hasVIPAccess: user.hasVIPAccess
        }
      });
    } else {
      const users = loadUsers();
      const userIndex = users.findIndex(u => u.id === req.params.id);
      if (userIndex < 0) return res.status(404).json({ error: 'User not found' });
      
      if (coins !== undefined) users[userIndex].coins = coins;
      if (role !== undefined) users[userIndex].role = role;
      if (hasVIPAccess !== undefined) users[userIndex].hasVIPAccess = hasVIPAccess;
      if (plan !== undefined && PLANS[plan]) users[userIndex].plan = plan;
      
      saveUsers(users);
      
      log(`Admin updated user "${users[userIndex].username}"`, 'ok');
      
      return res.json({
        ok: true,
        user: {
          id: users[userIndex].id,
          username: users[userIndex].username,
          role: users[userIndex].role,
          coins: users[userIndex].coins,
          hasVIPAccess: users[userIndex].hasVIPAccess
        }
      });
    }
  } catch (err) {
    log(`Admin user update error: ${err.message}`, 'error');
    return res.status(500).json({ error: 'Internal server error' });
  }
});

app.delete('/api/users/:id', requireAdmin, async (req, res) => {
  try {
    if (useMongoDB) {
      const user = await User.findById(req.params.id);
      if (!user) return res.status(404).json({ error: 'User not found' });
      if (user.role === 'admin') return res.status(403).json({ error: 'Cannot delete admin' });
      await User.findByIdAndDelete(req.params.id);
    } else {
      let users = loadUsers();
      const user = users.find(u => u.id === req.params.id);
      if (!user) return res.status(404).json({ error: 'User not found' });
      if (user.role === 'admin') return res.status(403).json({ error: 'Cannot delete admin' });
      users = users.filter(u => u.id !== req.params.id);
      saveUsers(users);
    }
    log(`Admin deleted user "${req.params.id}"`, 'warn');
    return res.json({ ok: true });
  } catch (err) {
    return res.status(500).json({ error: 'Internal server error' });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// SESSION ROUTES
// ─────────────────────────────────────────────────────────────────────────────
// ── NEW v7: GET single session by ID ──────────────────────────────────────────
app.get('/api/sessions/:id', requireAuth, async (req, res) => {
  try {
    let sess;
    if (useMongoDB) {
      sess = await Session.findById(req.params.id);
      if (sess) sess = { ...sess.toObject(), id: sess._id.toString() };
    } else {
      const sessions = loadSessions();
      sess = sessions.find(s => s.id === req.params.id);
    }
    if (!sess) return res.status(404).json({ error: 'Session not found' });
    if (req.user.role !== 'admin' && String(sess.ownerId) !== req.user.id) {
      return res.status(403).json({ error: 'Forbidden' });
    }
    return res.json(sess);
  } catch (err) {
    return res.status(500).json({ error: 'Internal server error' });
  }
});

// ── NEW v7: RESTful session action routes ─────────────────────────────────────
async function getSessionForAction(id, userId, isAdmin) {
  let sess;
  if (useMongoDB) {
    sess = await Session.findById(id);
    if (sess) sess = { ...sess.toObject(), id: sess._id.toString() };
  } else {
    const sessions = loadSessions();
    sess = sessions.find(s => s.id === id);
  }
  if (!sess) return { error: 'Session not found', status: 404 };
  if (!isAdmin && String(sess.ownerId) !== userId) return { error: 'Forbidden', status: 403 };
  return { sess };
}

app.post('/api/sessions/:id/start', requireAuth, async (req, res) => {
  try {
    const { sess, error, status } = await getSessionForAction(req.params.id, req.user.id, req.user.role === 'admin');
    if (error) return res.status(status).json({ error });
    startBotProcess(sess);
    logActivity(req.user.id, req.user.username, 'session_start', { sessionId: sess.id });
    pushNotification(sess.ownerId, 'Bot Started', `Session "${sess.ownerName || sess.id}" is starting.`, '🚀');
    return res.json({ ok: true });
  } catch (err) {
    log('Session start error: ' + err.message, 'error');
    return res.status(500).json({ error: 'Internal server error' });
  }
});

app.post('/api/sessions/:id/stop', requireAuth, async (req, res) => {
  try {
    const { sess, error, status } = await getSessionForAction(req.params.id, req.user.id, req.user.role === 'admin');
    if (error) return res.status(status).json({ error });
    stopBotProcess(sess.id);
    logActivity(req.user.id, req.user.username, 'session_stop', { sessionId: sess.id });
    pushNotification(sess.ownerId, 'Bot Stopped', `Session "${sess.ownerName || sess.id}" was stopped.`, '⛔');
    return res.json({ ok: true });
  } catch (err) {
    log('Session stop error: ' + err.message, 'error');
    return res.status(500).json({ error: 'Internal server error' });
  }
});

app.post('/api/sessions/:id/restart', requireAuth, async (req, res) => {
  try {
    const { sess, error, status } = await getSessionForAction(req.params.id, req.user.id, req.user.role === 'admin');
    if (error) return res.status(status).json({ error });
    stopBotProcess(sess.id);
    setTimeout(() => startBotProcess(sess), 1500);
    logActivity(req.user.id, req.user.username, 'session_restart', { sessionId: sess.id });
    pushNotification(sess.ownerId, 'Bot Restarting', `Session "${sess.ownerName || sess.id}" is restarting.`, '🔄');
    return res.json({ ok: true });
  } catch (err) {
    log('Session restart error: ' + err.message, 'error');
    return res.status(500).json({ error: 'Internal server error' });
  }
});

// GET logs for a specific session
app.get('/api/sessions/:id/logs', requireAuth, async (req, res) => {
  try {
    const { sess, error, status } = await getSessionForAction(req.params.id, req.user.id, req.user.role === 'admin');
    if (error) return res.status(status).json({ error });

    const sessionId = sess.id;
    let sessionLogs = logBuffer.filter(e => e.sessionId === sessionId);

    // Non-admin users: only last LOG_VIEWING_MINUTES minutes of logs
    if (req.user.role !== 'admin') {
      const cutoff = Date.now() - LOG_VIEWING_MINUTES * 60 * 1000;
      const startTime = sess.startTime ? new Date(sess.startTime).getTime() : 0;
      const limitFrom = Math.max(cutoff, startTime);
      sessionLogs = sessionLogs.filter(e => e.ts >= limitFrom);
    }

    return res.json({ sessionId, logs: sessionLogs });
  } catch (err) {
    return res.status(500).json({ error: 'Internal server error' });
  }
});

// ── END new v7 session sub-routes ─────────────────────────────────────────────

app.get('/api/sessions', requireAuth, async (req, res) => {
  try {
    if (useMongoDB) {
      const sessions = await Session.find(req.user.role === 'admin' ? {} : { ownerId: req.user.id });
      // Transform _id to id for frontend compatibility
      const transformed = sessions.map(s => ({ ...s.toObject(), id: s._id.toString() }));
      return res.json(transformed);
    } else {
      const sessions = loadSessions();
      if (req.user.role === 'admin') return res.json(sessions);
      return res.json(sessions.filter(s => String(s.ownerId) === req.user.id));
    }
  } catch {
    return res.json([]);
  }
});

app.post('/api/sessions', requireAuth, async (req, res) => {
  const { ownerName, ownerNumber, sessionIdString, botName, prefix, timezone, botId, serverTier } = req.body || {};
  if (!ownerName || !sessionIdString) return res.status(400).json({ error: 'ownerName and sessionIdString required' });

  try {
    // ── Plan-based bot limit check ────────────────────────────────────────
    if (req.user.role !== 'admin') {
      let currentUser;
      if (useMongoDB) {
        currentUser = await User.findById(req.user.id);
      } else {
        const users = loadUsers();
        currentUser = users.find(u => u.id === req.user.id);
      }
      const userPlan = (currentUser && currentUser.plan) ? currentUser.plan : 'free';
      const planInfo = PLANS[userPlan] || PLANS.free;
      // Count existing sessions for this user
      let existingCount = 0;
      if (useMongoDB) {
        existingCount = await Session.countDocuments({ ownerId: req.user.id });
      } else {
        const sessions = loadSessions();
        existingCount = sessions.filter(s => String(s.ownerId) === req.user.id).length;
      }
      if (existingCount >= planInfo.maxBots) {
        return res.status(402).json({
          error: `Plan limit reached. Your ${planInfo.name} plan allows ${planInfo.maxBots} bot(s). Upgrade your plan to add more.`,
          plan: userPlan,
          maxBots: planInfo.maxBots,
          currentBots: existingCount
        });
      }
    }
    // ─────────────────────────────────────────────────────────────────────

    const sessionData = {
      ownerId: req.user.id,
      ownerName,
      ownerNumber: ownerNumber || '',
      sessionIdString,
      botName: botName || 'NovaSpark Bot',
      prefix: prefix || '.',
      timezone: timezone || 'Africa/Harare',
      botId: botId || null,
      serverTier: serverTier || 'basic',
      status: 'stopped',
      startTime: null,
      paidUntil: null
    };

    if (useMongoDB) {
      const session = await Session.create(sessionData);
      log(`Session "${session._id}" created by "${req.user.username}"`, 'ok');
      broadcast({ type: 'session-created', session });
      return res.json({ ok: true, session });
    } else {
      const sessions = loadSessions();
      const newSess = { id: uuidv4(), ...sessionData, createdAt: new Date().toISOString() };
      sessions.push(newSess);
      saveSessions(sessions);
      log(`Session "${newSess.id}" created by "${req.user.username}"`, 'ok');
      broadcast({ type: 'session-created', session: newSess });
      return res.json({ ok: true, session: newSess });
    }
  } catch (err) {
    log(`Session creation error: ${err.message}`, 'error');
    return res.status(500).json({ error: 'Internal server error' });
  }
});

app.put('/api/sessions/:id', requireAuth, async (req, res) => {
  try {
    if (useMongoDB) {
      const session = await Session.findById(req.params.id);
      if (!session) return res.status(404).json({ error: 'Session not found' });
      if (req.user.role !== 'admin' && String(session.ownerId) !== req.user.id) {
        return res.status(403).json({ error: 'Forbidden' });
      }
      
      const allowed = ['ownerName', 'ownerNumber', 'sessionIdString', 'botName', 'prefix', 'timezone', 'botId', 'serverTier'];
      allowed.forEach(k => { if (req.body[k] !== undefined) session[k] = req.body[k]; });
      await session.save();
      
      broadcast({ type: 'session-updated', session });
      return res.json({ ok: true, session });
    } else {
      const sessions = loadSessions();
      const idx = sessions.findIndex(s => s.id === req.params.id);
      if (idx === -1) return res.status(404).json({ error: 'Session not found' });
      if (req.user.role !== 'admin' && sessions[idx].ownerId !== req.user.id) {
        return res.status(403).json({ error: 'Forbidden' });
      }
      
      const allowed = ['ownerName', 'ownerNumber', 'sessionIdString', 'botName', 'prefix', 'timezone', 'botId', 'serverTier'];
      allowed.forEach(k => { if (req.body[k] !== undefined) sessions[idx][k] = req.body[k]; });
      saveSessions(sessions);
      
      broadcast({ type: 'session-updated', session: sessions[idx] });
      return res.json({ ok: true, session: sessions[idx] });
    }
  } catch (err) {
    return res.status(500).json({ error: 'Internal server error' });
  }
});

app.delete('/api/sessions/:id', requireAuth, async (req, res) => {
  try {
    if (useMongoDB) {
      const session = await Session.findById(req.params.id);
      if (!session) return res.status(404).json({ error: 'Session not found' });
      if (req.user.role !== 'admin' && String(session.ownerId) !== req.user.id) {
        return res.status(403).json({ error: 'Forbidden' });
      }
      
      // Save to deleted bots
      await DeletedBot.create({
        originalId: session._id,
        type: 'session',
        ownerId: session.ownerId,
        data: session.toObject()
      });
      
      stopBotProcess(session._id.toString());
      await Session.findByIdAndDelete(req.params.id);
      
      log(`Session "${req.params.id}" deleted`, 'warn');
      broadcast({ type: 'session-deleted', sessionId: req.params.id });
      return res.json({ ok: true });
    } else {
      let sessions = loadSessions();
      const sess = sessions.find(s => s.id === req.params.id);
      if (!sess) return res.status(404).json({ error: 'Session not found' });
      if (req.user.role !== 'admin' && String(sess.ownerId) !== req.user.id) {
        return res.status(403).json({ error: 'Forbidden' });
      }
      
      // Save to deleted bots
      const deletedBots = loadDeletedBots();
      deletedBots.push({
        id: uuidv4(),
        originalId: sess.id,
        type: 'session',
        ownerId: sess.ownerId,
        data: sess,
        deletedAt: new Date().toISOString()
      });
      saveDeletedBots(deletedBots);
      
      stopBotProcess(sess.id);
      sessions = sessions.filter(s => s.id !== req.params.id);
      saveSessions(sessions);
      
      log(`Session "${sess.id}" deleted`, 'warn');
      broadcast({ type: 'session-deleted', sessionId: sess.id });
      return res.json({ ok: true });
    }
  } catch (err) {
    log(`Session deletion error: ${err.message}`, 'error');
    return res.status(500).json({ error: 'Internal server error' });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// BOT RECOVERY ROUTES
// ─────────────────────────────────────────────────────────────────────────────
app.get('/api/deleted-bots', requireAuth, async (req, res) => {
  try {
    if (useMongoDB) {
      const bots = await DeletedBot.find(req.user.role === 'admin' ? {} : { ownerId: req.user.id });
      return res.json(bots);
    } else {
      const bots = loadDeletedBots();
      if (req.user.role === 'admin') return res.json(bots);
      return res.json(bots.filter(b => String(b.ownerId) === req.user.id));
    }
  } catch {
    return res.json([]);
  }
});

app.post('/api/deleted-bots/:id/recover', requireAuth, async (req, res) => {
  try {
    if (useMongoDB) {
      const deletedBot = await DeletedBot.findById(req.params.id);
      if (!deletedBot) return res.status(404).json({ error: 'Deleted bot not found' });
      if (req.user.role !== 'admin' && String(deletedBot.ownerId) !== req.user.id) {
        return res.status(403).json({ error: 'Forbidden' });
      }
      
      if (deletedBot.type === 'session') {
        const { _id, ...data } = deletedBot.data;
        const session = await Session.create({ ...data, status: 'stopped', startTime: null, paidUntil: null });
        await DeletedBot.findByIdAndDelete(req.params.id);
        log(`Session "${session._id}" recovered`, 'ok');
        broadcast({ type: 'session-created', session });
        return res.json({ ok: true, session });
      } else {
        const { _id, ...data } = deletedBot.data;
        const botConfig = await BotConfig.create({ ...data, status: 'stopped' });
        await DeletedBot.findByIdAndDelete(req.params.id);
        log(`Panel bot "${botConfig._id}" recovered`, 'ok');
        broadcast({ type: 'panel-bot-created', bot: botConfig });
        return res.json({ ok: true, bot: botConfig });
      }
    } else {
      const deletedBots = loadDeletedBots();
      const idx = deletedBots.findIndex(b => b.id === req.params.id);
      if (idx === -1) return res.status(404).json({ error: 'Deleted bot not found' });
      const deletedBot = deletedBots[idx];
      if (req.user.role !== 'admin' && String(deletedBot.ownerId) !== req.user.id) {
        return res.status(403).json({ error: 'Forbidden' });
      }
      
      if (deletedBot.type === 'session') {
        const sessions = loadSessions();
        const newSession = { 
          id: uuidv4(), 
          ...deletedBot.data, 
          status: 'stopped', 
          startTime: null, 
          paidUntil: null,
          createdAt: new Date().toISOString()
        };
        sessions.push(newSession);
        saveSessions(sessions);
        deletedBots.splice(idx, 1);
        saveDeletedBots(deletedBots);
        log(`Session "${newSession.id}" recovered`, 'ok');
        broadcast({ type: 'session-created', session: newSession });
        return res.json({ ok: true, session: newSession });
      } else {
        const configs = loadBotConfigs();
        const newConfig = { 
          id: uuidv4(), 
          ...deletedBot.data, 
          status: 'stopped',
          createdAt: new Date().toISOString()
        };
        configs.push(newConfig);
        saveBotConfigs(configs);
        deletedBots.splice(idx, 1);
        saveDeletedBots(deletedBots);
        log(`Panel bot "${newConfig.id}" recovered`, 'ok');
        broadcast({ type: 'panel-bot-created', bot: newConfig });
        return res.json({ ok: true, bot: newConfig });
      }
    }
  } catch (err) {
    log(`Recovery error: ${err.message}`, 'error');
    return res.status(500).json({ error: 'Internal server error' });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// PANEL BOT MANAGEMENT ROUTES
// ─────────────────────────────────────────────────────────────────────────────
app.get('/api/panel-bots', requireAuth, async (req, res) => {
  try {
    if (useMongoDB) {
      const configs = await BotConfig.find(req.user.role === 'admin' ? {} : { ownerId: req.user.id });
      return res.json(configs);
    } else {
      const configs = loadBotConfigs();
      if (req.user.role === 'admin') return res.json(configs);
      return res.json(configs.filter(c => String(c.ownerId) === req.user.id));
    }
  } catch {
    return res.json([]);
  }
});

app.get('/api/panel-bots/:botId', requireAuth, async (req, res) => {
  try {
    if (useMongoDB) {
      const config = await BotConfig.findById(req.params.botId);
      if (!config) return res.status(404).json({ error: 'Bot not found' });
      if (req.user.role !== 'admin' && String(config.ownerId) !== req.user.id) {
        return res.status(403).json({ error: 'Forbidden' });
      }
      return res.json(config);
    } else {
      const configs = loadBotConfigs();
      const config = configs.find(c => c.id === req.params.botId);
      if (!config) return res.status(404).json({ error: 'Bot not found' });
      if (req.user.role !== 'admin' && String(config.ownerId) !== req.user.id) {
        return res.status(403).json({ error: 'Forbidden' });
      }
      return res.json(config);
    }
  } catch {
    return res.status(500).json({ error: 'Internal server error' });
  }
});

app.post('/api/panel-bots/upload', requireAuth, uploadZip.single('botZip'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file uploaded' });

  const botId = uuidv4();
  const botName = req.body.name || path.parse(req.file.originalname).name;
  const botDescription = req.body.description || '';
  const entryPoint = req.body.entryPoint || 'index.js';
  
  const extractDir = path.join(UPLOADED_BOTS_DIR, botId);
  fs.mkdirSync(extractDir, { recursive: true });

  const AdmZip = require('adm-zip');
  try {
    const zip = new AdmZip(req.file.path);
    zip.extractAllTo(extractDir, true);
    fs.unlinkSync(req.file.path);

    const packageJsonPath = path.join(extractDir, 'package.json');
    if (fs.existsSync(packageJsonPath)) {
      log(`Installing dependencies for bot "${botName}"...`, 'info');
      try {
        execSync('npm install', { cwd: extractDir, stdio: 'pipe' });
        log(`Dependencies installed for bot "${botName}"`, 'ok');
      } catch (err) {
        log(`Warning: Could not install dependencies for "${botName}": ${err.message}`, 'warn');
      }
    }

    const configData = {
      name: botName,
      description: botDescription,
      entryPoint: req.body.entryPoint || entryPoint,
      ownerId: req.user.id,
      ownerUsername: req.user.username,
      serverTier: 'basic',
      status: 'stopped',
      startTime: null,
      paidUntil: null,
      path: extractDir
    };

    if (useMongoDB) {
      const config = await BotConfig.create({ ...configData, _id: botId });
      log(`Panel bot "${botName}" uploaded by "${req.user.username}"`, 'ok');
      broadcast({ type: 'panel-bot-created', bot: config });
      return res.json({ ok: true, bot: config });
    } else {
      const configs = loadBotConfigs();
      const config = { id: botId, ...configData, createdAt: new Date().toISOString() };
      configs.push(config);
      saveBotConfigs(configs);
      log(`Panel bot "${botName}" uploaded by "${req.user.username}"`, 'ok');
      broadcast({ type: 'panel-bot-created', bot: config });
      return res.json({ ok: true, bot: config });
    }
  } catch (err) {
    fs.rmSync(extractDir, { recursive: true, force: true });
    log(`Failed to extract bot: ${err.message}`, 'error');
    return res.status(500).json({ error: 'Failed to extract bot: ' + err.message });
  }
});

app.put('/api/panel-bots/:botId', requireAuth, async (req, res) => {
  try {
    if (useMongoDB) {
      const config = await BotConfig.findById(req.params.botId);
      if (!config) return res.status(404).json({ error: 'Bot not found' });
      if (req.user.role !== 'admin' && String(config.ownerId) !== req.user.id) {
        return res.status(403).json({ error: 'Forbidden' });
      }
      
      const allowed = ['name', 'description', 'entryPoint', 'serverTier'];
      allowed.forEach(k => { if (req.body[k] !== undefined) config[k] = req.body[k]; });
      await config.save();
      
      broadcast({ type: 'panel-bot-updated', bot: config });
      return res.json({ ok: true, bot: config });
    } else {
      const configs = loadBotConfigs();
      const idx = configs.findIndex(c => c.id === req.params.botId);
      if (idx === -1) return res.status(404).json({ error: 'Bot not found' });
      if (req.user.role !== 'admin' && configs[idx].ownerId !== req.user.id) {
        return res.status(403).json({ error: 'Forbidden' });
      }
      
      const allowed = ['name', 'description', 'entryPoint', 'serverTier'];
      allowed.forEach(k => { if (req.body[k] !== undefined) configs[idx][k] = req.body[k]; });
      saveBotConfigs(configs);
      
      broadcast({ type: 'panel-bot-updated', bot: configs[idx] });
      return res.json({ ok: true, bot: configs[idx] });
    }
  } catch {
    return res.status(500).json({ error: 'Internal server error' });
  }
});

app.delete('/api/panel-bots/:botId', requireAuth, async (req, res) => {
  try {
    if (useMongoDB) {
      const config = await BotConfig.findById(req.params.botId);
      if (!config) return res.status(404).json({ error: 'Bot not found' });
      if (req.user.role !== 'admin' && String(config.ownerId) !== req.user.id) {
        return res.status(403).json({ error: 'Forbidden' });
      }
      
      // Save to deleted bots
      await DeletedBot.create({
        originalId: config._id,
        type: 'panel-bot',
        ownerId: config.ownerId,
        data: config.toObject()
      });
      
      stopPanelBotProcess(config._id.toString());
      const botDir = path.join(UPLOADED_BOTS_DIR, config._id.toString());
      if (fs.existsSync(botDir)) fs.rmSync(botDir, { recursive: true, force: true });
      await BotConfig.findByIdAndDelete(req.params.botId);
      
      log(`Panel bot "${config.name}" deleted`, 'warn');
      broadcast({ type: 'panel-bot-deleted', botId: req.params.botId });
      return res.json({ ok: true });
    } else {
      const configs = loadBotConfigs();
      const config = configs.find(c => c.id === req.params.botId);
      if (!config) return res.status(404).json({ error: 'Bot not found' });
      if (req.user.role !== 'admin' && String(config.ownerId) !== req.user.id) {
        return res.status(403).json({ error: 'Forbidden' });
      }
      
      // Save to deleted bots
      const deletedBots = loadDeletedBots();
      deletedBots.push({
        id: uuidv4(),
        originalId: config.id,
        type: 'panel-bot',
        ownerId: config.ownerId,
        data: config,
        deletedAt: new Date().toISOString()
      });
      saveDeletedBots(deletedBots);
      
      stopPanelBotProcess(config.id);
      const botDir = path.join(UPLOADED_BOTS_DIR, config.id);
      if (fs.existsSync(botDir)) fs.rmSync(botDir, { recursive: true, force: true });
      
      const newConfigs = configs.filter(c => c.id !== req.params.botId);
      saveBotConfigs(newConfigs);
      
      log(`Panel bot "${config.name}" deleted`, 'warn');
      broadcast({ type: 'panel-bot-deleted', botId: config.id });
      return res.json({ ok: true });
    }
  } catch (err) {
    log(`Panel bot deletion error: ${err.message}`, 'error');
    return res.status(500).json({ error: 'Internal server error' });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// BOT CONTROL ROUTES
// ─────────────────────────────────────────────────────────────────────────────
app.post('/api/panel-bots/:botId/start', requireAuth, async (req, res) => {
  try {
    let config;
    if (useMongoDB) {
      config = await BotConfig.findById(req.params.botId);
    } else {
      const configs = loadBotConfigs();
      config = configs.find(c => c.id === req.params.botId);
    }
    
    if (!config) return res.status(404).json({ error: 'Bot not found' });
    if (req.user.role !== 'admin' && String(config.ownerId) !== req.user.id) {
      return res.status(403).json({ error: 'Forbidden' });
    }

    // Plan check: bot start is free within the user's plan limit.
    // (Bot count limit is enforced at creation time; starting is always allowed.)
    startPanelBotProcess(config);
    return res.json({ ok: true });
  } catch (err) {
    log(`Bot start error: ${err.message}`, 'error');
    return res.status(500).json({ error: 'Internal server error' });
  }
});

app.post('/api/panel-bots/:botId/stop', requireAuth, async (req, res) => {
  try {
    let config;
    if (useMongoDB) {
      config = await BotConfig.findById(req.params.botId);
    } else {
      const configs = loadBotConfigs();
      config = configs.find(c => c.id === req.params.botId);
    }
    
    if (!config) return res.status(404).json({ error: 'Bot not found' });
    if (req.user.role !== 'admin' && String(config.ownerId) !== req.user.id) {
      return res.status(403).json({ error: 'Forbidden' });
    }

    stopPanelBotProcess(useMongoDB ? config._id.toString() : config.id);
    return res.json({ ok: true });
  } catch {
    return res.status(500).json({ error: 'Internal server error' });
  }
});

app.post('/api/panel-bots/:botId/restart', requireAuth, async (req, res) => {
  try {
    let config;
    if (useMongoDB) {
      config = await BotConfig.findById(req.params.botId);
    } else {
      const configs = loadBotConfigs();
      config = configs.find(c => c.id === req.params.botId);
    }
    
    if (!config) return res.status(404).json({ error: 'Bot not found' });
    if (req.user.role !== 'admin' && String(config.ownerId) !== req.user.id) {
      return res.status(403).json({ error: 'Forbidden' });
    }

    stopPanelBotProcess(useMongoDB ? config._id.toString() : config.id);
    setTimeout(() => startPanelBotProcess(config), 1500);
    return res.json({ ok: true });
  } catch {
    return res.status(500).json({ error: 'Internal server error' });
  }
});

// Get bot logs (limited for users)
app.get('/api/panel-bots/:botId/logs', requireAuth, async (req, res) => {
  try {
    let config;
    if (useMongoDB) {
      config = await BotConfig.findById(req.params.botId);
    } else {
      const configs = loadBotConfigs();
      config = configs.find(c => c.id === req.params.botId);
    }
    
    if (!config) return res.status(404).json({ error: 'Bot not found' });
    if (req.user.role !== 'admin' && String(config.ownerId) !== req.user.id) {
      return res.status(403).json({ error: 'Forbidden' });
    }

    let botLogs = logBuffer.filter(l => l.sessionId === req.params.botId);
    
    // Non-admin users can only see logs for first 20 minutes
    if (req.user.role !== 'admin') {
      const startTime = config.startTime ? new Date(config.startTime) : null;
      if (startTime) {
        const cutoff = new Date(startTime.getTime() + LOG_VIEWING_MINUTES * 60 * 1000);
        botLogs = botLogs.filter(l => new Date(l.ts) <= cutoff);
      }
    }
    
    return res.json({ logs: botLogs });
  } catch {
    return res.status(500).json({ error: 'Internal server error' });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// SESSION BOT CONTROL
// ─────────────────────────────────────────────────────────────────────────────
app.post('/api/bot/start', requireAuth, async (req, res) => {
  const { sessionId } = req.body || {};
  
  if (!sessionId) {
    return res.status(400).json({ error: 'Session ID is required' });
  }
  
  try {
    let sess;
    if (useMongoDB) {
      sess = await Session.findById(sessionId);
      if (sess) {
        sess = { ...sess.toObject(), id: sess._id.toString() };
      }
    } else {
      const sessions = loadSessions();
      sess = sessions.find(s => s.id === sessionId);
    }
    
    if (!sess) return res.status(404).json({ error: 'Session not found' });
    if (req.user.role !== 'admin' && String(sess.ownerId) !== req.user.id) {
      return res.status(403).json({ error: 'Forbidden' });
    }

    // Plan check: bot start is allowed within plan limits.
    startBotProcess(sess);
    return res.json({ ok: true });
  } catch (err) {
    log(`Bot start error: ${err.message}`, 'error');
    return res.status(500).json({ error: 'Internal server error' });
  }
});

app.post('/api/bot/stop', requireAuth, async (req, res) => {
  const { sessionId } = req.body || {};
  if (!sessionId) return res.status(400).json({ error: 'sessionId required' });

  try {
    let sess;
    if (useMongoDB) {
      sess = await Session.findById(sessionId);
      if (sess) sess = { ...sess.toObject(), id: sess._id.toString() };
    } else {
      const sessions = loadSessions();
      sess = sessions.find(s => s.id === sessionId);
    }

    if (!sess) return res.status(404).json({ error: 'Session not found' });
    if (req.user.role !== 'admin' && String(sess.ownerId) !== req.user.id) {
      return res.status(403).json({ error: 'Forbidden' });
    }

    stopBotProcess(sess.id || sessionId);
    return res.json({ ok: true });
  } catch (err) {
    log('Bot stop error: ' + err.message, 'error');
    return res.status(500).json({ error: 'Internal server error' });
  }
});

app.post('/api/bot/restart', requireAuth, async (req, res) => {
  const { sessionId } = req.body || {};
  if (!sessionId) return res.status(400).json({ error: 'sessionId required' });

  try {
    let sess;
    if (useMongoDB) {
      sess = await Session.findById(sessionId);
      if (sess) sess = { ...sess.toObject(), id: sess._id.toString() };
    } else {
      const sessions = loadSessions();
      sess = sessions.find(s => s.id === sessionId);
    }

    if (!sess) return res.status(404).json({ error: 'Session not found' });
    if (req.user.role !== 'admin' && String(sess.ownerId) !== req.user.id) {
      return res.status(403).json({ error: 'Forbidden' });
    }

    stopBotProcess(sess.id || sessionId);
    setTimeout(() => startBotProcess(sess), 1500);
    return res.json({ ok: true });
  } catch (err) {
    log('Bot restart error: ' + err.message, 'error');
    return res.status(500).json({ error: 'Internal server error' });
  }
});

app.post('/api/bot/cleanup', requireAdmin, (req, res) => {
  const result = runCleanup();
  res.json({ ok: true, ...result });
});

// ─────────────────────────────────────────────────────────────────────────────
// INSTALL BOT ROUTE
// ─────────────────────────────────────────────────────────────────────────────
app.post('/api/install-bot', requireAdmin, (req, res) => {
  try {
    log('Installing bot from GitHub...', 'info');
    execSync('git clone --depth 1 https://github.com/dev-modder/NovaSpark-Bot.git bot-src 2>&1 || (cd bot-src && git pull)', {
      cwd: __dirname, stdio: 'pipe'
    });
    execSync('npm install', { cwd: path.join(__dirname, 'bot-src'), stdio: 'pipe' });
    log('Bot installed successfully!', 'ok');
    res.json({ ok: true });
  } catch (err) {
    log(`Bot install failed: ${err.message}`, 'error');
    res.json({ ok: false, error: err.message });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// STATUS & HEALTH
// ─────────────────────────────────────────────────────────────────────────────
app.get('/api/status', (req, res) => {
  const mem = process.memoryUsage();
  res.json({
    uptime: Math.floor((Date.now() - state.startTime) / 1000),
    pingCount: state.pingCount,
    cleanCount: state.cleanCount,
    mem,
    version: '8.0.0'
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// V5 — STATS API (dashboard summary)
// ─────────────────────────────────────────────────────────────────────────────
app.get('/api/stats', requireAuth, async (req, res) => {
  try {
    let totalUsers = 0, totalSessions = 0, activeBots = 0, totalPanelBots = 0;

    if (useMongoDB) {
      totalUsers    = await User.countDocuments();
      totalSessions = await Session.countDocuments(req.user.role === 'admin' ? {} : { ownerId: req.user.id });
      totalPanelBots = await BotConfig.countDocuments(req.user.role === 'admin' ? {} : { ownerId: req.user.id });
    } else {
      const users    = loadUsers();
      const sessions = loadSessions();
      const configs  = loadBotConfigs();
      totalUsers     = users.length;
      totalSessions  = req.user.role === 'admin' ? sessions.length : sessions.filter(s => String(s.ownerId) === req.user.id).length;
      totalPanelBots = req.user.role === 'admin' ? configs.length : configs.filter(c => String(c.ownerId) === req.user.id).length;
    }

    activeBots = Object.keys(state.botProcesses).length + Object.keys(state.panelBotProcesses).length;

    const mem = process.memoryUsage();
    const uptimeSecs = Math.floor((Date.now() - state.startTime) / 1000);

    res.json({
      version: '8.0.0',
      uptime: uptimeSecs,
      activeBots,
      totalUsers,
      totalSessions,
      totalPanelBots,
      memUsedMB: Math.round(mem.rss / 1024 / 1024),
      memHeapMB: Math.round(mem.heapUsed / 1024 / 1024),
      nodeVersion: process.version,
      platform: process.platform
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// V5 — BOT FEATURES API
// ─────────────────────────────────────────────────────────────────────────────
app.get('/api/bot-features', (req, res) => {
  res.json({
    version: '8.0.0',
    botName: 'NovaSpark Bot',
    categories: [
      {
        name: 'Free Commands',
        icon: '🆓',
        commands: [
          { cmd: '.menu [group/ai/games/media/social/tools]', desc: 'Categorized command menu' },
          { cmd: '.homework <question>', desc: 'Detailed AI answer to any question' },
          { cmd: '.essay <topic>', desc: 'Full structured essay on any topic' },
          { cmd: '.summarize <text>', desc: 'Bullet-point summary of any text' },
          { cmd: '.translate <lang> <text>', desc: 'Translate anything to any language' },
          { cmd: '.studytips <subject>', desc: 'AI study tips for any subject' },
          { cmd: '.math <problem>', desc: 'Step-by-step math solutions' },
          { cmd: '.sticker', desc: 'Reply to image/video to create a sticker' },
          { cmd: '.imagine <prompt>', desc: 'Free AI image generation' },
          { cmd: '.tts [lang] <text>', desc: 'Text to speech — real voice note' },
          { cmd: '.news [topic]', desc: 'Live news headlines' },
          { cmd: '.qr <text>', desc: 'Generate a QR code' },
          { cmd: '.currency 100 USD ZAR', desc: 'Real-time currency exchange rates' },
          { cmd: '.poll Q | A | B | C', desc: 'Create a native WhatsApp poll' },
          { cmd: '.fact', desc: 'Get a verified random fact' },
          { cmd: '.urban <word>', desc: 'Urban Dictionary definition' },
          { cmd: '.bmi <kg> <cm>', desc: 'BMI calculator with health info' },
          { cmd: '.groupinfo', desc: 'Group analytics and member stats' },
          { cmd: '.roast @user', desc: 'AI-generated roast' },
          { cmd: '.weather <city>', desc: '3-day weather forecast' },
          { cmd: '.calc <expr>', desc: 'Scientific calculator (sin, cos, sqrt, etc.)' },
          { cmd: '.time [tz]', desc: 'World clock — 10 cities or custom timezone' }
        ]
      },
      {
        name: 'Games',
        icon: '🎮',
        commands: [
          { cmd: '.wordle', desc: 'Play Wordle — guess the 5-letter word' },
          { cmd: '.trivia', desc: 'Live trivia quiz with score tracking' },
          { cmd: '.hangman', desc: 'Classic hangman word game' },
          { cmd: '.rps rock/paper/scissors', desc: 'Rock Paper Scissors vs the bot' }
        ]
      },
      {
        name: 'Downloads',
        icon: '📥',
        commands: [
          { cmd: '.tiktok <url>', desc: 'TikTok video downloader (no watermark)' },
          { cmd: '.yt <query>', desc: 'YouTube video search and download' },
          { cmd: '.ytmp3 <url>', desc: 'Download YouTube audio as MP3' },
          { cmd: '.ytmp4 <url>', desc: 'Download YouTube video as MP4' },
          { cmd: '.instagram <url>', desc: 'Download Instagram Reels/Posts' },
          { cmd: '.facebook <url>', desc: 'Download Facebook videos' },
          { cmd: '.pinterest <url>', desc: 'Download Pinterest images' },
          { cmd: '.spotify <query>', desc: 'Spotify track info & preview' }
        ]
      },
      {
        name: 'Media & Tools',
        icon: '🛠️',
        commands: [
          { cmd: '.removebg', desc: 'Remove image background instantly' },
          { cmd: '.textart <style> <text>', desc: 'Fancy ASCII text art styles' },
          { cmd: '.viewonce', desc: 'Forward view-once messages' },
          { cmd: '.simage', desc: 'Save sticker as image' },
          { cmd: '.ssweb <url>', desc: 'Screenshot any website' }
        ]
      },
      {
        name: 'AI & Smart Features',
        icon: '🤖',
        commands: [
          { cmd: '.gpt <prompt>', desc: 'GPT-4 powered text generation' },
          { cmd: '.gemini <prompt>', desc: 'Google Gemini AI assistant' },
          { cmd: '.imagine2 <prompt>', desc: 'Premium AI image generation' },
          { cmd: '.remini', desc: 'AI photo enhancer — restore old images' },
          { cmd: '.character <name>', desc: 'Chat as a famous character' },
          { cmd: '.autochat on/off', desc: 'AI auto-reply mode for the group' }
        ]
      },
      {
        name: 'Fun & Social',
        icon: '🎉',
        commands: [
          { cmd: '.joke', desc: 'Random joke from multiple categories' },
          { cmd: '.meme', desc: 'Fetch a random meme image' },
          { cmd: '.quote', desc: 'Inspiring quote of the moment' },
          { cmd: '.8ball <question>', desc: 'Ask the magic 8-ball' },
          { cmd: '.flirt', desc: 'Smooth flirt lines' },
          { cmd: '.gayrate @user', desc: 'Fun gaydar rating (just for laughs)' },
          { cmd: '.lyrics <song>', desc: 'Get song lyrics' },
          { cmd: '.ship @user1 @user2', desc: 'Love compatibility score with emoji bar' },
          { cmd: '.truth', desc: 'Truth or Dare — curated truth question' },
          { cmd: '.dare', desc: 'Truth or Dare — dare challenge' },
          { cmd: '.compliment [@user]', desc: 'Tag someone with a genuine compliment' },
          { cmd: '.insult [@user]', desc: 'Funny (not cruel) savage roast' },
          { cmd: '.motivate [@user]', desc: 'Live motivation from quotable.io' }
        ]
      },
      {
        name: 'Group Management',
        icon: '👥',
        commands: [
          { cmd: '.warn @user [reason]', desc: 'Warn a group member' },
          { cmd: '.warns @user', desc: "Check a member's warnings" },
          { cmd: '.clearwarn @user', desc: 'Clear all warnings for a member' },
          { cmd: '.setwarnlimit N', desc: 'Set auto-kick threshold' },
          { cmd: '.kick @user', desc: 'Remove a member from the group' },
          { cmd: '.promote @user', desc: 'Promote member to admin' },
          { cmd: '.demote @user', desc: 'Remove admin from a member' },
          { cmd: '.mute', desc: 'Lock the group (admins only can send)' },
          { cmd: '.unmute', desc: 'Unlock the group for everyone' },
          { cmd: '.tagall [msg]', desc: 'Tag all group members' },
          { cmd: '.hidetag [msg]', desc: 'Tag all silently (no mention visible)' },
          { cmd: '.antilink on/off', desc: 'Auto-remove link messages' },
          { cmd: '.antiword on/off/add/remove', desc: 'Per-group bad word filter' },
          { cmd: '.antitoxic on/off', desc: 'AI-powered toxic message filter' },
          { cmd: '.nightmode on/off', desc: 'Auto mute/unmute on schedule' },
          { cmd: '.vip on/off/add/remove/list', desc: 'VIP-only mode — restrict non-VIPs' },
          { cmd: '.ghost on/off', desc: 'Ghost mode — hide bot presence' },
          { cmd: '.autoreact on/off', desc: 'Auto-react to messages with emoji' },
          { cmd: '.welcome on/off [msg]', desc: 'Custom welcome messages for new members' },
          { cmd: '.goodbye on/off [msg]', desc: 'Custom goodbye messages' },
          { cmd: '.groupstats', desc: 'Full group analytics dashboard' },
          { cmd: '.grouplink', desc: 'Get the group invite link' },
          { cmd: '.resetlink', desc: 'Reset the group invite link' },
          { cmd: '.delete', desc: 'Delete a replied message' }
        ]
      },
      {
        name: 'Premium Commands',
        icon: '💎',
        commands: [
          { cmd: '.examprep <subject>', desc: 'Full exam revision with AI' },
          { cmd: '.code <lang> <task>', desc: 'Generate working code in any language' },
          { cmd: '.remind <time> <msg>', desc: 'Set real reminders' },
          { cmd: '.mystats', desc: 'Personal usage analytics' },
          { cmd: '.autostudy on <subject>', desc: 'Daily AI study tips delivered automatically' },
          { cmd: '.setpersona <desc>', desc: 'Set a custom AI persona for the bot' }
        ]
      },
      {
        name: 'Owner Commands',
        icon: '👑',
        commands: [
          { cmd: '.broadcast <msg>', desc: 'Broadcast a message to all groups' },
          { cmd: '.setpremium @user on/off', desc: 'Grant or revoke premium access' },
          { cmd: '.botstats', desc: 'Full bot performance statistics' },
          { cmd: '.antidelete on/off', desc: 'Anti-delete — resend deleted messages' },
          { cmd: '.anticall on/off', desc: 'Auto-reject incoming calls' },
          { cmd: '.autoread on/off', desc: 'Auto-read all messages' },
          { cmd: '.pmblocker on/off', desc: 'Block non-contact DMs' },
          { cmd: '.topmembers', desc: 'Show most active group members' },
          { cmd: '.myactivity', desc: 'Your personal command activity log' }
        ]
      }
    ]
  });
});

// ── NEW v7: Admin broadcast notification to all / specific users ──────────────
app.post('/api/admin/broadcast', requireAdmin, async (req, res) => {
  const { title, body, icon = '📢', targetUserId } = req.body || {};
  if (!title || !body) return res.status(400).json({ error: 'title and body required' });

  try {
    let recipients = [];
    if (targetUserId) {
      recipients = [targetUserId];
    } else {
      // Broadcast to all users
      const users = await getAllUsers();
      recipients = users.map(u => String(u.id || u._id));
    }
    recipients.forEach(uid => pushNotification(uid, title, body, icon));
    log(`Admin broadcast "${title}" sent to ${recipients.length} user(s)`, 'ok');
    return res.json({ ok: true, sent: recipients.length });
  } catch (err) {
    return res.status(500).json({ error: 'Internal server error' });
  }
});

// ── NEW v7: User search (admin) ────────────────────────────────────────────────
app.get('/api/users/search', requireAdmin, async (req, res) => {
  const q = (req.query.q || '').toLowerCase().trim();
  if (!q) return res.status(400).json({ error: 'q query param required' });
  try {
    const users = await getAllUsers();
    const results = users.filter(u =>
      u.username.toLowerCase().includes(q) ||
      (u.referralCode || '').toLowerCase().includes(q)
    );
    return res.json(results);
  } catch (err) {
    return res.status(500).json({ error: 'Internal server error' });
  }
});

// ── NEW v7: Bot process metrics ────────────────────────────────────────────────
app.get('/api/admin/bot-metrics', requireAdmin, (req, res) => {
  const running = Object.keys(state.botProcesses);
  const panelRunning = Object.keys(state.panelBotProcesses);
  return res.json({
    runningSessionBots: running.length,
    runningPanelBots: panelRunning.length,
    sessionBotIds: running,
    panelBotIds: panelRunning,
    uptimeSeconds: Math.floor((Date.now() - state.startTime) / 1000),
    pingCount: state.pingCount
  });
});

// ── NEW v7: Bulk stop all bots (admin emergency) ───────────────────────────────
app.post('/api/admin/stop-all', requireAdmin, (req, res) => {
  const stopped = [];
  Object.keys(state.botProcesses).forEach(id => { stopBotProcess(id); stopped.push(id); });
  Object.keys(state.panelBotProcesses).forEach(id => { stopPanelBotProcess(id); stopped.push(id); });
  log(`Admin emergency stop — ${stopped.length} bots stopped`, 'warn');
  return res.json({ ok: true, stopped: stopped.length });
});

// ── NEW v7: Admin get all logs (full buffer) ───────────────────────────────────
app.get('/api/admin/logs', requireAdmin, (req, res) => {
  const level = req.query.level;
  const sessionId = req.query.sessionId;
  let logs = [...logBuffer];
  if (level) logs = logs.filter(e => e.level === level);
  if (sessionId) logs = logs.filter(e => e.sessionId === sessionId);
  return res.json({ logs, total: logs.length });
});

// ─────────────────────────────────────────────────────────────────────────────
// NODES BANK — EcoCash Payment Requests  (NEW v8)
// ─────────────────────────────────────────────────────────────────────────────
const BANK_FILE    = path.join(DATA_DIR, 'bank-orders.json');
const ECOCASH_NUM  = process.env.ECOCASH_NUMBER || '263786831091';

const BANK_PLANS = {
  basic: { name: 'Basic',  price_usd: 5,  price_zwg: 1800, maxBots: 3,  durationDays: 30 },
  pro:   { name: 'Pro',    price_usd: 10, price_zwg: 3600, maxBots: 10, durationDays: 30 },
  vip:   { name: 'VIP',    price_usd: 20, price_zwg: 7200, maxBots: 10, durationDays: 30, vip: true }
};

function loadBankOrders() {
  try { return JSON.parse(fs.readFileSync(BANK_FILE, 'utf8')); } catch { return []; }
}
function saveBankOrders(orders) {
  fs.writeFileSync(BANK_FILE, JSON.stringify(orders, null, 2));
}

// GET /api/bank/plans — public plan listing
app.get('/api/bank/plans', (req, res) => {
  res.json({ plans: BANK_PLANS, ecocash: ECOCASH_NUM });
});

// POST /api/bank/order — user submits payment proof
app.post('/api/bank/order', requireAuth, async (req, res) => {
  const { plan, txRef, phone } = req.body;
  if (!plan || !BANK_PLANS[plan]) return res.status(400).json({ error: 'Invalid plan' });
  if (!txRef || String(txRef).trim().length < 3) return res.status(400).json({ error: 'Transaction reference required' });

  const orders = loadBankOrders();
  if (orders.find(o => o.txRef === String(txRef).trim())) {
    return res.status(409).json({ error: 'Transaction reference already submitted' });
  }

  const order = {
    id: uuidv4(),
    userId: String(req.user.id || req.user._id),
    username: req.user.username,
    plan,
    planName: BANK_PLANS[plan].name,
    price_usd: BANK_PLANS[plan].price_usd,
    price_zwg: BANK_PLANS[plan].price_zwg,
    txRef: String(txRef).trim(),
    phone: String(phone || '').trim(),
    status: 'pending',
    submittedAt: new Date().toISOString(),
    reviewedAt: null,
    reviewedBy: null,
    note: ''
  };

  orders.push(order);
  saveBankOrders(orders);

  pushNotification(order.userId, '💳 Payment Submitted', `Your ${order.planName} plan order (ref: ${order.txRef}) has been received. Awaiting admin approval.`, '💳');
  const allUsers = loadUsers();
  const adminUser = allUsers.find(u => u.role === 'admin');
  if (adminUser) pushNotification(String(adminUser.id || adminUser._id), '🏦 New Bank Order', `${order.username} submitted a ${order.planName} order. Ref: ${order.txRef}`, '🏦');

  logActivity(order.userId, order.username, 'bank_order_submitted', { plan, txRef: order.txRef });
  res.json({ ok: true, orderId: order.id, message: 'Order submitted. Admin will activate within 24 hours.' });
});

// GET /api/bank/orders — user gets their own orders
app.get('/api/bank/orders', requireAuth, (req, res) => {
  const orders = loadBankOrders();
  const mine = orders.filter(o => o.userId === String(req.user.id || req.user._id));
  res.json(mine.reverse());
});

// GET /api/bank/orders/all — admin gets all orders
app.get('/api/bank/orders/all', requireAdmin, (req, res) => {
  const orders = loadBankOrders();
  res.json(orders.reverse());
});

// POST /api/bank/orders/:id/approve — admin approves order
app.post('/api/bank/orders/:id/approve', requireAdmin, async (req, res) => {
  const orders = loadBankOrders();
  const idx = orders.findIndex(o => o.id === req.params.id);
  if (idx === -1) return res.status(404).json({ error: 'Order not found' });
  const order = orders[idx];
  if (order.status !== 'pending') return res.status(400).json({ error: 'Order already processed' });

  const plan = BANK_PLANS[order.plan];
  const users = loadUsers();
  const uIdx = users.findIndex(u => String(u.id || u._id) === order.userId || u.username === order.username);
  if (uIdx !== -1) {
    users[uIdx].plan = order.plan === 'vip' ? 'pro' : order.plan;
    if (order.plan === 'vip') users[uIdx].hasVIPAccess = true;
    users[uIdx].planExpiresAt = new Date(Date.now() + plan.durationDays * 86400000).toISOString();
    saveUsers(users);
  }

  orders[idx].status = 'approved';
  orders[idx].reviewedAt = new Date().toISOString();
  orders[idx].reviewedBy = req.user.username;
  saveBankOrders(orders);

  pushNotification(order.userId, '✅ Plan Activated!', `Your ${order.planName} plan has been activated. Enjoy your bots!`, '✅');
  logActivity(order.userId, order.username, 'bank_plan_activated', { plan: order.plan, approvedBy: req.user.username });
  res.json({ ok: true });
});

// POST /api/bank/orders/:id/reject — admin rejects order
app.post('/api/bank/orders/:id/reject', requireAdmin, async (req, res) => {
  const orders = loadBankOrders();
  const idx = orders.findIndex(o => o.id === req.params.id);
  if (idx === -1) return res.status(404).json({ error: 'Order not found' });
  const { reason } = req.body;

  orders[idx].status = 'rejected';
  orders[idx].reviewedAt = new Date().toISOString();
  orders[idx].reviewedBy = req.user.username;
  orders[idx].note = reason || '';
  saveBankOrders(orders);

  pushNotification(orders[idx].userId, '❌ Payment Rejected', `Your ${orders[idx].planName} order was not approved. ${reason || 'Contact admin for details.'}`, '❌');
  res.json({ ok: true });
});

// ── NEW v8: Bot Uptime Tracker — per-session live stats ───────────────────────
app.get('/api/sessions/:id/uptime', requireAuth, async (req, res) => {
  try {
    const sessions = loadSessions();
    const sess = sessions.find(s => String(s.id) === req.params.id || String(s._id) === req.params.id);
    if (!sess) return res.status(404).json({ error: 'Session not found' });
    if (String(sess.ownerId) !== String(req.user.id || req.user._id) && req.user.role !== 'admin') {
      return res.status(403).json({ error: 'Forbidden' });
    }
    const pid = state.botProcesses[req.params.id];
    const isRunning = !!(pid);
    const uptimeMs = (isRunning && sess.startTime) ? Date.now() - new Date(sess.startTime).getTime() : 0;
    const uptimeSec = Math.max(0, Math.floor(uptimeMs / 1000));
    res.json({
      sessionId: req.params.id,
      status: sess.status || 'stopped',
      isRunning,
      uptimeSec,
      uptimeHuman: formatUptime(uptimeSec),
      startTime: sess.startTime || null
    });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

function formatUptime(sec) {
  if (!sec || sec <= 0) return '—';
  if (sec < 60) return `${sec}s`;
  if (sec < 3600) return `${Math.floor(sec/60)}m ${sec%60}s`;
  const h = Math.floor(sec/3600), m = Math.floor((sec%3600)/60), s = sec%60;
  return `${h}h ${m}m ${s}s`;
}

// ── NEW v7: Server-sent health details ────────────────────────────────────────
app.get('/health', (req, res) => res.json({
  status: 'ok',
  ts: Date.now(),
  version: '8.0.0',
  botName: 'NovaSpark Bot',
  uptime: Math.floor((Date.now() - state.startTime) / 1000),
  storage: useMongoDB ? 'mongodb' : 'file',
  activeBots: Object.keys(state.botProcesses).length + Object.keys(state.panelBotProcesses).length
}));

// =============================================================================
// NEW v8 FEATURES
// =============================================================================

// ── v8: Webhook Support ───────────────────────────────────────────────────────
// Admins can register webhooks. On bot events (start/stop/crash), the server
// sends a POST to each registered webhook URL.

const WEBHOOKS_FILE = path.join(DATA_DIR, 'webhooks.json');
function loadWebhooks() { try { return JSON.parse(fs.readFileSync(WEBHOOKS_FILE, 'utf8')); } catch { return []; } }
function saveWebhooks(wh) { fs.writeFileSync(WEBHOOKS_FILE, JSON.stringify(wh, null, 2)); }

async function fireWebhooks(event, payload) {
  const hooks = loadWebhooks();
  for (const hook of hooks) {
    try {
      await fetch(hook.url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-NovaSpark-Event': event, 'X-Webhook-Secret': hook.secret || '' },
        body: JSON.stringify({ event, ts: Date.now(), ...payload }),
      }).catch(() => {});
    } catch {}
  }
}

// GET /api/webhooks — list all webhooks
app.get('/api/webhooks', requireAdmin, (req, res) => {
  const hooks = loadWebhooks().map(h => ({ id: h.id, url: h.url, events: h.events, createdAt: h.createdAt }));
  res.json({ webhooks: hooks });
});

// POST /api/webhooks — register a webhook
app.post('/api/webhooks', requireAdmin, (req, res) => {
  const { url, events, secret } = req.body;
  if (!url) return res.status(400).json({ error: 'url required' });
  const hooks = loadWebhooks();
  const hook = { id: uuidv4(), url, events: events || ['bot.start','bot.stop','bot.crash'], secret: secret || '', createdAt: new Date().toISOString() };
  hooks.push(hook);
  saveWebhooks(hooks);
  log(`Webhook registered: ${url}`, 'ok');
  res.json({ success: true, hook: { id: hook.id, url: hook.url, events: hook.events } });
});

// DELETE /api/webhooks/:id — remove a webhook
app.delete('/api/webhooks/:id', requireAdmin, (req, res) => {
  const hooks = loadWebhooks().filter(h => h.id !== req.params.id);
  saveWebhooks(hooks);
  res.json({ success: true });
});

// POST /api/webhooks/:id/test — fire a test event
app.post('/api/webhooks/:id/test', requireAdmin, async (req, res) => {
  const hooks = loadWebhooks();
  const hook = hooks.find(h => h.id === req.params.id);
  if (!hook) return res.status(404).json({ error: 'Webhook not found' });
  try {
    await fetch(hook.url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-NovaSpark-Event': 'test', 'X-Webhook-Secret': hook.secret || '' },
      body: JSON.stringify({ event: 'test', ts: Date.now(), message: 'NovaSpark webhook test ⚡' }),
    });
    res.json({ success: true, message: 'Test webhook fired' });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── v8: Discord Webhook Alerts ────────────────────────────────────────────────
const DISCORD_WEBHOOK_URL = process.env.DISCORD_WEBHOOK_URL || '';

async function sendDiscordAlert(title, description, color = 0x3498db) {
  if (!DISCORD_WEBHOOK_URL) return;
  try {
    await fetch(DISCORD_WEBHOOK_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        embeds: [{
          title: `⚡ NovaSpark | ${title}`,
          description,
          color,
          timestamp: new Date().toISOString(),
          footer: { text: 'NovaSpark Bot Hosting v8.0' },
        }],
      }),
    }).catch(() => {});
  } catch {}
}

// GET /api/discord-alert — check if Discord alert is configured
app.get('/api/discord-alert', requireAdmin, (req, res) => {
  res.json({ configured: !!DISCORD_WEBHOOK_URL, url: DISCORD_WEBHOOK_URL ? '***configured***' : null });
});

// POST /api/discord-alert/test — send test Discord alert
app.post('/api/discord-alert/test', requireAdmin, async (req, res) => {
  if (!DISCORD_WEBHOOK_URL) return res.status(400).json({ error: 'DISCORD_WEBHOOK_URL env var not set' });
  await sendDiscordAlert('Test Alert', '✅ Discord alerts are working correctly!', 0x2ecc71);
  res.json({ success: true });
});

// ── v8: Bot Health Monitor + Auto-Restart ────────────────────────────────────
const BOT_HEALTH_FILE = path.join(DATA_DIR, 'bot-health.json');
function loadBotHealth() { try { return JSON.parse(fs.readFileSync(BOT_HEALTH_FILE, 'utf8')); } catch { return {}; } }
function saveBotHealth(h) { fs.writeFileSync(BOT_HEALTH_FILE, JSON.stringify(h, null, 2)); }

// Track crash counts per session
const crashCounts = {};
const AUTO_RESTART_THRESHOLD = parseInt(process.env.AUTO_RESTART_THRESHOLD || '3');
const AUTO_RESTART_ENABLED = process.env.AUTO_RESTART !== 'false';

// Patch startBotProcess to record health events (hook into existing process management)
function recordBotHealth(sessionId, event, detail = '') {
  const health = loadBotHealth();
  if (!health[sessionId]) health[sessionId] = { events: [], restarts: 0, crashes: 0 };
  health[sessionId].events.push({ event, detail, ts: Date.now() });
  if (health[sessionId].events.length > 100) health[sessionId].events = health[sessionId].events.slice(-100);
  if (event === 'crash') health[sessionId].crashes = (health[sessionId].crashes || 0) + 1;
  if (event === 'restart') health[sessionId].restarts = (health[sessionId].restarts || 0) + 1;
  health[sessionId].lastEvent = event;
  health[sessionId].lastSeen = Date.now();
  saveBotHealth(health);
}

// GET /api/health-monitor — full health overview of all bots
app.get('/api/health-monitor', requireAuth, (req, res) => {
  const health = loadBotHealth();
  const sessions = loadSessions();
  const userSessions = req.user.isAdmin ? sessions : sessions.filter(s => String(s.ownerId) === String(req.user.id));
  const result = userSessions.map(s => ({
    id: s.id,
    name: s.name || s.id,
    status: state.botProcesses[s.id] ? 'running' : 'stopped',
    health: health[s.id] || { events: [], crashes: 0, restarts: 0 },
  }));
  res.json({ bots: result });
});

// GET /api/health-monitor/:id — health for a specific bot
app.get('/api/health-monitor/:id', requireAuth, async (req, res) => {
  const sessions = loadSessions();
  const session = sessions.find(s => s.id === req.params.id);
  if (!session) return res.status(404).json({ error: 'Session not found' });
  if (!req.user.isAdmin && String(session.ownerId) !== String(req.user.id)) return res.status(403).json({ error: 'Forbidden' });
  const health = loadBotHealth();
  res.json({ id: req.params.id, status: state.botProcesses[req.params.id] ? 'running' : 'stopped', health: health[req.params.id] || {} });
});

// POST /api/health-monitor/:id/auto-restart — toggle auto-restart for a session
app.post('/api/health-monitor/:id/auto-restart', requireAuth, async (req, res) => {
  const { enabled } = req.body;
  const sessions = loadSessions();
  const session = sessions.find(s => s.id === req.params.id);
  if (!session) return res.status(404).json({ error: 'Not found' });
  session.autoRestart = !!enabled;
  saveSessions(sessions);
  res.json({ success: true, autoRestart: session.autoRestart });
});

// ── v8: Bot Uptime Graph Data ─────────────────────────────────────────────────
// Stores uptime snapshots every 5 minutes for 24-hour graph
const UPTIME_FILE = path.join(DATA_DIR, 'uptime-history.json');
function loadUptimeHistory() { try { return JSON.parse(fs.readFileSync(UPTIME_FILE, 'utf8')); } catch { return {}; } }
function saveUptimeHistory(h) { fs.writeFileSync(UPTIME_FILE, JSON.stringify(h, null, 2)); }

// Snapshot every 5 minutes
cron.schedule('*/5 * * * *', () => {
  const history = loadUptimeHistory();
  const sessions = loadSessions();
  const ts = Date.now();
  for (const s of sessions) {
    if (!history[s.id]) history[s.id] = [];
    history[s.id].push({ ts, up: !!state.botProcesses[s.id] });
    // Keep last 288 points (24 hours at 5-min intervals)
    if (history[s.id].length > 288) history[s.id] = history[s.id].slice(-288);
  }
  saveUptimeHistory(history);
});

// GET /api/sessions/:id/uptime-graph — 24hr uptime graph data
app.get('/api/sessions/:id/uptime-graph', requireAuth, async (req, res) => {
  const sessions = loadSessions();
  const session = sessions.find(s => s.id === req.params.id);
  if (!session) return res.status(404).json({ error: 'Not found' });
  if (!req.user.isAdmin && String(session.ownerId) !== String(req.user.id)) return res.status(403).json({ error: 'Forbidden' });
  const history = loadUptimeHistory();
  const data = history[req.params.id] || [];
  const uptimePct = data.length ? Math.round((data.filter(d => d.up).length / data.length) * 100) : 0;
  res.json({ sessionId: req.params.id, points: data, uptimePercent: uptimePct });
});

// ── v8: Scheduled Bot Restart ─────────────────────────────────────────────────
// POST /api/sessions/:id/schedule-restart — schedule a restart at a specific time/cron
const scheduledRestarts = new Map();

app.post('/api/sessions/:id/schedule-restart', requireAuth, async (req, res) => {
  const { cronExpr, reason } = req.body;
  if (!cronExpr) return res.status(400).json({ error: 'cronExpr required (e.g. "0 3 * * *" = 3am daily)' });
  const sessions = loadSessions();
  const session = sessions.find(s => s.id === req.params.id);
  if (!session) return res.status(404).json({ error: 'Session not found' });
  if (!req.user.isAdmin && String(session.ownerId) !== String(req.user.id)) return res.status(403).json({ error: 'Forbidden' });

  // Cancel existing scheduled restart
  if (scheduledRestarts.has(req.params.id)) {
    scheduledRestarts.get(req.params.id).destroy();
    scheduledRestarts.delete(req.params.id);
  }

  const task = cron.schedule(cronExpr, async () => {
    log(`Scheduled restart for session ${req.params.id} (${reason || 'no reason'})`, 'info');
    recordBotHealth(req.params.id, 'scheduled-restart', reason || 'cron');
    stopBotProcess(req.params.id);
    await new Promise(r => setTimeout(r, 2000));
    startBotProcess(req.params.id);
    await sendDiscordAlert('Scheduled Restart', `Session \`${req.params.id}\` was auto-restarted.\nReason: ${reason || 'Scheduled maintenance'}`, 0xf39c12);
  });
  scheduledRestarts.set(req.params.id, task);

  session.scheduledRestart = { cronExpr, reason, setAt: new Date().toISOString() };
  saveSessions(sessions);
  res.json({ success: true, cronExpr, message: `Restart scheduled: ${cronExpr}` });
});

// DELETE /api/sessions/:id/schedule-restart — cancel scheduled restart
app.delete('/api/sessions/:id/schedule-restart', requireAuth, async (req, res) => {
  if (scheduledRestarts.has(req.params.id)) {
    scheduledRestarts.get(req.params.id).destroy();
    scheduledRestarts.delete(req.params.id);
  }
  const sessions = loadSessions();
  const s = sessions.find(s => s.id === req.params.id);
  if (s) { delete s.scheduledRestart; saveSessions(sessions); }
  res.json({ success: true, message: 'Scheduled restart cancelled' });
});

// ── v8: Export Logs as CSV/TXT ────────────────────────────────────────────────

// GET /api/sessions/:id/logs/export?format=csv|txt — export session logs
app.get('/api/sessions/:id/logs/export', requireAuth, async (req, res) => {
  const sessions = loadSessions();
  const session = sessions.find(s => s.id === req.params.id);
  if (!session) return res.status(404).json({ error: 'Not found' });
  if (!req.user.isAdmin && String(session.ownerId) !== String(req.user.id)) return res.status(403).json({ error: 'Forbidden' });

  const format = (req.query.format || 'txt').toLowerCase();
  const logs = state.logBuffer.filter(l => !l.sessionId || l.sessionId === req.params.id);

  if (format === 'csv') {
    const csv = ['timestamp,level,message', ...logs.map(l =>
      `"${new Date(l.ts).toISOString()}","${l.level || 'info'}","${(l.message || '').replace(/"/g, '""')}"`
    )].join('\n');
    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', `attachment; filename="novaspark-logs-${req.params.id}-${Date.now()}.csv"`);
    return res.send(csv);
  } else {
    const txt = logs.map(l => `[${new Date(l.ts).toISOString()}] [${(l.level || 'INFO').toUpperCase()}] ${l.message || ''}`).join('\n');
    res.setHeader('Content-Type', 'text/plain');
    res.setHeader('Content-Disposition', `attachment; filename="novaspark-logs-${req.params.id}-${Date.now()}.txt"`);
    return res.send(txt);
  }
});

// GET /api/admin/logs/export?format=csv|txt — export ALL logs (admin)
app.get('/api/admin/logs/export', requireAdmin, (req, res) => {
  const format = (req.query.format || 'txt').toLowerCase();
  const logs = state.logBuffer;

  if (format === 'csv') {
    const csv = ['timestamp,level,sessionId,message', ...logs.map(l =>
      `"${new Date(l.ts).toISOString()}","${l.level || 'info'}","${l.sessionId || ''}","${(l.message || '').replace(/"/g, '""')}"`
    )].join('\n');
    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', `attachment; filename="novaspark-all-logs-${Date.now()}.csv"`);
    return res.send(csv);
  } else {
    const txt = logs.map(l => `[${new Date(l.ts).toISOString()}] [${(l.level||'INFO').toUpperCase()}] [${l.sessionId||'system'}] ${l.message||''}`).join('\n');
    res.setHeader('Content-Type', 'text/plain');
    res.setHeader('Content-Disposition', `attachment; filename="novaspark-all-logs-${Date.now()}.txt"`);
    return res.send(txt);
  }
});

// ── v8: API Rate Limit Dashboard ──────────────────────────────────────────────
const rateLimitStats = { auth: {}, api: {} };

// GET /api/admin/rate-limits — view rate limit hit statistics
app.get('/api/admin/rate-limits', requireAdmin, (req, res) => {
  const apiStats = {};
  // Summarize from auth attempts
  for (const [ip, data] of loginAttempts.entries()) {
    apiStats[ip] = { attempts: data.count, lockedUntil: data.lockedUntil || null };
  }
  res.json({
    loginLockouts: apiStats,
    rateLimitConfig: {
      auth: { max: 20, windowMs: '15min' },
      api: { max: 120, windowMs: '1min' },
    },
    totalLocked: Object.values(apiStats).filter(v => v.lockedUntil && v.lockedUntil > Date.now()).length,
  });
});

// POST /api/admin/rate-limits/unlock — unlock a specific IP
app.post('/api/admin/rate-limits/unlock', requireAdmin, (req, res) => {
  const { ip } = req.body;
  if (!ip) return res.status(400).json({ error: 'ip required' });
  loginAttempts.delete(ip);
  res.json({ success: true, message: `IP ${ip} unlocked` });
});

// POST /api/admin/rate-limits/clear — clear all lockouts
app.post('/api/admin/rate-limits/clear', requireAdmin, (req, res) => {
  loginAttempts.clear();
  res.json({ success: true, message: 'All lockouts cleared' });
});

// ── v8: Bot Comparison Dashboard ─────────────────────────────────────────────
// GET /api/admin/bot-comparison — compare all running bots side by side
app.get('/api/admin/bot-comparison', requireAdmin, async (req, res) => {
  const sessions = loadSessions();
  const health = loadBotHealth();
  const uptimeHistory = loadUptimeHistory();

  const comparison = sessions.map(s => {
    const h = health[s.id] || {};
    const uptimeData = uptimeHistory[s.id] || [];
    const uptimePct = uptimeData.length
      ? Math.round((uptimeData.filter(d => d.up).length / uptimeData.length) * 100)
      : (state.botProcesses[s.id] ? 100 : 0);

    return {
      id: s.id,
      name: s.name || s.id,
      status: state.botProcesses[s.id] ? 'running' : 'stopped',
      plan: s.plan || 'free',
      crashes: h.crashes || 0,
      restarts: h.restarts || 0,
      uptimePercent: uptimePct,
      autoRestart: s.autoRestart || false,
      scheduledRestart: s.scheduledRestart || null,
      createdAt: s.createdAt,
    };
  });
  res.json({ bots: comparison, total: comparison.length, running: comparison.filter(b => b.status === 'running').length });
});

// ── v8: System Resource Monitor ───────────────────────────────────────────────
app.get('/api/admin/system-resources', requireAdmin, async (req, res) => {
  try {
    const si = require('systeminformation');
    const [cpu, mem, disk, network] = await Promise.all([
      si.currentLoad().catch(() => null),
      si.mem().catch(() => null),
      si.fsSize().catch(() => []),
      si.networkStats().catch(() => []),
    ]);

    res.json({
      cpu: cpu ? { load: Math.round(cpu.currentLoad) } : null,
      memory: mem ? {
        total: mem.total,
        used: mem.used,
        free: mem.free,
        usedPercent: Math.round((mem.used / mem.total) * 100),
      } : null,
      disk: disk.length ? {
        total: disk[0].size,
        used: disk[0].used,
        usedPercent: Math.round(disk[0].use),
      } : null,
      network: network.length ? {
        rx_bytes: network[0].rx_bytes,
        tx_bytes: network[0].tx_bytes,
      } : null,
      activeBots: Object.keys(state.botProcesses).length,
      uptime: Math.floor((Date.now() - state.startTime) / 1000),
      nodeVersion: process.version,
      platform: process.platform,
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── v8: Session Tags / Notes ──────────────────────────────────────────────────
// Users can add tags and notes to their bot sessions for organization
app.put('/api/sessions/:id/tags', requireAuth, async (req, res) => {
  const { tags, notes } = req.body;
  const sessions = loadSessions();
  const session = sessions.find(s => s.id === req.params.id);
  if (!session) return res.status(404).json({ error: 'Not found' });
  if (!req.user.isAdmin && String(session.ownerId) !== String(req.user.id)) return res.status(403).json({ error: 'Forbidden' });
  if (tags !== undefined) session.tags = Array.isArray(tags) ? tags : [tags];
  if (notes !== undefined) session.notes = String(notes).slice(0, 500);
  saveSessions(sessions);
  res.json({ success: true, tags: session.tags, notes: session.notes });
});

// ── v8: Maintenance Window Announcer ─────────────────────────────────────────
app.post('/api/admin/maintenance', requireAdmin, async (req, res) => {
  const { message, durationMinutes, notify } = req.body;
  const msg = message || `🔧 NovaSpark is undergoing maintenance. Expected downtime: ${durationMinutes || 5} minutes.`;

  if (notify) {
    // Broadcast to all users via in-app notification
    const users = loadUsers();
    const notifs = loadNotifications ? loadNotifications() : [];
    for (const u of users) {
      notifs.push({ id: uuidv4(), userId: u.id, message: msg, type: 'maintenance', read: false, ts: Date.now() });
    }
    if (saveNotifications) saveNotifications(notifs);

    // Also send Discord alert
    await sendDiscordAlert('Maintenance Window', msg, 0xe74c3c);
  }

  res.json({ success: true, message: msg, duration: durationMinutes });
});

// ── v8: User 2FA (TOTP) ───────────────────────────────────────────────────────
// Simple email-code based 2FA (no external library needed)
const twoFACodes = new Map(); // userId -> { code, expiresAt }

function generate2FACode() {
  return Math.floor(100000 + Math.random() * 900000).toString();
}

// POST /api/auth/2fa/enable — request 2FA enable (sends code)
app.post('/api/auth/2fa/enable', requireAuth, async (req, res) => {
  const code = generate2FACode();
  twoFACodes.set(req.user.id, { code, expiresAt: Date.now() + 10 * 60 * 1000 }); // 10 min
  // In a real deployment, send code via email/WhatsApp
  // For now, return it in response (admin should set up email transport)
  log(`2FA code for ${req.user.username}: ${code}`, 'info');
  res.json({
    success: true,
    message: '2FA code generated. In production, this is sent to your registered email.',
    // Only return code if admin (for testing)
    code: req.user.isAdmin ? code : undefined,
    expiresIn: '10 minutes',
  });
});

// POST /api/auth/2fa/verify — verify 2FA code and enable
app.post('/api/auth/2fa/verify', requireAuth, async (req, res) => {
  const { code } = req.body;
  const stored = twoFACodes.get(req.user.id);
  if (!stored || stored.code !== code || Date.now() > stored.expiresAt) {
    return res.status(400).json({ error: 'Invalid or expired 2FA code' });
  }
  twoFACodes.delete(req.user.id);
  const users = loadUsers();
  const user = users.find(u => String(u.id) === String(req.user.id));
  if (user) { user.twoFAEnabled = true; saveUsers(users); }
  res.json({ success: true, message: '2FA enabled on your account' });
});

// POST /api/auth/2fa/disable — disable 2FA
app.post('/api/auth/2fa/disable', requireAuth, async (req, res) => {
  const users = loadUsers();
  const user = users.find(u => String(u.id) === String(req.user.id));
  if (user) { user.twoFAEnabled = false; saveUsers(users); }
  twoFACodes.delete(req.user.id);
  res.json({ success: true, message: '2FA disabled' });
});

// ── v8: Update version references ────────────────────────────────────────────
// Version is already 8.0.0 — no change needed

// =============================================================================
// END v8 FEATURES
// =============================================================================

// ─────────────────────────────────────────────────────────────────────────────
// SERVE HTML PAGES
// ─────────────────────────────────────────────────────────────────────────────
app.get('/login', (req, res) => res.sendFile(path.join(__dirname, 'public', 'login.html')));
app.get('/signup', (req, res) => res.sendFile(path.join(__dirname, 'public', 'signup.html')));
app.get('/terms', (req, res) => res.sendFile(path.join(__dirname, 'public', 'terms.html')));
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));
app.get('/panel-bots.html', (req, res) => res.sendFile(path.join(__dirname, 'public', 'panel-bots.html')));
app.get('/bot-features', (req, res) => res.sendFile(path.join(__dirname, 'public', 'bot-features.html')));
app.get('/bot-features.html', (req, res) => res.sendFile(path.join(__dirname, 'public', 'bot-features.html')));
app.get('/bank.html', (req, res) => res.sendFile(path.join(__dirname, 'public', 'bank.html')));
app.get('/bank', (req, res) => res.sendFile(path.join(__dirname, 'public', 'bank.html')));
// ── v8 new pages ─────────────────────────────────────────────────────────────
app.get('/health-monitor', (req, res) => res.sendFile(path.join(__dirname, 'public', 'health-monitor.html')));
app.get('/health-monitor.html', (req, res) => res.sendFile(path.join(__dirname, 'public', 'health-monitor.html')));
app.get('/webhooks', (req, res) => res.sendFile(path.join(__dirname, 'public', 'webhooks.html')));
app.get('/webhooks.html', (req, res) => res.sendFile(path.join(__dirname, 'public', 'webhooks.html')));
app.get('/system', (req, res) => res.sendFile(path.join(__dirname, 'public', 'system.html')));
app.get('/system.html', (req, res) => res.sendFile(path.join(__dirname, 'public', 'system.html')));

// ─────────────────────────────────────────────────────────────────────────────
// BOT PROCESS MANAGER
// ─────────────────────────────────────────────────────────────────────────────
async function setSessionStatus(sessionId, status) {
  try {
    if (useMongoDB) {
      await Session.findByIdAndUpdate(sessionId, { $set: { status } });
    } else {
      const sessions = loadSessions();
      const sess = sessions.find(s => s.id === sessionId);
      if (sess) {
        sess.status = status;
        saveSessions(sessions);
      }
    }
    broadcast({ type: 'status', sessionId, status });
  } catch {}
}

function startBotProcess(sess) {
  const sessionId = sess.id || sess._id?.toString();
  if (!sessionId) return;
  
  if (state.botProcesses[sessionId]) {
    log(`Bot "${sessionId}" is already running`, 'warn');
    return;
  }

  // Check if this session uses a panel bot
  if (sess.botId) {
    if (useMongoDB) {
      BotConfig.findById(sess.botId).then(botConfig => {
        if (botConfig) startPanelBotForSession(sess, botConfig);
      });
    } else {
      const configs = loadBotConfigs();
      const botConfig = configs.find(c => c.id === sess.botId);
      if (botConfig) startPanelBotForSession(sess, botConfig);
    }
    return;
  }

  // Default bot source
  const botDir = path.join(__dirname, 'bot-src');
  if (!fs.existsSync(botDir)) {
    log(`Bot source not found. Click "Install Bot" first.`, 'error');
    setSessionStatus(sessionId, 'crashed');
    return;
  }

  log(`Starting bot for session "${sessionId}" (${sess.ownerName})...`, 'info', sessionId);
  setSessionStatus(sessionId, 'starting');

  const env = {
    ...process.env,
    SESSION_ID: sess.sessionIdString,
    BOT_NAME: sess.botName || 'NovaSpark Bot',
    PREFIX: sess.prefix || '.',
    OWNER_NUMBER: sess.ownerNumber || '',
    TZ: sess.timezone || 'Africa/Harare'
  };

  const proc = spawn('node', ['index.js'], { cwd: botDir, env, stdio: ['ignore', 'pipe', 'pipe'] });
  state.botProcesses[sessionId] = proc;

  proc.stdout.on('data', d => log(d.toString().trim(), 'bot', sessionId));
  proc.stderr.on('data', d => log(d.toString().trim(), 'warn', sessionId));

  proc.on('spawn', () => setSessionStatus(sessionId, 'running'));

  proc.on('exit', (code) => {
    delete state.botProcesses[sessionId];
    const status = code === 0 ? 'stopped' : 'crashed';
    setSessionStatus(sessionId, status);
    log(`Bot "${sessionId}" exited with code ${code} → ${status}`, code === 0 ? 'warn' : 'error', sessionId);
  });
}

function startPanelBotForSession(sess, botConfig) {
  const sessionId = sess.id || sess._id?.toString();
  if (!sessionId) return;
  
  if (state.botProcesses[sessionId]) {
    log(`Bot "${sessionId}" is already running`, 'warn');
    return;
  }

  const botId = botConfig.id || botConfig._id?.toString();
  const botDir = path.join(UPLOADED_BOTS_DIR, botId);
  if (!fs.existsSync(botDir)) {
    log(`Panel bot directory not found for "${botConfig.name}"`, 'error');
    setSessionStatus(sessionId, 'crashed');
    return;
  }

  log(`Starting panel bot "${botConfig.name}" for session "${sessionId}"...`, 'info', sessionId);
  setSessionStatus(sessionId, 'starting');

  const env = {
    ...process.env,
    SESSION_ID: sess.sessionIdString,
    BOT_NAME: sess.botName || botConfig.name,
    PREFIX: sess.prefix || '.',
    OWNER_NUMBER: sess.ownerNumber || '',
    TZ: sess.timezone || 'Africa/Harare'
  };

  const proc = spawn('node', [botConfig.entryPoint || 'index.js'], { cwd: botDir, env, stdio: ['ignore', 'pipe', 'pipe'] });
  state.botProcesses[sessionId] = proc;

  proc.stdout.on('data', d => log(d.toString().trim(), 'bot', sessionId));
  proc.stderr.on('data', d => log(d.toString().trim(), 'warn', sessionId));

  proc.on('spawn', () => setSessionStatus(sessionId, 'running'));

  proc.on('exit', (code) => {
    delete state.botProcesses[sessionId];
    const status = code === 0 ? 'stopped' : 'crashed';
    setSessionStatus(sessionId, status);
    log(`Panel bot "${botConfig.name}" exited with code ${code} → ${status}`, code === 0 ? 'warn' : 'error', sessionId);
  });
}

function stopBotProcess(sessionId) {
  const proc = state.botProcesses[sessionId];
  if (proc) {
    proc.kill('SIGTERM');
    delete state.botProcesses[sessionId];
    setSessionStatus(sessionId, 'stopped');
    log(`Bot "${sessionId}" stopped`, 'warn', sessionId);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// PANEL BOT PROCESS MANAGER
// ─────────────────────────────────────────────────────────────────────────────
async function setPanelBotStatus(botId, status) {
  try {
    if (useMongoDB) {
      await BotConfig.findByIdAndUpdate(botId, { $set: { status } });
    } else {
      const configs = loadBotConfigs();
      const config = configs.find(c => c.id === botId);
      if (config) {
        config.status = status;
        saveBotConfigs(configs);
      }
    }
    broadcast({ type: 'panel-bot-status', botId, status });
  } catch {}
}

function startPanelBotProcess(config) {
  const botId = config.id || config._id?.toString();
  if (!botId) return;
  
  if (state.panelBotProcesses[botId]) {
    log(`Panel bot "${config.name}" is already running`, 'warn');
    return;
  }

  const botDir = path.join(UPLOADED_BOTS_DIR, botId);
  if (!fs.existsSync(botDir)) {
    log(`Panel bot directory not found for "${config.name}"`, 'error');
    setPanelBotStatus(botId, 'crashed');
    return;
  }

  log(`Starting panel bot "${config.name}"...`, 'info', botId);
  setPanelBotStatus(botId, 'starting');

  const env = {
    ...process.env,
    BOT_ID: botId,
    BOT_NAME: config.name
  };

  const proc = spawn('node', [config.entryPoint || 'index.js'], { cwd: botDir, env, stdio: ['ignore', 'pipe', 'pipe'] });
  state.panelBotProcesses[botId] = proc;

  proc.stdout.on('data', d => log(d.toString().trim(), 'bot', botId));
  proc.stderr.on('data', d => log(d.toString().trim(), 'warn', botId));

  proc.on('spawn', () => setPanelBotStatus(botId, 'running'));

  proc.on('exit', (code) => {
    delete state.panelBotProcesses[botId];
    const status = code === 0 ? 'stopped' : 'crashed';
    setPanelBotStatus(botId, status);
    log(`Panel bot "${config.name}" exited with code ${code} → ${status}`, code === 0 ? 'warn' : 'error', botId);
  });
}

function stopPanelBotProcess(botId) {
  const proc = state.panelBotProcesses[botId];
  if (proc) {
    proc.kill('SIGTERM');
    delete state.panelBotProcesses[botId];
    setPanelBotStatus(botId, 'stopped');
    log(`Panel bot "${botId}" stopped`, 'warn', botId);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// CLEANUP
// ─────────────────────────────────────────────────────────────────────────────
function runCleanup() {
  const tmpDir = '/tmp';
  let removed = 0, freedBytes = 0;
  try {
    const files = fs.readdirSync(tmpDir);
    const cutoff = Date.now() - 60 * 60 * 1000;
    for (const f of files) {
      const fp = path.join(tmpDir, f);
      try {
        const stat = fs.statSync(fp);
        if (stat.mtimeMs < cutoff) {
          freedBytes += stat.size;
          fs.rmSync(fp, { recursive: true, force: true });
          removed++;
        }
      } catch {}
    }
  } catch {}
  
  // Also cleanup expired deleted bots
  if (useMongoDB) {
    DeletedBot.deleteMany({ expiresAt: { $lt: new Date() } }).catch(() => {});
  }
  
  state.cleanCount++;
  const freedMB = (freedBytes / 1024 / 1024).toFixed(2);
  log(`Cleanup done: removed ${removed} files, freed ${freedMB} MB`, 'ok');
  broadcast({ type: 'cleanup', cleanCount: state.cleanCount, removed, freedMB, ts: Date.now() });
  return { removed, freedMB };
}

// ─────────────────────────────────────────────────────────────────────────────
// KEEP-ALIVE PING
// ─────────────────────────────────────────────────────────────────────────────
async function keepAlivePing() {
  if (!RENDER_URL) return;
  try {
    await fetch(`${RENDER_URL}/health`);
    state.pingCount++;
    log(`Keep-alive ping #${state.pingCount}`, 'info');
    broadcast({ type: 'ping', pingCount: state.pingCount, ts: Date.now() });
  } catch (err) {
    log(`Keep-alive ping failed: ${err.message}`, 'warn');
  }
}

setInterval(keepAlivePing, PING_INTERVAL_MS);

// ─────────────────────────────────────────────────────────────────────────────
// WEBSOCKET SERVER
// ─────────────────────────────────────────────────────────────────────────────
const wss = new WebSocket.Server({ server });
const clients = new Set();

function broadcast(data) {
  const msg = JSON.stringify(data);
  for (const ws of clients) {
    if (ws.readyState === WebSocket.OPEN) ws.send(msg);
  }
}

wss.on('connection', async (ws) => {
  clients.add(ws);

  // Send initial state
  let sessions = [], botConfigs = [];
  
  try {
    if (useMongoDB) {
      sessions = await Session.find();
      botConfigs = await BotConfig.find();
    } else {
      sessions = loadSessions();
      botConfigs = loadBotConfigs();
    }
  } catch {}

  ws.send(JSON.stringify({
    type: 'init',
    logs: logBuffer.slice(-150),
    sessions,
    panelBots: botConfigs,
    serverStatus: {
      uptime: Math.floor((Date.now() - state.startTime) / 1000),
      pingCount: state.pingCount,
      cleanCount: state.cleanCount,
      mem: process.memoryUsage(),
      version: '8.0.0'
    }
  }));

  ws.on('close', () => clients.delete(ws));
  ws.on('error', () => clients.delete(ws));
});

// ─────────────────────────────────────────────────────────────────────────────
// CRON JOBS
// ─────────────────────────────────────────────────────────────────────────────
cron.schedule('0 */6 * * *', runCleanup);

// Check for expired bot sessions every hour
cron.schedule('0 * * * *', async () => {
  const now = new Date();
  
  try {
    if (useMongoDB) {
      const expiredSessions = await Session.find({ 
        paidUntil: { $lt: now }, 
        status: 'running' 
      });
      
      for (const sess of expiredSessions) {
        stopBotProcess(sess._id.toString());
        log(`Session ${sess._id} stopped - paid time expired`, 'warn');
      }
      
      const expiredBots = await BotConfig.find({ 
        paidUntil: { $lt: now }, 
        status: 'running' 
      });
      
      for (const bot of expiredBots) {
        stopPanelBotProcess(bot._id.toString());
        log(`Panel bot ${bot._id} stopped - paid time expired`, 'warn');
      }
    } else {
      const sessions = loadSessions();
      for (const sess of sessions) {
        if (sess.status === 'running' && sess.paidUntil && new Date(sess.paidUntil) < now) {
          stopBotProcess(sess.id);
          log(`Session ${sess.id} stopped - paid time expired`, 'warn');
        }
      }
      
      const configs = loadBotConfigs();
      for (const config of configs) {
        if (config.status === 'running' && config.paidUntil && new Date(config.paidUntil) < now) {
          stopPanelBotProcess(config.id);
          log(`Panel bot ${config.id} stopped - paid time expired`, 'warn');
        }
      }
    }
  } catch (err) {
    log(`Error checking expired sessions: ${err.message}`, 'error');
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// START
// ─────────────────────────────────────────────────────────────────────────────
async function start() {
  await connectMongoDB();
  // Seed file-based admin only when MongoDB is NOT used
  if (!useMongoDB) ensureAdminExists();
  
  server.listen(PORT, () => {
    log(`NOVASPARK V7 — NovaSpark Bot Edition running on port ${PORT}`, 'ok');
    if (RENDER_URL) log(`Keep-alive targeting: ${RENDER_URL}`, 'info');
    else log(`Set RENDER_URL env var to enable keep-alive pings`, 'warn');
  });
}

start();

function gracefulShutdown(sig) {
  log(sig + ' received — shutting down bots gracefully...', 'warn');
  Object.keys(state.botProcesses).forEach(stopBotProcess);
  Object.keys(state.panelBotProcesses).forEach(stopPanelBotProcess);
  // Give processes 1.5s to clean up before hard exit
  setTimeout(() => {
    log('Shutdown complete.', 'ok');
    process.exit(0);
  }, 1500);
}
process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT',  () => gracefulShutdown('SIGINT'));
process.on('uncaughtException', (err) => {
  console.error('[UNCAUGHT]', err.message, err.stack);
  // Don't crash on non-fatal errors
});
process.on('unhandledRejection', (reason) => {
  console.error('[UNHANDLED REJECTION]', reason);
});
