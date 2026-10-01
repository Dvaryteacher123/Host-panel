/**
 * =====================================================
 *  ROUTES: api
 *  Public API for status / health / stats
 *  GET  /api/health
 *  GET  /api/stats
 *  GET  /api/bot/info
 *  GET  /api/commands
 *  GET  /api/version
 * =====================================================
 */

'use strict';

const express = require('express');
const router = express.Router();
const os = require('os');

const config = require('../config/config');
const logger = require('../utils/logger');
const database = require('../database/database');
const Session = require('../database/models/Session');
const User = require('../database/models/User');

// =====================================================
//  HEALTH
// =====================================================
router.get('/health', (req, res) => {
  const dbState = database.getState();
  const dbOk = database.isReady();

  const status = dbOk ? 'healthy' : 'degraded';

  return res.status(dbOk ? 200 : 503).json({
    success: dbOk,
    status,
    timestamp: new Date().toISOString(),
    uptime: process.uptime(),
    database: {
      state: dbState,
      ok: dbOk
    }
  });
});

// =====================================================
//  STATS
// =====================================================
router.get('/stats', async (req, res) => {
  try {
    const botManager = req.app.get('botManager');

    const dbSessions = await Session.countDocuments({ isActive: true }).catch(() => 0);
    const dbConnected = await Session.countDocuments({ isActive: true, status: 'connected' }).catch(() => 0);
    const users = await User.countDocuments({ isActive: true }).catch(() => 0);

    const memSessions = botManager?.getSessionCount?.() ?? 0;

    return res.json({
      success: true,
      stats: {
        sessionsInDb: dbSessions,
        sessionsConnected: dbConnected,
        sessionsInMemory: memSessions,
        users,
        uptime: process.uptime(),
        memory: {
          rss: process.memoryUsage().rss,
          heapUsed: process.memoryUsage().heapUsed,
          heapTotal: process.memoryUsage().heapTotal
        },
        system: {
          platform: os.platform(),
          arch: os.arch(),
          cpus: os.cpus()?.length || 0,
          totalMem: os.totalmem(),
          freeMem: os.freemem(),
          loadavg: os.loadavg()
        }
      }
    });
  } catch (err) {
    logger.error(`[api/stats] ${err.message}`);
    return res.status(500).json({ success: false, message: err.message });
  }
});

// =====================================================
//  BOT INFO
// =====================================================
router.get('/bot/info', (req, res) => {
  return res.json({
    success: true,
    bot: {
      name: config.bot.name,
      version: config.bot.version,
      owner: config.bot.owner,
      mode: config.bot.mode,
      prefix: config.bot.defaultPrefix,
      timezone: config.bot.timezone,
      footer: config.bot.footer
    },
    env: config.env,
    multiUser: config.multiUser.enabled
  });
});

// =====================================================
//  COMMANDS
// =====================================================
router.get('/commands', (req, res) => {
  try {
    const { listCommands, loadCommands } = require('../bot/handler');
    loadCommands();
    const commands = listCommands();

    return res.json({
      success: true,
      total: commands.length,
      commands
    });
  } catch (err) {
    logger.error(`[api/commands] ${err.message}`);
    return res.status(500).json({ success: false, message: err.message });
  }
});

// =====================================================
//  VERSION
// =====================================================
router.get('/version', (req, res) => {
  return res.json({
    success: true,
    name: config.bot.name,
    version: config.bot.version,
    node: process.version,
    env: config.env
  });
});

module.exports = router;
