# CopyToBaleBot

ربات همگام‌سازی کانال **تلگرام ⇄ بله** که روی سرور خودت اجرا می‌شود.
هر کسی می‌تواند کانال تلگرام و کانال بله‌اش را به هم وصل کند تا پست‌ها (دوطرفه یا یک‌طرفه) خودکار منتقل شوند.

A self-hosted Telegram ⇄ Bale channel-sync bot: one long-running Node.js process, no npm dependencies, SQLite storage.

## امکانات

- اتصال هر کانال تلگرام به یک کانال بله با کد یک‌بارمصرف (اثبات ادمین بودن در هر دو طرف)
- همگام‌سازی متن، عکس، ویدیو، گیف، فایل، موزیک، ویس، آلبوم، استیکر، لوکیشن، مخاطب و نظرسنجی (به‌صورت متن)
- همگام‌سازی ویرایش‌ها، ریپلای‌ها و سنجاق؛ حذف دوطرفه با `/del` (ریپلای روی پست) یا فوروارد به ربات
- تبدیل قالب‌بندی (بولد، ایتالیک، لینک) بین entityهای تلگرام و مارک‌داون بله
- تنظیمات هر اتصال: جهت (دوطرفه/یک‌طرفه)، توقف، جایگزینی خودکار یوزرنیم و لینک کانال، قوانین جایگزینی متن،
  سربرگ و امضا برای هر جهت، فیلتر کلمات، `#nosync`، فیلتر نوع محتوا، حذف لینک/منشن، ارسال بی‌صدا و...
- ارسال پست‌های قدیمی با فوروارد کردن آن‌ها به ربات
- عضویت اجباری جداگانه برای کاربران تلگرام و بله
- پنل مدیریت: آمار کامل، پیام همگانی، مدیریت/مسدودسازی کاربر، همهٔ اتصال‌ها، وضعیت سیستم و خطاها

## معماری

ربات یک پروسهٔ همیشه‌روشن Node.js است. دیتابیس SQLite با ماژول داخلی `node:sqlite` است و هیچ پکیج npm لازم نیست.

- **آپدیت‌های تلگرام** (`lib/intake.js`): به‌طور پیش‌فرض با long polling؛ اگر `TG_WEBHOOK_URL` تنظیم شود با وبهوک.
  آپدیت‌های هر چت به‌ترتیب و چت‌های مختلف هم‌زمان به `handlers/` سپرده می‌شوند.
- **پمپ بله** (`lib/pump.js`): پیوسته `getUpdates` بله را long-poll می‌کند، پست‌های کانال را در صف می‌گذارد و پیوی
  بله را پاسخ می‌دهد. اگر بله در دسترس نباشد با فاصلهٔ فزاینده (حداکثر یک دقیقه) دوباره تلاش می‌کند.
- **صف کارها** (`lib/queue.js`): انتقال فایل‌ها و ارسال‌ها در ۳ ورکر هم‌زمان انجام می‌شود؛ کارهای هر اتصال به‌ترتیب اجرا
  می‌شوند تا ترتیب پست‌ها حفظ شود. تلاش مجدد با backoff و اطلاع به صاحب اتصال.
- **نگهداری**: هر ثانیه آلبوم‌های کامل‌شده به صف می‌روند و هر ۱۰ دقیقه داده‌های قدیمی پاک می‌شوند.
- **خاموش شدن تمیز**: با `SIGTERM`/`SIGINT` ورکرها کار در دستشان را تمام می‌کنند. اگر پروسه ناگهانی بمیرد، کارهای
  نیمه‌کاره در اجرای بعدی دوباره در صف قرار می‌گیرند. قفل دیتابیس نمی‌گذارد دو نسخه هم‌زمان روی یک دیتابیس اجرا شوند.

```
server.js   entry point: startup, background loops, graceful shutdown
handlers/   Telegram update handlers (message, channel_post, edited_channel_post, callback_query, my_chat_member)
lib/        telegram & bale clients, db (node:sqlite) + schema, text/format engine, sync, queue, pump, intake, UI, admin
scripts/    import-tgcloud: one-time data migration from Telegram Serverless
deploy/     systemd unit
```

## راه‌اندازی

پیش‌نیازها:

- یک سرور لینوکسی با **Docker**، یا **Node.js 22.13 به بالا** (پیشنهاد: 24 LTS)
- دسترسی خروجی به `api.telegram.org` و `tapi.bale.ai` (یا relay/پروکسی؛ بخش «سرور داخل ایران» را ببین)
- دامنه و پورت باز لازم نیست (مگر در حالت وبهوک)

اول تنظیمات:

```bash
git clone https://github.com/aliveis/CopyToBaleBot.git && cd CopyToBaleBot
cp .env.example .env        # توکن ربات تلگرام و بله و آیدی ادمین‌ها را پر کن
```

اگر ربات قبلاً روی Telegram Serverless اجرا می‌شد، **قبل از اولین اجرا** بخش «انتقال از Telegram Serverless» را انجام بده.

### با Docker (پیشنهادی)

```bash
docker compose up -d --build
docker compose logs -f
```

دیتابیس در volume به نام `botdata` نگه داشته می‌شود و با rebuild از بین نمی‌رود.

### با systemd

```bash
sudo useradd --system --home-dir /opt/CopyToBaleBot copytobalebot
sudo git clone https://github.com/aliveis/CopyToBaleBot.git /opt/CopyToBaleBot
cd /opt/CopyToBaleBot
sudo cp .env.example .env && sudo nano .env
sudo mkdir -p data && sudo chown -R copytobalebot: data .env && sudo chmod 600 .env
sudo cp deploy/copytobalebot.service /etc/systemd/system/     # مسیر node را در فایل چک کن
sudo systemctl daemon-reload && sudo systemctl enable --now copytobalebot
journalctl -u copytobalebot -f
```

