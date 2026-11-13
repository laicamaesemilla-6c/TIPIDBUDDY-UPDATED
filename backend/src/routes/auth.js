const crypto = require('crypto');
const express = require('express');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const nodemailer = require('nodemailer');
const Account = require('../models/Account');

const router = express.Router();
const requestLog = new Map();
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const PASSWORD_MIN_LENGTH = 8;

const rateLimit = (keyPrefix, maximum, windowMs) => (req, res, next) => {
  const now = Date.now();
  const key = `${keyPrefix}:${req.ip}`;
  const recent = (requestLog.get(key) || []).filter((timestamp) => now - timestamp < windowMs);
  if (recent.length >= maximum) {
    return res.status(429).json({ success: false, message: 'Too many requests. Please try again later.' });
  }
  recent.push(now);
  requestLog.set(key, recent);
  next();
};

const normalizeEmail = (email) =>
  typeof email === 'string' ? email.trim().toLowerCase() : '';

const validateCredentials = (email, password) => {
  if (!EMAIL_PATTERN.test(email) || email.length > 254) {
    return 'Enter a valid email address.';
  }
  if (typeof password !== 'string' || password.length < PASSWORD_MIN_LENGTH || password.length > 128) {
    return `Password must be between ${PASSWORD_MIN_LENGTH} and 128 characters.`;
  }
  return null;
};

const hashPassword = (password) =>
  bcrypt.hash(crypto.createHash('sha256').update(password, 'utf8').digest('hex'), 12);

const verifyPassword = (password, passwordHash) =>
  bcrypt.compare(crypto.createHash('sha256').update(password, 'utf8').digest('hex'), passwordHash);

const getJwtSecret = () => {
  const secret = process.env.AUTH_JWT_SECRET;
  if (!secret || secret.length < 32) {
    const error = new Error('Authentication is not configured. Set AUTH_JWT_SECRET to a random secret of at least 32 characters.');
    error.status = 503;
    throw error;
  }
  return secret;
};

const createSession = (account) => ({
  token: jwt.sign(
    { sub: String(account._id), ver: account.tokenVersion },
    getJwtSecret(),
    { expiresIn: '30d', issuer: 'tipidbuddy-api', audience: 'tipidbuddy-app' }
  ),
  user: { email: account.email },
});

const handleAuthError = (res, error, context) => {
  if (error.status) {
    return res.status(error.status).json({ success: false, message: error.message });
  }
  if (error.code === 11000) {
    return res.status(409).json({ success: false, message: 'An account with this email already exists.' });
  }
  console.error(`[Auth] ${context} failed:`, error.message);
  return res.status(500).json({ success: false, message: 'Authentication could not be completed. Please try again.' });
};

router.post('/register', rateLimit('register', 8, 15 * 60 * 1000), async (req, res) => {
  const email = normalizeEmail(req.body?.email);
  const password = req.body?.password;
  const validationError = validateCredentials(email, password);
  if (validationError) return res.status(400).json({ success: false, message: validationError });

  try {
    getJwtSecret();
    const passwordHash = await hashPassword(password);
    const account = await Account.create({ email, passwordHash });
    res.status(201).json({ success: true, ...createSession(account) });
  } catch (error) {
    handleAuthError(res, error, 'registration');
  }
});

router.post('/login', rateLimit('login', 12, 15 * 60 * 1000), async (req, res) => {
  const email = normalizeEmail(req.body?.email);
  const password = req.body?.password;
  if (!EMAIL_PATTERN.test(email) || typeof password !== 'string' || !password) {
    return res.status(400).json({ success: false, message: 'Enter a valid email and password.' });
  }

  try {
    getJwtSecret();
    const account = await Account.findOne({ email }).select('+passwordHash');
    const matches = account?.passwordHash && await verifyPassword(password, account.passwordHash);
    if (!matches) {
      return res.status(401).json({ success: false, message: 'Invalid email or password.' });
    }
    res.json({ success: true, ...createSession(account) });
  } catch (error) {
    handleAuthError(res, error, 'login');
  }
});

const requireSession = async (req, res, next) => {
  const match = /^Bearer (.+)$/.exec(req.get('authorization') || '');
  if (!match) return res.status(401).json({ success: false, message: 'Sign in to continue.' });

  try {
    const claims = jwt.verify(match[1], getJwtSecret(), {
      issuer: 'tipidbuddy-api',
      audience: 'tipidbuddy-app',
    });
    const account = await Account.findById(claims.sub);
    if (!account || account.tokenVersion !== claims.ver) {
      return res.status(401).json({ success: false, message: 'Your session has expired. Please sign in again.' });
    }
    req.account = account;
    next();
  } catch (error) {
    if (error.status) return handleAuthError(res, error, 'session validation');
    return res.status(401).json({ success: false, message: 'Your session has expired. Please sign in again.' });
  }
};

