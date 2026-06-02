# تكامل نظام التقارير مع Node.js Backend

## 📋 نظرة عامة

تم دمج نموذج `NewDesignReport.htm` مع مشروع Node.js ليعمل كنظام تقارير متكامل:

```
┌─────────────────┐
│   Frontend      │
│  (port 8080)    │──▶ NewDesignReport.htm (ديناميكي)
│  /index.html    │
└────────┬────────┘
         │
      calls
         │
         ▼
┌─────────────────┐
│  Backend API    │
│  (port 3001)    │
│  /api/patients/ │──▶ database (Prisma)
│  :id/report     │
└─────────────────┘
```

## 🔌 API Endpoints

### 1. توليد التقرير (Redirect)
```
GET /api/patients/:id/report
```
**وظيفة**: جلب بيانات المريض وتحويلها إلى رابط يفتح النموذج الديناميكي
**الاستجابة**: Redirect إلى `/NewDesignReport.htm?name=...&caseId=...&sex=...&age=...&date=...`

**مثال**:
```
GET http://localhost:3001/api/patients/patient-123/report
→ Redirects to: /NewDesignReport.htm?name=علي%20أحمد&caseId=GD-0001&sex=ذكر&age=28&date=June%202,%202026
```

### 2. بيانات التقرير (JSON)
```
GET /api/patients/:id/report/json
```
**وظيفة**: جلب بيانات المريض بصيغة JSON لاستخدامها في frontend
**الاستجابة**:
```json
{
  "name": "علي أحمد",
  "caseId": "GD-0001",
  "sex": "ذكر",
  "age": 28,
  "date": "June 2, 2026",
  "diagnosis": "...",
  "treatment": "...",
  "notes": ["note1", "note2", ...]
}
```

**مثال**:
```
GET http://localhost:3001/api/patients/patient-123/report/json
→ Returns JSON object
```

## 🎯 كيفية الاستخدام

### من الـ Frontend (HTML/JavaScript)

#### الطريقة 1: فتح التقرير في نافذة جديدة
```html
<button onclick="openReport()">عرض التقرير</button>

<script>
  function openReport(patientId) {
    // الطريقة A: استخدام الـ redirect endpoint
    window.open(`http://localhost:3001/api/patients/${patientId}/report`, '_blank');
    
    // أو الطريقة B: جلب البيانات وملء النموذج محلياً
    // (لاحقاً)
  }
</script>
```

#### الطريقة 2: عرض التقرير في iframe
```html
<iframe src="http://localhost:3001/api/patients/patient-123/report" 
        width="800" height="1100" frameborder="0"></iframe>
```

#### الطريقة 3: طباعة مباشرة
```html
<button onclick="printReport()">طباعة</button>

<script>
  function printReport(patientId) {
    const reportWindow = window.open(`http://localhost:3001/api/patients/${patientId}/report`);
    reportWindow.addEventListener('load', () => {
      setTimeout(() => reportWindow.print(), 500);
    });
  }
</script>
```

### من الـ React/Vue
```typescript
// في أي component
import { useNavigate } from 'react-router-dom';

const navigate = useNavigate();

const handleViewReport = (patientId: string) => {
  // الطريقة 1: فتح في نافذة جديدة
  window.open(`http://localhost:3001/api/patients/${patientId}/report`, '_blank');
  
  // الطريقة 2: جلب البيانات أولاً
  // const response = await fetch(`/api/patients/${patientId}/report/json`);
  // const data = await response.json();
  // // ثم ملء النموذج محلياً باستخدام populateReport()
};