### اجرای دستی

```bash
npm start
```

منوی دستورات هر دو ربات هنگام شروع خودکار ثبت می‌شود. وضعیت پمپ، ورکرها و صف در
`/admin ← 🫀 وضعیت سیستم` دیده می‌شود.

## انتقال از Telegram Serverless

اسکریپت `scripts/import-tgcloud.mjs` اتصال‌ها، کاربران، تنظیمات، نگاشت پیام‌ها، آمار و بقیهٔ داده‌ها را یک‌بار از
دیتابیس Telegram Serverless به دیتابیس محلی منتقل می‌کند (از همان endpointی که `npx tgcloud run` استفاده می‌کند؛ چیزی
deploy نمی‌شود).

1. در `.env` مقدار `TGCLOUD_TOKEN` را هم بگذار
   (‏@BotFather ← ربات ← Serverless ← CLI Access ← Access token).
2. اختیاری — فقط شمارش، بدون هیچ تغییری:
   `npm run import:tgcloud -- --dry-run`
3. انتقال:
   `npm run import:tgcloud`
   (با Docker: `docker compose run --rm bot npm run import:tgcloud`)

   اسکریپت اول وبهوک ربات سرورلس را برمی‌دارد تا دیگر آپدیتی نگیرد، ۴۰ ثانیه صبر می‌کند تا کارهای در حال اجرایش
   تمام شود و بعد داده‌ها را منتقل می‌کند. اگر خروجی گرفتن شکست بخورد، وبهوک سرورلس را دوباره وصل می‌کند.
4. بلافاصله سرور را روشن کن. تلگرام آپدیت‌های این فاصله را نگه داشته و تحویل می‌دهد و پمپ بله از همان آفست قبلی ادامه
   می‌دهد.
5. دیگر روی tgcloud deploy نکن (و اگر BotFather گزینه‌اش را دارد، Serverless ربات را خاموش کن) تا پلتفرم وبهوکش را
   دوباره تنظیم نکند.

اسکریپت فقط در دیتابیس خالی می‌نویسد و وقتی ربات روشن است اجرا نمی‌شود. اگر سرور به `cloud.telegram.org` دسترسی ندارد،
اسکریپت را روی هر سیستم دیگری با Node 22.13+ اجرا کن و فایل `data/bot.db` را به سرور منتقل کن.

## حالت وبهوک (اختیاری)

Long polling برای بیشتر موارد کافی است. برای وبهوک، یک دامنه با HTTPS و reverse proxy لازم است:

```env
TG_WEBHOOK_URL=https://bot.example.com/telegram-webhook
PORT=8080
```

ربات روی `PORT` گوش می‌دهد، هنگام شروع وبهوک را ثبت می‌کند و فقط درخواست‌هایی را قبول می‌کند که secret درست داشته باشند.
نمونهٔ Caddy:

```
bot.example.com {
    reverse_proxy /telegram-webhook 127.0.0.1:8080
}
```

با Docker، بخش `ports` را در `docker-compose.yml` از کامنت دربیاور. برای برگشت به long polling کافی است
`TG_WEBHOOK_URL` را پاک کنی؛ ربات خودش وبهوک را برمی‌دارد.

## سرور داخل ایران

سرورهای داخل ایران معمولاً به `api.telegram.org` دسترسی ندارند (و بعضی سرورهای خارج به `tapi.bale.ai`). دو راه:

- **relay**: `TG_API_URL` (یا `BALE_API_URL`) را روی یک reverse proxy بگذار که درخواست‌ها را به API اصلی می‌رساند.
- **پروکسی HTTP**: `HTTPS_PROXY` و `NODE_USE_ENV_PROXY=1` (و `NO_PROXY=tapi.bale.ai` تا ترافیک بله مستقیم برود).
  Node این متغیرها را هنگام شروع می‌خواند؛ با Docker و systemd از `.env` کار می‌کنند، ولی با `npm start` باید در shell
  export شوند.

## پشتیبان‌گیری

همهٔ داده‌ها در یک فایل SQLite است (پیش‌فرض `data/bot.db`؛ در Docker داخل volume `botdata`). ربات را متوقف کن و فایل را
کپی کن، یا در حال اجرا با `sqlite3 data/bot.db ".backup backup.db"`.

## تنظیمات

| متغیر | توضیح |
|---|---|
| `TG_BOT_TOKEN` | توکن ربات تلگرام (الزامی) |
| `BALE_BOT_TOKEN` | توکن ربات بله (الزامی) |
| `TG_ADMINS`, `BALE_ADMINS` | آیدی عددی ادمین‌ها، جداشده با کاما |
| `DB_PATH` | مسیر دیتابیس (پیش‌فرض `data/bot.db`) |
| `TG_WEBHOOK_URL`, `HOST`, `PORT`, `TG_WEBHOOK_SECRET` | حالت وبهوک |
| `TG_API_URL`, `BALE_API_URL` | آدرس پایهٔ API (relay یا Bot API server محلی) |
| `TGCLOUD_TOKEN` | فقط برای `npm run import:tgcloud` |

## محدودیت‌ها

- API تلگرام و بله حذف پست کانال را اطلاع نمی‌دهند؛ حذف دوطرفه با `/del` یا فوروارد به ربات انجام می‌شود.
- فایل‌های بزرگ‌تر از ۲۰ مگابایت (سقف `getFile`) منتقل نمی‌شوند.
- ویرایش مدیا (تعویض فایل) منتقل نمی‌شود؛ ویرایش متن و کپشن منتقل می‌شود.
