# LADYBUGNODES V5 Implementation Plan

## Phase 1: Database & Backend Setup
- [x] Add MongoDB connection and models
- [x] Create User model with coins, referral, VIP fields
- [x] Create Session/Bot models for MongoDB
- [x] Create RedemptionCode model for admin-created codes
- [x] Create DeletedBot model for recovery

## Phase 2: Authentication System
- [x] Add free sign-up endpoint (open registration)
- [x] Add login endpoint
- [x] Add referral system (5 coins per referral)
- [x] Add daily coin reward (2 coins per day)

## Phase 3: Coin System Enhancement
- [x] Implement 5 coins to run bot for 2 days
- [x] Add coin deduction with duration tracking
- [x] Add referral tracking and rewards
- [x] Add daily reward claim system

## Phase 4: Server Tiers
- [x] Add VIP server tier (200 coins)
- [x] Add Basic server tier (default)
- [x] Add server tier field to sessions
- [x] Implement tier-based features

## Phase 5: Admin Features
- [x] Admin can access all servers
- [x] Admin can create redemption codes
- [x] Codes can be used by users to run bots
- [x] Admin panel for code management
- [x] Admin can create users (POST /api/users)
- [x] Admin can update users (PUT /api/users/:id)

## Phase 6: Bot Logs & Recovery
- [x] Limit user bot logs to first 20 minutes
- [x] Store deleted bots for recovery
- [x] Add bot recovery endpoint
- [x] Admin can see full logs

## Phase 7: Frontend Updates
- [x] Update dashboard to V5 (public/index.html)
- [x] Add sign-up page (public/signup.html)
- [x] Add referral system UI
- [x] Add daily reward button
- [x] Add VIP server purchase UI
- [x] Add redemption code input
- [x] Add bot recovery section
- [x] Create public/panel-bots.html for V5
- [x] Add footer with terms link to all pages

## Phase 8: Deployment
- [x] Update package.json with mongoose
- [x] Update render.yaml for MongoDB env
- [x] Fix server initialization order issue
- [x] Test server startup locally

## Phase 9: Bug Fixes (Session 2)
- [x] Fix MongoDB duplicate key error (whatsappNumber index)
- [x] Fix session ID not being passed correctly (_id vs id)
- [x] Add sparse index handling for MongoDB
- [x] Fix admin user creation endpoint
- [x] Add terms and conditions page

## Completed Features Summary
✅ Free Sign Up & Login
✅ Coin System (2 daily, 5 to run bot, 5 referral bonus)
✅ VIP Server (200 coins)
✅ Basic Server tier
✅ Admin access to all servers
✅ Redemption codes
✅ 20-minute log limit for users
✅ Bot recovery (7 days)
✅ MongoDB integration
✅ Terms & Conditions page
✅ Admin user management (create/update/delete)