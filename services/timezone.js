const APP_TIME_ZONE = process.env.APP_TIME_ZONE || process.env.TZ || 'Asia/Shanghai';

process.env.TZ = APP_TIME_ZONE;

function pad2(value) {
  return String(value).padStart(2, '0');
}

function beijingNow() {
  return new Date();
}

function formatBeijingDateTime(date = beijingNow()) {
  const d = new Date(date);
  return [
    d.getFullYear(),
    pad2(d.getMonth() + 1),
    pad2(d.getDate()),
  ].join('-') + ' ' + [
    pad2(d.getHours()),
    pad2(d.getMinutes()),
    pad2(d.getSeconds()),
  ].join(':');
}

module.exports = {
  APP_TIME_ZONE,
  beijingNow,
  formatBeijingDateTime,
};