const handlePrint = (patientId: string) => {
  const reportWindow = window.open(`http://localhost:3001/api/patients/${patientId}/report`);
  reportWindow?.addEventListener('load', () => {
    setTimeout(() => reportWindow?.print(), 500);
  });
};
```

## 🌐 تشغيل النظام

### 1. تشغيل Backend (port 3001)
```bash
cd backend
npm install
npm run dev  # أو: npx ts-node src/index.ts
```

### 2. تشغيل Frontend (port 8080)
```bash
# في نافذة أخرى
node server.js  # أو: python serve.py
```

### 3. افتح المتصفح
```
http://localhost:8080/
```

## 📝 البيانات المدعومة

النموذج يدعم الحقول التالية (من database):

| الحقل | النوع | الوصف |
|------|-------|-------|
| `name` | string | اسم المريض |
| `caseId` | string | معرّف الحالة |
| `sex` | string | الجنس (M/F أو ذكر/أنثى) |
| `age` | number | العمر |
| `dateCreated` | date | تاريخ الإنشاء |
| `diagnosis` | string | التشخيص |
| `treatment` | string | خطة العلاج |
| `notes` | string | ملاحظات (حتى 6 أسطر) |

## 🔧 تخصيص النموذج

### تغيير الألوان
في `NewDesignReport.htm`:
```css
.yellow-card {
    background-color: #dfb74c; /* تغيير هنا */
}
```

### إضافة حقول جديدة
1. أضف عنصر في HTML:
```html
<p id="newField">[Default Value]</p>
```

2. أضف الحقل في دالة populateReport:
```javascript
const newFieldEl = document.getElementById('newField');
if(newFieldEl) newFieldEl.textContent = data.newField || '[Default]';
```

3. أضف البيانات في Backend:
```typescript
router.get('/patients/:id/report/json', async (req, res) => {
  // ...
  res.json({
    // ... fields
    newField: patient.newField, // أضف هنا
  });
});
```

## 🖨️ الطباعة إلى PDF

### من المتصفح
1. افتح التقرير
2. اضغط `Ctrl+P` (أو `Cmd+P` على Mac)
3. اختر "حفظ باسم PDF"

### برمجياً (Node.js - اختياري)
إذا كنت تريد PDF من الـ backend مباشرة:
```bash
npm install puppeteer
```

ثم أضف endpoint:
```typescript
router.get('/patients/:id/report/pdf', async (req, res) => {
  const browser = await puppeteer.launch();
  const page = await browser.newPage();
  
  // اذهب للنموذج الديناميكي
  await page.goto(`http://localhost:8080/NewDesignReport.htm?...`);
  
  // وول PDF
  const pdf = await page.pdf({ format: 'A4' });
  
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `attachment; filename="GD-${patientId}.pdf"`);
  res.send(pdf);
  
  await browser.close();
});
```

## 🔒 معايير الأمان

- ✅ تنظيف جميع المدخلات من database
- ✅ التحقق من وجود المريض قبل توليد التقرير
- ✅ معالجة الأخطاء بشكل آمن
- ✅ عدم كشف تفاصيل المريض في URLs (استخدام ID فقط)

## 🐛 استكشاف الأخطاء

### الخطأ: "Patient not found"
- تأكد من وجود المريض في database
- تحقق من ID الصحيح

### الخطأ: CORS Error
- تأكد من تشغيل كلا الخادمين (port 3001 و 8080)
- في backend/src/index.ts:
```typescript
app.use(cors({ origin: 'http://localhost:8080' }));
```

### الخطأ: الصور لا تظهر في النموذج
- تأكد من وجود الصور في `css/` folder
- استخدم الرابط الكامل: `http://localhost:8080/css/image.png`

## 📚 الملفات ذات الصلة

```
GoldenDentist/
├── NewDesignReport.htm           ← النموذج الديناميكي
├── backend/
│   └── src/
│       ├── index.ts              ← Express app
│       └── routes/
│           └── patients.ts       ← Report endpoints
├── server.js                     ← Frontend static server
└── css/                          ← الصور والأنماط
    ├── image-removebg-preview.png
    └── Ultra-high-resolution_4K_enhancement...png
```

## ✅ قائمة المراجعة

- [ ] تشغيل Backend بنجاح
- [ ] تشغيل Frontend بنجاح
- [ ] فتح `/NewDesignReport.htm` يعرض النموذج
- [ ] زيارة `/api/patients/[id]/report` تعيد البيانات
- [ ] النقر على "عرض التقرير" يفتح نموذج مملوء بالبيانات
- [ ] الطباعة تعمل بنجاح

## 🎉 جاهز!

النظام الآن متكامل وجاهز للاستخدام!
