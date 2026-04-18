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

// ─────────────────────────────────────────────────────────────────────────────
// CONFIG
// ─────────────────────────────────────────────────────────────────────────────
const PORT         = process.env.PORT || 3000;
const RENDER_URL   = process.env.RENDER_URL || '';
const JWT_SECRET   = process.env.JWT_SECRET || 'ladybugnodes-secret-change-me';
const MONGODB_URI  = process.env.MONGODB_URI || process.env.MONGO_URL || '';
const PING_INTERVAL_MS = 14 * 60 * 1000;  // 14 minutes

// Default admin credentials
const ADMIN_USERNAME = process.env.ADMIN_USERNAME || 'devntando';
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'ntando';

// Coin costs and rewards
const COIN_COST_START = 5;        // 5 coins to run bot for 2 days
const COIN_DAILY_REWARD = 2;      // 2 coins per day
const COIN_REFERRAL_REWARD = 5;   // 5 coins per referral
const VIP_SERVER_COST = 200;      // 200 coins for VIP server
const BOT_DURATION_DAYS = 2;      // Bot runs for 2 days
const LOG_VIEWING_MINUTES = 20;   // Users can see logs for 20 minutes

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

if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
if (!fs.existsSync(UPLOADED_BOTS_DIR)) fs.mkdirSync(UPLOADED_BOTS_DIR, { recursive: true });

// MongoDB Schemas
const userSchema = new mongoose.Schema({
  username: { type: String, required: true, unique: true },
  password: { type: String, required: true },
  role: { type: String, enum: ['admin', 'user'], default: 'user' },
  coins: { type: Number, default: 50 },
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
  botName: { type: String, default: 'LadybugBot' },
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
  coins: { type: Number, default: 5 },
  durationDays: { type: Number, default: BOT_DURATION_DAYS },
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
      coins: 999999999,
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
      coins: 999999999999999,
      referralCode: uuidv4().slice(0, 8).toUpperCase(),
      referralCount: 0,
      hasVIPAccess: true,
      createdAt: new Date().toISOString()
    });
    saveUsers(users);
    console.log(`[OK] Admin user "${ADMIN_USERNAME}" created.`);
  }
}

ensureAdminExists();

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

