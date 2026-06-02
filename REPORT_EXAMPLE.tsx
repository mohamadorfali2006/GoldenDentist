/**
 * مثال عملي: استخدام نظام التقارير مع Backend
 * 
 * هذا الملف يوضح كيفية دمج التقارير في تطبيق React
 */

import React, { useState } from 'react';

export function PatientReportExample() {
  const [patientId] = useState('patient-123'); // من database
  const [loading, setLoading] = useState(false);

  /**
   * الطريقة 1: فتح التقرير في نافذة جديدة
   * (أبسط طريقة - تحويل مباشر من Backend)
   */
  const openReport = async () => {
    try {
      setLoading(true);
      // Backend يرسل redirect إلى النموذج مع البيانات
      window.open(
        `http://localhost:3001/api/patients/${patientId}/report`,
        '_blank',
        'width=900,height=1200'
      );
    } catch (error) {
      console.error('فشل فتح التقرير:', error);
    } finally {
      setLoading(false);
    }
  };

  /**
   * الطريقة 2: جلب البيانات وملء النموذج محلياً
   * (متقدمة - تحكم أكثر)
   */
  const openReportAdvanced = async () => {
    try {
      setLoading(true);

      // 1. جلب بيانات المريض من Backend
      const response = await fetch(
        `http://localhost:3001/api/patients/${patientId}/report/json`
      );

      if (!response.ok) {
        throw new Error('فشل جلب البيانات');
      }

      const data = await response.json();

      // 2. فتح نافذة النموذج
      const reportWindow = window.open('/NewDesignReport.htm', '_blank', 'width=900,height=1200');

      // 3. انتظر تحميل الصفحة ثم ملء البيانات
      if (reportWindow) {
        reportWindow.addEventListener('load', () => {
          setTimeout(() => {
            // 4. استدعِ دالة ملء البيانات من النموذج
            if (reportWindow.ReportTemplate?.populateReport) {
              reportWindow.ReportTemplate.populateReport(data);
            }
          }, 500);
        });
      }
    } catch (error) {
      console.error('خطأ:', error);
      alert('فشل فتح التقرير');
    } finally {
      setLoading(false);
    }
  };

  /**
   * الطريقة 3: طباعة مباشرة
   */
  const printReport = async () => {
    try {
      setLoading(true);
      const reportWindow = window.open(
        `http://localhost:3001/api/patients/${patientId}/report`,
        '_blank'
      );

      if (reportWindow) {
        reportWindow.addEventListener('load', () => {
          setTimeout(() => {
            reportWindow.print();
          }, 500);
        });
      }
    } catch (error) {
      console.error('خطأ:', error);
    } finally {
      setLoading(false);
    }
  };

  /**
   * الطريقة 4: عرض في iframe
   */
  const [showIframe, setShowIframe] = useState(false);

  return (
    <div style={{ padding: '20px', fontFamily: 'Arial' }}>
      <h1>🏥 نظام التقارير الطبية</h1>

      <div style={{
        display: 'flex',
        gap: '10px',
        marginBottom: '20px',
        flexWrap: 'wrap'
      }}>
        <button
          onClick={openReport}
          disabled={loading}
          style={buttonStyle('primary')}
        >
          {loading ? '⏳ جاري الفتح...' : '📋 عرض التقرير'}
        </button>

        <button
          onClick={openReportAdvanced}
          disabled={loading}
          style={buttonStyle('secondary')}
        >
          {loading ? '⏳ جاري التحضير...' : '🔧 عرض متقدم'}
        </button>

        <button
          onClick={printReport}
          disabled={loading}
          style={buttonStyle('success')}
        >
          {loading ? '⏳ جاري الطباعة...' : '🖨️ طباعة'}
        </button>

        <button
          onClick={() => setShowIframe(!showIframe)}
          style={buttonStyle('info')}
        >
          {showIframe ? '❌ إغلاق معاينة' : '👁️ معاينة مباشرة'}
        </button>
      </div>

      {/* معاينة مباشرة في iframe */}
      {showIframe && (
        <div style={{
          marginTop: '20px',
          border: '1px solid #ddd',
          borderRadius: '8px',
          overflow: 'hidden'
        }}>
          <iframe
            src={`http://localhost:3001/api/patients/${patientId}/report`}
            width="100%"
            height="1200"
            frameBorder="0"
            title="Report Preview"
          />
        </div>
      )}

      {/* معلومات */}
      <div style={{
        marginTop: '30px',
        padding: '15px',
        backgroundColor: '#f5f5f5',
        borderRadius: '8px'
      }}>
        <h3>ℹ️ معلومات التكامل</h3>
        <ul>
          <li>✅ <strong>Backend:</strong> http://localhost:3001</li>
          <li>✅ <strong>Frontend:</strong> http://localhost:8080</li>
          <li>✅ <strong>Endpoint 1:</strong> GET /api/patients/:id/report (تحويل مباشر)</li>
          <li>✅ <strong>Endpoint 2:</strong> GET /api/patients/:id/report/json (بيانات JSON)</li>
          <li>✅ <strong>Template:</strong> /NewDesignReport.htm (ديناميكي)</li>
        </ul>
      </div>

      <div style={{
        marginTop: '20px',
        padding: '15px',
        backgroundColor: '#e8f4f8',
        borderRadius: '8px',
        fontSize: '14px'
      }}>
        <h4>🔄 سير العملية:</h4>
        <p>
          1️⃣ المستخدم ينقر على زر "عرض التقرير"<br/>
          2️⃣ يتم استدعاء API من Backend لجلب بيانات المريض<br/>
          3️⃣ Backend يقرأ البيانات من Database (Prisma)<br/>
          4️⃣ يتم تحويل البيانات إلى URL parameters<br/>
          5️⃣ يتم فتح /NewDesignReport.htm مع الـ parameters<br/>
          6️⃣ النموذج يقوم بتعبئة البيانات تلقائياً<br/>
          7️⃣ المستخدم يمكنه الطباعة أو حفظ كـ PDF<br/>
        </p>
      </div>
    </div>
  );
}

// نمط الأزرار
function buttonStyle(type: string) {
  const baseStyle = {
    padding: '10px 20px',
    fontSize: '14px',
    border: 'none',
    borderRadius: '6px',
    cursor: 'pointer',
    fontWeight: 'bold',
    transition: 'all 0.3s ease',
  };

  const colors = {
    primary: { background: '#4CAF50', color: 'white' },
    secondary: { background: '#2196F3', color: 'white' },
    success: { background: '#FF9800', color: 'white' },
    info: { background: '#9C27B0', color: 'white' },
  };

  return { ...baseStyle, ...(colors[type as keyof typeof colors] || colors.primary) };
}

export default PatientReportExample;