router.get('/me', requireSession, (req, res) => {
  res.json({ success: true, user: { email: req.account.email } });
});

router.post('/logout', requireSession, async (req, res) => {
  try {
    req.account.tokenVersion += 1;
    await req.account.save();
    res.json({ success: true });
  } catch (error) {
    handleAuthError(res, error, 'logout');
  }
});

router.post('/password-reset/request', rateLimit('password-reset', 3, 60 * 60 * 1000), async (req, res) => {
  const email = normalizeEmail(req.body?.email);
  if (!EMAIL_PATTERN.test(email)) {
    return res.status(400).json({ success: false, message: 'Enter a valid email address.' });
  }

  const { SMTP_HOST, SMTP_USER, SMTP_PASS, SMTP_FROM } = process.env;
  if (!SMTP_HOST || !SMTP_USER || !SMTP_PASS || !SMTP_FROM) {
    return res.status(503).json({
      success: false,
      message: 'Password reset email is not configured. Set SMTP_HOST, SMTP_USER, SMTP_PASS, and SMTP_FROM on the backend.',
    });
  }

  try {
    const account = await Account.findOne({ email }).select(
      '+passwordHash +passwordResetTokenHash +passwordResetExpiresAt'
    );
    if (account?.passwordHash) {
      const token = crypto.randomBytes(32).toString('hex');
      account.passwordResetTokenHash = crypto.createHash('sha256').update(token).digest('hex');
      account.passwordResetExpiresAt = new Date(Date.now() + 30 * 60 * 1000);
      await account.save();

      const resetBase = process.env.PASSWORD_RESET_URL || 'tipidbuddy://reset-password';
      const separator = resetBase.includes('?') ? '&' : '?';
      const resetUrl = `${resetBase}${separator}token=${encodeURIComponent(token)}`;
      const port = Number(process.env.SMTP_PORT) || 587;
      const transporter = nodemailer.createTransport({
        host: SMTP_HOST,
        port,
        secure: process.env.SMTP_SECURE === 'true' || port === 465,
        auth: { user: SMTP_USER, pass: SMTP_PASS },
      });
      await transporter.sendMail({
        from: SMTP_FROM,
        to: email,
        subject: 'Reset your TipidBuddy password',
        text: `Use this link within 30 minutes to reset your TipidBuddy password:\n\n${resetUrl}`,
      });
    }

    res.json({
      success: true,
      message: 'If an account exists for that email, a password reset link has been sent.',
    });
  } catch (error) {
    console.error('[Auth] Password reset email could not be sent:', error.message);
    res.status(502).json({
      success: false,
      message: 'Could not send the password reset email. Check the backend mail configuration and try again.',
    });
  }
});

router.post('/password-reset/complete', rateLimit('password-reset-complete', 8, 15 * 60 * 1000), async (req, res) => {
  const { token, password } = req.body || {};
  if (typeof token !== 'string' || token.length !== 64) {
    return res.status(400).json({ success: false, message: 'This password reset link is invalid or expired.' });
  }
  if (typeof password !== 'string' || password.length < PASSWORD_MIN_LENGTH || password.length > 128) {
    return res.status(400).json({
      success: false,
      message: `Password must be between ${PASSWORD_MIN_LENGTH} and 128 characters.`,
    });
  }

  try {
    const passwordResetTokenHash = crypto.createHash('sha256').update(token).digest('hex');
    const account = await Account.findOne({
      passwordResetTokenHash,
      passwordResetExpiresAt: { $gt: new Date() },
    }).select('+passwordResetTokenHash +passwordResetExpiresAt');
    if (!account) {
      return res.status(400).json({ success: false, message: 'This password reset link is invalid or expired.' });
    }

    account.passwordHash = await hashPassword(password);
    account.passwordResetTokenHash = null;
    account.passwordResetExpiresAt = null;
    account.tokenVersion += 1;
    await account.save();
    res.json({ success: true, message: 'Your password has been reset. You can now sign in.' });
  } catch (error) {
    handleAuthError(res, error, 'password reset');
  }
});

module.exports = router;
