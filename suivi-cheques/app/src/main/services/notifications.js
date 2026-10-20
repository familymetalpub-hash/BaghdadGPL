'use strict';

const { assertPermission } = require('./authorization');

function createNotification(db, { userId, companyId = null, type, title, body = null, entityType = null, entityId = null }) {
  if (!userId) return null;
  const result = db
    .prepare(
      `INSERT INTO notifications(user_id, company_id, type, title, body, entity_type, entity_id)
       VALUES (?,?,?,?,?,?,?)`
    )
    .run(userId, companyId, type, title, body, entityType, entityId === null ? null : String(entityId));
  return Number(result.lastInsertRowid);
}

function notifyRole(db, { roleCode, companyId = null, type, title, body = null, entityType = null, entityId = null, excludeUserId = null }) {
  const users = db
    .prepare(
      `SELECT u.id FROM users u JOIN roles r ON r.id = u.role_id
       WHERE r.code = ? AND u.is_active = 1 AND (? IS NULL OR u.id <> ?)`
    )
    .all(roleCode, excludeUserId, excludeUserId);
  const ids = [];
  for (const u of users) {
    ids.push(
      createNotification(db, { userId: u.id, companyId, type, title, body, entityType, entityId })
    );
  }
  return ids;
}

function listNotifications(db, ctx, options = {}) {
  assertPermission(ctx, 'notifications.view');
  const limit = Math.min(100, Math.max(1, Number(options.limit) || 30));
  const onlyUnread = options.unreadOnly === true;
  const params = [ctx.user.id];
  let where = 'user_id = ?';
  if (onlyUnread) where += ' AND is_read = 0';
  return db
    .prepare(`SELECT * FROM notifications WHERE ${where} ORDER BY id DESC LIMIT ?`)
    .all(...params, limit)
    .map((n) => ({
      id: n.id,
      type: n.type,
      title: n.title,
      body: n.body,
      companyId: n.company_id,
      entityType: n.entity_type,
      entityId: n.entity_id,
      isRead: Boolean(n.is_read),
      readAt: n.read_at,
      createdAt: n.created_at,
    }));
}

function unreadCount(db, ctx) {
  assertPermission(ctx, 'notifications.view');
  return db.prepare('SELECT COUNT(*) AS n FROM notifications WHERE user_id = ? AND is_read = 0').get(ctx.user.id).n;
}

function markRead(db, ctx, input) {
  assertPermission(ctx, 'notifications.view');
  const now = new Date().toISOString();
  if (input && Array.isArray(input.ids) && input.ids.length) {
    const ids = [...new Set(input.ids.map(Number).filter((n) => Number.isInteger(n) && n > 0))].slice(0, 500);
    if (ids.length) {
      db.prepare(
        `UPDATE notifications SET is_read = 1, read_at = ? WHERE user_id = ? AND is_read = 0 AND id IN (${ids.map(() => '?').join(',')})`
      ).run(now, ctx.user.id, ...ids);
    }
    return { ok: true, count: ids.length };
  }
  if (input && input.id) {
    db.prepare('UPDATE notifications SET is_read = 1, read_at = ? WHERE id = ? AND user_id = ?').run(
      new Date().toISOString(),
      Number(input.id),
      ctx.user.id
    );
  } else {
    db.prepare('UPDATE notifications SET is_read = 1, read_at = ? WHERE user_id = ? AND is_read = 0').run(
      new Date().toISOString(),
      ctx.user.id
    );
  }
  return { ok: true };
}

module.exports = { createNotification, notifyRole, listNotifications, unreadCount, markRead };
