# حزمة تصحيح روابط ونطاق PWA لمستودع CBM Mila

هذه الحزمة مخصصة للمستودع:
`https://github.com/CBM-MILA/CBM-MILA-DIGITAL-PLATFORM`

## طريقة التطبيق (دون كتابة كود)
1. نزّل ملف ZIP وافتحه بواسطة Extract All.
2. ستجد الملفات المصححة مباشرة داخل المجلد، وليس داخل مجلد مشروع فرعي.
3. افتح المجلد المحلي المتصل بمستودع GitHub Desktop.
4. انسخ محتويات الحزمة إلى مجلد المستودع نفسه ووافق على استبدال الملفات العشرة عند ظهور الرسالة.
5. لا تحذف ولا تستبدل مجلد `data/` أو أي ملف بيانات؛ ستبقى بيانات المباريات المحدثة كما هي.
6. افتح GitHub Desktop، واكتب في Summary: `fix: align CBM PWA with new GitHub Pages path` ثم اضغط Commit to main وبعدها Push origin.

## الملفات التي تتغير
- `index.html`: canonical وOpen Graph وStructured Data إلى رابط الموقع الجديد.
- `manifest.webmanifest`: تعريف تطبيق PWA بالمسار الجديد.
- `config.js`: رفع إصدار البناء لإجبار Service Worker على تحديث الكاش.
- `app.js`: تصحيح رابط المشاركة الاحتياطي.
- `scraper.py`: تصحيح روابط الموقع في User-Agent ورسائل Telegram.
- `robots.txt` و`sitemap.xml` و`README.md`: تحديث الروابط العامة.
- `test_digest.py`: تحديث توقع رابط الموقع داخل الاختبار.
- `sw.js`: عزل أسماء الكاش الخاصة بهذا المشروع، وعدم حذف كاشات تطبيقات أخرى على نطاق GitHub Pages نفسه، وإضافة قالب البطاقة والخلفية إلى التخزين المسبق.

## ملاحظة
لا تحتوي هذه الحزمة على أي أسرار أو مفاتيح خاصة، ولا تستبدل ملفات `data/data.json` أو `data/status.json`.
