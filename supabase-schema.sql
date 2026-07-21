-- ============================================================
-- إعداد قاعدة بيانات Supabase لنظام «سجل حوالات P2P»
-- انسخ هذا كامله والصقه في: Supabase → SQL Editor → Run
-- ============================================================

-- جدول تخزين بسيط (مفتاح/قيمة). يحفظ ثلاثة مفاتيح:
--   orders    → كل الطلبات
--   transfers → سجل الإيداع والسحب
--   config    → الإعدادات + مفاتيح API + كلمات السر (مشفّرة)
create table if not exists public.kv (
  key text primary key,
  value jsonb,
  updated_at timestamptz not null default now()
);

-- تفعيل حماية الصفوف (Row Level Security):
-- بلا سياسات عامة = لا أحد يصل للبيانات إلا الخادم عبر مفتاح service_role.
-- (مفتاح service_role يتجاوز RLS، ويُستخدم من الخادم فقط — لا يظهر للمتصفح.)
alter table public.kv enable row level security;
