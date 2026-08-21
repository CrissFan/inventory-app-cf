import crypto from 'crypto';
import jwt from 'jsonwebtoken';
import db from './db.js';

const JWT_SECRET = process.env.JWT_SECRET || crypto.randomBytes(64).toString('hex');
const TOKEN_EXPIRY = '30d';

function hashPassword(password, salt) {
  salt = salt || crypto.randomBytes(16).toString('hex');
  const hash = crypto.pbkdf2Sync(password, salt, 100000, 64, 'sha512').toString('hex');
  return `${salt}:${hash}`;
}

function verifyPassword(password, stored) {
  const [salt, hash] = stored.split(':');
  return hashPassword(password, salt) === stored;
}

function generateToken(user) {
  return jwt.sign(
    { id: user.id, team_id: user.team_id, role: user.role, display_name: user.display_name },
    JWT_SECRET,
    { expiresIn: TOKEN_EXPIRY }
  );
}

function authMiddleware(req, res, next) {
  const header = req.headers.authorization;
  if (!header || !header.startsWith('Bearer ')) {
    return res.status(401).json({ error: '请先登录' });
  }
  try {
    const token = header.split(' ')[1];
    req.user = jwt.verify(token, JWT_SECRET);
    next();
  } catch (err) {
    return res.status(401).json({ error: '登录已过期，请重新登录' });
  }
}

// Optional auth — attaches user if token present, but doesn't fail
function optionalAuth(req, res, next) {
  const header = req.headers.authorization;
  if (header && header.startsWith('Bearer ')) {
    try {
      req.user = jwt.verify(header.split(' ')[1], JWT_SECRET);
    } catch {}
  }
  next();
}

// Admin only middleware
function adminOnly(req, res, next) {
  if (req.user?.role !== 'admin') {
    return res.status(403).json({ error: '仅管理员可操作' });
  }
  next();
}

// ====== Auth Routes ======

export function authRoutes(router) {
  // Register: creates a new team and admin user
  router.post('/auth/register', (req, res) => {
    const { username, password, display_name, team_name } = req.body;

    if (!username || !username.trim() || username.length < 2) {
      return res.status(400).json({ error: '用户名至少2个字符' });
    }
    if (!password || password.length < 4) {
      return res.status(400).json({ error: '密码至少4个字符' });
    }
    if (!team_name || !team_name.trim()) {
      return res.status(400).json({ error: '团队名称不能为空' });
    }

    let userId, inviteCode;

    const doRegister = db.transaction(() => {
      const code = 'INV' + crypto.randomBytes(4).toString('hex').toUpperCase();
      const team = db.prepare(
        'INSERT INTO teams (name, invite_code) VALUES (?, ?)'
      ).run(team_name.trim(), code);

      const teamId = team.lastInsertRowid;
      const pwdHash = hashPassword(password);
      const user = db.prepare(
        'INSERT INTO users (team_id, username, password_hash, display_name, role) VALUES (?, ?, ?, ?, ?)'
      ).run(teamId, username.trim(), pwdHash, display_name?.trim() || username.trim(), 'admin');

      userId = user.lastInsertRowid;
      inviteCode = code;
    });

    doRegister();

    const userInfo = db.prepare(
      'SELECT u.*, t.name as team_name, t.invite_code FROM users u JOIN teams t ON u.team_id = t.id WHERE u.id = ?'
    ).get(userId);

    const token = generateToken(userInfo);
    res.status(201).json({
      token,
      user: {
        id: userInfo.id,
        username: userInfo.username,
        display_name: userInfo.display_name,
        role: userInfo.role,
        team: { id: userInfo.team_id, name: userInfo.team_name, invite_code: userInfo.invite_code },
      },
    });
  });

  // Login
  router.post('/auth/login', (req, res) => {
    const { team_id, username, password } = req.body;

    if (!username || !password) {
      return res.status(400).json({ error: '请输入用户名和密码' });
    }

    let user;
    if (team_id) {
      // Login to specific team
      user = db.prepare(
        'SELECT u.*, t.name as team_name, t.invite_code FROM users u JOIN teams t ON u.team_id = t.id WHERE u.team_id = ? AND u.username = ?'
      ).get(team_id, username.trim());
    } else {
      // Login by username (find across all teams — take first match)
      user = db.prepare(
        'SELECT u.*, t.name as team_name, t.invite_code FROM users u JOIN teams t ON u.team_id = t.id WHERE u.username = ? LIMIT 1'
      ).get(username.trim());
    }

    if (!user) {
      return res.status(401).json({ error: '用户名或密码错误' });
    }

    if (!verifyPassword(password, user.password_hash)) {
      return res.status(401).json({ error: '用户名或密码错误' });
    }

    const token = generateToken(user);
    res.json({
      token,
      user: {
        id: user.id,
        username: user.username,
        display_name: user.display_name,
        role: user.role,
        team: { id: user.team_id, name: user.team_name, invite_code: user.invite_code },
      },
    });
  });

  // Get current user
  router.get('/auth/me', authMiddleware, (req, res) => {
    const user = db.prepare(
      'SELECT u.*, t.name as team_name, t.invite_code FROM users u JOIN teams t ON u.team_id = t.id WHERE u.id = ?'
    ).get(req.user.id);

    if (!user) return res.status(404).json({ error: '用户不存在' });

    res.json({
      user: {
        id: user.id,
        username: user.username,
        display_name: user.display_name,
        role: user.role,
        team: { id: user.team_id, name: user.team_name, invite_code: user.invite_code },
      },
    });
  });

  // Join a team via invite code
  router.post('/auth/join', (req, res) => {
    const { invite_code, username, password, display_name } = req.body;

    if (!invite_code || !username || !password) {
      return res.status(400).json({ error: '请填写完整信息' });
    }

    const team = db.prepare('SELECT * FROM teams WHERE invite_code = ?').get(invite_code.toUpperCase());
    if (!team) {
      return res.status(404).json({ error: '邀请码无效，未找到对应团队' });
    }

    // Check if username already exists in this team
    const existing = db.prepare('SELECT id FROM users WHERE team_id = ? AND username = ?').get(team.id, username.trim());
    if (existing) {
      return res.status(409).json({ error: '该用户名已在团队中使用' });
    }

    const pwdHash = hashPassword(password);
    const result = db.prepare(
      'INSERT INTO users (team_id, username, password_hash, display_name, role) VALUES (?, ?, ?, ?, ?)'
    ).run(team.id, username.trim(), pwdHash, display_name?.trim() || username.trim(), 'member');

    const user = db.prepare(
      'SELECT u.*, t.name as team_name, t.invite_code FROM users u JOIN teams t ON u.team_id = t.id WHERE u.id = ?'
    ).get(result.lastInsertRowid);

    const token = generateToken(user);
    res.status(201).json({
      token,
      user: {
        id: user.id,
        username: user.username,
        display_name: user.display_name,
        role: user.role,
        team: { id: user.team_id, name: user.team_name, invite_code: user.invite_code },
      },
    });
  });
}