app.use(express.json());
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
      let initialCoins = 50;
      
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
      let initialCoins = 50;
      
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

  try {
    if (useMongoDB) {
      const user = await User.findOne({ username });
      if (!user || !(await bcrypt.compare(password, user.password))) {
        return res.status(401).json({ error: 'Invalid credentials' });
      }

      const token = jwt.sign({ id: user._id, username: user.username, role: user.role }, JWT_SECRET, { expiresIn: '7d' });
      log(`User "${username}" logged in`, 'ok');
      
      return res.json({ 
        ok: true, 
        token, 
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
      const user = users.find(u => u.username === username);
      if (!user || !bcrypt.compareSync(password, user.password)) {
        return res.status(401).json({ error: 'Invalid credentials' });
      }

      const token = jwt.sign({ id: user.id, username: user.username, role: user.role }, JWT_SECRET, { expiresIn: '7d' });
      log(`User "${username}" logged in`, 'ok');
      
      return res.json({ 
        ok: true, 
        token, 
        user: { 
          id: user.id, 
          username: user.username, 
          role: user.role, 
          coins: user.coins,
          referralCode: user.referralCode,
          hasVIPAccess: user.hasVIPAccess
        } 
      });
    }
  } catch (err) {
    log(`Login error: ${err.message}`, 'error');
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
  const { coins = 5, durationDays = BOT_DURATION_DAYS } = req.body || {};
  
  try {
    const code = uuidv4().slice(0, 12).toUpperCase();
    
    if (useMongoDB) {
      await RedemptionCode.create({
        code,
        coins: Number(coins),
        durationDays: Number(durationDays),
        createdBy: req.user.id
      });
    } else {
      const codes = loadRedemptionCodes();
      codes.push({
        id: uuidv4(),
        code,
        coins: Number(coins),
        durationDays: Number(durationDays),
        createdBy: req.user.id,
        usedBy: null,
        usedAt: null,
        createdAt: new Date().toISOString()
      });
      saveRedemptionCodes(codes);
    }
    
    log(`Admin created redemption code "${code}" worth ${coins} coins`, 'ok');
    return res.json({ ok: true, code, coins, durationDays });
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
      
      user.coins += redemptionCode.coins;
      await user.save();
      
      redemptionCode.usedBy = req.user.id;
      redemptionCode.usedAt = new Date();
      await redemptionCode.save();
      
      broadcast({ type: 'coins-updated', userId: user._id, coins: user.coins });
      log(`User "${user.username}" redeemed code "${code}" for ${redemptionCode.coins} coins`, 'ok');
      
      return res.json({ ok: true, coins: user.coins, rewarded: redemptionCode.coins });
    } else {
      const codes = loadRedemptionCodes();
      const redemptionCode = codes.find(c => c.code === code);
      if (!redemptionCode) return res.status(404).json({ error: 'Invalid code' });
      if (redemptionCode.usedBy) return res.status(400).json({ error: 'Code already used' });
      
      const users = loadUsers();
      const user = users.find(u => u.id === req.user.id);
      if (!user) return res.status(404).json({ error: 'User not found' });
      
      user.coins = (user.coins || 0) + redemptionCode.coins;
      saveUsers(users);
      
      redemptionCode.usedBy = req.user.id;
      redemptionCode.usedAt = new Date().toISOString();
      saveRedemptionCodes(codes);
      
      broadcast({ type: 'coins-updated', userId: user.id, coins: user.coins });
      log(`User "${user.username}" redeemed code "${code}" for ${redemptionCode.coins} coins`, 'ok');
      
      return res.json({ ok: true, coins: user.coins, rewarded: redemptionCode.coins });
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
  const { coins, role, hasVIPAccess } = req.body || {};
  
  try {
    if (useMongoDB) {
      const user = await User.findById(req.params.id);
      if (!user) return res.status(404).json({ error: 'User not found' });
      
      if (coins !== undefined) user.coins = coins;
      if (role !== undefined) user.role = role;
      if (hasVIPAccess !== undefined) user.hasVIPAccess = hasVIPAccess;
      
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
      return res.json(sessions.filter(s => s.ownerId === req.user.id));
    }
  } catch {
    return res.json([]);
  }
});

app.post('/api/sessions', requireAuth, async (req, res) => {
  const { ownerName, ownerNumber, sessionIdString, botName, prefix, timezone, botId, serverTier } = req.body || {};
  if (!ownerName || !sessionIdString) return res.status(400).json({ error: 'ownerName and sessionIdString required' });

  try {
    const sessionData = {
      ownerId: req.user.id,
      ownerName,
      ownerNumber: ownerNumber || '',
      sessionIdString,
      botName: botName || 'LadybugBot',
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
      if (req.user.role !== 'admin' && session.ownerId !== req.user.id) {
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
      if (req.user.role !== 'admin' && session.ownerId !== req.user.id) {
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
      if (req.user.role !== 'admin' && sess.ownerId !== req.user.id) {
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
      return res.json(bots.filter(b => b.ownerId === req.user.id));
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
      if (req.user.role !== 'admin' && deletedBot.ownerId !== req.user.id) {
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
      if (req.user.role !== 'admin' && deletedBot.ownerId !== req.user.id) {
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
      return res.json(configs.filter(c => c.ownerId === req.user.id));
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
      if (req.user.role !== 'admin' && config.ownerId !== req.user.id) {
        return res.status(403).json({ error: 'Forbidden' });
      }
      return res.json(config);
    } else {
      const configs = loadBotConfigs();
      const config = configs.find(c => c.id === req.params.botId);
      if (!config) return res.status(404).json({ error: 'Bot not found' });
      if (req.user.role !== 'admin' && config.ownerId !== req.user.id) {
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
      if (req.user.role !== 'admin' && config.ownerId !== req.user.id) {
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
      if (req.user.role !== 'admin' && config.ownerId !== req.user.id) {
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
      if (req.user.role !== 'admin' && config.ownerId !== req.user.id) {
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
    if (req.user.role !== 'admin' && config.ownerId !== req.user.id) {
      return res.status(403).json({ error: 'Forbidden' });
    }

    // Coin check (skip for admin or VIP)
    if (req.user.role !== 'admin') {
      let user;
      if (useMongoDB) {
        user = await User.findById(req.user.id);
      } else {
        const users = loadUsers();
        user = users.find(u => u.id === req.user.id);
      }
      
      if (!user || user.coins < COIN_COST_START) {
        return res.status(402).json({ error: `Not enough coins. Starting a bot costs ${COIN_COST_START} coins for ${BOT_DURATION_DAYS} days.` });
      }
      
      // Deduct coins and set paid duration
      user.coins -= COIN_COST_START;
      const paidUntil = new Date(Date.now() + BOT_DURATION_DAYS * 24 * 60 * 60 * 1000);
      
      if (useMongoDB) {
        await User.findByIdAndUpdate(user._id, { $set: { coins: user.coins } });
        await BotConfig.findByIdAndUpdate(config._id, { $set: { paidUntil, startTime: new Date() } });
      } else {
        const users = loadUsers();
        const userIndex = users.findIndex(u => u.id === user.id);
        if (userIndex >= 0) {
          users[userIndex].coins = user.coins;
          saveUsers(users);
        }
        const configs = loadBotConfigs();
        const configIndex = configs.findIndex(c => c.id === config.id);
        if (configIndex >= 0) {
          configs[configIndex].paidUntil = paidUntil.toISOString();
          configs[configIndex].startTime = new Date().toISOString();
          saveBotConfigs(configs);
          config = configs[configIndex];
        }
      }
      
      broadcast({ type: 'coins-updated', userId: user.id, coins: user.coins });
      log(`${COIN_COST_START} coins deducted from "${user.username}" for bot start (running for ${BOT_DURATION_DAYS} days)`, 'warn');
    }

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
    if (req.user.role !== 'admin' && config.ownerId !== req.user.id) {
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
    if (req.user.role !== 'admin' && config.ownerId !== req.user.id) {
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
    if (req.user.role !== 'admin' && config.ownerId !== req.user.id) {
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
    if (req.user.role !== 'admin' && sess.ownerId !== req.user.id) {
      return res.status(403).json({ error: 'Forbidden' });
    }

    // Coin check (skip for admin or VIP)
    if (req.user.role !== 'admin' && !sess.serverTier !== 'vip') {
      let user;
      if (useMongoDB) {
        user = await User.findById(req.user.id);
      } else {
        const users = loadUsers();
        user = users.find(u => u.id === req.user.id);
      }
      
      if (!user || user.coins < COIN_COST_START) {
        return res.status(402).json({ error: `Not enough coins. Starting a bot costs ${COIN_COST_START} coins for ${BOT_DURATION_DAYS} days.` });
      }
      
      // Deduct coins and set paid duration
      user.coins -= COIN_COST_START;
      const paidUntil = new Date(Date.now() + BOT_DURATION_DAYS * 24 * 60 * 60 * 1000);
      
      if (useMongoDB) {
        await User.findByIdAndUpdate(user._id, { $set: { coins: user.coins } });
        await Session.findByIdAndUpdate(sess._id, { $set: { paidUntil, startTime: new Date() } });
      } else {
        const users = loadUsers();
        const userIndex = users.findIndex(u => u.id === user.id);
        if (userIndex >= 0) {
          users[userIndex].coins = user.coins;
          saveUsers(users);
        }
        const sessions = loadSessions();
        const sessIndex = sessions.findIndex(s => s.id === sess.id);
        if (sessIndex >= 0) {
          sessions[sessIndex].paidUntil = paidUntil.toISOString();
          sessions[sessIndex].startTime = new Date().toISOString();
          saveSessions(sessions);
          sess = sessions[sessIndex];
        }
      }
      
      broadcast({ type: 'coins-updated', userId: user.id, coins: user.coins });
      log(`${COIN_COST_START} coins deducted from "${user.username}" for bot start (running for ${BOT_DURATION_DAYS} days)`, 'warn');
    }

    startBotProcess(sess);
    return res.json({ ok: true });
  } catch (err) {
    log(`Bot start error: ${err.message}`, 'error');
    return res.status(500).json({ error: 'Internal server error' });
  }
});

app.post('/api/bot/stop', requireAuth, async (req, res) => {
  const { sessionId } = req.body || {};
  
  try {
    let sess;
    if (useMongoDB) {
      sess = await Session.findById(sessionId);
    } else {
      const sessions = loadSessions();
      sess = sessions.find(s => s.id === sessionId);
    }
    
    if (!sess) return res.status(404).json({ error: 'Session not found' });
    if (req.user.role !== 'admin' && sess.ownerId !== req.user.id) {
      return res.status(403).json({ error: 'Forbidden' });
    }

    stopBotProcess(sessionId);
    return res.json({ ok: true });
  } catch {
    return res.status(500).json({ error: 'Internal server error' });
  }
});

app.post('/api/bot/restart', requireAuth, async (req, res) => {
  const { sessionId } = req.body || {};
  
  try {
    let sess;
    if (useMongoDB) {
      sess = await Session.findById(sessionId);
    } else {
      const sessions = loadSessions();
      sess = sessions.find(s => s.id === sessionId);
    }
    
    if (!sess) return res.status(404).json({ error: 'Session not found' });
    if (req.user.role !== 'admin' && sess.ownerId !== req.user.id) {
      return res.status(403).json({ error: 'Forbidden' });
    }

    stopBotProcess(sessionId);
    setTimeout(() => startBotProcess(sess), 1500);
    return res.json({ ok: true });
  } catch {
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
    execSync('git clone --depth 1 https://github.com/dev-modder/Ladybug-Mini.git bot-src 2>&1 || (cd bot-src && git pull)', {
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
    version: '5.0.0'
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
      totalSessions  = req.user.role === 'admin' ? sessions.length : sessions.filter(s => s.ownerId === req.user.id).length;
      totalPanelBots = req.user.role === 'admin' ? configs.length : configs.filter(c => c.ownerId === req.user.id).length;
    }

    activeBots = Object.keys(state.botProcesses).length + Object.keys(state.panelBotProcesses).length;

    const mem = process.memoryUsage();
    const uptimeSecs = Math.floor((Date.now() - state.startTime) / 1000);

    res.json({
      version: '5.0.0',
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
    version: '5.0.0',
    categories: [
      {
        name: 'General',
        icon: '🌐',
        commands: [
          { cmd: '.menu', desc: 'Show full command list with categories' },
          { cmd: '.ping', desc: 'Check bot response time & uptime' },
          { cmd: '.info', desc: 'Bot info: version, owner, prefix' },
          { cmd: '.alive', desc: 'Confirm the bot is online' },
          { cmd: '.runtime', desc: 'Show how long the bot has been running' }
        ]
      },
      {
        name: 'Media & Downloads',
        icon: '📥',
        commands: [
          { cmd: '.ytmp3 <url>', desc: 'Download YouTube audio as MP3' },
          { cmd: '.ytmp4 <url>', desc: 'Download YouTube video as MP4' },
          { cmd: '.tiktok <url>', desc: 'Download TikTok video (no watermark)' },
          { cmd: '.instagram <url>', desc: 'Download Instagram Reels/Posts' },
          { cmd: '.sticker', desc: 'Convert image/video to WhatsApp sticker' },
          { cmd: '.toimg', desc: 'Convert sticker back to image' }
        ]
      },
      {
        name: 'AI & Tools',
        icon: '🤖',
        commands: [
          { cmd: '.ai <prompt>', desc: 'Chat with an AI assistant' },
          { cmd: '.gpt <prompt>', desc: 'GPT-powered text generation' },
          { cmd: '.img <prompt>', desc: 'AI image generation' },
          { cmd: '.translate <lang> <text>', desc: 'Translate text to any language' },
          { cmd: '.weather <city>', desc: 'Get current weather for any city' }
        ]
      },
      {
        name: 'Group Management',
        icon: '👥',
        commands: [
          { cmd: '.kick @user', desc: 'Remove a user from the group' },
          { cmd: '.promote @user', desc: 'Promote user to group admin' },
          { cmd: '.demote @user', desc: 'Remove admin from a user' },
          { cmd: '.mute', desc: 'Mute the group (admins only can send)' },
          { cmd: '.unmute', desc: 'Unmute the group for everyone' },
          { cmd: '.add <number>', desc: 'Add a new member to the group' },
          { cmd: '.groupinfo', desc: 'Show group info and stats' },
          { cmd: '.setdesc <text>', desc: 'Change the group description' },
          { cmd: '.setname <text>', desc: 'Rename the group' },
          { cmd: '.antilink on/off', desc: 'Auto-remove messages containing links' },
          { cmd: '.antispam on/off', desc: 'Auto-remove spam messages' }
        ]
      },
      {
        name: 'Fun & Games',
        icon: '🎮',
        commands: [
          { cmd: '.joke', desc: 'Get a random joke' },
          { cmd: '.meme', desc: 'Fetch a random meme image' },
          { cmd: '.quote', desc: 'Get an inspiring quote' },
          { cmd: '.trivia', desc: 'Start a trivia quiz' },
          { cmd: '.truth', desc: 'Truth or dare — truth question' },
          { cmd: '.dare', desc: 'Truth or dare — dare challenge' },
          { cmd: '.8ball <question>', desc: 'Ask the magic 8-ball' }
        ]
      },
      {
        name: 'Owner / Admin',
        icon: '👑',
        commands: [
          { cmd: '.broadcast <msg>', desc: 'Broadcast message to all groups' },
          { cmd: '.setprefix <char>', desc: 'Change bot command prefix' },
          { cmd: '.block @user', desc: 'Block a contact' },
          { cmd: '.unblock @user', desc: 'Unblock a contact' },
          { cmd: '.restart', desc: 'Restart the bot process' },
          { cmd: '.clearlog', desc: 'Clear bot activity logs' }
        ]
      }
    ]
  });
});

app.get('/health', (req, res) => res.json({ status: 'ok', ts: Date.now(), version: '5.0.0' }));

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
    BOT_NAME: sess.botName || 'LadybugBot',
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
      version: '5.0.0'
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
  
  server.listen(PORT, () => {
    log(`LADYBUGNODES V5 running on port ${PORT}`, 'ok');
    if (RENDER_URL) log(`Keep-alive targeting: ${RENDER_URL}`, 'info');
    else log(`Set RENDER_URL env var to enable keep-alive pings`, 'warn');
  });
}

start();

process.on('SIGTERM', () => {
  log('SIGTERM received — shutting down bots...', 'warn');
  Object.keys(state.botProcesses).forEach(stopBotProcess);
  Object.keys(state.panelBotProcesses).forEach(stopPanelBotProcess);
  process.exit(0);
});
