# سالم — منصة شات

شبكة محادثات Real-time بالعربية (RTL) مبنية بـ Express + Socket.IO.
تحديثات live للرسائل والحضور ومؤشر الكتابة وإيصالات القراءة، مع أمان صارم وقابلية توسع.

---

## المزايا

- **Real-time**: رسائل لحظية، حضور متعدد الجلسات، مؤشر كتابة، إيصالات قراءة (✓✓).
- **أمان**:
  - جلسات HttpOnly cookies: `salem_at` (JWT 15 دقيقة) + `salem_rt` (refresh عشوائي 256-bit مخزّن كـ SHA-256 مع **دوران عند كل استخدام** وإبطال عند الخروج).
  - CSRF عبر `SameSite=Strict` + فحص Origin + إلزام `Content-Type: application/json` للتغييرات.
  - Rate limiting منفصل (API عام / Auth / لكل مستخدم) + Token-bucket للرسائل + حد أقصى للجلسات (`TOO_MANY_SESSIONS`).
  - Helmet + CSP صارم بلا inline scripts، `X-Powered-By` معطّل، SQL parameterized بالكامل.
  - فحص أمان-il fail-fast: في `production` لا يقلع السيرفر بدون `JWT_SECRET` و`DATABASE_URL`.
- **قابلية توسع**: DB دفعية مزدوجة **PostgreSQL** (إنتاج) / **SQLite** (`node:sqlite` بدون تبعيات، للاختبار والتطوير)، Migrations مرقمة، Cursor pagination، Deduplication برسائل `client_msg_id`.
- **واجهة RTL حديثة**: بدون build step، ES modules، dark/light، متجاوبة للموبايل، Optimistic send، إعادة اتصال تلقائية للـ socket.

---

## البدء السريع (تطوير محلي — SQLite)

```bash
npm install
npm run dev        # http://localhost:3000  (SQLite في data/chat.db)
```

لا حاجة لأي إعداد: secret عشوائي يُولَّد في وضع التطوير، وDB تُنشأ تلقائيًا.

## الإنتاج

```bash
cp .env.example .env
# املأ: NODE_ENV=production, JWT_SECRET (≥32 حرفًا), DATABASE_URL (PostgreSQL)  — وAPP_URL اختياري
npm start
```

- `npm start` يشغّل الـ migrations تلقائيًا قبل الاستماع.
- على Render/Railway/Nginx: اضبط `TRUST_PROXY=true` حتى تعمل الـ rate limits و`req.ip` بشكل صحيح.
- الـ websocket بالـ Cookies: تعمل تلقائيًا لأنها same-origin.

## الاختبارات

```bash
npm test          # 51 اختبارًا: auth (11) + conversations (12) + socket (12) + security (16)
npm run test:e2e  # smoke اختبار المتصفح الحقيقي عبر Playwright (يتطلب تثبيت playwright)
```

الاختبارات تعمل على SQLite (in-memory) بدون أي تبعيات خارجية سوى `socket.io-client` (dev).

## البنية

```
server.js                 نقطة الدخول: migrate → listen → graceful shutdown
src/config.js            إعدادات + fail-fast في الإنتاج
src/db.js                محوّل SQLite/PG (translation تلقائي $n → ? مرتبة)
src/migrate.js           تطبيق الـ migrations
src/migrations/001-init.js  schema + ترقية تلقائية من schema القديم (receiver_id)
src/middleware.js        auth / CSRF / JSON / rate limits / error handler
src/routes/              auth, users, conversations
src/socket.js            أحداث الشات (message:send/read/typing/presence) + حدود
src/presence.js          خريطة حضور متعدد الجلسات في الذاكرة
public/                  واجهة RTL (index.html + style.css + app/ ES modules)
test/                    harness + مجاميع الاختبارات
smoke-fe.cjs             E2E عبر Playwright
```

## المصادقة والأمان بالتفصيل

| طبقة | الآلية |
| --- | --- |
| Access token | JWT HS256 في cookie `salem_at`, HttpOnly, SameSite=Strict, 15 دقيقة |
| Refresh token | عشوائي 256-bit، cache-hash في `sessions`، دوران عند كل `/api/auth/refresh` |
| جلسات | `sessions` جدول + Revocation (logout/refresh تلقائي) — إعادة استخدام token مبطل → 401 |
| CSRF | SameSite=Strict + رفض Origins غير مسموح (403) + `Content-Type: application/json` إلزامي (415) |
| Rate limits | `RATE_API` لكل IP، `RATE_AUTH` على /auth، `RATE_AUTH_USER` حسب الاسم، token bucket للرسائل |
| XSS | CSP بـ `script-src 'self'` (لا inline)، تخزين الرسائل raw، والـ UI يعرضها عبر `textContent` |

## واجهة API

| Method | Path | الوصف |
| --- | --- | --- |
| POST | `/api/auth/register` | إنشاء حساب (يبعث cookies) |
| POST | `/api/auth/login` | دخول |
| POST | `/api/auth/refresh` | دوران refresh token |
| POST | `/api/auth/logout` | إبطال الجلسة + مسح cookies |
| GET | `/api/auth/me` | المستخدم الحالي |
| GET | `/api/conversations?limit=` | قائمة المحادثات (آخر رسالة، unread، online) |
| POST | `/api/conversations` `{userId}` | فتح/إيجاد DM |
| GET | `/api/conversations/:id/messages?before&after&limit` | رسائل مع cursor pagination |
| POST | `/api/conversations/:id/read` `{lastReadId}` | تحديث القراءة |
| GET | `/api/users?q=&limit=` | بحث مستخدمين |
| GET | `/api/users/:id` | ملف مستخدم (online) |
| GET | `/api/users/:id/shared-conversation` | DM موجود مسبقًا؟ |
| GET | `/healthz` | فحص جاهزية |

### Socket.IO events

- emit `message:send` `{conversationId, content, clientMsgId, replyToId?}` → ack `{ok, message}` أو `{error}` (`duplicate:true` عند تكرار). يبث `message:new` للأعضاء الآخرين.
- emit `conversation:read` `{conversationId, lastReadId}` → يبث `conversation:read`.
- emit `typing` `{conversationId}` → يبث `typing` (معدل 2 ثانية، `throttled:true`).
- استقبال `presence` قائمة online user ids، و`session:error` عند تجاوز حد الجلسات.

المصادقة في الـ handshake من cookie `salem_at` + فحص Origin (مثل REST).

## قاعدة البيانات

- **Dev/Test**: SQLite (`node:sqlite`) — `data/chat.db` افتراضيًا، أو `DB_FILE=:memory:` للاختبار.
- **Prod**: PostgreSQL عبر `DATABASE_URL` (يفضَّل مع SSL).
- الجداول: `users`, `sessions`, `conversations`, `conversation_members` (de-normalized `last_read_message_id`, `muted_until`, `archived_at`), `messages` (فهرس `(conversation_id, id)` للـ pagination و`UNIQUE(conversation_id, client_msg_id)` للـ deduplication).
- `conversations` تخزّن `last_message_id/last_message_at` de-normalized لسرعة القائمة.
- ترقية تلقائية: لو كان DB قديم (به `messages.receiver_id` و`rooms`) يُعاد بناؤه بمعاملة واحدة.

## ملاحظات

- كود الأمان لا يعتمد على `localStorage` (كلها cookies محمية).
- ضبط `limits` (RATE_*, MSG_MAX_LEN) عبر متغيرات البيئة.
- `playwright` اختياري للاختبارات الآلية فقط (ليس اعتمادًا للتشغيل).