// ====== Team Routes ======

export function teamRoutes(router) {
  // Get team info
  router.get('/team', authMiddleware, (req, res) => {
    const team = db.prepare('SELECT * FROM teams WHERE id = ?').get(req.user.team_id);
    if (!team) return res.status(404).json({ error: '团队不存在' });

    const members = db.prepare(
      'SELECT id, username, display_name, role, created_at FROM users WHERE team_id = ? ORDER BY role DESC, created_at ASC'
    ).all(req.user.team_id);

    res.json({ team, members });
  });

  // Add member (admin only)
  router.post('/team/members', authMiddleware, adminOnly, (req, res) => {
    const { username, password, display_name, role } = req.body;

    if (!username || !username.trim()) {
      return res.status(400).json({ error: '用户名不能为空' });
    }
    if (!password || password.length < 4) {
      return res.status(400).json({ error: '密码至少4个字符' });
    }
    const validRole = ['admin', 'member', 'viewer'].includes(role) ? role : 'member';

    const existing = db.prepare('SELECT id FROM users WHERE team_id = ? AND username = ?')
      .get(req.user.team_id, username.trim());
    if (existing) {
      return res.status(409).json({ error: '该用户名已存在' });
    }

    const pwdHash = hashPassword(password);
    const info = db.prepare(
      'INSERT INTO users (team_id, username, password_hash, display_name, role) VALUES (?, ?, ?, ?, ?)'
    ).run(req.user.team_id, username.trim(), pwdHash, display_name?.trim() || username.trim(), validRole);

    const member = db.prepare(
      'SELECT id, username, display_name, role, created_at FROM users WHERE id = ?'
    ).get(info.lastInsertRowid);

    res.status(201).json(member);
  });

  // Update member (admin only, can't modify self)
  router.put('/team/members/:id', authMiddleware, adminOnly, (req, res) => {
    const memberId = parseInt(req.params.id);
    if (memberId === req.user.id) {
      return res.status(400).json({ error: '不能修改自己的信息' });
    }

    const member = db.prepare('SELECT * FROM users WHERE id = ? AND team_id = ?').get(memberId, req.user.team_id);
    if (!member) return res.status(404).json({ error: '成员不存在' });

    const { display_name, role, password } = req.body;
    const updates = [];
    const params = [];

    if (display_name !== undefined) {
      updates.push('display_name = ?');
      params.push(display_name.trim());
    }
    if (role && ['admin', 'member', 'viewer'].includes(role)) {
      updates.push('role = ?');
      params.push(role);
    }
    if (password && password.length >= 4) {
      updates.push('password_hash = ?');
      params.push(hashPassword(password));
    }

    if (updates.length === 0) return res.status(400).json({ error: '没有要更新的内容' });

    params.push(memberId);
    db.prepare(`UPDATE users SET ${updates.join(', ')} WHERE id = ?`).run(...params);

    const updated = db.prepare('SELECT id, username, display_name, role, created_at FROM users WHERE id = ?').get(memberId);
    res.json(updated);
  });

  // Remove member (admin only, can't remove self)
  router.delete('/team/members/:id', authMiddleware, adminOnly, (req, res) => {
    const memberId = parseInt(req.params.id);
    if (memberId === req.user.id) {
      return res.status(400).json({ error: '不能移除自己' });
    }

    const result = db.prepare('DELETE FROM users WHERE id = ? AND team_id = ?').run(memberId, req.user.team_id);
    if (result.changes === 0) return res.status(404).json({ error: '成员不存在' });

    res.json({ success: true });
  });

  // Update team info (admin only)
  router.put('/team', authMiddleware, adminOnly, (req, res) => {
    const { name } = req.body;
    if (!name || !name.trim()) return res.status(400).json({ error: '团队名称不能为空' });

    db.prepare('UPDATE teams SET name = ? WHERE id = ?').run(name.trim(), req.user.team_id);
    res.json({ success: true, name: name.trim() });
  });

  // Regenerate invite code (admin only)
  router.post('/team/invite-code', authMiddleware, adminOnly, (req, res) => {
    const code = 'INV' + crypto.randomBytes(4).toString('hex').toUpperCase();
    db.prepare('UPDATE teams SET invite_code = ? WHERE id = ?').run(code, req.user.team_id);
    res.json({ invite_code: code });
  });
}

export { generateToken, verifyPassword, hashPassword, authMiddleware, optionalAuth, adminOnly, JWT_SECRET };
