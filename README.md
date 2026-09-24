# سالم — شات ويب موبايل

شات موقع: أي حد يعمل حساب، يشوف قائمة الأعضاء، ويبعت رسائل خاصة real-time.

قاعدة البيانات: PostgreSQL (Neon) — نفس الطريقة المستخدمة في FTC2.

## التشغيل محليًا

```bash
npm install
```

لازم تضيف ملف `.env` أو environment variable باسم `DATABASE_URL` (رابط Neon) قبل التشغيل:

```bash
DATABASE_URL="postgres://user:pass@host/dbname?sslmode=require" node server.js
```

## النشر على Neon + Render

### 1) Neon (قاعدة البيانات)
1. سجّل دخول على neon.tech وافتح المشروع (أو اعمل مشروع جديد منفصل عن قاعدة بيانات FTC2).
2. من الـ Dashboard خد الـ Connection String (بيبدأ بـ `postgres://...`).
3. الجداول بتتعمل تلقائيًا أول ما السيرفر يشتغل (مفيش حاجة تعمليها يدوي في Neon).

### 2) رفع الكود على GitHub
اعملي repo جديد **منفصل تمامًا عن FTC2** وارفعي عليه محتوى المجلد ده.

### 3) Render (استضافة السيرفر)
1. من Render Dashboard: New → Web Service → اختاري الـ repo الجديد.
2. Build Command: `npm install`
3. Start Command: `npm start`
4. من تبويب Environment ضيفي:
   - `DATABASE_URL` = الرابط اللي جبتيه من Neon
   - `JWT_SECRET` = أي نص عشوائي طويل وسري (مثلاً 40 حرف عشوائي)
5. دوسي Create Web Service واستني لحد ما يخلص الـ deploy.
6. Render هيديكي رابط زي `https://your-app.onrender.com` — ده رابط الشات النهائي.

> ملاحظة: أول طلب بعد فترة خمول ممكن ياخد شوية ثواني علشان Render بيرجّع السيرفر يصحى (على الخطة المجانية).

## البنية

```
chat-app/
├── server.js        # Express + Socket.io + كل الـ API
├── db.js            # الاتصال بـ Neon (PostgreSQL) وإنشاء الجداول
├── public/
│   ├── index.html   # واجهة الدخول + قائمة الأعضاء + الشات
│   ├── style.css     # تصميم مظلم متجاوب للموبايل
│   └── app.js        # منطق العميل + الاتصال بالسوكيت
```

## المميزات الحالية
- تسجيل / دخول بكلمة مرور مشفرة (bcrypt) + JWT
- قائمة أعضاء مع حالة "متصل / غير متصل" لحظيًا
- محادثات خاصة 1-إلى-1 بالـ real-time (Socket.io)
- مؤشر "بيكتب..."
- سجل الرسائل محفوظ في Postgres، بيفضل موجود بعد أي deploy جديد
- تصميم مخصص للموبايل بالكامل (RTL عربي)

## أفكار للتوسعة لاحقًا
- صور شخصية حقيقية بدل الحرف الأول
- إشعارات push
- غرف جماعية مش بس محادثات فردية
- رفع صور/ملفات في الشات
