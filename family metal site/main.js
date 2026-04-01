// مثال بسيط: فتح كل الروابط في نافذة جديدة
document.querySelectorAll('a').forEach(link => {
    link.setAttribute('target', '_blank');
});